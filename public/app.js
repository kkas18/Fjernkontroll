// Fjern – grensesnittet. Snakker bare med den lokale broen på samme opprinnelse.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const POLL_MS = 2500;
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 150;

const state = {
  saved: [],
  found: [],
  device: null,
  ready: false,
  bridge: true,
  message: '',
  scanning: false,
  connecting: 0,
};

// Lagring kan være blokkert (privat modus, full lagring). Appen skal virke likevel.
const storage = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignorer */ }
  },
};

const sameDevice = (a, b) => Boolean(a && b && a.type === b.type && a.host === b.host);
const isValidDevice = (d) => d && ['roku', 'lg'].includes(d.type) && typeof d.host === 'string';
const typeLabel = (type) => (type === 'lg' ? 'LG webOS' : 'Roku');

function isPrivateIPv4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const [a, b, ...rest] = ip.split('.').map(Number);
  if (![a, b, ...rest].every((n) => n <= 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function persist() {
  storage.write('fjern-devices', state.saved);
  if (state.device) storage.write('fjern-selected', `${state.device.type}:${state.device.host}`);
}

function remember(device) {
  state.saved = [device, ...state.saved.filter((d) => !sameDevice(d, device))];
  persist();
}

async function api(route, body) {
  let response;
  try {
    response = await fetch(`/api/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    state.bridge = false;
    throw new Error('Broen svarer ikke. Start den i Termux med «node server.mjs».');
  }
  state.bridge = true;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Noe gikk galt.');
  return data;
}

// ---------- Visning ----------

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function haptic(ms = 10) {
  navigator.vibrate?.(ms);
}

function render() {
  const { device, ready, bridge } = state;
  $('#deviceName').textContent = device?.name || 'Ingen TV';
  $('#deviceMeta').hidden = !device;
  $('#deviceMeta').textContent = device ? `${typeLabel(device.type)} · ${device.host}` : '';
  $('#deviceButton').setAttribute('aria-label', device ? `${device.name}. Bytt TV` : 'Velg TV');

  const led = !bridge ? 'err' : ready ? 'ok' : device ? 'busy' : 'off';
  $('#led').dataset.state = led;

  const notice = $('#notice');
  let text = '';
  let tone = 'info';
  if (!bridge) {
    text = 'Broen svarer ikke. Start den i Termux med «node server.mjs».';
    tone = 'err';
  } else if (device && !ready) {
    text = state.message || 'Kobler til …';
    tone = /ikke|feil|avvist|frakoblet|kontakt/i.test(text) ? 'err' : 'busy';
  }
  notice.hidden = !text;
  notice.textContent = text;
  notice.dataset.tone = tone;

  $('#remote').hidden = !device;
  $('#empty').hidden = Boolean(device);
  $('#powerOpen').disabled = !device;
  $('#textOpen').disabled = !device;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function deviceItem(device, { stored }) {
  const li = document.createElement('li');
  li.className = 'device-item';

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'device-select';
  if (sameDevice(device, state.device)) select.setAttribute('aria-current', 'true');
  const name = document.createElement('strong');
  name.textContent = device.name;
  const detail = document.createElement('small');
  detail.className = 'mono';
  detail.textContent = `${typeLabel(device.type)} · ${device.host}`;
  select.append(name, detail);
  select.addEventListener('click', () => {
    $('#devicesSheet').close();
    connect(device);
  });
  li.append(select);

  if (stored) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'device-remove';
    remove.setAttribute('aria-label', `Fjern ${device.name}`);
    remove.append(icon('trash'));
    remove.addEventListener('click', () => {
      if (!confirm(`Fjerne ${device.name} fra listen?`)) return;
      state.saved = state.saved.filter((d) => !sameDevice(d, device));
      persist();
      renderLists();
    });
    li.append(remove);
  }
  return li;
}

function emptyItem(text) {
  const li = document.createElement('li');
  li.className = 'list-empty';
  li.textContent = text;
  return li;
}

function renderLists() {
  const saved = state.saved.map((d) => deviceItem(d, { stored: true }));
  $('#savedList').replaceChildren(...(saved.length ? saved : [emptyItem('Ingen lagrede TV-er ennå.')]));

  const fresh = state.found.filter((d) => !state.saved.some((s) => sameDevice(s, d)));
  const found = fresh.map((d) => deviceItem(d, { stored: false }));
  const emptyText = state.scanning ? 'Søker …' : 'Ingen nye TV-er. Trykk Søk, eller legg til med IP.';
  $('#foundList').replaceChildren(...(found.length ? found : [emptyItem(emptyText)]));

  $('#scan').disabled = state.scanning;
  $('#scanLabel').textContent = state.scanning ? 'Søker …' : 'Søk';
}

// ---------- Handlinger ----------

async function connect(device, { userInitiated = true } = {}) {
  if (userInitiated) haptic();
  const attempt = ++state.connecting;
  state.device = device;
  state.ready = false;
  state.message = `Kobler til ${device.name} …`;
  render();
  try {
    const answer = await api('connect', { device });
    if (attempt !== state.connecting) return;
    state.device = answer.device || device;
    state.ready = answer.ready;
    state.message = answer.state;
    persist();
    if (state.ready) remember(state.device);
  } catch (error) {
    if (attempt !== state.connecting) return;
    state.ready = false;
    state.message = error.message;
  } finally {
    if (attempt === state.connecting) state.connecting = 0;
    render();
  }
}

async function refreshStatus() {
  if (state.connecting) return;
  try {
    const status = await api('status');
    if (state.connecting) return;
    if (status.device) {
      state.device = status.device;
      state.ready = status.ready;
      state.message = status.state;
      if (status.ready && !state.saved.some((d) => sameDevice(d, status.device))) remember(status.device);
    } else if (state.device) {
      // Broen er startet på nytt og har glemt TV-en. Behold valget og be brukeren koble til igjen.
      state.ready = false;
      state.message = 'Broen er startet på nytt. Velg TV-en for å koble til igjen.';
    }
  } catch {
    state.ready = false;
  }
  render();
}

function flash(button, className, ms) {
  if (!button) return;
  button.classList.remove('is-sent', 'is-failed');
  button.classList.add(className);
  setTimeout(() => button.classList.remove(className), ms);
}

const inFlight = new Set();
async function send(key, button) {
  if (!state.device) return;
  if (!state.ready) {
    toast(state.message || 'TV-en er ikke tilkoblet ennå.');
    flash(button, 'is-failed', 600);
    return;
  }
  if (inFlight.has(key)) return; // unngå kø når en knapp holdes inne
  inFlight.add(key);
  try {
    await api('command', { key });
    flash(button, 'is-sent', 160);
  } catch (error) {
    haptic([20, 40, 20]);
    flash(button, 'is-failed', 600);
    toast(error.message);
    refreshStatus();
  } finally {
    inFlight.delete(key);
  }
}

// Holdes en navigasjons- eller volumknapp inne, gjentas kommandoen.
function bindKey(button) {
  const key = button.dataset.key;
  const repeat = button.hasAttribute('data-repeat');
  let delay;
  let interval;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(interval);
  };

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    haptic();
    send(key, button);
    if (repeat) {
      delay = setTimeout(() => { interval = setInterval(() => send(key, button), REPEAT_EVERY_MS); }, REPEAT_DELAY_MS);
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, stop);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  // Tastatur og skjermleser utløser click uten pointerdown (detail === 0).
  button.addEventListener('click', (event) => {
    if (event.detail === 0) send(key, button);
  });
}

async function scan() {
  if (state.scanning) return;
  state.scanning = true;
  state.found = [];
  renderLists();
  try {
    const answer = await api('scan', {});
    state.found = answer.devices || [];
    if (!state.found.length) toast('Fant ingen TV. Prøv å legge til med IP.');
  } catch (error) {
    toast(error.message);
  } finally {
    state.scanning = false;
    renderLists();
  }
}

function openDevices({ scanNow = false } = {}) {
  renderLists();
  $('#devicesSheet').showModal();
  if (scanNow) scan();
}

// ---------- Oppkobling ----------

$$('[data-key]').forEach(bindKey);
$('#deviceButton').addEventListener('click', () => openDevices());
$('#emptyScan').addEventListener('click', () => openDevices({ scanNow: true }));
$('#emptyManual').addEventListener('click', () => $('#manualDialog').showModal());
$('#scan').addEventListener('click', scan);
$('#manualOpen').addEventListener('click', () => $('#manualDialog').showModal());
$$('[data-close]').forEach((el) => el.addEventListener('click', () => $(`#${el.dataset.close}`).close()));

$('#manualForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const host = $('#ip').value.trim();
  const type = new FormData(event.target).get('deviceType');
  if (!isPrivateIPv4(host)) {
    toast('Skriv en lokal IP-adresse, for eksempel 192.168.1.42.');
    $('#ip').focus();
    return;
  }
  $('#manualDialog').close();
  $('#devicesSheet').close();
  connect({ type, host, name: `${typeLabel(type)} · ${host}` });
});

$('#textOpen').addEventListener('click', () => {
  $('#textDialog').showModal();
  $('#tvText').focus();
});
$('#textForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#tvText').value.trim();
  if (!text) return;
  $('#textDialog').close();
  try {
    await api('text', { text });
    $('#tvText').value = '';
    toast('Tekst sendt.');
  } catch (error) {
    toast(error.message);
  }
});

$('#powerOpen').addEventListener('click', () => $('#powerDialog').showModal());
$('#powerConfirm').addEventListener('click', () => {
  $('#powerDialog').close();
  send('PowerOff', $('#powerOpen'));
});

const KEYBOARD = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Select', Backspace: 'Back', '+': 'VolumeUp', '-': 'VolumeDown', m: 'Mute' };
document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]') || event.target.closest('input, textarea, select')) return;
  // Enter på en fokusert knapp skal trykke den knappen, ikke sende OK til TV-en.
  if (event.key === 'Enter' && event.target.closest('button, summary')) return;
  const key = KEYBOARD[event.key];
  if (key && state.device) {
    event.preventDefault();
    send(key, document.querySelector(`[data-key="${key}"]`));
  }
});

// Spør bare etter status mens appen er synlig; sparer batteri.
let pollTimer;
function startPolling() {
  clearInterval(pollTimer);
  refreshStatus();
  pollTimer = setInterval(refreshStatus, POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(pollTimer);
  else startPolling();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

state.saved = storage.read('fjern-devices', []).filter(isValidDevice);
const lastSelected = storage.read('fjern-selected', null);
const previous = state.saved.find((d) => `${d.type}:${d.host}` === lastSelected);
render();
if (previous) connect(previous, { userInitiated: false }).then(startPolling);
else startPolling();
