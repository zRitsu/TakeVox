import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
import sys
import webbrowser
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
import qrcode
import qrcode.image.svg

from audio_router import AudioDriverRouter
from cert_utils import ensure_local_certificates
from driver_installer import DEFAULT_DRIVER_DOWNLOAD_URL, VirtualDriverInstaller


BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
STATIC_DIR = BUNDLE_DIR / "static"
CERT_DIR = APP_DIR / "certs"
RECORDINGS_DIR = APP_DIR / "recordings"
CONFIG_PATH = APP_DIR / "takevox.config.json"
DEFAULT_CONFIG = {
    "host": "0.0.0.0",
    "port": 8765,
    "scheme": "https",
    "open_browser_on_start": True,
    "desktop_path": "/desktop",
    "desktop_session_id": "",
    "desktop_session_key": "",
    "driver_download_url": DEFAULT_DRIVER_DOWNLOAD_URL,
    "mobile_access_password": "",
    "mobile_auth_token_ttl_days": 30,
    "auth_secret": "",
}


def write_config_file(payload: dict[str, object]) -> None:
    CONFIG_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_raw_config() -> tuple[dict[str, object], bool]:
    if not CONFIG_PATH.exists():
        write_config_file(DEFAULT_CONFIG)
        return dict(DEFAULT_CONFIG), True

    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        write_config_file(DEFAULT_CONFIG)
        return dict(DEFAULT_CONFIG), True

    if not isinstance(raw, dict):
        write_config_file(DEFAULT_CONFIG)
        return dict(DEFAULT_CONFIG), True

    return raw, False


def load_config() -> dict[str, object]:
    raw, config_created = read_raw_config()
    config = dict(DEFAULT_CONFIG)
    config.update(raw)
    config["port"] = int(config["port"])
    config["host"] = str(config["host"])
    config["scheme"] = str(config["scheme"])
    config["open_browser_on_start"] = bool(config["open_browser_on_start"])
    config["desktop_path"] = str(config["desktop_path"])
    config["desktop_session_id"] = str(config["desktop_session_id"])
    config["desktop_session_key"] = str(config["desktop_session_key"])
    config["driver_download_url"] = str(config["driver_download_url"])
    config["mobile_access_password"] = str(config["mobile_access_password"])
    config["mobile_auth_token_ttl_days"] = max(1, int(config["mobile_auth_token_ttl_days"]))
    config["auth_secret"] = str(config["auth_secret"])
    if not config["desktop_session_id"]:
        config["desktop_session_id"] = secrets.token_hex(2).upper()
    if not config["desktop_session_key"]:
        config["desktop_session_key"] = secrets.token_urlsafe(18)
    if not config["auth_secret"]:
        config["auth_secret"] = secrets.token_hex(32)
        serialized = dict(raw if isinstance(raw, dict) else {})
        serialized.update(config)
        write_config_file(serialized)
    elif config_created:
        write_config_file(config)
    return config


CONFIG = load_config()
APP_HOST = str(CONFIG["host"])
APP_PORT = int(CONFIG["port"])
APP_SCHEME = str(CONFIG["scheme"])
OPEN_BROWSER_ON_START = bool(CONFIG["open_browser_on_start"])
DESKTOP_PATH = str(CONFIG["desktop_path"])
DESKTOP_SESSION_ID = str(CONFIG["desktop_session_id"])
DESKTOP_SESSION_KEY = str(CONFIG["desktop_session_key"])
DRIVER_DOWNLOAD_URL = str(CONFIG["driver_download_url"])
MOBILE_ACCESS_PASSWORD = str(CONFIG["mobile_access_password"])
MOBILE_AUTH_TOKEN_TTL_DAYS = int(CONFIG["mobile_auth_token_ttl_days"])
AUTH_SECRET = str(CONFIG["auth_secret"])
_browser_opened = False
MOBILE_AUDIO_PACKET_MAGIC = b"TVX1"
MOBILE_AUTH_TOKEN_VERSION = 1


def persist_config_value(key: str, value: object) -> None:
    raw, _ = read_raw_config()
    serialized = dict(raw)
    serialized[key] = value
    write_config_file(serialized)


def generate_desktop_session_id() -> str:
    return secrets.token_hex(2).upper()


def generate_desktop_session_key() -> str:
    return secrets.token_urlsafe(18)


def get_desktop_session_id() -> str:
    global DESKTOP_SESSION_ID
    if not DESKTOP_SESSION_ID:
        DESKTOP_SESSION_ID = generate_desktop_session_id()
        persist_config_value("desktop_session_id", DESKTOP_SESSION_ID)
    return DESKTOP_SESSION_ID


def get_desktop_session_key() -> str:
    global DESKTOP_SESSION_KEY
    if not DESKTOP_SESSION_KEY:
        DESKTOP_SESSION_KEY = generate_desktop_session_key()
        persist_config_value("desktop_session_key", DESKTOP_SESSION_KEY)
    return DESKTOP_SESSION_KEY


def reset_desktop_session_credentials() -> tuple[str, str]:
    global DESKTOP_SESSION_ID, DESKTOP_SESSION_KEY
    DESKTOP_SESSION_ID = generate_desktop_session_id()
    DESKTOP_SESSION_KEY = generate_desktop_session_key()
    persist_config_value("desktop_session_id", DESKTOP_SESSION_ID)
    persist_config_value("desktop_session_key", DESKTOP_SESSION_KEY)
    return DESKTOP_SESSION_ID, DESKTOP_SESSION_KEY


def get_local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def get_desktop_url() -> str:
    return f"{APP_SCHEME}://localhost:{APP_PORT}{DESKTOP_PATH}"


def open_browser_once() -> None:
    global _browser_opened
    if _browser_opened or not OPEN_BROWSER_ON_START:
        return
    _browser_opened = True
    threading.Timer(1.0, lambda: webbrowser.open(get_desktop_url())).start()


def extract_pcm_payload(data: bytes) -> bytes:
    header_size = 16
    if len(data) >= header_size and data[:4] == MOBILE_AUDIO_PACKET_MAGIC:
        return data[header_size:]
    return data


def mobile_auth_enabled() -> bool:
    return bool(MOBILE_ACCESS_PASSWORD.strip())


def _urlsafe_b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _urlsafe_b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def create_mobile_auth_token() -> str:
    now = int(time.time())
    payload = {
        "sub": "mobile",
        "ver": MOBILE_AUTH_TOKEN_VERSION,
        "iat": now,
        "exp": now + (MOBILE_AUTH_TOKEN_TTL_DAYS * 24 * 60 * 60),
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded_payload = _urlsafe_b64encode(payload_bytes)
    signature = hmac.new(AUTH_SECRET.encode("utf-8"), encoded_payload.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded_payload}.{_urlsafe_b64encode(signature)}"


def validate_mobile_auth_token(token: str) -> bool:
    if not token or "." not in token:
        return False

    encoded_payload, encoded_signature = token.split(".", 1)
    try:
        expected_signature = hmac.new(
            AUTH_SECRET.encode("utf-8"),
            encoded_payload.encode("ascii"),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(_urlsafe_b64encode(expected_signature), encoded_signature):
            return False

        payload_raw = _urlsafe_b64decode(encoded_payload)
        payload = json.loads(payload_raw.decode("utf-8"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return False

    if payload.get("sub") != "mobile":
        return False
    if payload.get("ver") != MOBILE_AUTH_TOKEN_VERSION:
        return False
    expires_at = int(payload.get("exp", 0))
    return expires_at > int(time.time())


@dataclass
class SessionState:
    desktop: Optional[WebSocket] = None
    mobile: Optional[WebSocket] = None
    created: float = field(default_factory=lambda: asyncio.get_event_loop().time())


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_browser_once()
    yield


app = FastAPI(title="TakeVox", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/recordings", StaticFiles(directory=RECORDINGS_DIR), name="recordings")
sessions: dict[str, SessionState] = {}
audio_router = AudioDriverRouter()
driver_installer = VirtualDriverInstaller(APP_DIR, audio_router, download_url=DRIVER_DOWNLOAD_URL)


def render_page(template_name: str) -> str:
    template_path = STATIC_DIR / template_name
    html = template_path.read_text(encoding="utf-8")
    local_ip = get_local_ip()
    return (
        html.replace("__LOCAL_IP__", local_ip)
        .replace("__APP_PORT__", str(APP_PORT))
        .replace("__APP_SCHEME__", APP_SCHEME)
        .replace("__DESKTOP_SESSION_ID__", get_desktop_session_id())
        .replace("__DESKTOP_SESSION_KEY__", get_desktop_session_key())
    )


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return render_page("index.html")


@app.get("/desktop", response_class=HTMLResponse)
async def desktop() -> str:
    return render_page("desktop.html")


@app.get("/mobile", response_class=HTMLResponse)
async def mobile() -> str:
    return render_page("mobile.html")


@app.get("/qr")
async def qr_code(data: str) -> Response:
    factory = qrcode.image.svg.SvgImage
    image = qrcode.make(data, image_factory=factory, box_size=10, border=2)
    buffer = BytesIO()
    image.save(buffer)
    svg = buffer.getvalue().decode("utf-8")
    width_match = re.search(r'width="([0-9.]+)mm"', svg)
    height_match = re.search(r'height="([0-9.]+)mm"', svg)
    if width_match and height_match:
        svg = re.sub(r'="([0-9.]+)mm"', r'="\1"', svg)
        view_box = f'viewBox="0 0 {width_match.group(1)} {height_match.group(1)}"'
        svg = re.sub(r'width="[0-9.]+" height="[0-9.]+"', f'width="100%" height="100%" {view_box} preserveAspectRatio="xMidYMid meet"', svg, count=1)
    return Response(content=svg, media_type="image/svg+xml")


@app.get("/api/mobile-auth/status")
async def mobile_auth_status() -> JSONResponse:
    return JSONResponse(
        {
            "required": mobile_auth_enabled(),
            "ttlDays": MOBILE_AUTH_TOKEN_TTL_DAYS,
        }
    )


@app.post("/api/mobile-auth/login")
async def mobile_auth_login(request: Request) -> JSONResponse:
    if not mobile_auth_enabled():
        return JSONResponse({"ok": True, "required": False, "token": None, "ttlDays": MOBILE_AUTH_TOKEN_TTL_DAYS})

    payload = await request.json()
    password = str(payload.get("password", "")) if isinstance(payload, dict) else ""
    if not hmac.compare_digest(password, MOBILE_ACCESS_PASSWORD):
        raise HTTPException(status_code=401, detail="Senha invalida.")

    return JSONResponse(
        {
            "ok": True,
            "required": True,
            "token": create_mobile_auth_token(),
            "ttlDays": MOBILE_AUTH_TOKEN_TTL_DAYS,
        }
    )


@app.post("/api/mobile-auth/validate")
async def mobile_auth_validate(request: Request) -> JSONResponse:
    if not mobile_auth_enabled():
        return JSONResponse({"ok": True, "required": False, "valid": True})

    payload = await request.json()
    token = str(payload.get("token", "")) if isinstance(payload, dict) else ""
    return JSONResponse({"ok": True, "required": True, "valid": validate_mobile_auth_token(token)})


@app.post("/api/desktop-session/reset")
async def reset_desktop_session() -> JSONResponse:
    session_id, session_key = reset_desktop_session_credentials()
    return JSONResponse({"ok": True, "sessionId": session_id, "sessionKey": session_key})


def _safe_recording_name(filename: str) -> str:
    safe_name = Path(filename).name.replace(" ", "_")
    if not safe_name:
        raise HTTPException(status_code=400, detail="Nome de arquivo invalido.")
    return safe_name


def _recording_path(filename: str) -> Path:
    safe_name = _safe_recording_name(filename)
    return RECORDINGS_DIR / safe_name


@app.get("/api/recordings")
async def list_recordings() -> JSONResponse:
    items = []
    for path in sorted(RECORDINGS_DIR.glob("*"), key=lambda item: item.stat().st_mtime, reverse=True):
        if not path.is_file():
            continue
        stat = path.stat()
        items.append(
            {
                "name": path.name,
                "size": stat.st_size,
                "modifiedAt": stat.st_mtime,
                "url": f"/recordings/{path.name}",
            }
        )
    return JSONResponse({"items": items})


@app.post("/api/recordings")
async def save_recording(request: Request, filename: str) -> JSONResponse:
    safe_name = _safe_recording_name(filename)
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")

    target = RECORDINGS_DIR / safe_name
    target.write_bytes(payload)
    return JSONResponse(
        {
            "ok": True,
            "name": target.name,
            "size": target.stat().st_size,
            "url": f"/recordings/{target.name}",
        }
    )


@app.post("/api/recordings/rename")
async def rename_recording(old_filename: str, new_filename: str) -> JSONResponse:
    source = _recording_path(old_filename)
    if not source.exists() or not source.is_file():
        raise HTTPException(status_code=404, detail="Arquivo original nao encontrado.")

    new_safe_name = _safe_recording_name(new_filename)
    target = RECORDINGS_DIR / new_safe_name
    if target.exists():
        raise HTTPException(status_code=409, detail="Ja existe um arquivo com este nome.")

    source.rename(target)
    return JSONResponse({"ok": True, "name": target.name, "url": f"/recordings/{target.name}"})


@app.post("/api/recordings/delete")
async def delete_recording(filename: str) -> JSONResponse:
    target = _recording_path(filename)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Arquivo nao encontrado.")

    target.unlink()
    return JSONResponse({"ok": True, "name": target.name})


@app.post("/api/open-recordings-folder")
async def open_recordings_folder() -> JSONResponse:
    os.startfile(str(RECORDINGS_DIR))
    return JSONResponse({"ok": True, "path": str(RECORDINGS_DIR)})


@app.get("/api/audio-devices")
async def list_audio_devices() -> JSONResponse:
    return JSONResponse({"items": audio_router.list_output_devices()})


@app.get("/api/audio-route")
async def get_audio_route() -> JSONResponse:
    state = audio_router.get_state()
    return JSONResponse(
        {
            "enabled": state.enabled,
            "deviceId": state.device_id,
            "deviceName": state.device_name,
            "channels": state.channels,
            "lastError": state.last_error,
        }
    )


@app.get("/api/driver/status")
async def get_driver_status() -> JSONResponse:
    status = driver_installer.get_status()
    return JSONResponse(
        {
            "installed": status.installed,
            "preferredCount": status.preferred_count,
            "downloadUrl": status.download_url,
            "archivePath": str(status.archive_path),
            "extractDir": str(status.extract_dir),
            "installerPath": str(status.installer_path) if status.installer_path else None,
            "launchReady": status.launch_ready,
            "windowsOnly": status.windows_only,
            "message": status.message,
        }
    )


@app.post("/api/driver/install")
async def install_driver() -> JSONResponse:
    try:
        status = driver_installer.launch_installer()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return JSONResponse(
        {
            "ok": True,
            "installed": status.installed,
            "preferredCount": status.preferred_count,
            "downloadUrl": status.download_url,
            "archivePath": str(status.archive_path),
            "extractDir": str(status.extract_dir),
            "installerPath": str(status.installer_path) if status.installer_path else None,
            "launchReady": status.launch_ready,
            "windowsOnly": status.windows_only,
            "message": "Pacote preparado. Confirme a instalacao do driver no Windows e reinicie o PC ao final.",
        }
    )


@app.post("/api/audio-route/select")
async def select_audio_route(device_id: int, channels: int = 1) -> JSONResponse:
    state = audio_router.enable(device_id, channels=channels)
    return JSONResponse(
        {
            "enabled": state.enabled,
            "deviceId": state.device_id,
            "deviceName": state.device_name,
            "channels": state.channels,
            "lastError": state.last_error,
        }
    )


@app.post("/api/audio-route/disable")
async def disable_audio_route() -> JSONResponse:
    state = audio_router.disable()
    return JSONResponse(
        {
            "enabled": state.enabled,
            "deviceId": state.device_id,
            "deviceName": state.device_name,
            "channels": state.channels,
            "lastError": state.last_error,
        }
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    session_id = None
    role = None
    try:
        hello_raw = await websocket.receive_text()
        hello = json.loads(hello_raw)
        role = hello.get("role")
        session_id = hello.get("sessionId")
        auth_token = str(hello.get("authToken", ""))
        desktop_key = str(hello.get("desktopKey", ""))

        if role not in {"desktop", "mobile"} or not session_id:
            await websocket.send_json({"type": "error", "message": "Handshake invalido."})
            await websocket.close(code=1008)
            return

        if role == "mobile" and mobile_auth_enabled() and not validate_mobile_auth_token(auth_token):
            await websocket.send_json({"type": "error", "message": "Login do celular necessario ou expirado."})
            await websocket.close(code=1008)
            return
        if role == "mobile" and desktop_key != get_desktop_session_key():
            await websocket.send_json({"type": "error", "message": "Chave de pareamento invalida. Escaneie o QR do desktop novamente."})
            await websocket.close(code=1008)
            return

        session = sessions.setdefault(session_id, SessionState())

        if role == "desktop":
            if session.desktop and session.desktop.client_state.name == "CONNECTED":
                await websocket.send_json({"type": "error", "message": "Ja existe um desktop conectado nesta sessao."})
                await websocket.close(code=1008)
                return
            session.desktop = websocket
            await websocket.send_json({"type": "session-ready", "sessionId": session_id})
            if session.mobile:
                await websocket.send_json({"type": "peer-status", "mobileConnected": True})
                await session.mobile.send_json({"type": "peer-status", "desktopConnected": True})
            else:
                await websocket.send_json({"type": "peer-status", "mobileConnected": False})
        else:
            if session.mobile and session.mobile.client_state.name == "CONNECTED":
                await websocket.send_json({"type": "error", "message": "Ja existe um celular transmitindo nesta sessao."})
                await websocket.close(code=1008)
                return
            session.mobile = websocket
            await websocket.send_json({"type": "session-ready", "sessionId": session_id})
            if session.desktop:
                await websocket.send_json({"type": "peer-status", "desktopConnected": True})
                await session.desktop.send_json({"type": "peer-status", "mobileConnected": True})
            else:
                await websocket.send_json({"type": "peer-status", "desktopConnected": False})

        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if role == "mobile" and session.desktop:
                if "bytes" in message and message["bytes"] is not None:
                    pcm_payload = extract_pcm_payload(message["bytes"])
                    audio_router.feed_pcm_bytes(pcm_payload)
                    await session.desktop.send_bytes(message["bytes"])
                elif "text" in message and message["text"] is not None:
                    await session.desktop.send_text(message["text"])
            elif role == "desktop" and session.mobile:
                if "text" in message and message["text"] is not None:
                    await session.mobile.send_text(message["text"])
    except WebSocketDisconnect:
        pass
    finally:
        if session_id and session_id in sessions:
            session = sessions[session_id]
            if role == "desktop" and session.desktop is websocket:
                session.desktop = None
                if session.mobile:
                    await session.mobile.send_json({"type": "peer-status", "desktopConnected": False})
            if role == "mobile" and session.mobile is websocket:
                session.mobile = None
                if session.desktop:
                    await session.desktop.send_json({"type": "peer-status", "mobileConnected": False})
            if not session.desktop and not session.mobile:
                sessions.pop(session_id, None)


if __name__ == "__main__":
    import uvicorn

    local_ip = get_local_ip()
    cert_paths = ensure_local_certificates(CERT_DIR, local_ip)
    print(f"TakeVox HTTPS pronto em {get_desktop_url()}")
    print(f"Abra no celular: https://{local_ip}:{APP_PORT}/mobile")
    print(f"Config em: {CONFIG_PATH}")
    print(f"Instale esta CA no Android: {cert_paths['ca_cert']}")

    uvicorn.run(
        "app:app",
        host=APP_HOST,
        port=APP_PORT,
        reload=False,
        ssl_certfile=str(cert_paths["server_cert"]),
        ssl_keyfile=str(cert_paths["server_key"]),
    )
