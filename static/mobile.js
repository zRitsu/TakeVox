const sessionInput = document.getElementById("session-input");
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const authCard = document.getElementById("auth-card");
const passwordInput = document.getElementById("password-input");
const loginBtn = document.getElementById("login-btn");
const forgetDeviceBtn = document.getElementById("forget-device-btn");
const authStatusEl = document.getElementById("auth-status");
const audioSettingsEl = document.getElementById("audio-settings");
const statusEl = document.getElementById("status");
const levelBar = document.getElementById("level-bar");
const levelText = document.getElementById("level-text");

let ws = null;
let stream = null;
let audioContext = null;
let processorNode = null;
let sourceNode = null;
let animationFrame = null;
let analyserNode = null;
let monitorData = null;
let isDisconnecting = false;
let audioPacketSequence = 0;
let mobileAuthRequired = false;
let mobileAuthenticated = false;
let mobileAuthToken = "";
let pairedDesktopKey = "";
let autoReconnectAttempted = false;
let autoReconnectInFlight = false;

const mobileAuthTokenStorageKey = "takevox.mobile.authToken";
const pairedDesktopSessionIdStorageKey = "takevox.mobile.desktopSessionId";
const pairedDesktopSessionKeyStorageKey = "takevox.mobile.desktopSessionKey";
const audioPacketMagic = "TVX1";

function setConnectionButtons(connected) {
  connectBtn.disabled = connected || (mobileAuthRequired && !mobileAuthenticated);
  disconnectBtn.disabled = !connected;
}

function getAudioConstraints() {
  return {
    channelCount: 1,
  };
}

function isLocalhostHost(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function setStatus(text, tone = "amber") {
  const palette = {
    amber: "text-lg font-semibold text-amber-200",
    green: "text-lg font-semibold text-emerald-200",
    red: "text-lg font-semibold text-rose-200",
    cyan: "text-lg font-semibold text-cyan-200",
  };
  statusEl.textContent = text;
  statusEl.className = `mt-2 ${palette[tone] || palette.amber}`;
}

function renderAudioSettings(text, tone = "slate") {
  const palette = {
    slate: "mt-3 text-xs leading-5 text-slate-500",
    green: "mt-3 text-xs leading-5 text-emerald-200",
    amber: "mt-3 text-xs leading-5 text-amber-200",
    red: "mt-3 text-xs leading-5 text-rose-200",
  };
  audioSettingsEl.textContent = text;
  audioSettingsEl.className = palette[tone] || palette.slate;
}

function formatConstraintFlag(label, value) {
  if (value === undefined) {
    return `${label}: ?`;
  }
  return `${label}: ${value ? "on" : "off"}`;
}

function describeTrackSettings(track) {
  if (!track || typeof track.getSettings !== "function") {
    renderAudioSettings("Este navegador nao expoe detalhes do microfone.", "amber");
    return;
  }

  const settings = track.getSettings();
  const parts = [
    "captura direta",
  ];
  if (settings.sampleRate) {
    parts.push(`Hz: ${settings.sampleRate}`);
  }
  if (settings.channelCount) {
    parts.push(`ch: ${settings.channelCount}`);
  }
  if (settings.latency !== undefined) {
    parts.push(`lat: ${Number(settings.latency).toFixed(3)}s`);
  }
  renderAudioSettings(parts.join(" • "), "green");
}

function setAuthStatus(text, tone = "slate") {
  const palette = {
    slate: "text-sm text-slate-400",
    green: "text-sm font-medium text-emerald-200",
    red: "text-sm font-medium text-rose-200",
    cyan: "text-sm font-medium text-cyan-200",
    amber: "text-sm font-medium text-amber-200",
  };
  authStatusEl.textContent = text;
  authStatusEl.className = `mt-3 ${palette[tone] || palette.slate}`;
}

function persistMobileToken(token) {
  mobileAuthToken = token || "";
  if (mobileAuthToken) {
    window.localStorage.setItem(mobileAuthTokenStorageKey, mobileAuthToken);
    return;
  }
  window.localStorage.removeItem(mobileAuthTokenStorageKey);
}

function setAuthState(authenticated) {
  mobileAuthenticated = Boolean(authenticated) || !mobileAuthRequired;
  passwordInput.disabled = mobileAuthenticated || !mobileAuthRequired;
  loginBtn.disabled = mobileAuthenticated || !mobileAuthRequired;
  forgetDeviceBtn.disabled = !mobileAuthRequired || !mobileAuthToken;

  if (!mobileAuthRequired) {
    authCard.classList.add("hidden");
  } else {
    authCard.classList.remove("hidden");
  }

  if (!mobileAuthRequired) {
    setConnectionButtons(Boolean(ws && ws.readyState === WebSocket.OPEN));
    return;
  }

  if (mobileAuthenticated) {
    passwordInput.value = "";
    setAuthStatus("Celular autorizado. O token salvo sera reutilizado automaticamente.", "green");
  } else if (mobileAuthToken) {
    setAuthStatus("O token salvo expirou ou nao e mais valido. Informe a senha novamente.", "amber");
  } else {
    setAuthStatus("Digite a senha para autorizar este celular e salvar um token persistente.", "slate");
  }

  setConnectionButtons(Boolean(ws && ws.readyState === WebSocket.OPEN));
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || "Falha na requisicao");
  }
  return data;
}

async function validateStoredToken() {
  if (!mobileAuthRequired) {
    persistMobileToken("");
    setAuthState(true);
    return true;
  }

  const storedToken = window.localStorage.getItem(mobileAuthTokenStorageKey) || "";
  if (!storedToken) {
    persistMobileToken("");
    setAuthState(false);
    return false;
  }

  const data = await postJson("/api/mobile-auth/validate", { token: storedToken });
  if (data.valid) {
    persistMobileToken(storedToken);
    setAuthState(true);
    return true;
  }

  persistMobileToken("");
  setAuthState(false);
  return false;
}

async function loadMobileAuth() {
  const response = await fetch("/api/mobile-auth/status");
  const data = await response.json();
  mobileAuthRequired = Boolean(data.required);
  if (!mobileAuthRequired) {
    persistMobileToken("");
    setAuthState(true);
    return;
  }

  await validateStoredToken();
}

async function loginMobileAccess() {
  const password = passwordInput.value.trim();
  if (!password) {
    setAuthStatus("Digite a senha de acesso antes de continuar.", "red");
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = "Entrando...";
  try {
    const data = await postJson("/api/mobile-auth/login", { password });
    persistMobileToken(data.token || "");
    setAuthState(true);
    setStatus("Celular autorizado. Agora voce pode conectar ao PC.", "green");
    tryAutoReconnect();
  } catch (error) {
    persistMobileToken("");
    setAuthState(false);
    setAuthStatus(error.message, "red");
  } finally {
    loginBtn.disabled = mobileAuthenticated;
    loginBtn.textContent = "Entrar e lembrar";
  }
}

async function tryAutoReconnect() {
  if (autoReconnectAttempted || autoReconnectInFlight) {
    return;
  }
  if (mobileAuthRequired && !mobileAuthenticated) {
    return;
  }

  const sessionId = getSessionId();
  const storedSessionKey = window.localStorage.getItem(pairedDesktopSessionKeyStorageKey) || "";
  if (!sessionId || sessionId.length < 4 || !storedSessionKey) {
    return;
  }

  pairedDesktopKey = pairedDesktopKey || storedSessionKey;
  autoReconnectInFlight = true;
  try {
    setStatus("Tentando reconectar automaticamente ao desktop pareado...", "cyan");
    await connectSocket();
    autoReconnectAttempted = true;
  } catch (error) {
    setStatus("Toque em Conectar ao PC para liberar o microfone e reconectar.", "amber");
  } finally {
    autoReconnectInFlight = false;
  }
}

function forgetMobileAccess() {
  if (ws && ws.readyState <= 1) {
    disconnectMobile();
  }
  persistMobileToken("");
  setAuthState(false);
  setStatus("Token removido deste celular.", "amber");
}

function getMicrophoneUnavailableMessage() {
  if (!window.isSecureContext && !isLocalhostHost(window.location.hostname)) {
    return "No Android, o navegador so libera microfone em HTTPS ou localhost. Abra esta pagina em HTTPS.";
  }

  return "Este navegador nao disponibiliza acesso ao microfone nesta pagina.";
}

async function requestMicrophoneStream() {
  const audioConstraints = getAudioConstraints();
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    const capturedStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
    const [track] = capturedStream.getAudioTracks();
    if (track) {
      describeTrackSettings(track);
    }
    return capturedStream;
  }

  const legacyGetUserMedia =
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia ||
    navigator.msGetUserMedia;

  if (typeof legacyGetUserMedia === "function") {
    return new Promise((resolve, reject) => {
      legacyGetUserMedia.call(
        navigator,
        {
          audio: audioConstraints,
          video: false,
        },
        resolve,
        reject,
      );
    });
  }

  throw new Error(getMicrophoneUnavailableMessage());
}

function applyQuerySession() {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session");
  const key = params.get("key");
  if (session) {
    sessionInput.value = session.toUpperCase();
    window.localStorage.setItem(pairedDesktopSessionIdStorageKey, session.toUpperCase());
    if (key) {
      pairedDesktopKey = key;
      window.localStorage.setItem(pairedDesktopSessionKeyStorageKey, key);
    }
    setStatus("Sessão preenchida automaticamente", "cyan");
    return;
  }

  const storedSessionId = window.localStorage.getItem(pairedDesktopSessionIdStorageKey) || "";
  const storedSessionKey = window.localStorage.getItem(pairedDesktopSessionKeyStorageKey) || "";
  if (storedSessionId && storedSessionKey) {
    sessionInput.value = storedSessionId.toUpperCase();
    pairedDesktopKey = storedSessionKey;
    setStatus("Celular pareado com o ultimo desktop autorizado", "cyan");
  }
}

function getSessionId() {
  return sessionInput.value.trim().toUpperCase();
}

function resetLevelMeter() {
  levelBar.style.width = "0%";
  levelText.textContent = "0%";
}

function buildAudioPacket(pcmBuffer) {
  const payload = new Uint8Array(pcmBuffer);
  const packet = new ArrayBuffer(16 + payload.byteLength);
  const view = new DataView(packet);
  view.setUint8(0, audioPacketMagic.charCodeAt(0));
  view.setUint8(1, audioPacketMagic.charCodeAt(1));
  view.setUint8(2, audioPacketMagic.charCodeAt(2));
  view.setUint8(3, audioPacketMagic.charCodeAt(3));
  view.setUint32(4, audioPacketSequence, true);
  view.setFloat64(8, Date.now(), true);
  new Uint8Array(packet, 16).set(payload);
  audioPacketSequence = (audioPacketSequence + 1) >>> 0;
  return packet;
}

async function connectSocket() {
  const sessionId = getSessionId();
  if (!sessionId || sessionId.length < 4) {
    setStatus("Digite o código da sessão do PC", "red");
    return;
  }

  if (mobileAuthRequired && !mobileAuthenticated) {
    setStatus("Faça login no celular antes de conectar.", "red");
    return;
  }

  const storedSessionKey = window.localStorage.getItem(pairedDesktopSessionKeyStorageKey) || "";
  if (!pairedDesktopKey && storedSessionKey) {
    pairedDesktopKey = storedSessionKey;
  }
  if (!pairedDesktopKey) {
    setStatus("Escaneie o QR do desktop para parear este celular com uma chave valida.", "red");
    return;
  }

  if (ws && ws.readyState <= 1) {
    return;
  }

  connectBtn.disabled = true;
  setStatus("Abrindo microfone...", "cyan");
  try {
    await startStreaming();
  } catch (error) {
    const message = String(error.message || error);
    if (
      autoReconnectInFlight
      && (
        message.includes("Permission")
        || message.includes("permission")
        || message.includes("gesture")
        || message.includes("NotAllowed")
      )
    ) {
      throw error;
    }
    setStatus(`Erro ao abrir microfone: ${message}`, "red");
    setConnectionButtons(false);
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ role: "mobile", sessionId, authToken: mobileAuthToken, desktopKey: pairedDesktopKey }));
    setStatus("Conectando ao PC...", "cyan");
    setConnectionButtons(true);
  });

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    const data = JSON.parse(event.data);
    if (data.type === "peer-status") {
      if (data.desktopConnected) {
        setStatus("PC conectado. Microfone transmitindo.", "green");
      } else {
        setStatus("PC desconectado. Abra o painel do desktop.", "amber");
      }
    }
    if (data.type === "error") {
      if (data.message.includes("Login do celular")) {
        forgetMobileAccess();
      }
      if (data.message.includes("pareamento")) {
        pairedDesktopKey = "";
        window.localStorage.removeItem(pairedDesktopSessionKeyStorageKey);
      }
      setStatus(data.message, "red");
    }
  });

  ws.addEventListener("close", () => {
    ws = null;
    stopStreaming(false);
    if (!isDisconnecting) {
      setStatus("Conexão encerrada", "red");
    }
    isDisconnecting = false;
    setConnectionButtons(false);
  });
}

function updateLevel() {
  if (!analyserNode || !monitorData) {
    return;
  }
  analyserNode.getFloatTimeDomainData(monitorData);
  let peak = 0;
  let energy = 0;
  for (let i = 0; i < monitorData.length; i += 1) {
    const value = monitorData[i];
    peak = Math.max(peak, Math.abs(value));
    energy += value * value;
  }
  const rms = Math.sqrt(energy / monitorData.length);
  const meterLevel = Math.max(rms * 2.8, peak * 0.45);
  const deadZone = 0.012;
  const normalizedLevel = meterLevel <= deadZone
    ? 0
    : Math.min(1, (meterLevel - deadZone) / (0.35 - deadZone));
  const percent = Math.min(100, Math.round(normalizedLevel * 100));
  levelBar.style.width = `${percent}%`;
  levelText.textContent = `${percent}%`;
  animationFrame = requestAnimationFrame(updateLevel);
}

async function startStreaming() {
  if (stream || audioContext || processorNode) {
    return;
  }

  stream = await requestMicrophoneStream();

  audioContext = new AudioContext({ sampleRate: 48000 });
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const workletSource = `
    class MicSender extends AudioWorkletProcessor {
      constructor() {
        super();
        this.pending = [];
        this.pendingLength = 0;
        this.targetFrames = 2048;
      }

      emitFrame() {
        if (this.pendingLength < this.targetFrames) {
          return;
        }

        const pcm16 = new Int16Array(this.targetFrames);
        let written = 0;

        while (written < this.targetFrames && this.pending.length) {
          const chunk = this.pending[0];
          const take = Math.min(chunk.length, this.targetFrames - written);
          pcm16.set(chunk.subarray(0, take), written);
          written += take;

          if (take === chunk.length) {
            this.pending.shift();
          } else {
            this.pending[0] = chunk.subarray(take);
          }
          this.pendingLength -= take;
        }

        this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
      }

      process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) {
          return true;
        }
        const samples = input[0];
        const pcm16 = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) {
          const value = Math.max(-1, Math.min(1, samples[i]));
          pcm16[i] = value < 0 ? value * 32768 : value * 32767;
        }
        this.pending.push(pcm16);
        this.pendingLength += pcm16.length;

        while (this.pendingLength >= this.targetFrames) {
          this.emitFrame();
        }
        return true;
      }
    }

    registerProcessor('mic-sender', MicSender);
  `;

  const blob = new Blob([workletSource], { type: "application/javascript" });
  const moduleUrl = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(moduleUrl);

  sourceNode = audioContext.createMediaStreamSource(stream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 1024;
  monitorData = new Float32Array(analyserNode.fftSize);
  processorNode = new AudioWorkletNode(audioContext, "mic-sender");

  processorNode.port.onmessage = (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(buildAudioPacket(event.data));
    }
  };

  sourceNode.connect(analyserNode);
  analyserNode.connect(processorNode);

  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;
  processorNode.connect(muteGain);
  muteGain.connect(audioContext.destination);
  updateLevel();
}

function stopStreaming(resetStatus = true) {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  audioPacketSequence = 0;
  resetLevelMeter();
  if (resetStatus) {
    setStatus("Desconectado", "amber");
  }
}

function disconnectMobile() {
  isDisconnecting = true;
  stopStreaming(false);
  if (ws && ws.readyState <= 1) {
    ws.close();
  } else {
    ws = null;
    isDisconnecting = false;
    setConnectionButtons(false);
    setStatus("Desconectado", "amber");
  }
}

connectBtn.addEventListener("click", connectSocket);
disconnectBtn.addEventListener("click", disconnectMobile);
loginBtn.addEventListener("click", loginMobileAccess);
forgetDeviceBtn.addEventListener("click", forgetMobileAccess);
passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loginMobileAccess();
  }
});

setConnectionButtons(false);
applyQuerySession();
loadMobileAuth().catch(() => {
  mobileAuthRequired = true;
  persistMobileToken("");
  setAuthState(false);
  setAuthStatus("Nao foi possivel verificar o token salvo.", "red");
});
setTimeout(() => {
  tryAutoReconnect();
}, 150);

if (!window.isSecureContext && !isLocalhostHost(window.location.hostname)) {
  setStatus("Android exige HTTPS para liberar o microfone nesta URL", "red");
}
