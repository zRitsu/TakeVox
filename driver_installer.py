from __future__ import annotations

import os
import platform
import subprocess
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from audio_router import AudioDriverRouter


DEFAULT_DRIVER_DOWNLOAD_URL = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip"


@dataclass
class DriverInstallStatus:
    installed: bool
    preferred_count: int
    download_url: str
    archive_path: Path
    extract_dir: Path
    installer_path: Path | None
    launch_ready: bool
    windows_only: bool
    message: str


class VirtualDriverInstaller:
    def __init__(self, base_dir: Path, audio_router: AudioDriverRouter, download_url: str = DEFAULT_DRIVER_DOWNLOAD_URL) -> None:
        self._audio_router = audio_router
        self._download_url = download_url
        self._drivers_dir = base_dir / "drivers"
        self._archive_path = self._drivers_dir / Path(download_url).name
        self._extract_dir = self._drivers_dir / "vb-cable"

    def get_status(self) -> DriverInstallStatus:
        preferred_devices = [item for item in self._audio_router.list_output_devices() if item.get("preferred")]
        windows_only = os.name == "nt"
        installer_path = self._resolve_installer_path()
        launch_ready = windows_only and installer_path is not None and installer_path.exists()
        if preferred_devices:
            message = "Driver virtual compativel ja encontrado no Windows."
        elif not windows_only:
            message = "A instalacao assistida do driver foi preparada apenas para Windows."
        elif launch_ready:
            message = "Pacote do driver pronto para instalar."
        else:
            message = "Nenhum driver virtual compativel detectado."

        return DriverInstallStatus(
            installed=bool(preferred_devices),
            preferred_count=len(preferred_devices),
            download_url=self._download_url,
            archive_path=self._archive_path,
            extract_dir=self._extract_dir,
            installer_path=installer_path,
            launch_ready=launch_ready,
            windows_only=windows_only,
            message=message,
        )

    def prepare_download(self) -> DriverInstallStatus:
        if os.name != "nt":
            return self.get_status()

        self._drivers_dir.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(self._download_url, self._archive_path)
        if self._extract_dir.exists():
            for path in sorted(self._extract_dir.rglob("*"), reverse=True):
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    path.rmdir()
            self._extract_dir.rmdir()
        self._extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(self._archive_path) as archive:
            archive.extractall(self._extract_dir)
        return self.get_status()

    def launch_installer(self) -> DriverInstallStatus:
        status = self.get_status()
        if not status.windows_only:
            raise RuntimeError("A instalacao assistida do driver esta disponivel apenas no Windows.")
        if status.installed:
            return status
        if not status.launch_ready or status.installer_path is None:
            status = self.prepare_download()
        installer_path = status.installer_path
        if installer_path is None or not installer_path.exists():
            raise RuntimeError("Nao foi possivel localizar o instalador do driver apos extrair o pacote.")

        command = [
            "powershell",
            "-NoProfile",
            "-Command",
            f"Start-Process -FilePath '{installer_path}' -ArgumentList '-i','-h' -Verb RunAs",
        ]
        subprocess.Popen(command)
        return self.get_status()

    def _resolve_installer_path(self) -> Path | None:
        if not self._extract_dir.exists():
            return None

        machine = platform.machine().lower()
        is_64bits = "64" in machine or "arm" in machine
        preferred_names = ["VBCABLE_Setup_x64.exe"] if is_64bits else ["VBCABLE_Setup.exe"]
        fallback_names = ["VBCABLE_Setup_x64.exe", "VBCABLE_Setup.exe"]

        for name in preferred_names + fallback_names:
            matches = list(self._extract_dir.rglob(name))
            if matches:
                return matches[0]

        return None
