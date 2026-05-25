const driverCallout = document.getElementById("driver-callout");
const driverCalloutTitle = document.getElementById("driver-callout-title");
const driverCalloutBody = document.getElementById("driver-callout-body");

function renderDriverCallout(state) {
  if (!driverCallout || !driverCalloutTitle || !driverCalloutBody) {
    return;
  }

  if (state.installed) {
    driverCallout.className = "rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4";
    driverCalloutTitle.textContent = "Adaptador detectado";
    driverCalloutTitle.className = "text-emerald-200";
    driverCalloutBody.textContent = "Um driver virtual compatível já foi detectado neste PC. Você pode usar o TakeVox no navegador e também encaminhar o áudio para apps do Windows pelo painel do desktop.";
    driverCalloutBody.className = "mt-2 leading-6 text-emerald-50";
    return;
  }

  driverCallout.className = "rounded-2xl border border-white/10 bg-white/5 p-4";
  driverCalloutTitle.textContent = "Importante";
  driverCalloutTitle.className = "text-slate-400";
  driverCalloutBody.textContent = "Esta versão entrega áudio ao navegador do PC. Para virar um microfone de sistema no Windows, ainda seria necessário um driver virtual no desktop.";
  driverCalloutBody.className = "mt-2 leading-6";
}

async function refreshDriverCallout() {
  try {
    const response = await fetch("/api/driver/status");
    const data = await response.json();
    renderDriverCallout(data);
  } catch {
    // Keep default copy if status lookup fails.
  }
}

refreshDriverCallout();
