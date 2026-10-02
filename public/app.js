// Fjern – grensesnittet. Snakker bare med den lokale broen på samme opprinnelse.
import {
  addRecent, BRIDGE_DOWN, bundledIcon, DEFAULT_NAMES, displayName, fallbackColor, favoriteApps, initials, isPrivateIPv4, isValidDevice, newDevices, noticeFor,
  normalizeName, rememberDevice, sameDevice, sortApps, toggleFavorite, typeLabel,
} from './logic.js';

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
  code: null,
  capabilities: null,
  apps: [],
  appsFor: null,
  scanning: false,
  connecting: 0,
  announcedReady: null,
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

function persist() {
  storage.write('fjern-devices', state.saved);
  if (state.device) storage.write('fjern-selected', `${state.device.type}:${state.device.host}`);
}

function remember(device) {
  state.saved = rememberDevice(state.saved, device);
  persist();
}

// I Android-appen går kallene direkte til Kotlin-broen i stedet for til Node over HTTP.
const native = window.FjernAndroid;
const nativePending = new Map();
let nativeId = 0;
window.__fjernNative = (id, result) => {
  const resolve = nativePending.get(id);
  if (!resolve) return;
  nativePending.delete(id);
  resolve(result);
};
if (native) document.documentElement.dataset.platform = 'android';

function nativeCall(route, body) {
  return new Promise((resolve, reject) => {
    const id = String(++nativeId);
    const timer = setTimeout(() => {
      nativePending.delete(id);
      reject(new Error('TV-en svarte ikke i tide.'));
    }, 20_000);
    nativePending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    native.request(id, route, body ? JSON.stringify(body) : null);
  });
}

async function api(route, body) {
  if (native) {
    const { status, body: data } = await nativeCall(route, body);
    if (status >= 400) throw new Error(data?.error || 'Noe gikk galt.');
    return data;
  }
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
    throw new Error(BRIDGE_DOWN);
  }
  state.bridge = true;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Noe gikk galt.');
  return data;
}

function applyStatus(status) {
  state.device = status.device || state.device;
  state.ready = Boolean(status.ready);
  state.message = status.state || '';
  state.code = status.code || null;
  state.capabilities = status.capabilities || null;
}

// ---------- Visning ----------

function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  clearTimeout(toastTimer);
  // Åpne ark ligger i nettleserens øverste lag. Meldingen legges der på nytt hver gang, så den havner over dem.
  if (el.showPopover) {
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      el.showPopover();
    } catch { /* popover støttes ikke: vises som før */ }
  }
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    toastTimer = setTimeout(() => { try { el.hidePopover?.(); } catch { /* allerede skjult */ } }, 200);
  }, 3200);
}

function haptic(pattern = 10) {
  navigator.vibrate?.(pattern);
}

// ---------- Ark ----------

// Arkene glir ned når de lukkes, og kan dras ned eller lukkes med et trykk utenfor.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SWIPE_CLOSE_PX = 80;

function closeSheet(dialog) {
  if (!dialog.open || dialog.classList.contains('is-closing')) return;
  if (reducedMotion.matches) {
    dialog.style.transform = '';
    dialog.close();
    return;
  }
  dialog.classList.remove('is-dragging', 'is-settling');
  dialog.classList.add('is-closing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.classList.remove('is-closing');
    dialog.style.transform = '';
    dialog.close();
  };
  dialog.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 260);
}

function enableSheet(dialog) {
  const grip = document.createElement('div');
  grip.className = 'sheet-grip';
  grip.setAttribute('aria-hidden', 'true');
  dialog.prepend(grip);

  // Escape og Android-tilbake lukker med samme animasjon.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSheet(dialog);
  });
  // Trykk på den mørke bakgrunnen (utenfor arket) lukker.
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientY < box.top || event.clientX < box.left || event.clientX > box.right) closeSheet(dialog);
  });

  // Dra ned fra håndtaket eller overskriften.
  let startY = null;
  let offset = 0;
  dialog.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.sheet-grip, .sheet-head');
    if (!handle || event.target.closest('button, input, a') || dialog.scrollTop > 0) return;
    startY = event.clientY;
    offset = 0;
    dialog.setPointerCapture(event.pointerId);
    dialog.classList.remove('is-settling');
    dialog.classList.add('is-dragging');
  });
  dialog.addEventListener('pointermove', (event) => {
    if (startY === null) return;
    offset = Math.max(0, event.clientY - startY);
    dialog.style.transform = `translateY(${offset}px)`;
  });
  const release = () => {
    if (startY === null) return;
    startY = null;
    dialog.classList.remove('is-dragging');
    if (offset > SWIPE_CLOSE_PX) {
      closeSheet(dialog);
      return;
    }
    dialog.classList.add('is-settling');
    dialog.style.transform = '';
  };
  dialog.addEventListener('pointerup', release);
  dialog.addEventListener('pointercancel', release);
}
$$('dialog.sheet').forEach(enableSheet);

// Skjermlesere får beskjed når TV-en blir klar, siden statuslinjen da skjules.
function announce() {
  const key = state.ready && state.device ? `${state.device.type}:${state.device.host}` : null;
  if (key === state.announcedReady) return;
  state.announcedReady = key;
  if (key) $('#announce').textContent = `Tilkoblet ${displayName(state.device, state.saved)}.`;
}

function render() {
  const { device, ready, bridge, capabilities } = state;
  const name = device ? displayName(device, state.saved) : 'Ingen TV';
  $('#deviceName').textContent = name;
  $('#deviceMeta').hidden = !device;
  $('#deviceMeta').textContent = device ? typeLabel(device.type) : '';
  $('#deviceButton').setAttribute('aria-label', device ? `${name}, ${typeLabel(device.type)} på ${device.host}. Bytt TV` : 'Velg TV');
  $('#led').dataset.state = !bridge ? 'err' : ready ? 'ok' : device ? (state.code && state.code !== 'needs-code' ? 'err' : 'busy') : 'off';

  const notice = noticeFor(state);
  $('#notice').hidden = !notice.text;
  $('#notice').dataset.tone = notice.tone;
  $('#noticeText').textContent = notice.text;
  $('#noticeAction').hidden = !notice.action;
  $('#noticeAction').textContent = notice.action?.label || '';
  $('#noticeAction').dataset.action = notice.action?.id || '';

  $('#remote').hidden = !device;
  $('#homeTop').hidden = !device || capabilities?.search !== 'youtube';
  $('#empty').hidden = Boolean(device);
  $('#powerOpen').disabled = !device;
  $('#textOpen').disabled = !device;

  $('#channelRocker').classList.toggle('is-unused', capabilities?.channels === false);
  applyCapabilities(capabilities);

  renderApps();
  announce();
  promptPairing();
}

// Android TV: når boksen viser paringskoden, åpnes kodevinduet av seg selv (én gang per paring).
let pairPrompted = false;
function promptPairing() {
  const waiting = state.code === 'needs-code' && state.device?.type === 'androidtv';
  if (!waiting) {
    pairPrompted = false;
    return;
  }
  if (pairPrompted || document.querySelector('dialog[open]')) return;
  pairPrompted = true;
  openPair();
}

function openPair() {
  $('#pairCode').value = '';
  $('#pairError').hidden = true;
  $('#pairDialog').showModal();
  $('#pairCode').focus();
}

// Favoritter lagres per TV i brukerens rekkefølge.
const deviceKey = (device) => `${device.type}:${device.host}`;
function storedFavorites() {
  return state.device ? storage.read('fjern-favorites', {})[deviceKey(state.device)] : undefined;
}
function saveFavorites(ids) {
  const all = storage.read('fjern-favorites', {});
  all[deviceKey(state.device)] = ids;
  storage.write('fjern-favorites', all);
}

// Ikonet hentes fra TV-en via broen, eller følger med appen (Android TV). Til det er lastet
// (eller hvis det mangler) vises forbokstaver.
function appIcon(app, size = 'm') {
  const box = document.createElement('span');
  box.className = `app-icon ${size}`;
  box.style.setProperty('--app-color', fallbackColor(app));
  box.setAttribute('aria-hidden', 'true');
  box.textContent = initials(app.name);
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = bundledIcon(app) || `/api/icon/${encodeURIComponent(app.id)}?tv=${encodeURIComponent(state.device?.host || '')}`;
  img.addEventListener('load', () => box.classList.add('has-image'));
  img.addEventListener('error', () => img.remove());
  box.append(img);
  return box;
}

function favTile(label, icon, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fav';
  const text = document.createElement('span');
  text.className = 'fav-label';
  text.textContent = label;
  button.append(icon, text);
  button.addEventListener('click', onClick);
  return button;
}

// Taster og funksjoner TV-en ikke har, skjules. Talltaster og fargetaster beholder plassen sin
// (så rutenettet ikke hopper), resten fjernes helt.
function supports(capabilities, cap) {
  if (!capabilities) return false;
  if (cap in capabilities) return Boolean(capabilities[cap]);
  return Array.isArray(capabilities.keys) && capabilities.keys.includes(cap);
}
function applyCapabilities(capabilities) {
  for (const el of $$('[data-cap]')) {
    const ok = supports(capabilities, el.dataset.cap);
    if (el.classList.contains('num')) el.classList.toggle('is-unavailable', !ok);
    else el.hidden = !ok;
  }
  $('.color-keys').hidden = !$$('.color-keys [data-cap]').some((el) => !el.hidden);
}

function renderApps() {
  const visible = state.ready && state.apps.length > 0;
  $('#apps').hidden = !visible;
  if (!visible) return;
  const favorites = favoriteApps(state.apps, storedFavorites());
  const tiles = favorites.map((app) => {
    const tile = favTile(app.name, appIcon(app), () => launch(app, tile));
    return tile;
  });
  const allIcon = document.createElement('span');
  allIcon.className = 'app-icon m all';
  allIcon.setAttribute('aria-hidden', 'true');
  allIcon.append(svgIcon('grid'));
  tiles.push(favTile('Alle apper', allIcon, openAllApps));
  $('#appGrid').replaceChildren(...tiles);
}

function appRow(app, favoriteIds) {
  const li = document.createElement('li');
  li.className = 'app-row';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'app-open';
  const name = document.createElement('span');
  name.textContent = app.name;
  open.append(appIcon(app, 's'), name);
  open.addEventListener('click', () => {
    closeSheet($('#appsSheet'));
    launch(app, null);
  });
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'app-star';
  const isFavorite = favoriteIds.includes(app.id);
  star.setAttribute('aria-pressed', String(isFavorite));
  star.setAttribute('aria-label', isFavorite ? `Fjern ${app.name} fra favoritter` : `Legg ${app.name} til favoritter`);
  star.append(svgIcon('star'));
  star.addEventListener('click', () => {
    saveFavorites(toggleFavorite(state.apps, storedFavorites(), app.id));
    renderAllApps();
    renderApps();
  });
  li.append(open, star);
  return li;
}

function renderAllApps() {
  const favoriteIds = favoriteApps(state.apps, storedFavorites()).map((app) => app.id);
  const { regular, system } = sortApps(state.apps);
  $('#allApps').replaceChildren(...regular.map((app) => appRow(app, favoriteIds)));
  $('#systemApps').replaceChildren(...system.map((app) => appRow(app, favoriteIds)));
  $('#systemAppsTitle').hidden = system.length === 0;
}

function openAllApps() {
  renderAllApps();
  $('#appsSheet').showModal();
}

function deviceItem(device, { stored }) {
  const li = document.createElement('li');
  li.className = 'device-item';

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'device-select';
  if (sameDevice(device, state.device)) select.setAttribute('aria-current', 'true');
  const name = document.createElement('strong');
  name.textContent = displayName(device, state.saved);
  const detail = document.createElement('small');
  detail.className = 'mono';
  detail.textContent = `${typeLabel(device.type)} · ${device.host}`;
  select.append(name, detail);
  select.addEventListener('click', () => {
    closeSheet($('#devicesSheet'));
    connect(device);
  });
  li.append(select);

  if (stored) {
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'device-remove';
    rename.setAttribute('aria-label', `Gi ${displayName(device, state.saved)} nytt navn`);
    rename.append(svgIcon('edit'));
    rename.addEventListener('click', () => askRename(device));
    li.append(rename);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'device-remove';
    remove.setAttribute('aria-label', `Fjern ${device.name}`);
    remove.append(svgIcon('trash'));
    remove.addEventListener('click', () => askRemove(device));
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

  const found = newDevices(state.found, state.saved).map((d) => deviceItem(d, { stored: false }));
  const emptyText = state.scanning ? 'Søker …' : 'Ingen nye TV-er. Trykk Søk, eller legg til med IP.';
  $('#foundList').replaceChildren(...(found.length ? found : [emptyItem(emptyText)]));

  $('#scan').disabled = state.scanning;
  $('#scanLabel').textContent = state.scanning ? 'Søker …' : 'Søk';
}

// ---------- Handlinger ----------

async function loadApps() {
  const key = state.device && `${state.device.type}:${state.device.host}`;
  if (!state.ready || !key || state.appsFor === key) return;
  state.appsFor = key;
  try {
    const { apps } = await api('apps');
    if (state.appsFor === key) state.apps = apps || [];
  } catch {
    state.apps = [];
  }
  render();
}

async function connect(device, { userInitiated = true, route = 'connect' } = {}) {
  if (userInitiated) haptic();
  const attempt = ++state.connecting;
  state.device = device;
  state.ready = false;
  state.code = null;
  state.apps = [];
  state.appsFor = null;
  state.message = `Kobler til ${device.name} …`;
  render();
  try {
    const answer = await api(route, route === 'connect' ? { device } : {});
    if (attempt !== state.connecting) return;
    applyStatus(answer);
    persist();
    if (state.ready) remember(state.device);
  } catch (error) {
    if (attempt !== state.connecting) return;
    state.ready = false;
    state.message = error.message;
  } finally {
    if (attempt === state.connecting) state.connecting = 0;
    render();
    loadApps();
  }
}

async function refreshStatus() {
  if (state.connecting) return;
  try {
    const status = await api('status');
    if (state.connecting) return;
    if (status.device) {
      applyStatus(status);
      const saved = state.saved.find((d) => sameDevice(d, status.device));
      // Nytt navn fra TV-en (f.eks. modellnavn) oppdaterer listen, men aldri brukerens eget navn.
      if (status.ready && (!saved || saved.name !== normalizeName(status.device))) remember(status.device);
    } else if (state.device) {
      // Broen er startet på nytt og har glemt TV-en. Behold valget og tilby ny tilkobling.
      state.ready = false;
      state.code = 'unreachable';
      state.message = 'Broen er startet på nytt.';
    }
  } catch {
    state.ready = false;
  }
  render();
  loadApps();
}

function flash(button, className, ms) {
  if (!button) return;
  button.classList.remove('is-sent', 'is-failed');
  button.classList.add(className);
  setTimeout(() => button.classList.remove(className), ms);
}

const inFlight = new Set();
async function send(key, button, { requireReady = true } = {}) {
  if (!state.device) return false;
  if (requireReady && !state.ready) {
    toast(state.message || 'TV-en er ikke tilkoblet ennå.');
    flash(button, 'is-failed', 600);
    return false;
  }
  if (inFlight.has(key)) return false; // unngå kø når en knapp holdes inne
  inFlight.add(key);
  try {
    await api('command', { key });
    flash(button, 'is-sent', 160);
    return true;
  } catch (error) {
    haptic([20, 40, 20]);
    flash(button, 'is-failed', 600);
    toast(error.message);
    refreshStatus();
    return false;
  } finally {
    inFlight.delete(key);
  }
}

async function launch(app, button) {
  haptic();
  try {
    await api('launch', { id: app.id });
    flash(button, 'is-sent', 200);
    if (state.nowPlaying) {
      state.nowPlaying = null;
      renderNowPlaying();
    }
    // Engangshint: YouTube på TV-en er tungvint å søke i med fjernkontrollen.
    if (/youtube/i.test(app.name) && !storage.read('fjern-hint-yt', false)) {
      storage.write('fjern-hint-yt', true);
      setTimeout(() => toast('Tips: Søk enklere fra mobilen med «Søk på YouTube» øverst.'), 600);
    }
  } catch (error) {
    flash(button, 'is-failed', 600);
    toast(error.message);
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
    state.found = (answer.devices || []).filter(isValidDevice);
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

let renaming = null;
function askRename(device) {
  renaming = device;
  $('#renameInput').value = state.saved.find((d) => sameDevice(d, device))?.customName || '';
  $('#renameDialog').showModal();
  $('#renameInput').focus();
}

let removing = null;
function askRemove(device) {
  removing = device;
  $('#removeText').textContent = `${displayName(device, state.saved)} fjernes fra listen. Du kan legge den til igjen senere.`;
  $('#removeDialog').showModal();
}

function openPower() {
  const caps = state.capabilities || {};
  $('#powerOn').disabled = !caps.powerOn;
  $('#powerOff').disabled = !state.ready;
  const hints = [];
  if (!caps.powerOn) {
    const type = state.device?.type;
    hints.push(type === 'lg'
      ? 'Slå på krever at TV-en har vært tilkoblet én gang, og at «Slå på via Wi‑Fi» er aktivert på TV-en.'
      : type === 'samsung'
        ? 'Slå på krever at TV-en har vært tilkoblet én gang, og at «Slå på med mobil» er aktivert (Innstillinger → Generelt → Nettverk → Ekspertinnstillinger).'
        : type === 'androidtv'
          ? 'Android TV kan bare slås på mens appen er koblet til den. Bruk fjernkontrollen eller TV-en.'
          : 'Denne Roku-enheten kan ikke slås på via nettverket.');
  }
  hints.push('TV-en kan ikke alltid slås på igjen via nettverket etter at den er slått av.');
  $('#powerHint').textContent = hints.join(' ');
  $('#powerDialog').showModal();
}

// ---------- Oppkobling ----------

$$('[data-key]').forEach(bindKey);
$('#deviceButton').addEventListener('click', () => openDevices());
$('#emptyScan').addEventListener('click', () => openDevices({ scanNow: true }));
$('#emptyManual').addEventListener('click', () => $('#manualDialog').showModal());
$('#scan').addEventListener('click', scan);
$('#manualOpen').addEventListener('click', () => $('#manualDialog').showModal());
$$('[data-close]').forEach((el) => el.addEventListener('click', () => closeSheet($(`#${el.dataset.close}`))));

$('#noticeAction').addEventListener('click', (event) => {
  if (!state.device) return;
  const action = event.currentTarget.dataset.action;
  if (action === 'pair') openPair();
  else if (action === 'repair') connect(state.device, { route: 'repair' });
  else connect(state.device);
});

$('#pairCode').addEventListener('input', (event) => {
  // Koden er heksadesimal: store bokstaver, bare 0–9 og A–F.
  const input = event.currentTarget;
  input.value = input.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
  $('#pairError').hidden = true;
});
// Feil vises rett under feltet, der brukeren ser.
function pairError(message) {
  $('#pairError').textContent = message;
  $('#pairError').hidden = false;
}
$('#pairForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('#pairCode').value.trim();
  if (code.length !== 6) {
    pairError('Koden er seks tegn, slik den vises på TV-en.');
    $('#pairCode').focus();
    return;
  }
  const button = $('#pairSubmit');
  button.disabled = true;
  button.textContent = 'Sjekker koden …';
  try {
    applyStatus(await api('pair', { code }));
    closeSheet($('#pairDialog'));
    toast('Paret. Kobler til …');
  } catch (error) {
    pairError(error.message);
    $('#pairCode').select();
  } finally {
    button.disabled = false;
    button.textContent = 'Par';
    render();
  }
});

$('#diagOpen').addEventListener('click', async () => {
  let text;
  try {
    const { about, lines } = await api('diagnostics');
    const status = `Status: ${state.ready ? 'klar' : 'ikke klar'} · ${state.message || '–'} · kode ${state.code || '–'}`;
    const device = state.device ? `TV: ${typeLabel(state.device.type)} ${state.device.host}` : 'TV: ingen valgt';
    text = [about, device, status, '', ...(lines.length ? lines : ['(ingen hendelser ennå)'])].join('\n');
  } catch (error) {
    text = `Kunne ikke hente loggen: ${error.message}`;
  }
  $('#diagText').textContent = text;
  $('#diagDialog').showModal();
});
$('#diagCopy').addEventListener('click', async () => {
  const text = $('#diagText').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Kopiert.');
  } catch {
    // Reserve: marker teksten slik at brukeren kan kopiere den selv.
    const range = document.createRange();
    range.selectNodeContents($('#diagText'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('Marker teksten og kopier den.');
  }
});

$('#renameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const customName = $('#renameInput').value.trim().slice(0, 40);
  state.saved = state.saved.map((d) => {
    if (!sameDevice(d, renaming)) return d;
    const { customName: _old, ...rest } = d;
    return customName ? { ...rest, customName } : rest;
  });
  persist();
  closeSheet($('#renameDialog'));
  renderLists();
  render();
});

$('#removeConfirm').addEventListener('click', () => {
  if (removing) {
    state.saved = state.saved.filter((d) => !sameDevice(d, removing));
    persist();
    renderLists();
  }
  removing = null;
  closeSheet($('#removeDialog'));
});

$('#manualForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const host = $('#ip').value.trim();
  const type = new FormData(event.target).get('deviceType');
  if (!isPrivateIPv4(host)) {
    toast('Skriv en lokal IP-adresse, for eksempel 192.168.1.42.');
    $('#ip').focus();
    return;
  }
  closeSheet($('#manualDialog'));
  closeSheet($('#devicesSheet'));
  connect({ type, host, name: DEFAULT_NAMES[type] });
});

// «Skriv på TV» ligger i «Mer»; arket byttes uten animasjon så to ark ikke står oppå hverandre.
$('#textOpen').addEventListener('click', () => {
  $('#moreSheet').close();
  $('#textDialog').showModal();
  $('#tvText').focus();
});
$('#textBackspace').addEventListener('click', (event) => send('Backspace', event.currentTarget));
// ---------- YouTube: søk på mobilen, spill av på TV-en ----------

const RECENT_KEY = 'fjern-yt-recent';
const recentSearches = () => addRecent(storage.read(RECENT_KEY, []), '');
const rememberSearch = (query) => {
  storage.write(RECENT_KEY, addRecent(storage.read(RECENT_KEY, []), query));
  renderHomeRecent();
};

// Siste søk vises også på forsiden, i plassen under søkefeltet (bare på høye skjermer, se CSS).
const HOME_RECENT_MAX = 4;
function renderHomeRecent() {
  const list = recentSearches().slice(0, HOME_RECENT_MAX);
  $('#homeRecent').hidden = list.length === 0;
  $('#homeRecent').replaceChildren(...list.map((query) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    const text = document.createElement('span');
    text.textContent = query;
    chip.append(svgIcon('recent'), text);
    chip.setAttribute('aria-label', `Søk på YouTube etter ${query}`);
    chip.addEventListener('click', () => {
      openYouTube({ focus: false });
      $('#ytQuery').value = query;
      runSearch(query);
    });
    return chip;
  }));
}

function renderRecent() {
  const list = recentSearches();
  const showRecent = list.length > 0 && !$('#ytResults').children.length;
  $('#ytRecentBox').hidden = !showRecent;
  $('#ytRecent').replaceChildren(...list.map((query) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = query;
    chip.addEventListener('click', () => {
      $('#ytQuery').value = query;
      runSearch(query);
    });
    return chip;
  }));
}

function thumbnail(id, className) {
  const box = document.createElement('span');
  box.className = className;
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = `/api/ytthumb/${encodeURIComponent(id)}`;
  img.addEventListener('error', () => img.remove());
  box.append(img);
  return box;
}

function videoRow(video) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'yt-item';
  button.setAttribute('aria-label', `Spill ${video.title} på TV-en`);
  const thumb = thumbnail(video.id, 'yt-thumb');
  if (video.duration) {
    const badge = document.createElement('span');
    badge.className = video.duration === 'Direkte' ? 'yt-duration live' : 'yt-duration';
    badge.textContent = video.duration;
    thumb.append(badge);
  }
  const textBox = document.createElement('span');
  textBox.className = 'yt-text';
  const title = document.createElement('span');
  title.className = 'yt-title';
  title.textContent = video.title;
  const meta = document.createElement('span');
  meta.className = 'yt-meta';
  meta.textContent = [video.channel, video.views].filter(Boolean).join(' · ');
  textBox.append(title, meta);
  button.append(thumb, textBox);
  button.addEventListener('click', () => playVideo(video, button));
  li.append(button);
  return li;
}

async function playVideo(video, button) {
  haptic();
  button?.classList.add('is-playing');
  try {
    await api('ytplay', { id: video.id });
    state.nowPlaying = video;
    renderNowPlaying();
    toast('Spilles på TV-en.');
  } catch (error) {
    toast(error.message);
  } finally {
    button?.classList.remove('is-playing');
  }
}

// Søket går mens brukeren skriver: forslag til søkeord etter en kort pause, og treff litt etter.
// Enter, et forslag eller talesøk gir et «fullt» søk som lagres i siste søk og skjuler tastaturet.
const LIVE_MIN_CHARS = 2;
const SUGGEST_DELAY = 200;
const LIVE_DELAY = 550;
const resultCache = new Map();
let searchToken = 0;
let suggestToken = 0;
let suggestTimer = 0;
let liveTimer = 0;

function cacheResults(q, videos) {
  resultCache.delete(q);
  resultCache.set(q, videos);
  if (resultCache.size > 30) resultCache.delete(resultCache.keys().next().value);
}

function hideSuggestions() {
  suggestToken += 1;
  clearTimeout(suggestTimer);
  $('#ytSuggest').hidden = true;
  $('#ytSuggest').replaceChildren();
}

function renderSuggestions(list) {
  $('#ytSuggest').hidden = list.length === 0;
  $('#ytSuggest').replaceChildren(...list.map((text) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yt-suggestion';
    button.setAttribute('aria-label', `Søk etter ${text}`);
    const label = document.createElement('span');
    label.textContent = text;
    button.append(svgIcon('search'), label);
    button.addEventListener('click', () => {
      $('#ytQuery').value = text;
      runSearch(text);
    });
    li.append(button);
    return li;
  }));
}

async function loadSuggestions(q) {
  const token = ++suggestToken;
  try {
    const { suggestions } = await api('ytsuggest', { query: q });
    if (token === suggestToken && $('#ytQuery').value.trim() === q) renderSuggestions((suggestions || []).slice(0, 4));
  } catch {
    // forslag er en bonus; ved feil vises bare ingen
  }
}

async function runSearch(query, { live = false } = {}) {
  const q = query.trim();
  if (!q) return;
  const token = ++searchToken;
  clearTimeout(liveTimer);
  if (!live) {
    hideSuggestions();
    $('#ytQuery').blur(); // skjul mobiltastaturet så resultatene synes
    rememberSearch(q);
  }
  $('#ytRecentBox').hidden = true;
  const show = (videos) => {
    $('#ytStatus').textContent = videos.length ? '' : `Ingen treff for «${q}».`;
    $('#ytResults').replaceChildren(...videos.map(videoRow));
    $('.ytview-body').scrollTop = 0;
  };
  const cached = resultCache.get(q);
  if (cached) return show(cached);
  // Mens brukeren skriver, står forrige treff til de nye kommer (ingen blinking).
  if (!live || !$('#ytResults').children.length) {
    $('#ytResults').replaceChildren();
    $('#ytStatus').textContent = `Søker etter «${q}» …`;
  }
  try {
    const { videos } = await api('ytsearch', { query: q });
    cacheResults(q, videos);
    if (token === searchToken) show(videos);
  } catch (error) {
    if (token === searchToken) $('#ytStatus').textContent = error.message;
  }
}

function onQueryInput() {
  const q = $('#ytQuery').value.trim();
  clearTimeout(suggestTimer);
  clearTimeout(liveTimer);
  if (!q) {
    searchToken += 1;
    hideSuggestions();
    $('#ytResults').replaceChildren();
    $('#ytStatus').textContent = '';
    renderRecent();
    return;
  }
  if (q.length < LIVE_MIN_CHARS) return;
  suggestTimer = setTimeout(() => loadSuggestions(q), SUGGEST_DELAY);
  liveTimer = setTimeout(() => runSearch(q, { live: true }), LIVE_DELAY);
}

// «Spilles nå»: liten linje med det som går på TV-en, både på forsiden og i YouTube-visningen.
function nowBar(target) {
  const video = state.nowPlaying;
  target.hidden = !video;
  if (!video) return target.replaceChildren();
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'nowbar-main';
  open.setAttribute('aria-label', `Spilles nå: ${video.title}`);
  const label = document.createElement('span');
  label.className = 'nowbar-text';
  const small = document.createElement('small');
  small.textContent = 'Spilles nå';
  const title = document.createElement('span');
  title.textContent = video.title;
  label.append(small, title);
  open.append(thumbnail(video.id, 'nowbar-thumb'), label);
  open.addEventListener('click', () => (target.id === 'nowYt' ? closeYouTube() : openYouTube()));
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'nowbar-action';
  play.setAttribute('aria-label', 'Spill av / pause');
  play.append(svgIcon('playpause'));
  play.addEventListener('click', () => send('PlayPause', play));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'nowbar-action';
  close.setAttribute('aria-label', 'Skjul «Spilles nå»');
  close.append(svgIcon('close'));
  close.addEventListener('click', () => {
    state.nowPlaying = null;
    renderNowPlaying();
  });
  target.replaceChildren(open, play, close);
}
function renderNowPlaying() {
  nowBar($('#nowHome'));
  nowBar($('#nowYt'));
}

function openYouTube({ focus = true } = {}) {
  $('#ytView').hidden = false;
  document.body.classList.add('yt-open');
  renderRecent();
  renderNowPlaying();
  if (focus && !$('#ytResults').children.length) $('#ytQuery').focus();
}
function closeYouTube() {
  $('#ytView').hidden = true;
  document.body.classList.remove('yt-open');
}

// Talesøk: Android-appen bruker telefonens talegjenkjenning; Chrome har sin egen.
const voicePending = new Map();
let voiceId = 0;
window.__fjernVoice = (id, text) => {
  const resolve = voicePending.get(id);
  voicePending.delete(id);
  resolve?.(text || '');
};
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceAvailable = Boolean(native?.voiceAvailable?.()) || Boolean(SpeechRecognition);

function listen() {
  if (native?.voiceAvailable?.()) {
    return new Promise((resolve) => {
      const id = String(++voiceId);
      voicePending.set(id, resolve);
      native.voice(id);
    });
  }
  return new Promise((resolve) => {
    const recognition = new SpeechRecognition();
    recognition.lang = 'nb-NO';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => resolve(event.results[0]?.[0]?.transcript || '');
    recognition.onerror = () => resolve('');
    recognition.onend = () => resolve('');
    recognition.start();
  });
}

async function voiceSearch() {
  openYouTube({ focus: false });
  $('#ytStatus').textContent = 'Lytter … si hva du vil se.';
  const text = (await listen()).trim();
  if (!text) {
    $('#ytStatus').textContent = 'Fikk ikke med meg det. Prøv igjen, eller skriv.';
    return;
  }
  $('#ytQuery').value = text;
  runSearch(text);
}

$('#searchOpen').addEventListener('click', (event) => {
  if (event.target.closest('#searchPillMic')) voiceSearch();
  else openYouTube();
});
$('#ytBack').addEventListener('click', closeYouTube);
$('#ytMic').addEventListener('click', voiceSearch);
$('#ytForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch($('#ytQuery').value);
});
$('#ytQuery').addEventListener('input', onQueryInput);
$('#ytRecentClear').addEventListener('click', () => {
  storage.write(RECENT_KEY, []);
  renderRecent();
  renderHomeRecent();
});
renderHomeRecent();
$('#ytMic').hidden = !voiceAvailable;
$('#searchPillMic').hidden = !voiceAvailable;

// ---------- Skriv på TV ----------

// Teksten skrives i feltet som er åpent på TV-en; arket blir stående for mer skriving.
$('#textForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#tvText').value;
  if (!text.trim()) {
    $('#tvText').focus();
    return;
  }
  try {
    await api('text', { text });
    $('#tvText').value = '';
    toast('Tekst sendt til TV-en.');
  } catch (error) {
    toast(error.message);
  }
});
$('#textEnter').addEventListener('click', (event) => send('Enter', event.currentTarget));

$('#numOpen').addEventListener('click', () => $('#numSheet').showModal());
$('#moreOpen').addEventListener('click', () => $('#moreSheet').showModal());
$('#inputOpen').addEventListener('click', async () => {
  const list = $('#inputList');
  list.replaceChildren(emptyItem('Henter innganger …'));
  $('#inputSheet').showModal();
  try {
    const { inputs } = await api('inputs');
    list.replaceChildren(...(inputs.length ? inputs.map(inputRow) : [emptyItem('Fant ingen innganger på TV-en.')]));
  } catch (error) {
    list.replaceChildren(emptyItem(error.message));
  }
});

function inputRow(input) {
  const li = document.createElement('li');
  li.className = 'app-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'app-open';
  if (!input.connected) button.classList.add('is-disconnected');
  const icon = document.createElement('span');
  icon.className = 'app-icon s all';
  icon.setAttribute('aria-hidden', 'true');
  icon.append(svgIcon('hdmi'));
  const name = document.createElement('span');
  name.textContent = input.connected ? input.name : `${input.name} (ikke tilkoblet)`;
  button.append(icon, name);
  button.addEventListener('click', async () => {
    try {
      await api('input', { id: input.id });
      closeSheet($('#inputSheet'));
      toast(`Bytter til ${input.name}.`);
    } catch (error) {
      toast(error.message);
    }
  });
  li.append(button);
  return li;
}

$('#powerOpen').addEventListener('click', openPower);
$('#powerOff').addEventListener('click', () => {
  closeSheet($('#powerDialog'));
  send('PowerOff', $('#powerOpen'));
});
$('#powerOn').addEventListener('click', async () => {
  closeSheet($('#powerDialog'));
  if (await send('PowerOn', $('#powerOpen'), { requireReady: false })) {
    toast('Slår på TV-en …');
    refreshStatus();
  }
});

const KEYBOARD = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Select', Backspace: 'Back',
  '+': 'VolumeUp', '-': 'VolumeDown', m: 'Mute', ' ': 'PlayPause', k: 'PlayPause',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [String(n), `Num${n}`])),
};
document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]') || !$('#ytView').hidden || event.target.closest('input, textarea, select')) return;
  // Enter på en fokusert knapp skal trykke den knappen, ikke sende OK til TV-en.
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('button, summary')) return;
  const key = KEYBOARD[event.key];
  if (key?.startsWith('Num') && !supports(state.capabilities, key)) return;
  if (key && state.device) {
    event.preventDefault();
    send(key, document.querySelector(`[data-key="${key}"]:not([hidden])`));
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

// Android-tilbakeknappen lukker først et åpent ark.
window.__fjernBack = () => {
  const open = document.querySelector('dialog[open]');
  if (open) {
    closeSheet(open);
    return true;
  }
  if (!$('#ytView').hidden) {
    closeYouTube();
    return true;
  }
  return false;
};

if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

state.saved = storage.read('fjern-devices', []).filter(isValidDevice).map((d) => ({ ...d, name: normalizeName(d) }));
const lastSelected = storage.read('fjern-selected', null);
const previous = state.saved.find((d) => `${d.type}:${d.host}` === lastSelected);
render();
if (previous) connect(previous, { userInitiated: false }).then(startPolling);
else startPolling();
