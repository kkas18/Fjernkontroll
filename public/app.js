// Fjern – grensesnittet. Snakker bare med den lokale broen på samme opprinnelse.
import {
  BRIDGE_DOWN, displayName, fallbackColor, favoriteApps, initials, isPrivateIPv4, isValidDevice, newDevices, noticeFor,
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
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function haptic(pattern = 10) {
  navigator.vibrate?.(pattern);
}

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
  $('#deviceMeta').textContent = device ? device.host : '';
  $('#deviceButton').setAttribute('aria-label', device ? `${name}, ${typeLabel(device.type)} på ${device.host}. Bytt TV` : 'Velg TV');
  $('#led').dataset.state = !bridge ? 'err' : ready ? 'ok' : device ? (state.code ? 'err' : 'busy') : 'off';

  const notice = noticeFor(state);
  $('#notice').hidden = !notice.text;
  $('#notice').dataset.tone = notice.tone;
  $('#noticeText').textContent = notice.text;
  $('#noticeAction').hidden = !notice.action;
  $('#noticeAction').textContent = notice.action?.label || '';
  $('#noticeAction').dataset.action = notice.action?.id || '';

  $('#remote').hidden = !device;
  $('#empty').hidden = Boolean(device);
  $('#powerOpen').disabled = !device;
  $('#textOpen').disabled = !device;

  $('#channelRocker').classList.toggle('is-unused', capabilities?.channels === false);
  applyCapabilities(capabilities);

  renderApps();
  announce();
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

// Ikonet hentes fra TV-en via broen. Til det er lastet (eller hvis det mangler) vises forbokstaver.
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
  img.src = `/api/icon/${encodeURIComponent(app.id)}?tv=${encodeURIComponent(state.device?.host || '')}`;
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
  $('#ytSearch').hidden = capabilities?.search !== 'youtube';
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
    $('#appsSheet').close();
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
    $('#devicesSheet').close();
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
    hints.push(state.device?.type === 'lg'
      ? 'Slå på krever at TV-en har vært tilkoblet én gang, og at «Slå på via Wi‑Fi» er aktivert på TV-en.'
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
$$('[data-close]').forEach((el) => el.addEventListener('click', () => $(`#${el.dataset.close}`).close()));

$('#noticeAction').addEventListener('click', (event) => {
  if (!state.device) return;
  if (event.currentTarget.dataset.action === 'repair') connect(state.device, { route: 'repair' });
  else connect(state.device);
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
  $('#renameDialog').close();
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
  $('#removeDialog').close();
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
  $('#manualDialog').close();
  $('#devicesSheet').close();
  connect({ type, host, name: type === 'lg' ? 'LG-TV' : 'Roku' });
});

$('#textOpen').addEventListener('click', () => {
  $('#textDialog').showModal();
  $('#tvText').focus();
});
$('#textBackspace').addEventListener('click', (event) => send('Backspace', event.currentTarget));
// YouTube-modus: søk på mobilen, se resultatene her, og trykk for å spille på TV-en (som casting).
function videoRow(video) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'yt-item';
  button.setAttribute('aria-label', `Spill ${video.title} på TV-en`);
  const thumb = document.createElement('span');
  thumb.className = 'yt-thumb';
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = `/api/ytthumb/${encodeURIComponent(video.id)}`;
  img.addEventListener('error', () => img.remove());
  thumb.append(img);
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
  button.addEventListener('click', async () => {
    haptic();
    button.classList.add('is-playing');
    try {
      await api('ytplay', { id: video.id });
      $('#textDialog').close();
      toast('Spilles på TV-en.');
    } catch (error) {
      button.classList.remove('is-playing');
      toast(error.message);
    }
  });
  li.append(button);
  return li;
}

$('#textForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('#tvText').value.trim();
  if (!query) {
    $('#tvText').focus();
    return;
  }
  $('#tvText').blur(); // skjul mobiltastaturet så resultatene synes
  $('#ytStatus').textContent = `Søker etter «${query}» …`;
  $('#ytResults').replaceChildren();
  try {
    const { videos } = await api('ytsearch', { query });
    $('#ytStatus').textContent = videos.length ? `${videos.length} treff. Trykk på en video for å spille den på TV-en.` : `Ingen treff for «${query}».`;
    $('#ytResults').replaceChildren(...videos.map(videoRow));
  } catch (error) {
    $('#ytStatus').textContent = error.message;
  }
});
// «Skriv på TV» skriver i tekstfeltet som er åpent på TV-en; arket blir stående for mer skriving.
$('#textSend').addEventListener('click', async () => {
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
      $('#inputSheet').close();
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
  $('#powerDialog').close();
  send('PowerOff', $('#powerOpen'));
});
$('#powerOn').addEventListener('click', async () => {
  $('#powerDialog').close();
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
  if (document.querySelector('dialog[open]') || event.target.closest('input, textarea, select')) return;
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
  if (!open) return false;
  open.close();
  return true;
};

if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

state.saved = storage.read('fjern-devices', []).filter(isValidDevice).map((d) => ({ ...d, name: normalizeName(d) }));
const lastSelected = storage.read('fjern-selected', null);
const previous = state.saved.find((d) => `${d.type}:${d.host}` === lastSelected);
render();
if (previous) connect(previous, { userInitiated: false }).then(startPolling);
else startPolling();
