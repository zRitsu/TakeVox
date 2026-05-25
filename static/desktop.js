const sessionLabel = document.getElementById("session-id");
const mobileLinkEl = document.getElementById("mobile-link");
const mobileStatusEl = document.getElementById("mobile-status");
const audioStatusEl = document.getElementById("audio-status");
const newSessionBtn = document.getElementById("new-session");
const unlockAudioBtn = document.getElementById("unlock-audio");
const bufferStatusEl = document.getElementById("buffer-status");
const latencyStatusEl = document.getElementById("latency-status");
const jitterStatusEl = document.getElementById("jitter-status");
const packetLossStatusEl = document.getElementById("packet-loss-status");
const packetOrderStatusEl = document.getElementById("packet-order-status");
const monitorModeStatusEl = document.getElementById("monitor-mode-status");
const monitorModeAutoBtn = document.getElementById("monitor-mode-auto");
const monitorModeLowLatencyBtn = document.getElementById("monitor-mode-low-latency");
const monitorModeStableBtn = document.getElementById("monitor-mode-stable");
const qrImage = document.getElementById("qr-image");
const canvas = document.getElementById("meter");
const ctx = canvas.getContext("2d");
const panelTabs = Array.from(document.querySelectorAll("[data-panel-tab]"));
const panelContents = Array.from(document.querySelectorAll("[data-panel-content]"));
const audioDeviceSelect = document.getElementById("audio-device-select");
const audioChannelsSelect = document.getElementById("audio-channels-select");
const driverPeerDeviceEl = document.getElementById("driver-peer-device");
const refreshDevicesBtn = document.getElementById("refresh-devices-btn");
const enableDriverBtn = document.getElementById("enable-driver-btn");
const disableDriverBtn = document.getElementById("disable-driver-btn");
const driverStatusEl = document.getElementById("driver-status");
const driverInstallStatusEl = document.getElementById("driver-install-status");
const installDriverBtn = document.getElementById("install-driver-btn");
const recordStartBtn = document.getElementById("record-start-btn");
const recordStopBtn = document.getElementById("record-stop-btn");
const recordPreviewCard = document.getElementById("record-preview-card");
const recordingPlayer = document.getElementById("recording-player");
const downloadRecordingBtn = document.getElementById("download-recording-btn");
const saveRecordingBtn = document.getElementById("save-recording-btn");
const recordingNameEl = document.getElementById("recording-name");
const recordingMetaEl = document.getElementById("recording-meta");
const refreshRecordingsBtn = document.getElementById("refresh-recordings-btn");
const openRecordingsFolderBtn = document.getElementById("open-recordings-folder-btn");
const savedRecordingsList = document.getElementById("saved-recordings-list");
const recordingsSearchInput = document.getElementById("recordings-search");
const filenameTemplateInput = document.getElementById("filename-template");
const filenamePaddingInput = document.getElementById("filename-padding");
const localIp = document.body.dataset.localIp || window.location.hostname;
const appPort = document.body.dataset.appPort || window.location.port || "8765";
const appScheme = document.body.dataset.appScheme || "https";

let sessionId = "";
let ws = null;
let audioContext = null;
let playbackNode = null;
let localAudioEnabled = false;
let visualLevel = 0;
let pendingFrames = 0;
let jitterEstimateMs = 0;
let lastPacketTransitMs = null;
let packetTransitBaselineMs = null;
let lastPacketSequence = null;
let packetLossCount = 0;
let packetOutOfOrderCount = 0;
let mobileConnected = false;
let isRecording = false;
let recordingChunks = [];
let recordingObjectUrl = "";
let recordingBlob = null;
let recordingStartedAt = 0;
let recordingFilename = "";
let savedRecordings = [];
let audioDevices = [];
let driverInstallState = null;
let selectedMonitorMode = "auto";
let effectiveMonitorMode = "low-latency";
const sampleRate = 48000;
const driverStorageKeys = {
  deviceId: "takevox.driver.deviceId",
  channels: "takevox.driver.channels",
};
const monitorStorageKey = "takevox.monitor.mode";
const audioPacketHeaderSize = 16;
const audioPacketMagic = "TVX1";

function getMonitorConfig(mode) {
  return mode === "stable"
    ? { minStartSamples: 6144, maxBufferedSamples: 32768 }
    : { minStartSamples: 4096, maxBufferedSamples: 24576 };
}

function applyEffectiveMonitorMode(mode) {
  effectiveMonitorMode = mode === "stable" ? "stable" : "low-latency";
  if (playbackNode) {
    playbackNode.port.postMessage({ type: "config", ...getMonitorConfig(effectiveMonitorMode) });
  }
  if (monitorModeStatusEl) {
    const label = effectiveMonitorMode === "stable" ? "Mais estavel" : "Baixo atraso";
    monitorModeStatusEl.textContent = selectedMonitorMode === "auto" ? `Automatico / ${label}` : label;
  }
}

function setMonitorMode(mode) {
  selectedMonitorMode = mode === "stable" || mode === "low-latency" ? mode : "auto";
  window.localStorage.setItem(monitorStorageKey, selectedMonitorMode);

  const isAuto = selectedMonitorMode === "auto";
  const isLowLatency = selectedMonitorMode === "low-latency";
  const isStable = selectedMonitorMode === "stable";
  monitorModeAutoBtn.className = isAuto
    ? "rounded-2xl border border-cyan-300/30 bg-cyan-300/15 px-4 py-3 text-sm font-semibold text-cyan-100 transition"
    : "rounded-2xl border border-transparent bg-transparent px-4 py-3 text-sm font-semibold text-slate-300 transition";
  monitorModeLowLatencyBtn.className = isLowLatency
    ? "rounded-2xl border border-cyan-300/30 bg-cyan-300/15 px-4 py-3 text-sm font-semibold text-cyan-100 transition"
    : "rounded-2xl border border-transparent bg-transparent px-4 py-3 text-sm font-semibold text-slate-300 transition";
  monitorModeStableBtn.className = isStable
    ? "rounded-2xl border border-cyan-300/30 bg-cyan-300/15 px-4 py-3 text-sm font-semibold text-cyan-100 transition"
    : "rounded-2xl border border-transparent bg-transparent px-4 py-3 text-sm font-semibold text-slate-300 transition";

  if (selectedMonitorMode === "auto") {
    updateAdaptiveMonitorMode();
  } else {
    applyEffectiveMonitorMode(selectedMonitorMode);
  }
}

function updateAdaptiveMonitorMode() {
  if (selectedMonitorMode !== "auto") {
    return;
  }

  const nextMode = effectiveMonitorMode === "stable"
    ? (jitterEstimateMs <= 10 ? "low-latency" : "stable")
    : (jitterEstimateMs >= 18 ? "stable" : "low-latency");
  applyEffectiveMonitorMode(nextMode);
}

function resetMonitorTelemetry() {
  jitterEstimateMs = 0;
  lastPacketTransitMs = null;
  packetTransitBaselineMs = null;
  lastPacketSequence = null;
  packetLossCount = 0;
  packetOutOfOrderCount = 0;
  pendingFrames = 0;
  bufferStatusEl.textContent = "0 samples • 0 ms";
  latencyStatusEl.textContent = "0 ms";
  jitterStatusEl.textContent = "0 ms";
  packetLossStatusEl.textContent = "0";
  packetOrderStatusEl.textContent = "0";
  if (selectedMonitorMode === "auto") {
    applyEffectiveMonitorMode("low-latency");
  }
}

function parseIncomingAudioPacket(buffer) {
  const view = new DataView(buffer);
  const hasHeader =
    buffer.byteLength >= audioPacketHeaderSize
    && String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) === audioPacketMagic;

  if (!hasHeader) {
    return {
      pcm: new Int16Array(buffer),
      sequence: null,
      sentAtMs: null,
    };
  }

  return {
    pcm: new Int16Array(buffer.slice(audioPacketHeaderSize)),
    sequence: view.getUint32(4, true),
    sentAtMs: view.getFloat64(8, true),
  };
}

function updateNetworkJitter(sentAtMs) {
  if (!sentAtMs) {
    return;
  }

  const arrivalMs = Date.now();
  const transitMs = arrivalMs - sentAtMs;
  if (packetTransitBaselineMs === null) {
    packetTransitBaselineMs = transitMs;
  }

  const normalizedTransitMs = transitMs - packetTransitBaselineMs;
  if (lastPacketTransitMs !== null) {
    const variationMs = Math.abs(normalizedTransitMs - lastPacketTransitMs);
    jitterEstimateMs += (variationMs - jitterEstimateMs) / 16;
  }
  lastPacketTransitMs = normalizedTransitMs;
  jitterStatusEl.textContent = `${Math.max(0, Math.round(jitterEstimateMs))} ms`;
  updateAdaptiveMonitorMode();
}

function updatePacketSequenceStats(sequence) {
  if (sequence === null || sequence === undefined) {
    return;
  }

  if (lastPacketSequence === null) {
    lastPacketSequence = sequence;
    return;
  }

  const expectedSequence = (lastPacketSequence + 1) >>> 0;
  if (sequence === expectedSequence) {
    lastPacketSequence = sequence;
  } else if (sequence > expectedSequence) {
    packetLossCount += sequence - expectedSequence;
    lastPacketSequence = sequence;
  } else {
    packetOutOfOrderCount += 1;
  }

  packetLossStatusEl.textContent = String(packetLossCount);
  packetOrderStatusEl.textContent = String(packetOutOfOrderCount);
}

function normalizeVirtualPeerName(name) {
  let peerName = name;
  if (/cable input/i.test(peerName)) {
    peerName = peerName.replace(/cable input/gi, "CABLE Output");
  } else if (/cable in/i.test(peerName)) {
    peerName = peerName.replace(/cable in/gi, "CABLE Output");
  } else if (/input \(vb-audio point\)/i.test(peerName)) {
    peerName = peerName.replace(/input \(vb-audio point\)/gi, "CABLE Output (VB-Audio Point)");
  }
  return peerName;
}

function updateDriverPeerHint() {
  if (!driverPeerDeviceEl) {
    return;
  }
  const selectedId = Number(audioDeviceSelect.value);
  const selectedDevice = audioDevices.find((device) => device.id === selectedId);
  if (!selectedDevice) {
    driverPeerDeviceEl.textContent = "Instale ou habilite um driver virtual compatível, como VB-Cable, para ver o par de entrada correspondente.";
    return;
  }

  const suggestedPeerName = normalizeVirtualPeerName(selectedDevice.name);
  if (suggestedPeerName !== selectedDevice.name) {
    driverPeerDeviceEl.textContent = `Nos outros apps, procure por: ${suggestedPeerName}`;
    return;
  }

  driverPeerDeviceEl.textContent = `Se outro app for capturar este sinal, procure a entrada correspondente a: ${selectedDevice.name}`;
}

function setActivePanel(panelName) {
  panelTabs.forEach((tab) => {
    const isActive = tab.dataset.panelTab === panelName;
    tab.className = isActive
      ? "panel-tab rounded-2xl border border-cyan-300/30 bg-cyan-300/15 px-4 py-3 text-sm font-semibold tracking-[0.15em] text-cyan-100 shadow-[0_0_0_1px_rgba(103,232,249,0.08)] transition"
      : "panel-tab rounded-2xl border border-transparent bg-transparent px-4 py-3 text-sm font-semibold tracking-[0.15em] text-slate-300 transition hover:bg-white/5 hover:text-white";
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  panelContents.forEach((content) => {
    const isActive = content.dataset.panelContent === panelName;
    content.classList.toggle("hidden", !isActive);
  });

  if (panelName === "monitor") {
    requestAnimationFrame(resizeCanvas);
  }
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawMeter() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(0.5, "#155e75");
  gradient.addColorStop(1, "#67e8f9");

  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 24; i += 1) {
    const x = (width / 24) * i;
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(x, 0, 2, height);
  }

  const activeHeight = Math.max(10, height * visualLevel);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, height - activeHeight, width, activeHeight);

  visualLevel *= 0.92;
  requestAnimationFrame(drawMeter);
}

function makeSessionId() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function buildMobileUrl() {
  const url = new URL(`${appScheme}://${localIp}:${appPort}/mobile`);
  url.searchParams.set("session", sessionId);
  if (document.body.dataset.desktopSessionKey) {
    url.searchParams.set("key", document.body.dataset.desktopSessionKey);
  }
  return url.toString();
}

function renderQr(url) {
  qrImage.src = `/qr?data=${encodeURIComponent(url)}`;
}

function formatMobileUrlForDisplay(url) {
  try {
    const parsed = new URL(url);
    const session = parsed.searchParams.get("session") || sessionId;
    return `${parsed.origin}${parsed.pathname}?session=${session}`;
  } catch {
    return url;
  }
}

function renderAudioDevices(devices) {
  audioDevices = devices;
  if (!devices.length) {
    audioDeviceSelect.innerHTML = '<option value="">Nenhum driver virtual compatível encontrado</option>';
    updateDriverPeerHint();
    return;
  }
  audioDeviceSelect.innerHTML = devices
    .map((device) => {
      const details = `${device.name} • ${device.hostapi} • ${device.maxOutputChannels}ch`;
      return `<option value="${device.id}">${details}</option>`;
    })
    .join("");

  const savedDeviceId = window.localStorage.getItem(driverStorageKeys.deviceId);
  const preferredDevice =
    devices.find((device) => device.id === Number(savedDeviceId))
    || devices.find((device) => device.preferred)
    || devices[0];
  if (preferredDevice) {
    audioDeviceSelect.value = String(preferredDevice.id);
  }
  updateDriverPeerHint();
}

function renderAudioRouteState(state) {
  if (state.enabled && state.deviceName) {
    const channelsLabel = state.channels >= 2 ? "estéreo" : "mono";
    driverStatusEl.textContent = `Driver virtual ativo em: ${state.deviceName} • ${channelsLabel} • ${sampleRate} Hz`;
    driverStatusEl.className = "mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100";
  } else if (state.lastError) {
    driverStatusEl.textContent = `Erro no driver virtual: ${state.lastError}`;
    driverStatusEl.className = "mt-4 rounded-2xl border border-rose-300/20 bg-rose-300/10 px-4 py-3 text-sm text-rose-100";
  } else {
    driverStatusEl.textContent = "Driver virtual desativado.";
    driverStatusEl.className = "mt-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300";
  }

  if (state.deviceId !== null && state.deviceId !== undefined) {
    audioDeviceSelect.value = String(state.deviceId);
    window.localStorage.setItem(driverStorageKeys.deviceId, String(state.deviceId));
  }
  if (state.enabled && state.channels) {
    audioChannelsSelect.value = String(state.channels >= 2 ? 2 : 1);
    window.localStorage.setItem(driverStorageKeys.channels, audioChannelsSelect.value);
  }
}

function renderDriverInstallState(state) {
  driverInstallState = state;
  if (state.installed) {
    driverInstallStatusEl.textContent = "Driver virtual compatível detectado. A instalação assistida não é necessária.";
    installDriverBtn.disabled = true;
    installDriverBtn.textContent = "Driver já detectado";
    return;
  }

  if (!state.windowsOnly) {
    driverInstallStatusEl.textContent = "A instalação assistida do driver está disponível apenas no Windows.";
    installDriverBtn.disabled = true;
    installDriverBtn.textContent = "Indisponível";
    return;
  }

  driverInstallStatusEl.textContent = `${state.message} O TakeVox pode baixar o pacote oficial, extrair e abrir o instalador com elevação.`;
  installDriverBtn.disabled = false;
  installDriverBtn.textContent = "Baixar e instalar driver";
}

async function refreshAudioDevices() {
  const response = await fetch("/api/audio-devices");
  const data = await response.json();
  renderAudioDevices(data.items || []);
}

async function refreshAudioRouteState() {
  const response = await fetch("/api/audio-route");
  const data = await response.json();
  renderAudioRouteState(data);
}

async function refreshDriverInstallState() {
  const response = await fetch("/api/driver/status");
  const data = await response.json();
  renderDriverInstallState(data);
}

async function enableDriverRoute() {
  const selected = audioDeviceSelect.value;
  if (!selected) {
    driverStatusEl.textContent = "Selecione um device de saída antes de ativar.";
    return;
  }
  const channels = audioChannelsSelect.value || "1";
  enableDriverBtn.disabled = true;
  enableDriverBtn.textContent = "Ativando...";
  try {
    window.localStorage.setItem(driverStorageKeys.deviceId, selected);
    window.localStorage.setItem(driverStorageKeys.channels, channels);
    const response = await fetch(`/api/audio-route/select?device_id=${encodeURIComponent(selected)}&channels=${encodeURIComponent(channels)}`, { method: "POST" });
    const data = await response.json();
    renderAudioRouteState(data);
  } finally {
    enableDriverBtn.disabled = false;
    enableDriverBtn.textContent = "Ativar driver";
  }
}

async function disableDriverRoute() {
  disableDriverBtn.disabled = true;
  disableDriverBtn.textContent = "Desativando...";
  try {
    const response = await fetch("/api/audio-route/disable", { method: "POST" });
    const data = await response.json();
    renderAudioRouteState(data);
  } finally {
    disableDriverBtn.disabled = false;
    disableDriverBtn.textContent = "Desativar";
  }
}

async function installDriver() {
  installDriverBtn.disabled = true;
  installDriverBtn.textContent = "Preparando...";
  try {
    const response = await fetch("/api/driver/install", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Falha ao preparar a instalação do driver");
    }
    driverInstallStatusEl.textContent = `${data.message} Depois da instalação, reinicie o PC e volte em Atualizar.`;
  } catch (error) {
    driverInstallStatusEl.textContent = error.message;
  } finally {
    await refreshDriverInstallState().catch(() => {});
  }
}

function hydrateDriverPreferences() {
  const savedChannels = window.localStorage.getItem(driverStorageKeys.channels);
  if (savedChannels === "1" || savedChannels === "2") {
    audioChannelsSelect.value = savedChannels;
    return;
  }
  audioChannelsSelect.value = "2";
}

function setRecordingButtons() {
  recordStartBtn.disabled = !mobileConnected || isRecording;
  recordStopBtn.disabled = !isRecording;
}

function formatDuration(seconds) {
  return `${seconds.toFixed(1)}s`;
}

function formatFileSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatModified(ts) {
  return new Date(ts * 1000).toLocaleString("pt-BR");
}

function makeRecordingFilename() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  return `takevox-desktop-${stamp}.wav`;
}

function getFilenameTemplate() {
  const raw = filenameTemplateInput.value.trim();
  return raw || "takevox-desktop.*.wav";
}

function getFilenamePadding() {
  const parsed = Number.parseInt(filenamePaddingInput.value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, 10);
}

function buildConfiguredFilename() {
  const template = getFilenameTemplate();
  if (!template.includes("*")) {
    return template;
  }

  const value = window.prompt("Digite o número para completar o nome do arquivo:", "1");
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("Digite apenas números para o nome do arquivo.");
  }

  const padding = getFilenamePadding();
  const padded = String(Number.parseInt(trimmed, 10)).padStart(padding, "0");
  return template.replace("*", padded);
}

function concatInt16Chunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeWavFromPcm(samples, recordingSampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const channelCount = 1;
  const bitsPerSample = 16;
  const byteRate = recordingSampleRate * channelCount * (bitsPerSample / 8);
  const blockAlign = channelCount * (bitsPerSample / 8);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, recordingSampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(offset, samples[i], true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function renderSavedRecordings(items) {
  const search = recordingsSearchInput.value.trim().toLowerCase();
  const filteredItems = items.filter((item) => item.name.toLowerCase().includes(search));

  if (!items.length) {
    savedRecordingsList.innerHTML = '<div class="rounded-2xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm text-slate-400">Nenhuma gravação salva ainda.</div>';
    return;
  }

  if (!filteredItems.length) {
    savedRecordingsList.innerHTML = '<div class="rounded-2xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm text-slate-400">Nenhum arquivo corresponde ao filtro.</div>';
    return;
  }

  savedRecordingsList.innerHTML = items
    .filter((item) => item.name.toLowerCase().includes(search))
    .slice(0, 6)
    .map((item) => `
      <div class="rounded-2xl border border-white/10 bg-[#07111f] px-4 py-3 transition hover:border-cyan-300/25 hover:bg-[#091528]" data-recording-name="${item.name}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold text-cyan-200">${item.name}</div>
            <div class="mt-1 text-xs uppercase tracking-[0.2em] text-slate-500">${formatModified(item.modifiedAt)}</div>
          </div>
          <div class="text-xs font-medium text-mint">${formatFileSize(item.size)}</div>
        </div>
        <audio class="mt-3 w-full" controls preload="none" src="${item.url}"></audio>
        <div class="mt-3 flex flex-wrap gap-2">
          <a href="${item.url}" target="_blank" class="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/10">
            Abrir arquivo
          </a>
          <a href="${item.url}" download="${item.name}" class="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/10">
            Baixar
          </a>
          <button type="button" data-action="rename" data-name="${item.name}" class="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/10">
            Renomear
          </button>
          <button type="button" data-action="delete" data-name="${item.name}" class="rounded-2xl border border-rose-300/20 bg-rose-300/10 px-3 py-2 text-xs font-semibold text-rose-100 transition hover:bg-rose-300/15">
            Apagar
          </button>
        </div>
      </div>
    `)
    .join("");
}

async function refreshSavedRecordings() {
  const response = await fetch("/api/recordings");
  const data = await response.json();
  savedRecordings = data.items || [];
  renderSavedRecordings(savedRecordings);
}

async function openRecordingsFolder() {
  openRecordingsFolderBtn.disabled = true;
  openRecordingsFolderBtn.textContent = "Abrindo...";
  try {
    const response = await fetch("/api/open-recordings-folder", { method: "POST" });
    if (!response.ok) {
      throw new Error("Falha ao abrir a pasta");
    }
    audioStatusEl.textContent = "Pasta de gravações aberta no Windows";
  } catch (error) {
    audioStatusEl.textContent = error.message;
  } finally {
    openRecordingsFolderBtn.disabled = false;
    openRecordingsFolderBtn.textContent = "Abrir pasta";
  }
}

async function renameRecording(oldName) {
  const suggested = oldName;
  const newName = window.prompt("Digite o novo nome do arquivo:", suggested);
  if (newName === null) {
    return;
  }
  const trimmed = newName.trim();
  if (!trimmed) {
    audioStatusEl.textContent = "Nome inválido para renomear";
    return;
  }

  const response = await fetch(
    `/api/recordings/rename?old_filename=${encodeURIComponent(oldName)}&new_filename=${encodeURIComponent(trimmed)}`,
    { method: "POST" },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Falha ao renomear arquivo");
  }
  await refreshSavedRecordings();
  audioStatusEl.textContent = `Arquivo renomeado para ${trimmed}`;
}

async function deleteRecording(name) {
  const confirmed = window.confirm(`Apagar a gravação "${name}"?`);
  if (!confirmed) {
    return;
  }

  const response = await fetch(`/api/recordings/delete?filename=${encodeURIComponent(name)}`, {
    method: "POST",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Falha ao apagar arquivo");
  }
  await refreshSavedRecordings();
  audioStatusEl.textContent = `Arquivo apagado: ${name}`;
}

function renderRecordingPreview(blob) {
  if (recordingObjectUrl) {
    URL.revokeObjectURL(recordingObjectUrl);
  }
  recordingBlob = blob;
  recordingFilename = makeRecordingFilename();
  recordingObjectUrl = URL.createObjectURL(blob);
  recordingPlayer.src = recordingObjectUrl;
  downloadRecordingBtn.href = recordingObjectUrl;
  downloadRecordingBtn.download = recordingFilename;
  recordingNameEl.textContent = recordingFilename;
  const seconds = Math.max(0, (Date.now() - recordingStartedAt) / 1000);
  recordingMetaEl.textContent = `${formatDuration(seconds)} • ${formatFileSize(blob.size)}`;
  recordPreviewCard.classList.remove("hidden");
}

async function saveRecordingToServer() {
  if (!recordingBlob) {
    audioStatusEl.textContent = "Nenhuma gravação pronta para salvar";
    return;
  }

  let finalFilename;
  try {
    finalFilename = buildConfiguredFilename();
  } catch (error) {
    audioStatusEl.textContent = error.message;
    return;
  }
  if (!finalFilename) {
    audioStatusEl.textContent = "Salvamento cancelado";
    return;
  }

  saveRecordingBtn.disabled = true;
  saveRecordingBtn.textContent = "Salvando...";
  try {
    const response = await fetch(`/api/recordings?filename=${encodeURIComponent(finalFilename)}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: recordingBlob,
    });
    if (!response.ok) {
      throw new Error("Falha ao salvar arquivo");
    }
    recordingFilename = finalFilename;
    downloadRecordingBtn.download = recordingFilename;
    recordingNameEl.textContent = recordingFilename;
    await refreshSavedRecordings();
    audioStatusEl.textContent = "Gravação salva no PC";
  } catch (error) {
    audioStatusEl.textContent = error.message;
  } finally {
    saveRecordingBtn.disabled = false;
    saveRecordingBtn.textContent = "Salvar no PC";
  }
}

function startRecording() {
  recordingChunks = [];
  recordingBlob = null;
  recordingFilename = "";
  recordingStartedAt = Date.now();
  isRecording = true;
  audioStatusEl.textContent = "Gravando no PC a partir do microfone do celular";
  setRecordingButtons();
}

function stopRecording() {
  if (!isRecording) {
    return;
  }
  isRecording = false;
  setRecordingButtons();
  if (!recordingChunks.length) {
    audioStatusEl.textContent = "Nenhum áudio recebido durante a gravação";
    return;
  }
  const merged = concatInt16Chunks(recordingChunks);
  const wavBlob = encodeWavFromPcm(merged, sampleRate);
  renderRecordingPreview(wavBlob);
  audioStatusEl.textContent = "Gravação pronta para preview e salvar";
}

async function ensureAudio() {
  localAudioEnabled = true;
  if (audioContext) {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    unlockAudioBtn.textContent = "Audio ativo";
    return;
  }

  audioContext = new AudioContext({ sampleRate });
  const workletSource = `
    class StreamPlayer extends AudioWorkletProcessor {
      constructor() {
        super();
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.bufferedSamples = 0;
        this.maxBufferedSamples = 48000 / 4;
        this.minStartSamples = 960;
        this.port.onmessage = (event) => {
          if (event.data.type === 'samples') {
            const incoming = new Float32Array(event.data.payload);
            this.queue.push(incoming);
            this.bufferedSamples += incoming.length;

            while (this.bufferedSamples > this.maxBufferedSamples && this.queue.length > 1) {
              const dropped = this.queue.shift();
              if (dropped) {
                this.bufferedSamples -= dropped.length;
              }
            }

            this.port.postMessage({ type: 'buffer-size', value: this.bufferedSamples });
            return;
          }

          if (event.data.type === 'config') {
            if (typeof event.data.minStartSamples === 'number') {
              this.minStartSamples = Math.max(128, event.data.minStartSamples);
            }
            if (typeof event.data.maxBufferedSamples === 'number') {
              this.maxBufferedSamples = Math.max(this.minStartSamples, event.data.maxBufferedSamples);
            }
          }
        };
      }

      process(inputs, outputs) {
        const output = outputs[0][0];
        output.fill(0);

        const totalBuffered = this.bufferedSamples + (this.current ? this.current.length - this.offset : 0);
        if (!this.current && totalBuffered < this.minStartSamples) {
          return true;
        }

        let written = 0;
        while (written < output.length) {
          if (!this.current) {
            this.current = this.queue.shift() || null;
            this.offset = 0;
            if (this.current) {
              this.bufferedSamples -= this.current.length;
            }
            this.port.postMessage({
              type: 'buffer-size',
              value: this.bufferedSamples + (this.current ? this.current.length - this.offset : 0),
            });
          }

          if (!this.current) {
            break;
          }

          const available = this.current.length - this.offset;
          const needed = output.length - written;
          const chunk = Math.min(available, needed);
          output.set(this.current.subarray(this.offset, this.offset + chunk), written);
          written += chunk;
          this.offset += chunk;

          if (this.offset >= this.current.length) {
            this.current = null;
            this.offset = 0;
          }
        }

        this.port.postMessage({
          type: 'buffer-size',
          value: this.bufferedSamples + (this.current ? this.current.length - this.offset : 0),
        });

        return true;
      }
    }

    registerProcessor('stream-player', StreamPlayer);
  `;

  const blob = new Blob([workletSource], { type: "application/javascript" });
  const moduleUrl = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(moduleUrl);
  playbackNode = new AudioWorkletNode(audioContext, "stream-player");
  playbackNode.connect(audioContext.destination);
  applyEffectiveMonitorMode(effectiveMonitorMode);
  playbackNode.port.onmessage = (event) => {
    if (event.data.type === "buffer-size") {
      pendingFrames = Math.max(0, Math.round(event.data.value || 0));
      const milliseconds = Math.round((pendingFrames / sampleRate) * 1000);
      bufferStatusEl.textContent = `${pendingFrames} samples • ${milliseconds} ms`;
      latencyStatusEl.textContent = `${milliseconds} ms`;
    }
  };
  unlockAudioBtn.textContent = "Audio ativo";
  audioStatusEl.textContent = "Saída de áudio habilitada";
}

function connectDesktop(nextSessionId = "") {
  if (ws) {
    ws.close();
  }

  sessionId = nextSessionId || document.body.dataset.desktopSessionId || makeSessionId();
  sessionLabel.textContent = sessionId;
  const mobileUrl = buildMobileUrl();
  mobileLinkEl.textContent = formatMobileUrlForDisplay(mobileUrl);
  mobileLinkEl.title = mobileUrl;
  renderQr(mobileUrl);
  mobileStatusEl.textContent = "Aguardando conexão";
  mobileStatusEl.className = "mt-2 text-xl font-semibold text-amber-300";
  audioStatusEl.textContent = "Pronto para receber";
  mobileConnected = false;
  resetMonitorTelemetry();
  setRecordingButtons();

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ role: "desktop", sessionId }));
  });

  ws.addEventListener("message", async (event) => {
    if (typeof event.data === "string") {
      const data = JSON.parse(event.data);
      if (data.type === "peer-status") {
        mobileConnected = Boolean(data.mobileConnected);
        mobileStatusEl.textContent = mobileConnected ? "Celular conectado" : "Aguardando conexão";
        mobileStatusEl.className = mobileConnected
          ? "mt-2 text-xl font-semibold text-emerald-300"
          : "mt-2 text-xl font-semibold text-amber-300";
        setRecordingButtons();
      }
      if (data.type === "error") {
        audioStatusEl.textContent = data.message;
      }
      return;
    }

    const packet = parseIncomingAudioPacket(event.data);
    updateNetworkJitter(packet.sentAtMs);
    updatePacketSequenceStats(packet.sequence);
    const pcm = packet.pcm;
    const pcmCopy = new Int16Array(pcm);
    if (isRecording) {
      recordingChunks.push(pcmCopy);
    }

    const samples = new Float32Array(pcm.length);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const value = pcm[i] / 32768;
      samples[i] = value;
      peak = Math.max(peak, Math.abs(value));
    }
    visualLevel = Math.max(visualLevel, peak);
    if (localAudioEnabled && playbackNode) {
      playbackNode.port.postMessage({ type: "samples", payload: samples }, [samples.buffer]);
    }
    if (!isRecording) {
      audioStatusEl.textContent = localAudioEnabled
        ? "Recebendo áudio em tempo real"
        : "Recebendo áudio em tempo real com monitor local desativado";
    }
  });

  ws.addEventListener("close", () => {
    mobileConnected = false;
    mobileStatusEl.textContent = "Conexão encerrada";
    mobileStatusEl.className = "mt-2 text-xl font-semibold text-rose-300";
    resetMonitorTelemetry();
    setRecordingButtons();
  });
}

async function createNewDesktopSession() {
  newSessionBtn.disabled = true;
  newSessionBtn.textContent = "Gerando...";
  try {
    const response = await fetch("/api/desktop-session/reset", { method: "POST" });
    const data = await response.json();
    if (!response.ok || !data.sessionId) {
      throw new Error(data.detail || "Falha ao criar nova sessão");
    }
    document.body.dataset.desktopSessionId = data.sessionId;
    document.body.dataset.desktopSessionKey = data.sessionKey || "";
    connectDesktop(data.sessionId);
  } catch (error) {
    audioStatusEl.textContent = error.message;
  } finally {
    newSessionBtn.disabled = false;
    newSessionBtn.textContent = "Nova sessão";
  }
}

newSessionBtn.addEventListener("click", createNewDesktopSession);
unlockAudioBtn.addEventListener("click", ensureAudio);
monitorModeAutoBtn.addEventListener("click", () => setMonitorMode("auto"));
monitorModeLowLatencyBtn.addEventListener("click", () => setMonitorMode("low-latency"));
monitorModeStableBtn.addEventListener("click", () => setMonitorMode("stable"));
panelTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setActivePanel(tab.dataset.panelTab);
  });
});
recordStartBtn.addEventListener("click", startRecording);
recordStopBtn.addEventListener("click", stopRecording);
saveRecordingBtn.addEventListener("click", saveRecordingToServer);
refreshRecordingsBtn.addEventListener("click", refreshSavedRecordings);
openRecordingsFolderBtn.addEventListener("click", openRecordingsFolder);
refreshDevicesBtn.addEventListener("click", async () => {
  try {
    await refreshAudioDevices();
    await refreshAudioRouteState();
    await refreshDriverInstallState();
  } catch (error) {
    driverStatusEl.textContent = error.message;
  }
});
audioDeviceSelect.addEventListener("change", () => {
  if (audioDeviceSelect.value) {
    window.localStorage.setItem(driverStorageKeys.deviceId, audioDeviceSelect.value);
  }
  updateDriverPeerHint();
});
audioChannelsSelect.addEventListener("change", () => {
  window.localStorage.setItem(driverStorageKeys.channels, audioChannelsSelect.value);
});
enableDriverBtn.addEventListener("click", async () => {
  try {
    await enableDriverRoute();
  } catch (error) {
    driverStatusEl.textContent = error.message;
  }
});
disableDriverBtn.addEventListener("click", async () => {
  try {
    await disableDriverRoute();
  } catch (error) {
    driverStatusEl.textContent = error.message;
  }
});
installDriverBtn.addEventListener("click", installDriver);
recordingsSearchInput.addEventListener("input", () => {
  renderSavedRecordings(savedRecordings);
});
savedRecordingsList.addEventListener("click", async (event) => {
  const target = event.target.closest("button[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  const name = target.dataset.name;
  if (!action || !name) {
    return;
  }

  target.disabled = true;
  try {
    if (action === "rename") {
      await renameRecording(name);
    } else if (action === "delete") {
      await deleteRecording(name);
    }
  } catch (error) {
    audioStatusEl.textContent = error.message;
  } finally {
    target.disabled = false;
  }
});
window.addEventListener("resize", resizeCanvas);

recordStopBtn.disabled = true;
setMonitorMode(window.localStorage.getItem(monitorStorageKey) || "auto");
resetMonitorTelemetry();
setActivePanel("driver");
resizeCanvas();
drawMeter();
hydrateDriverPreferences();
refreshAudioDevices()
  .then(refreshAudioRouteState)
  .then(refreshDriverInstallState)
  .catch(() => {
    driverStatusEl.textContent = "Nao foi possivel carregar os devices de áudio.";
  });
refreshSavedRecordings().catch(() => {
  savedRecordingsList.innerHTML = '<div class="rounded-2xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm text-slate-400">Nao foi possivel carregar a lista.</div>';
});
connectDesktop();
