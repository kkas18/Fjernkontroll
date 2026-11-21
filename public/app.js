// Fjern – grensesnittet. Snakker bare med den lokale broen på samme opprinnelse.
// Oppbygging: TV-velger og strøm øverst, tre faner (Fjernkontroll, Apper, YouTube) og en egen
// «Koble til TV»-skjerm som søker, gjenkjenner merket ut fra IP-adressen og veileder per merke.
import {
  addRecent, BRIDGE_DOWN, bundledIcon, DEFAULT_NAMES, displayName, fallbackColor, favoriteApps, favoriteSlots, initials, isFavoriteListFull, isPrivateIPv4, isValidDevice, noticeFor,
  normalizeName, rememberDevice, sameDevice, sortApps, toggleFavorite, typeLabel,
} from './logic.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const POLL_MS = 2500;
const FAST_POLL_MS = 1000;
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 150;

const state = {
  saved: [],
  device: null,
  ready: false,
  bridge: true,
  message: '',
  code: null,
  capabilities: null,
  apps: [],
  appsFor: null,
  connecting: 0,
  announcedReady: null,
  view: 'remote',
  nowPlaying: null,
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

// ---------- Små hjelpere ----------

function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
// Varsel nederst. Med handling (for eksempel «Prøv en annen måte») får det en knapp og står lenger.
function toast(message, action = null) {
  const box = $('#toast');
  box.replaceChildren(el('span', '', message));
  box.classList.toggle('has-action', Boolean(action));
  if (action) {
    const button = el('button', 'toast-action', action.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      hideToast();
      action.run();
    });
    box.append(button);
  }
  clearTimeout(toastTimer);
  // Åpne ark ligger i nettleserens øverste lag. Meldingen legges der på nytt hver gang, så den havner over dem.
  if (box.showPopover) {
    try {
      if (box.matches(':popover-open')) box.hidePopover();
      box.showPopover();
    } catch { /* popover støttes ikke: vises som før */ }
  }
  requestAnimationFrame(() => box.classList.add('show'));
  toastTimer = setTimeout(hideToast, action ? 7000 : 3200);
}
function hideToast() {
  const box = $('#toast');
  clearTimeout(toastTimer);
  box.classList.remove('show');
  toastTimer = setTimeout(() => { try { box.hidePopover?.(); } catch { /* allerede skjult */ } }, 200);
}

function haptic(pattern = 10) {
  navigator.vibrate?.(pattern);
}

function emptyItem(text, tag = 'li') {
  return el(tag, 'list-empty', text);
}

// Merkemerke (farget brikke) for TV-typen, brukt i søkeresultater, TV-listen og tilkoblingen.
const BRAND_SHORT = { roku: 'Roku', lg: 'LG', samsung: 'SAM', androidtv: 'ATV' };
// Undertekst for en TV: merke og adresse (tall med fast bredde) på én linje.
function metaLine(device, extra = '') {
  return el('small', 'tnum', [typeLabel(device.type), device.host, extra].filter(Boolean).join(' · '));
}

function brandBadge(type) {
  const badge = el('span', 'brand-badge', BRAND_SHORT[type] || 'TV');
  badge.dataset.type = type;
  badge.setAttribute('aria-hidden', 'true');
  return badge;
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
const closeAllSheets = () => $$('dialog[open]').forEach((dialog) => dialog.close());

function enableSheet(dialog) {
  const grip = el('div', 'sheet-grip');
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

// ---------- Visning ----------

// Skjermlesere får beskjed når TV-en blir klar, siden merknaden da skjules.
function announce() {
  const key = state.ready && state.device ? `${state.device.type}:${state.device.host}` : null;
  if (key === state.announcedReady) return;
  state.announcedReady = key;
  if (key) $('#announce').textContent = `Tilkoblet ${displayName(state.device, state.saved)}.`;
}

// Kort status under TV-navnet. Detaljer og handlinger står i merknaden under toppen.
function statusWord() {
  if (!state.bridge) return 'Broen svarer ikke';
  if (state.ready) return 'Tilkoblet';
  if (state.connecting) return 'Kobler til …';
  if (state.code === 'needs-code') return 'Venter på kode';
  return 'Ikke tilkoblet';
}

const VIEWS = { remote: '#remote', apps: '#appsView', yt: '#ytView' };

function render() {
  const { device, ready, bridge, capabilities } = state;
  const name = device ? displayName(device, state.saved) : 'Ingen TV valgt';
  $('#deviceName').textContent = name;
  $('#deviceMeta').hidden = !device;
  $('#deviceMeta').textContent = device ? `${typeLabel(device.type)} · ${statusWord()}` : '';
  $('#deviceButton').setAttribute('aria-label', device ? `${name}, ${typeLabel(device.type)} på ${device.host}. Bytt TV` : 'Velg TV');
  $('#led').dataset.state = !bridge ? 'err' : ready ? 'ok' : device ? (state.code && state.code !== 'needs-code' ? 'err' : 'busy') : 'off';

  const notice = noticeFor(state);
  $('#notice').hidden = !notice.text;
  $('#notice').dataset.tone = notice.tone;
  $('#noticeText').textContent = notice.text;
  $('#noticeAction').hidden = !notice.action;
  $('#noticeAction').textContent = notice.action?.label || '';
  $('#noticeAction').dataset.action = notice.action?.id || '';

  // YouTube-fanen finnes bare når TV-en kan spille YouTube.
  const youtube = capabilities?.search === 'youtube' || !capabilities;
  $('.tab[data-view="yt"]').hidden = !youtube;
  if (!youtube && state.view === 'yt') state.view = 'remote';
  for (const [view, selector] of Object.entries(VIEWS)) $(selector).hidden = !device || state.view !== view;
  for (const tab of $$('.tab')) {
    if (tab.dataset.view === state.view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('#tabbar').hidden = !device;
  $('#powerOpen').hidden = !device; // uten TV er det ingenting å slå av eller på
  $('#textOpen').disabled = !device;

  $('#channelRocker').classList.toggle('is-unused', capabilities?.channels === false);
  applyCapabilities(capabilities);
  showNowHome();

  renderApps();
  renderAppsView();
  announce();
  promptPairing();
  renderConnect();
  // Uten valgt TV er tilkoblingsskjermen det eneste som gir mening.
  if (!device && $('#connectView').hidden) openConnect();
}

function switchView(view) {
  if (!VIEWS[view] || view === state.view) return;
  state.view = view;
  render();
  if (view === 'apps') {
    loadInputs();
    $('#appsView').scrollTop = 0;
  }
  if (view === 'yt') {
    renderRecent();
    renderNowPlaying();
  }
}
$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  haptic(6);
  switchView(tab.dataset.view);
}));

// Android TV: når boksen viser paringskoden, åpnes kodefeltet av seg selv (én gang per paring).
let pairPrompted = false;
function promptPairing() {
  const waiting = state.code === 'needs-code' && state.device?.type === 'androidtv';
  if (!waiting) {
    pairPrompted = false;
    return;
  }
  if (pairPrompted || document.querySelector('dialog[open]') || connectState.step === 'pair') return;
  pairPrompted = true;
  openPairFor(state.device);
}

// ---------- Favoritter (raske snarveier på fjernkontrollen) ----------

const deviceKey = (device) => `${device.type}:${device.host}`;
function storedFavorites() {
  return state.device ? storage.read('fjern-favorites', {})[deviceKey(state.device)] : undefined;
}
// Favorittene står på én rad: 4 på vanlige telefoner, 5 på brede. Raden tegnes på nytt når bredden krysser grensen.
const wideQuery = matchMedia('(min-width: 400px)');
const slots = () => favoriteSlots(wideQuery.matches ? 400 : 0);
wideQuery.addEventListener('change', () => {
  renderApps({ force: true });
  renderAppsView();
});
function saveFavorites(ids) {
  const all = storage.read('fjern-favorites', {});
  all[deviceKey(state.device)] = ids;
  storage.write('fjern-favorites', all);
}

// Ikonet hentes fra TV-en via broen, eller følger med appen (Android TV). Til det er lastet
// (eller hvis det mangler) vises forbokstaver.
function appIcon(app, size = 'm') {
  const box = el('span', `app-icon ${size}`, initials(app.name));
  box.style.setProperty('--app-color', fallbackColor(app));
  box.setAttribute('aria-hidden', 'true');
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
  const button = el('button', 'fav');
  button.type = 'button';
  button.append(icon, el('span', 'fav-label', label));
  button.addEventListener('click', onClick);
  return button;
}

// Taster og funksjoner TV-en ikke har, skjules. Talltaster beholder plassen sin (så rutenettet ikke hopper).
function supports(capabilities, cap) {
  if (!capabilities) return false;
  if (cap in capabilities) return Boolean(capabilities[cap]);
  return Array.isArray(capabilities.keys) && capabilities.keys.includes(cap);
}
function applyCapabilities(capabilities) {
  for (const node of $$('[data-cap]')) {
    const ok = supports(capabilities, node.dataset.cap);
    if (node.classList.contains('num')) node.classList.toggle('is-unavailable', !ok);
    else node.hidden = !ok;
  }
  $('.color-keys').hidden = !$$('.color-keys [data-cap]').some((node) => !node.hidden);
}

// Raden tegnes bare på nytt når innholdet faktisk endres (ellers lastes ikonene på nytt hvert 2,5 s,
// og et trykk som faller sammen med en statusoppdatering, går tapt).
let appsKey = '';
function renderApps({ force = false } = {}) {
  const visible = Boolean(state.device) && state.apps.length > 0;
  $('#apps').hidden = !visible;
  // Frakoblet: raden blir stående nedtonet, så oppsettet ikke hopper når forbindelsen kommer tilbake.
  $('#apps').classList.toggle('is-offline', visible && !state.ready);
  if (!visible) {
    appsKey = '';
    return;
  }
  const favorites = favoriteApps(state.apps, storedFavorites(), slots());
  const key = JSON.stringify([deviceKey(state.device), slots(), favorites.map((app) => [app.id, app.name, app.icon || ''])]);
  if (!force && key === appsKey) return;
  appsKey = key;
  const tiles = favorites.map((app) => {
    const tile = favTile(app.name, appIcon(app), () => launch(app, tile));
    return tile;
  });
  const allIcon = el('span', 'app-icon m all');
  allIcon.setAttribute('aria-hidden', 'true');
  allIcon.append(svgIcon('grid'));
  tiles.push(favTile('Alle', allIcon, () => switchView('apps')));
  tiles.at(-1).setAttribute('aria-label', 'Alle apper');
  $('#appGrid').style.setProperty('--slots', String(slots() + 1));
  $('#appGrid').replaceChildren(...tiles);
}

// ---------- Apper-fanen ----------

let appsEdit = false;
let appFilter = '';
let appsViewKey = '';

function appTile(app, isFavorite) {
  const tile = el('button', 'tile');
  tile.type = 'button';
  tile.append(appIcon(app, 'l'), el('span', 'tile-name', app.name));
  if (appsEdit) {
    tile.setAttribute('aria-pressed', String(isFavorite));
    tile.setAttribute('aria-label', isFavorite ? `Fjern ${app.name} fra favoritter` : `Legg ${app.name} til favoritter`);
    const star = el('span', 'tile-star');
    star.setAttribute('aria-hidden', 'true');
    star.append(svgIcon('star'));
    tile.append(star);
  }
  tile.addEventListener('click', () => {
    if (!appsEdit) return launch(app, tile);
    if (!isFavorite && isFavoriteListFull(state.apps, storedFavorites(), slots())) {
      toast(`Fjernkontrollen har plass til ${slots()} favoritter. Fjern en først.`);
      return;
    }
    haptic(6);
    saveFavorites(toggleFavorite(state.apps, storedFavorites(), app.id, slots()));
    renderAppsView({ force: true });
    renderApps();
  });
  return tile;
}

function renderAppsView({ force = false } = {}) {
  const view = $('#appsView');
  if (view.hidden) return;
  view.classList.toggle('is-offline', !state.ready);
  const max = slots();
  const favorites = favoriteApps(state.apps, storedFavorites(), max);
  const key = JSON.stringify([state.device && deviceKey(state.device), state.ready, appsEdit, appFilter, max,
    favorites.map((app) => app.id), state.apps.map((app) => [app.id, app.name, app.icon || ''])]);
  if (!force && key === appsViewKey) return;
  appsViewKey = key;

  const favoriteIds = favorites.map((app) => app.id);
  const q = appFilter.trim().toLowerCase();
  const match = (app) => !q || app.name.toLowerCase().includes(q);
  const { regular, system } = sortApps(state.apps.filter((app) => !favoriteIds.includes(app.id)));
  const others = [...regular, ...system].filter(match);
  const shownFavorites = favorites.filter(match);

  $('#favEdit').hidden = state.apps.length === 0;
  $('#favEdit').textContent = appsEdit ? 'Ferdig' : 'Velg favoritter';
  $('#favEdit').setAttribute('aria-pressed', String(appsEdit));
  $('#appSearchBox').hidden = state.apps.length < 9;
  $('#appsHint').hidden = !appsEdit;
  $('#appsHint').textContent = `Trykk på en app for å legge den til eller fjerne den. Fjernkontrollen har plass til ${max}.`;
  $('#favAppsTitle').textContent = appsEdit ? `Favoritter (${favorites.length} av ${max})` : 'Favoritter';
  $('#favApps').replaceChildren(...(shownFavorites.length
    ? shownFavorites.map((app) => appTile(app, true))
    : [emptyItem(q ? 'Ingen favoritter passer søket.' : 'Ingen ennå. Trykk «Velg favoritter».', 'p')]));
  $('#allAppsTitle').textContent = q ? 'Treff' : 'Alle apper';
  const emptyText = state.apps.length ? 'Ingen apper passer søket.' : state.ready ? 'Henter apper …' : 'Koble til TV-en for å se appene.';
  $('#allApps').replaceChildren(...(others.length ? others.map((app) => appTile(app, false)) : [emptyItem(emptyText, 'p')]));
}

$('#favEdit').addEventListener('click', () => {
  appsEdit = !appsEdit;
  renderAppsView({ force: true });
});
$('#appSearch').addEventListener('input', (event) => {
  appFilter = event.currentTarget.value;
  renderAppsView();
});

// Kilder (HDMI og lignende) står nederst i Apper-fanen.
let inputsFor = null;
async function loadInputs({ force = false } = {}) {
  const show = Boolean(state.device) && state.ready && supports(state.capabilities, 'inputs');
  $('#inputsTitle').hidden = !show;
  $('#inputList').hidden = !show;
  if (!show) return;
  const key = deviceKey(state.device);
  if (!force && inputsFor === key) return;
  inputsFor = key;
  const list = $('#inputList');
  list.replaceChildren(emptyItem('Henter kilder …'));
  try {
    const { inputs } = await api('inputs');
    list.replaceChildren(...(inputs.length ? inputs.map(inputRow) : [emptyItem('Fant ingen kilder på TV-en.')]));
  } catch (error) {
    inputsFor = null;
    list.replaceChildren(emptyItem(error.message));
  }
}

function inputRow(input) {
  const li = el('li');
  const button = el('button', 'input-row');
  button.type = 'button';
  if (!input.connected) button.classList.add('is-disconnected');
  const icon = el('span', 'app-icon all');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(svgIcon('hdmi'));
  button.append(icon, el('span', '', input.connected ? input.name : `${input.name} (ikke tilkoblet)`));
  button.addEventListener('click', async () => {
    haptic();
    try {
      await api('input', { id: input.id });
      toast(`Bytter til ${input.name}.`);
    } catch (error) {
      toast(error.message);
    }
  });
  li.append(button);
  return li;
}

// ---------- TV-er (lagrede) ----------

function deviceItem(device) {
  const li = el('li', 'device-item');
  const select = el('button', 'device-select');
  select.type = 'button';
  if (sameDevice(device, state.device)) select.setAttribute('aria-current', 'true');
  const text = el('span', 'found-text');
  text.append(el('strong', '', displayName(device, state.saved)), metaLine(device));
  select.append(brandBadge(device.type), text);
  select.addEventListener('click', () => {
    closeSheet($('#devicesSheet'));
    if (!sameDevice(device, state.device) || !state.ready) connect(device);
  });

  const rename = el('button', 'device-remove');
  rename.type = 'button';
  rename.setAttribute('aria-label', `Gi ${displayName(device, state.saved)} nytt navn`);
  rename.append(svgIcon('edit'));
  rename.addEventListener('click', () => askRename(device));

  const remove = el('button', 'device-remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Fjern ${displayName(device, state.saved)}`);
  remove.append(svgIcon('trash'));
  remove.addEventListener('click', () => askRemove(device));

  li.append(select, rename, remove);
  return li;
}

function renderSavedList() {
  const saved = state.saved.map(deviceItem);
  $('#savedList').replaceChildren(...(saved.length ? saved : [emptyItem('Ingen lagrede TV-er ennå.')]));
}

function openDevices() {
  renderSavedList();
  $('#devicesSheet').showModal();
}

// ---------- Koble til TV ----------

const connectState = { step: null, target: null, scanning: false, found: [], doneTimer: 0, fastPoll: 0 };
const STEP_IDS = { search: '#stepSearch', manual: '#stepManual', pair: '#stepPair', done: '#stepDone' };
const STEP_TITLES = { search: 'Koble til TV', manual: 'Skriv inn IP-adresse', pair: 'Kobler til', done: 'Tilkoblet' };
// Hva brukeren skal gjøre på TV-en første gang, per merke.
const BRAND_GUIDE = {
  lg: 'Se på TV-en og velg «Godta» når den spør om tilkobling. Det skjer bare første gang.',
  samsung: 'Se på TV-en og velg «Tillat» når den spør. Det skjer bare første gang.',
  androidtv: 'Første gang viser TV-en en kode på seks tegn. Den skriver du inn her.',
  roku: 'Roku kobler til uten godkjenning. Hvis det stopper opp: slå på «Control by mobile apps» i TV-ens innstillinger.',
};

function openConnect({ step = 'search' } = {}) {
  closeAllSheets();
  $('#connectView').hidden = false;
  showStep(step);
  renderConnect();
  if (step === 'search') startScan();
}

function closeConnect() {
  stopFastPoll();
  clearTimeout(connectState.doneTimer);
  connectState.step = null;
  $('#connectView').hidden = true;
}

function showStep(step) {
  connectState.step = step;
  for (const [name, selector] of Object.entries(STEP_IDS)) $(selector).hidden = name !== step;
  $('#connectTitle').textContent = STEP_TITLES[step];
  $('#connectView').classList.toggle('is-first', !state.device && step === 'search');
  if (step !== 'pair') stopFastPoll();
  $('#connectView').scrollTop = 0;
}

// Uten valgt TV kan tilkoblingsskjermen ikke lukkes (det finnes ingenting bak den).
function renderConnect() {
  if ($('#connectView').hidden) return;
  $('#connectView').classList.toggle('is-first', !state.device && connectState.step === 'search');
  if (connectState.step === 'pair') renderPairStep();
}

function startFastPoll() {
  stopFastPoll();
  connectState.fastPoll = setInterval(refreshStatus, FAST_POLL_MS);
}
function stopFastPoll() {
  clearInterval(connectState.fastPoll);
  connectState.fastPoll = 0;
}

async function startScan() {
  if (connectState.scanning) return;
  connectState.scanning = true;
  connectState.found = [];
  $('#connectView').classList.add('is-scanning');
  $('#scanStatus').textContent = 'Søker etter TV-er på Wi‑Fi …';
  $('#scanAgain').disabled = true;
  renderFound();
  try {
    const answer = await api('scan', {});
    connectState.found = (answer.devices || []).filter(isValidDevice);
    const n = connectState.found.length;
    $('#scanStatus').textContent = n
      ? `Fant ${n === 1 ? 'én TV' : `${n} TV-er`}. Trykk på den du vil styre.`
      : state.saved.length
        ? 'Søket fant ingen TV-er. Velg en lagret TV, søk igjen eller skriv inn IP-adressen.'
        : 'Fant ingen TV-er. Søk igjen, eller skriv inn IP-adressen.';
  } catch (error) {
    $('#scanStatus').textContent = error.message;
  } finally {
    connectState.scanning = false;
    $('#connectView').classList.remove('is-scanning');
    $('#scanAgain').disabled = false;
    renderFound();
  }
}

// Funne TV-er først, deretter lagrede som søket ikke fant (de kan likevel være på, for eksempel når
// nettverket stopper søket). TV-en som allerede er i bruk, står ikke i listen.
function renderFound() {
  const found = connectState.found;
  const savedOnly = state.saved.filter((d) => !found.some((f) => sameDevice(f, d)));
  const list = [...found, ...savedOnly].filter((d) => !(state.ready && state.device && sameDevice(d, state.device)));
  const items = list.map((device, index) => {
    const li = el('li');
    const button = el('button', 'found-item');
    button.type = 'button';
    button.style.animationDelay = `${index * 50}ms`;
    const saved = state.saved.find((d) => sameDevice(d, device));
    const text = el('span', 'found-text');
    const where = found.some((f) => sameDevice(f, device)) ? (saved ? 'Lagret' : '') : 'Lagret, ikke funnet nå';
    text.append(el('strong', '', saved ? displayName(saved, state.saved) : device.name), metaLine(device, where));
    button.append(brandBadge(device.type), text, svgIcon('chevron-right'));
    button.addEventListener('click', () => beginConnect(saved ? { ...device, name: saved.name } : device));
    li.append(button);
    return li;
  });
  $('#foundList').replaceChildren(...items);
}

function manualError(message) {
  $('#manualError').textContent = message;
  $('#manualError').hidden = !message;
}

// Brukeren skriver bare IP-adressen; broen finner selv ut hvilket merke TV-en er.
// Finner den ingenting, kan brukeren velge merke selv.
$('#stepManual').addEventListener('submit', async (event) => {
  event.preventDefault();
  const host = $('#ip').value.trim();
  if (!isPrivateIPv4(host)) {
    manualError('Skriv en lokal IP-adresse, for eksempel 192.168.1.42.');
    $('#ip').focus();
    return;
  }
  manualError('');
  const chosen = !$('#typeChoice').hidden && new FormData(event.currentTarget).get('deviceType');
  if (chosen) {
    beginConnect({ type: chosen, host, name: DEFAULT_NAMES[chosen] });
    return;
  }
  const button = $('#manualSubmit');
  button.disabled = true;
  button.textContent = 'Finner TV-en …';
  try {
    const { device } = await api('probe', { host });
    beginConnect(device);
  } catch (error) {
    manualError(`${error.message} Du kan også velge merke selv.`);
    $('#typeChoice').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = $('#typeChoice').hidden ? 'Finn TV-en' : 'Koble til';
  }
});
$('#ip').addEventListener('input', () => manualError(''));

// Viser tilkoblingssteget og kobler til. «repair» glemmer lagret nøkkel/sertifikat først (endret sertifikat).
function beginConnect(device, { route = 'connect' } = {}) {
  haptic();
  connectState.target = device;
  $('#pairCode').value = '';
  $('#pairError').hidden = true;
  showStep('pair');
  startFastPoll();
  connect(device, { userInitiated: false, route });
  renderPairStep();
}
const needsRepair = () => state.code === 'cert-changed' || state.code === 'needs-repair';

// Kodefeltet for Android TV, åpnet fra merknaden eller automatisk når boksen viser koden.
function openPairFor(device) {
  closeAllSheets();
  connectState.target = device;
  $('#connectView').hidden = false;
  showStep('pair');
  startFastPoll();
  renderConnect();
}

let pairFocused = false;
function renderPairStep() {
  const target = connectState.target;
  if (!target) return;
  const badge = brandBadge(target.type);
  badge.id = 'pairBrand';
  $('#pairBrand').replaceWith(badge);
  const isTarget = state.device && sameDevice(state.device, target);
  const name = displayName(target, state.saved);
  const needsCode = isTarget && state.code === 'needs-code';
  const failed = isTarget && !state.connecting && !state.ready && !needsCode && noticeFor(state).tone === 'err';

  if (isTarget && state.ready) {
    showDone(name);
    return;
  }
  $('#pairForm').hidden = !needsCode;
  $('#pairRetry').hidden = !failed;
  $('#pairSpinner').hidden = needsCode || failed;
  if (needsCode) {
    $('#pairTitle').textContent = 'Skriv inn koden';
    $('#pairText').textContent = 'Koden vises nå på TV-skjermen.';
    $('#pairStatus').textContent = '';
    if (!pairFocused) {
      pairFocused = true;
      $('#pairCode').focus();
    }
    return;
  }
  pairFocused = false;
  if (failed) {
    const repair = needsRepair();
    $('#pairTitle').textContent = repair ? 'Må pares på nytt' : 'Fikk ikke kontakt';
    $('#pairText').textContent = state.message || 'TV-en svarte ikke.';
    $('#pairStatus').textContent = repair ? '' : 'Telefonen og TV-en må være på samme Wi‑Fi.';
    $('#pairAgain').textContent = repair ? 'Par på nytt' : 'Prøv igjen';
    return;
  }
  $('#pairTitle').textContent = `Kobler til ${name}`;
  $('#pairText').textContent = BRAND_GUIDE[target.type] || '';
  $('#pairStatus').textContent = isTarget && state.message && !/^Kobler til/.test(state.message) ? state.message : '';
}

function showDone(name) {
  if (connectState.step === 'done') return;
  showStep('done');
  $('#doneTitle').textContent = `Tilkoblet ${name}`;
  haptic([10, 40, 10]);
  connectState.doneTimer = setTimeout(() => {
    closeConnect();
    state.view = 'remote';
    render();
  }, 900);
}

$('#scanAgain').addEventListener('click', startScan);
$('#manualOpen').addEventListener('click', () => {
  showStep('manual');
  $('#typeChoice').hidden = true;
  $('#manualSubmit').textContent = 'Finn TV-en';
  manualError('');
  $('#ip').focus();
});
$('#pairAgain').addEventListener('click', () => {
  const target = connectState.target;
  if (!target) return;
  const repair = needsRepair() && state.device && sameDevice(state.device, target);
  beginConnect(target, { route: repair ? 'repair' : 'connect' });
});
// «Velg en annen TV»: avbryt tilkoblingen og gå tilbake til søket.
$('#pairCancel').addEventListener('click', () => {
  const target = connectState.target;
  connectState.target = null;
  if (target && state.device && sameDevice(target, state.device) && !state.ready) forgetActiveDevice();
  showStep('search');
  render();
  startScan();
});
$('#connectBack').addEventListener('click', () => connectBack());
function connectBack() {
  if (connectState.step === 'manual') {
    showStep('search');
    renderConnect();
    return true;
  }
  if (connectState.step === 'pair') {
    $('#pairCancel').click();
    return true;
  }
  if (state.device) {
    closeConnect();
    return true;
  }
  return false;
}

$('#pairCode').addEventListener('input', (event) => {
  // Koden er heksadesimal: store bokstaver, bare 0–9 og A–F.
  const input = event.currentTarget;
  input.value = input.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
  $('#pairError').hidden = true;
});
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
  } catch (error) {
    pairError(error.message);
    $('#pairCode').select();
  } finally {
    button.disabled = false;
    button.textContent = 'Par';
    render();
  }
});

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
  // Samme TV på nytt (f.eks. «Prøv igjen»): appraden blir stående nedtonet til TV-en svarer.
  if (!state.device || !sameDevice(state.device, device)) {
    state.apps = [];
    inputsFor = null;
  }
  state.device = device;
  state.ready = false;
  state.code = null;
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

// TV-en som er i bruk, glemmes: broen kobler fra, og den kommer ikke tilbake ved neste statusoppdatering.
function forgetActiveDevice() {
  const token = ++state.connecting;
  Object.assign(state, { device: null, ready: false, code: null, message: '', capabilities: null, apps: [], appsFor: null, nowPlaying: null });
  inputsFor = null;
  storage.write('fjern-selected', null);
  api('disconnect', {}).catch(() => {}).finally(() => { if (state.connecting === token) state.connecting = 0; });
  renderNowPlaying();
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

// Én åpning per app om gangen. Tar den tid (Android TV prøver flere lenker), viser flisen «Åpner …».
const launching = new Set();
async function launch(app, button, { retry = false } = {}) {
  if (!state.ready) {
    toast(state.message || 'TV-en er ikke tilkoblet ennå.');
    flash(button, 'is-failed', 600);
    return;
  }
  if (launching.has(app.id)) return;
  launching.add(app.id);
  haptic();
  const label = button?.querySelector('.fav-label, .tile-name');
  const busy = setTimeout(() => {
    button?.classList.add('is-busy');
    button?.setAttribute('aria-busy', 'true');
    if (label) label.textContent = 'Åpner …';
  }, 300);
  try {
    const result = await api('launch', retry ? { id: app.id, retry: true } : { id: app.id });
    flash(button, 'is-sent', 200);
    // Android TV-bokser som ikke melder hvilken app som er åpen: brukeren kan be om neste måte å åpne den på.
    if (result?.verified === false && result.canRetry) {
      toast(`Åpnet ikke ${app.name} seg?`, { label: 'Prøv en annen måte', run: () => launch(app, button, { retry: true }) });
    }
    if (state.nowPlaying) {
      state.nowPlaying = null;
      renderNowPlaying();
    }
  } catch (error) {
    flash(button, 'is-failed', 600);
    toast(error.message);
  } finally {
    clearTimeout(busy);
    launching.delete(app.id);
    button?.classList.remove('is-busy');
    button?.removeAttribute('aria-busy');
    if (label) label.textContent = app.name;
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

// ---------- Berøringsflate ----------

// Sveip gir piltaster (ett steg per 40 px, så et langt sveip gir flere), et kort trykk gir OK.
// Kommandoene sendes i kø, så raske sveip ikke mister steg.
const PAD_KEY = 'fjern-pad-mode';
const SWIPE_STEP_PX = 40;
const TAP_MAX_MS = 450;
let touchQueue = Promise.resolve();
let queued = 0;
function sendQueued(key) {
  if (queued >= 8) return;
  queued += 1;
  touchQueue = touchQueue.then(() => api('command', { key })).catch((error) => toast(error.message)).finally(() => { queued -= 1; });
}

function setPadMode(mode) {
  const touch = mode === 'touch';
  $('#dpad').hidden = touch;
  $('#touchpad').hidden = !touch;
  $('.cluster').classList.toggle('is-touch', touch);
  const toggle = $('#padMode');
  toggle.setAttribute('aria-pressed', String(touch));
  const label = touch ? 'Bytt til piltaster' : 'Bytt til berøringsflate';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  toggle.replaceChildren(svgIcon(touch ? 'dpad' : 'touch'));
  storage.write(PAD_KEY, touch ? 'touch' : 'dpad');
}
$('#padMode').addEventListener('click', () => {
  haptic(6);
  setPadMode($('#touchpad').hidden ? 'touch' : 'dpad');
});

(() => {
  const pad = $('#touchpad');
  const dot = pad.querySelector('.touch-dot');
  let gesture = null;
  const place = (event) => {
    const box = pad.getBoundingClientRect();
    dot.style.transform = `translate(${event.clientX - box.left}px, ${event.clientY - box.top}px)`;
  };
  pad.addEventListener('pointerdown', (event) => {
    if (!state.ready) {
      toast(state.message || 'TV-en er ikke tilkoblet ennå.');
      return;
    }
    pad.setPointerCapture(event.pointerId);
    gesture = { x: event.clientX, y: event.clientY, t: Date.now(), moved: false };
    place(event);
    pad.classList.add('is-active');
  });
  pad.addEventListener('pointermove', (event) => {
    if (!gesture) return;
    place(event);
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_STEP_PX) return;
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'Right' : 'Left') : (dy > 0 ? 'Down' : 'Up');
    sendQueued(key);
    haptic(6);
    gesture.moved = true;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
  });
  const end = (event) => {
    if (!gesture) return;
    if (event.type === 'pointerup' && !gesture.moved && Date.now() - gesture.t < TAP_MAX_MS) {
      sendQueued('Select');
      haptic();
      flash(pad, 'is-sent', 200);
    }
    gesture = null;
    pad.classList.remove('is-active');
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
})();

// ---------- Strøm, navn, fjerning, logg ----------

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

$$('[data-key]').forEach(bindKey);
$('#deviceButton').addEventListener('click', () => openDevices());
$('#addTv').addEventListener('click', () => {
  closeSheet($('#devicesSheet'));
  openConnect();
});
$$('[data-close]').forEach((node) => node.addEventListener('click', () => closeSheet($(`#${node.dataset.close}`))));

$('#noticeAction').addEventListener('click', (event) => {
  if (!state.device) return;
  const action = event.currentTarget.dataset.action;
  if (action === 'pair') openPairFor(state.device);
  else if (action === 'repair') connect(state.device, { route: 'repair' });
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
  closeSheet($('#renameDialog'));
  renderSavedList();
  render();
});

$('#removeConfirm').addEventListener('click', () => {
  if (removing) {
    state.saved = state.saved.filter((d) => !sameDevice(d, removing));
    if (state.device && sameDevice(removing, state.device)) forgetActiveDevice();
    persist();
    renderSavedList();
    render();
  }
  removing = null;
  closeSheet($('#removeDialog'));
});

// «Skriv på TV» ligger i «Mer»; arket byttes uten animasjon så to ark ikke står oppå hverandre.
$('#textOpen').addEventListener('click', () => {
  $('#moreSheet').close();
  $('#textDialog').showModal();
  $('#tvText').focus();
});
$('#textBackspace').addEventListener('click', (event) => send('Backspace', event.currentTarget));
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

$('#moreOpen').addEventListener('click', () => $('#moreSheet').showModal());
$('#numOpen').addEventListener('click', () => {
  $('#moreSheet').close();
  $('#numSheet').showModal();
});
// Kilde: står nederst i Apper-fanen.
$('#inputOpen').addEventListener('click', async () => {
  $('#moreSheet').close();
  switchView('apps');
  await loadInputs({ force: true });
  $('#inputsTitle').scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
});

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

// ---------- YouTube: søk på mobilen, spill av på TV-en ----------

const RECENT_KEY = 'fjern-yt-recent';
const recentSearches = () => addRecent(storage.read(RECENT_KEY, []), '');
const rememberSearch = (query) => {
  storage.write(RECENT_KEY, addRecent(storage.read(RECENT_KEY, []), query));
};

function renderRecent() {
  const list = recentSearches();
  const showRecent = list.length > 0 && !$('#ytResults').children.length;
  $('#ytRecentBox').hidden = !showRecent;
  $('#ytRecent').replaceChildren(...list.map((query) => {
    const chip = el('button', 'chip', query);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      $('#ytQuery').value = query;
      runSearch(query);
    });
    return chip;
  }));
}

function thumbnail(id, className) {
  const box = el('span', className);
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
  const li = el('li');
  const button = el('button', 'yt-item');
  button.type = 'button';
  button.setAttribute('aria-label', `Spill ${video.title} på TV-en`);
  const thumb = thumbnail(video.id, 'yt-thumb');
  if (video.duration) thumb.append(el('span', video.duration === 'Direkte' ? 'yt-duration live' : 'yt-duration', video.duration));
  const textBox = el('span', 'yt-text');
  textBox.append(el('span', 'yt-title', video.title), el('span', 'yt-meta', [video.channel, video.views].filter(Boolean).join(' · ')));
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
    state.nowPlaying = video; // «Spilles nå»-linjen er bekreftelsen
    renderNowPlaying();
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
    const li = el('li');
    const button = el('button', 'yt-suggestion');
    button.type = 'button';
    button.setAttribute('aria-label', `Søk etter ${text}`);
    button.append(svgIcon('search'), el('span', '', text));
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
    if (!live) $('#ytView').scrollTop = 0;
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

// «Spilles nå»: liten linje med det som går på TV-en, både på fjernkontrollen og i YouTube-fanen.
function nowBar(target) {
  const video = state.nowPlaying;
  target.hidden = !video;
  if (!video) return target.replaceChildren();
  const open = el('button', 'nowbar-main');
  open.type = 'button';
  open.setAttribute('aria-label', `Spilles nå: ${video.title}`);
  const label = el('span', 'nowbar-text');
  label.append(el('small', '', 'Spilles nå'), el('span', '', video.title));
  open.append(thumbnail(video.id, 'nowbar-thumb'), label);
  open.addEventListener('click', () => switchView(target.id === 'nowYt' ? 'remote' : 'yt'));
  const play = el('button', 'nowbar-action');
  play.type = 'button';
  play.setAttribute('aria-label', 'Spill av / pause');
  play.append(svgIcon('playpause'));
  play.addEventListener('click', () => send('PlayPause', play));
  const close = el('button', 'nowbar-action');
  close.type = 'button';
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
  showNowHome();
}
// Uten forbindelse kan «Spilles nå» ikke styre noe, og fjernkontrollen trenger plassen til merknaden.
function showNowHome() {
  $('#nowHome').hidden = !state.nowPlaying || !state.ready;
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
  switchView('yt');
  $('#ytStatus').textContent = 'Lytter … si hva du vil se.';
  const text = (await listen()).trim();
  if (!text) {
    $('#ytStatus').textContent = 'Fikk ikke med meg det. Prøv igjen, eller skriv.';
    return;
  }
  $('#ytQuery').value = text;
  runSearch(text);
}

$('#ytMic').addEventListener('click', voiceSearch);
$('#ytForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch($('#ytQuery').value);
});
$('#ytQuery').addEventListener('input', onQueryInput);
$('#ytRecentClear').addEventListener('click', () => {
  storage.write(RECENT_KEY, []);
  renderRecent();
});
$('#ytMic').hidden = !voiceAvailable;

// ---------- Tastatur, status, tilbake ----------

const KEYBOARD = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Select', Backspace: 'Back',
  '+': 'VolumeUp', '-': 'VolumeDown', m: 'Mute', ' ': 'PlayPause', k: 'PlayPause',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [String(n), `Num${n}`])),
};
document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]') || state.view !== 'remote' || !$('#connectView').hidden || event.target.closest('input, textarea, select')) return;
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
  if (document.hidden) {
    clearInterval(pollTimer);
    stopFastPoll();
  } else {
    startPolling();
    if (connectState.step === 'pair') startFastPoll();
  }
});

// Android-tilbakeknappen: først åpent ark, så tilkoblingsskjermen, så tilbake til fjernkontrollen.
window.__fjernBack = () => {
  const open = document.querySelector('dialog[open]');
  if (open) {
    closeSheet(open);
    return true;
  }
  if (!$('#connectView').hidden) return connectBack();
  if (state.view !== 'remote') {
    switchView('remote');
    return true;
  }
  return false;
};

if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

state.saved = storage.read('fjern-devices', []).filter(isValidDevice).map((d) => ({ ...d, name: normalizeName(d) }));
const lastSelected = storage.read('fjern-selected', null);
const previous = state.saved.find((d) => `${d.type}:${d.host}` === lastSelected);
setPadMode(storage.read(PAD_KEY, 'dpad'));
// Forrige TV vises med en gang (og kobles til under), så tilkoblingsskjermen ikke blinker forbi.
if (previous) state.device = previous;
render();
if (previous) connect(previous, { userInitiated: false }).then(startPolling);
else startPolling();
