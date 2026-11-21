// Grensesnittest i ekte nettleser, mot en falsk bro (ingen TV trengs):
//  1. Oppsett: fjernkontrollen skal aldri overlappe, rulle eller havne utenfor skjermen, uansett TV-type,
//     telefonstørrelse, antall favoritter, varsler, «Spilles nå» og piltaster/berøringsflate.
//  2. Tilkobling: søk, trykk på funnet TV, Android TV-kode, IP-adresse med automatisk merke, valg av
//     merke når TV-en ikke gjenkjennes, og «Fikk ikke kontakt».
//  3. Funksjoner: faner, favoritter, «Åpner …», frakoblet tilstand, berøringsflate, kilder, tastatur,
//     tilbakeknappen og fjerning av TV-en som er i bruk.
// Kjøres i CI med Chrome og playwright-core:
//   npm install --no-save playwright-core && CHROME_PATH=$(which google-chrome) npm run check:ui
// Lokalt kan PLAYWRIGHT_MODULE peke på en installert playwright (for eksempel global).
// SHOTS=<mappe> lagrer i tillegg skjermbilder av alle skjermene i Galaxy-størrelser.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright-core', 'playwright'].filter(Boolean);
  for (const name of candidates) {
    try {
      const mod = await import(fs.existsSync(name) ? pathToFileURL(name).href : name);
      return mod.chromium || mod.default?.chromium;
    } catch { /* prøv neste */ }
  }
  throw new Error('Fant ikke playwright-core. Kjør: npm install --no-save playwright-core');
}
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = '/opt/pw-browsers';
  if (fs.existsSync(local)) {
    const dir = fs.readdirSync(local).find((name) => /^chromium-\d+$/.test(name));
    if (dir) return path.join(local, dir, 'chrome-linux', 'chrome');
  }
  return undefined;
}

// ---------- Falsk bro ----------
const HOST = '192.168.1.60';
const APPS = ['NRK TV', 'Netflix', 'Viaplay', 'Prime Video', 'Uyanik TV', 'YouTube', 'TV 2 Play', 'Disney+', 'HBO Max', 'Spotify']
  .map((name, i) => ({ id: `app${i}`, name, system: false, color: null }));
const KEYS = ['Num0', 'Num1', 'Red', 'Green', 'Yellow', 'Blue', 'Info', 'Guide', 'Settings', 'Subtitles', 'Teletext', 'Recent', 'Search', 'Enter'];
const CAPS = {
  androidtv: { playPause: 'single', channels: true, powerOn: true, apps: true, inputs: false, search: 'youtube', keys: KEYS },
  lg: { playPause: 'split', channels: true, powerOn: true, apps: true, inputs: true, search: 'youtube', keys: KEYS },
  samsung: { playPause: 'single', channels: true, powerOn: true, apps: true, inputs: true, search: 'youtube', keys: KEYS },
  roku: { playPause: 'single', channels: false, powerOn: true, apps: true, inputs: true, search: 'youtube', keys: ['Info', 'Search'] },
};
const FOUND = [
  { type: 'lg', host: '192.168.1.60', name: 'LG OLED65C3' },
  { type: 'androidtv', host: '192.168.1.61', name: 'Telia TV-boks' },
  { type: 'samsung', host: '192.168.1.62', name: 'Samsung Q80' },
];
const PAIR_CODE = 'A1B2C3';

// Broens tilstand: hvilken TV som er valgt, og om den er klar. Scenarioet styrer hvordan den svarer.
let scenario = {};
let bridge = { device: null, ready: false, code: null, state: 'Ingen TV valgt.' };
const calls = [];
const statusOf = () => {
  const { device } = bridge;
  if (!device) return { device: null, ready: false, state: 'Ingen TV valgt.' };
  if (scenario.notice) return { device, ready: false, state: 'Forbindelsen falt ut. Kobler til igjen …', code: 'unreachable', capabilities: CAPS[device.type] };
  return { device, ready: bridge.ready, state: bridge.state, code: bridge.code, capabilities: scenario.caps || CAPS[device.type] };
};
function handleApi(route, body, res) {
  const json = (data, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  };
  const later = (ms, fn) => setTimeout(fn, ms);
  switch (route) {
    case 'status': return json(statusOf());
    case 'scan': return later(scenario.scanDelay ?? 300, () => json({ devices: scenario.found ?? FOUND }));
    case 'probe': {
      if (body.host === '192.168.1.77') return later(200, () => json({ device: { type: 'lg', host: body.host, name: 'LG-TV' } }));
      return later(200, () => json({ error: 'Fant ingen TV som Fjern støtter på denne adressen.' }, 404));
    }
    case 'connect': {
      const device = body.device;
      bridge.device = { type: device.type, host: device.host, name: device.name };
      if (scenario.unreachable) {
        Object.assign(bridge, { ready: false, code: 'unreachable', state: 'Fikk ikke kontakt med TV-en. Sjekk at den er på.' });
      } else if (scenario.certChanged) {
        Object.assign(bridge, { ready: false, code: 'cert-changed', state: 'TV-en har fått nytt sertifikat. Par på nytt for å fortsette.' });
      } else if (device.type === 'androidtv' && !scenario.paired) {
        Object.assign(bridge, { ready: false, code: 'needs-code', state: 'Skriv inn koden som vises på TV-en.' });
      } else {
        Object.assign(bridge, { ready: true, code: null, state: 'Tilkoblet' });
      }
      return later(scenario.connectDelay ?? 150, () => json(statusOf()));
    }
    case 'repair':
      scenario.certChanged = false;
      Object.assign(bridge, { ready: true, code: null, state: 'Tilkoblet' });
      return later(150, () => json(statusOf()));
    case 'pair': {
      if (body.code !== PAIR_CODE) return json({ error: 'Feil kode. Prøv igjen.' }, 400);
      scenario.paired = true;
      Object.assign(bridge, { ready: true, code: null, state: 'Tilkoblet' });
      return json(statusOf());
    }
    case 'disconnect':
      bridge = { device: null, ready: false, code: null, state: 'Ingen TV valgt.' };
      return json(statusOf());
    case 'apps': return json({ apps: APPS });
    case 'inputs': return json({ inputs: [{ id: 'hdmi1', name: 'HDMI 1', connected: true }, { id: 'hdmi2', name: 'HDMI 2', connected: false }] });
    case 'ytsearch': return json({ videos: [
      { id: 'n61ULEU7CO0', title: 'Lofi hip hop radio – beats to relax/study to', channel: 'Lofi Girl', duration: 'Direkte', views: '' },
      { id: 'jfKfPfyJRdk', title: 'Rolig musikk til kvelden', channel: 'Kanal', duration: '1:02:13', views: '2,1 mill. visninger' },
    ] });
    case 'ytsuggest': return json({ suggestions: ['lofi hip hop', 'lofi girl'] });
    case 'launch': return later(scenario.launchDelay || 0, () => json({ ok: true }));
    default:
      if (route.startsWith('icon') || route.startsWith('ytthumb')) return json({}, 404);
      return json({ ok: true });
  }
}
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const route = url.pathname.slice(5);
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ route, body });
      res.setHeader('content-type', 'application/json');
      handleApi(route, body, res);
    });
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const routes = (name) => calls.filter((call) => call.route === name);

// ---------- Målinger ----------
const SIZES = [[320, 568], [360, 640], [360, 780], [384, 832], [412, 915]];
const VARIANTS = [
  { name: 'enkel', favorites: 0 },
  { name: 'full', favorites: 9, nowPlaying: true },
  { name: 'frakoblet', favorites: 9, notice: true, nowPlaying: true },
  { name: 'berøring', favorites: 9, touch: true },
];

function measure() {
  const regions = ['.topbar', '#notice', '#apps', '#nowHome', '.pad-area', '.controls', '#tabbar'];
  const boxes = regions.map((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.closest('[hidden]') || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    return { sel, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }).filter(Boolean);
  const problems = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const overlap = Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top);
      if (overlap > 1) problems.push(`${boxes[i].sel} overlapper ${boxes[j].sel} (${Math.round(overlap)} px)`);
    }
  }
  for (const b of boxes) {
    if (b.top < -1 || b.bottom > innerHeight + 1 || b.left < -1 || b.right > innerWidth + 1) problems.push(`${b.sel} er utenfor skjermen`);
  }
  if (document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1) problems.push('siden ruller');
  // Knappene i kontrollpanelet skal ikke overlappe hverandre.
  const ctl = [...document.querySelectorAll('.controls > *')].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map((el) => el.getBoundingClientRect());
  for (let i = 0; i < ctl.length; i++) {
    for (let j = i + 1; j < ctl.length; j++) {
      const a = ctl[i];
      const b = ctl[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) problems.push('knapper i kontrollpanelet overlapper');
    }
  }
  const small = [...document.querySelectorAll('#remote button, .topbar button, #tabbar button')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && getComputedStyle(el).visibility !== 'hidden' && (r.width < 40 || r.height < 40);
  }).map((el) => el.getAttribute('aria-label') || el.textContent.trim());
  if (small.length) problems.push(`for små knapper: ${small.slice(0, 4).join(', ')}`);
  const touch = !document.querySelector('#touchpad').hidden;
  const pad = document.querySelector(touch ? '#touchpad' : '#dpad').getBoundingClientRect();
  if (Math.min(pad.width, pad.height) < (touch ? 110 : 140)) problems.push(`${touch ? 'berøringsflaten' : 'styrekorset'} er bare ${Math.round(pad.width)}×${Math.round(pad.height)} px`);
  // Bytteknappen i hjørnet skal ikke ligge over sirkelen med pilene.
  if (!touch) {
    const t = document.querySelector('#padMode').getBoundingClientRect();
    const cx = pad.left + pad.width / 2;
    const cy = pad.top + pad.height / 2;
    const nx = Math.max(t.left, Math.min(cx, t.right));
    const ny = Math.max(t.top, Math.min(cy, t.bottom));
    if (Math.hypot(nx - cx, ny - cy) < pad.width / 2 - 1) problems.push('bytteknappen ligger over styrekorset');
  }
  const rows = new Set([...document.querySelectorAll('#appGrid .fav')].map((el) => Math.round(el.getBoundingClientRect().top))).size;
  if (rows > 1) problems.push(`favorittene går over ${rows} rader`);
  return { problems, pad: `${touch ? 'flate' : 'kors'} ${Math.round(pad.width)}×${Math.round(pad.height)}` };
}

const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath: chromePath() });
let failures = 0;
let checks = 0;
const check = (ok, text) => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${text}`);
};

// Åpner appen med en lagret TV (eller ingen, for første oppstart).
async function open(sc = {}, { type = 'lg', favorites = 4, width = 360, height = 780, saved = true, touch = false, scale = 1 } = {}) {
  scenario = { ...sc };
  bridge = saved
    ? { device: { type, host: HOST, name: 'Stue' }, ready: true, code: null, state: 'Tilkoblet' }
    : { device: null, ready: false, code: null, state: 'Ingen TV valgt.' };
  if (saved && type === 'androidtv') scenario.paired = true;
  calls.length = 0;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  await page.addInitScript(({ type, favorites, ids, saved, touch, host }) => {
    if (saved) {
      localStorage.setItem('fjern-devices', JSON.stringify([{ type, host, name: 'Stue' }]));
      localStorage.setItem('fjern-selected', JSON.stringify(`${type}:${host}`));
      localStorage.setItem('fjern-favorites', JSON.stringify({ [`${type}:${host}`]: ids.slice(0, favorites) }));
    }
    localStorage.setItem('fjern-yt-recent', JSON.stringify(['lofi', 'nrk nyheter']));
    if (touch) localStorage.setItem('fjern-pad-mode', JSON.stringify('touch'));
  }, { type, favorites, ids: APPS.map((app) => app.id), saved, touch, host: HOST });
  await page.goto(base);
  await page.waitForTimeout(600);
  return page;
}
const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return Boolean(el && !el.closest('[hidden]') && el.getClientRects().length);
}, sel);
const toastText = (page) => page.evaluate(() => document.querySelector('#toast').textContent);
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
// «Spilles nå»: søk og spill en video i YouTube-fanen, og gå tilbake til fjernkontrollen.
async function playSomething(page) {
  await page.click('.tab[data-view="yt"]', { timeout: 3000 });
  await page.fill('#ytQuery', 'lofi');
  await page.press('#ytQuery', 'Enter');
  await page.click('.yt-item', { timeout: 3000 });
  await page.click('.tab[data-view="remote"]', { timeout: 3000 });
  await page.waitForTimeout(400); // fanebyttet animeres; mål etterpå
}

try {
  // ---------- 1. Oppsett ----------
  for (const type of Object.keys(CAPS)) {
    for (const variant of VARIANTS) {
      for (const [width, height] of SIZES) {
        const page = await open({ notice: false }, { type, favorites: variant.favorites, width, height, touch: variant.touch });
        const steps = [];
        if (variant.nowPlaying) {
          try {
            await playSomething(page);
          } catch {
            steps.push('YouTube-fanen kunne ikke brukes (dekket av noe annet)');
          }
        }
        if (variant.notice) {
          scenario.notice = true;
          await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2700)));
        }
        const { problems, pad } = await page.evaluate(measure);
        problems.unshift(...steps);
        if (page.errors.length) problems.push(`JS-feil: ${page.errors.join('; ')}`);
        checks += 1;
        const label = `${type.padEnd(9)} ${variant.name.padEnd(9)} ${`${width}×${height}`.padEnd(8)}`;
        if (problems.length) {
          failures += 1;
          console.log(`✗ ${label} ${problems.join(' · ')}`);
        } else {
          console.log(`✓ ${label} ${pad}`);
        }
        await page.close();
      }
    }
  }

  // ---------- 2. Tilkobling ----------
  // Første oppstart: tilkoblingsskjermen søker med en gang og viser TV-ene som kort. Den kan ikke lukkes.
  let page = await open({ scanDelay: 1500 }, { saved: false, scale: shots ? 2 : 1 });
  check(await visible(page, '#connectView') && await visible(page, '#stepSearch'), 'første oppstart: «Koble til TV» vises');
  check(await page.evaluate(() => document.querySelector('#connectView').classList.contains('is-scanning')), 'første oppstart: søker med en gang');
  await shot(page, '01-tilkobling-soker');
  await page.waitForTimeout(1200);
  check(await page.$$eval('#foundList .found-item', (els) => els.length) === 3, 'søket viser tre TV-er som kort');
  check(!(await visible(page, '#connectBack')), 'første oppstart: ingen tilbakeknapp');
  check(/Fant 3 TV-er/.test(await page.textContent('#scanStatus')), 'statusen sier hvor mange som ble funnet');
  await shot(page, '02-tilkobling-funnet');
  // Trykk på LG-kortet: veiledning for LG, deretter «Tilkoblet» og fjernkontrollen.
  scenario.connectDelay = 600;
  await page.click('#foundList .found-item >> nth=0');
  await page.waitForTimeout(200);
  check(await visible(page, '#stepPair') && /Godta/.test(await page.textContent('#pairText')), 'LG: veiledning om «Godta» på TV-en mens den kobler til');
  await shot(page, '03-tilkobling-lg');
  await page.waitForTimeout(700);
  check(await visible(page, '#stepDone'), 'LG: «Tilkoblet» bekreftes');
  await page.waitForTimeout(1100);
  check(!(await visible(page, '#connectView')) && await visible(page, '#remote') && await visible(page, '#tabbar'), 'LG: fjernkontrollen og fanene vises etterpå');
  check((await page.textContent('#deviceName')) === 'LG OLED65C3', 'TV-navnet står øverst');
  check(routes('connect').at(-1)?.body.device.type === 'lg', 'tilkoblingen bruker merket fra søket');
  check(page.errors.length === 0, `ingen JS-feil i tilkoblingen${page.errors.length ? `: ${page.errors.join('; ')}` : ''}`);
  await page.close();

  // Android TV: kodefeltet vises, koden blir store bokstaver, feil kode gir beskjed, riktig kode kobler til.
  page = await open({}, { saved: false, scale: shots ? 2 : 1 });
  await page.waitForTimeout(400);
  await page.click('#foundList .found-item >> nth=1');
  await page.waitForTimeout(500);
  check(await visible(page, '#pairForm'), 'Android TV: kodefeltet vises når TV-en viser koden');
  await page.fill('#pairCode', 'zz00');
  await page.type('#pairCode', 'a1b2c3x');
  check((await page.inputValue('#pairCode')).length <= 6 && /^[0-9A-F]*$/.test(await page.inputValue('#pairCode')), 'koden filtreres til store heksadesimale tegn');
  await page.fill('#pairCode', '');
  await page.type('#pairCode', 'a1b2c4');
  await shot(page, '04-tilkobling-kode');
  await page.click('#pairSubmit');
  await page.waitForTimeout(300);
  check(await visible(page, '#pairError') && /Feil kode/.test(await page.textContent('#pairError')), 'feil kode gir tydelig beskjed');
  await page.fill('#pairCode', '');
  await page.type('#pairCode', 'a1b2c3');
  await page.click('#pairSubmit');
  await page.waitForTimeout(1300);
  check(await visible(page, '#remote') && routes('pair').at(-1)?.body.code === PAIR_CODE, 'riktig kode kobler til og viser fjernkontrollen');
  await page.close();

  // IP-adresse: merket finnes automatisk. Ugyldig adresse gir beskjed med en gang.
  page = await open({ found: [] }, { saved: false, scale: shots ? 2 : 1 });
  await page.waitForTimeout(400);
  check(/Fant ingen TV-er/.test(await page.textContent('#scanStatus')), 'ingen funnet: forklaring og vei videre');
  await page.click('#manualOpen');
  check(await visible(page, '#stepManual') && !(await visible(page, '#typeChoice')), 'IP-adresse: bare ett felt, merket velges ikke');
  check(await visible(page, '#connectBack'), 'IP-adresse: tilbakeknapp til søket');
  await page.fill('#ip', '8.8.8.8');
  await page.click('#manualSubmit');
  check(await visible(page, '#manualError') && routes('probe').length === 0, 'ugyldig adresse stoppes før noe sendes');
  await page.fill('#ip', '192.168.1.77');
  await shot(page, '05-tilkobling-ip');
  await page.click('#manualSubmit');
  await page.waitForTimeout(1600);
  check(routes('probe').at(-1)?.body.host === '192.168.1.77', 'IP-adresse: broen spørres hvilket merke TV-en er');
  check(routes('connect').at(-1)?.body.device.type === 'lg' && await visible(page, '#remote'), 'IP-adresse: kobler til LG uten at merket ble valgt');
  await page.close();

  // Ukjent adresse: merkevalget dukker opp, og valgt merke brukes.
  page = await open({ found: [] }, { saved: false });
  await page.waitForTimeout(400);
  await page.click('#manualOpen');
  await page.fill('#ip', '192.168.1.99');
  await page.click('#manualSubmit');
  await page.waitForTimeout(400);
  check(await visible(page, '#typeChoice') && /velge merke selv/.test(await page.textContent('#manualError')), 'ukjent TV: merkevalg vises med forklaring');
  await page.check('input[name="deviceType"][value="samsung"]');
  await page.click('#manualSubmit');
  await page.waitForTimeout(400);
  check(routes('connect').at(-1)?.body.device.type === 'samsung', 'ukjent TV: valgt merke brukes');
  await page.close();

  // Fikk ikke kontakt: tydelig feil med «Prøv igjen» og «Velg en annen TV».
  page = await open({ unreachable: true }, { saved: false, scale: shots ? 2 : 1 });
  await page.waitForTimeout(400);
  await page.click('#foundList .found-item >> nth=2');
  await page.waitForTimeout(600);
  check(await visible(page, '#pairRetry') && /Fikk ikke kontakt/.test(await page.textContent('#pairTitle')), 'ingen kontakt: feil med «Prøv igjen»');
  await shot(page, '06-tilkobling-feil');
  await page.click('#pairCancel');
  await page.waitForTimeout(500);
  check(await visible(page, '#stepSearch') && routes('disconnect').length === 1, '«Velg en annen TV»: tilbake til søket, og broen kobles fra');
  await page.close();

  // Endret sertifikat: «Må pares på nytt», og knappen bruker broens «repair» (ikke vanlig tilkobling).
  page = await open({ certChanged: true }, { saved: false });
  await page.waitForTimeout(400);
  await page.click('#foundList .found-item >> nth=0');
  await page.waitForTimeout(600);
  check(/pares på nytt/.test(await page.textContent('#pairTitle')) && (await page.textContent('#pairAgain')) === 'Par på nytt', 'endret sertifikat: «Må pares på nytt» med egen knapp');
  await page.click('#pairAgain');
  await page.waitForTimeout(1400);
  check(routes('repair').length === 1 && await visible(page, '#remote'), 'endret sertifikat: «Par på nytt» bruker repair og kobler til');
  await page.close();

  // ---------- 3. Funksjoner ----------
  // App-ikonene skal ikke bygges på nytt ved hver statusoppdatering (da kan trykk gå tapt).
  page = await open({}, { scale: shots ? 2 : 1 });
  check(!(await visible(page, '#connectView')) && await visible(page, '#remote'), 'lagret TV: rett til fjernkontrollen');
  await page.evaluate(() => { window.__tile = document.querySelector('#appGrid .fav'); });
  await page.waitForTimeout(3000); // mer enn én statusoppdatering (2,5 s)
  check(await page.evaluate(() => Boolean(window.__tile) && document.querySelector('#appGrid .fav') === window.__tile), 'app-ikonene står fast mellom statusoppdateringer');
  await shot(page, '10-fjernkontroll');
  // Faner.
  await page.click('.tab[data-view="apps"]');
  check(await visible(page, '#appsView') && !(await visible(page, '#remote')), 'Apper-fanen viser alle apper');
  check(await page.$$eval('#allApps .tile', (els) => els.length) === 6 && await page.$$eval('#favApps .tile', (els) => els.length) === 4, 'Apper: 4 favoritter og 6 andre');
  check(await visible(page, '#inputList') && await page.$$eval('#inputList .input-row', (els) => els.length) === 2, 'Apper: kildene (HDMI) står nederst');
  await shot(page, '11-apper');
  check(await page.evaluate(() => window.__fjernBack()) && await visible(page, '#remote'), 'tilbakeknappen går fra Apper til fjernkontrollen');
  await page.click('.tab[data-view="yt"]');
  check(await visible(page, '#ytView') && await page.$$eval('#ytRecent .chip', (els) => els.length) === 2, 'YouTube-fanen viser siste søk');
  await page.fill('#ytQuery', 'lofi');
  await page.waitForTimeout(900);
  check(await page.$$eval('#ytResults .yt-item', (els) => els.length) === 2, 'YouTube: treff mens man skriver');
  await page.click('.yt-item >> nth=0');
  await page.waitForTimeout(200);
  check(routes('ytplay').length === 1 && await visible(page, '#nowYt'), 'YouTube: trykk spiller på TV-en og viser «Spilles nå»');
  await shot(page, '12-youtube');
  await page.click('.tab[data-view="remote"]');
  check(await visible(page, '#nowHome'), '«Spilles nå» står også på fjernkontrollen');
  // Tastatur sender til TV-en bare på fjernkontrollen.
  calls.length = 0;
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  check(routes('command').at(-1)?.body.key === 'Up', 'tastatur: pil opp sender «Up»');
  // Mer-arket og TV-listen.
  await page.click('#moreOpen');
  await page.waitForTimeout(300);
  check(await visible(page, '#moreSheet'), '«Mer» åpner flere taster');
  await shot(page, '13-mer');
  await page.click('#inputOpen');
  await page.waitForTimeout(500);
  check(await visible(page, '#appsView') && await visible(page, '#inputList'), '«Kilde» i «Mer» går til kildene');
  await page.click('.tab[data-view="remote"]');
  await page.click('#deviceButton');
  await page.waitForTimeout(300);
  check(await page.$$eval('#savedList .device-item', (els) => els.length) === 1, 'TV-velgeren viser lagrede TV-er');
  await shot(page, '14-tv-er');
  await page.click('#addTv');
  await page.waitForTimeout(500);
  check(await visible(page, '#connectView') && !(await page.evaluate(() => document.querySelector('#connectView').classList.contains('is-first'))), '«Legg til TV» åpner søket, som kan lukkes');
  await page.click('#connectBack');
  check(!(await visible(page, '#connectView')), 'tilbake lukker søket når en TV er valgt');
  check(page.errors.length === 0, `ingen JS-feil i fanene${page.errors.length ? `: ${page.errors.join('; ')}` : ''}`);
  await page.close();

  // YouTube-fanen finnes bare når TV-en kan spille YouTube.
  page = await open({ caps: { ...CAPS.roku, search: false } }, { type: 'roku' });
  check(!(await visible(page, '.tab[data-view="yt"]')), 'uten YouTube-støtte: ingen YouTube-fane');
  await page.close();

  // Favoritter: 4 på vanlige telefoner, 5 på brede. Full rad gir beskjed, og ingenting endres.
  page = await open({}, { favorites: 9 });
  check(await page.$$eval('#appGrid .fav', (els) => els.length) === 5, '360 px: 4 favoritter og «Alle»');
  await page.click('#appGrid .fav >> nth=-1');
  await page.waitForTimeout(200);
  check(await visible(page, '#appsView'), '«Alle» åpner Apper-fanen');
  await page.click('#favEdit');
  check((await page.textContent('#favAppsTitle')) === 'Favoritter (4 av 4)', 'redigering: «Favoritter (4 av 4)»');
  await page.click('#allApps .tile >> nth=0');
  check(/plass til 4 favoritter/.test(await toastText(page)), 'full rad: beskjed om at det er plass til 4');
  check(await page.$$eval('#favApps .tile', (els) => els.length) === 4, 'full rad: fortsatt 4 favoritter');
  await page.click('#favApps .tile >> nth=0');
  check(await page.$$eval('#favApps .tile', (els) => els.length) === 3, 'trykk på favoritt fjerner den');
  check(await page.$$eval('#appGrid .fav', (els) => els.length) === 4, 'fjernkontrollen oppdateres med en gang');
  await page.click('#favEdit');
  calls.length = 0;
  await page.click('#allApps .tile >> nth=0');
  await page.waitForTimeout(150);
  check(routes('launch').length === 1, 'utenfor redigering åpner et trykk appen');
  await page.close();
  page = await open({}, { favorites: 9, width: 412, height: 915 });
  check(await page.$$eval('#appGrid .fav', (els) => els.length) === 6, '412 px: 5 favoritter og «Alle»');
  await page.close();

  // «Åpner …» mens appen startes, og bare én åpning ved dobbelttrykk.
  page = await open({ launchDelay: 1200 });
  await page.click('#appGrid .fav >> nth=0');
  await page.waitForTimeout(500);
  check((await page.textContent('#appGrid .fav >> nth=0')).includes('Åpner …'), 'flisen viser «Åpner …» mens appen startes');
  await page.click('#appGrid .fav >> nth=0');
  await page.waitForTimeout(1200);
  check(routes('launch').length === 1, 'dobbelttrykk gir bare én åpning');
  check(!(await page.textContent('#appGrid .fav >> nth=0')).includes('Åpner'), 'flisen får navnet tilbake etterpå');
  await page.close();

  // Berøringsflate: sveip gir piltaster (ett steg per 40 px), trykk gir OK. Valget huskes.
  page = await open({}, { scale: shots ? 2 : 1 });
  await page.click('#padMode');
  check(await visible(page, '#touchpad') && !(await visible(page, '#dpad')), 'berøringsflaten slås på');
  await shot(page, '15-beroring');
  calls.length = 0;
  const box = await page.locator('#touchpad').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 50, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 5, cy, { steps: 5 });
  await page.mouse.move(cx + 40, cy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(routes('command').filter((call) => call.body.key === 'Right').length === 2, 'sveip 90 px til høyre gir to steg til høyre');
  calls.length = 0;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(200);
  check(routes('command').at(-1)?.body.key === 'Select', 'trykk på flaten gir OK');
  await page.reload();
  await page.waitForTimeout(500);
  check(await visible(page, '#touchpad'), 'berøringsflaten huskes til neste gang');
  await page.close();

  // Forbindelsen faller etter at appene er lastet: appraden står nedtonet (ingen hopp), og trykk gir beskjed.
  page = await open({});
  scenario.notice = true;
  await page.waitForTimeout(2800); // neste statusoppdatering ser at TV-en er borte
  check(await page.evaluate(() => !document.querySelector('#apps').hidden && document.querySelector('#apps').classList.contains('is-offline')), 'frakoblet: appraden står nedtonet');
  check(await visible(page, '#notice') && /Prøv igjen/.test(await page.textContent('#noticeAction')), 'frakoblet: merknad med «Prøv igjen»');
  calls.length = 0;
  await page.click('#appGrid .fav >> nth=0', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  check(!routes('launch').length && /Forbindelsen falt ut/.test(await toastText(page)), 'frakoblet: trykk på app gir beskjed og sender ingenting');
  await page.close();

  // Fjerne TV-en som er i bruk: broen kobler fra, søket åpnes, og TV-en kommer ikke tilbake.
  page = await open({});
  await page.click('#deviceButton');
  await page.click('#savedList .device-remove >> nth=1');
  await page.click('#removeConfirm');
  await page.waitForTimeout(3000);
  check(routes('disconnect').length === 1, 'fjern TV i bruk: broen kobles fra');
  check(await visible(page, '#connectView') && !(await visible(page, '#remote')), 'fjern TV i bruk: «Koble til TV» vises, og TV-en kommer ikke tilbake');
  await page.close();

  // Skjermbilder av fjernkontrollen i andre Galaxy-størrelser.
  if (shots) {
    for (const [width, height, name] of [[320, 568, 'liten'], [412, 915, 'stor']]) {
      page = await open({}, { favorites: 9, width, height, scale: 2 });
      await playSomething(page);
      await shot(page, `20-fjernkontroll-${name}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${checks - failures}/${checks} grensesnittsjekker OK`);
process.exit(failures ? 1 : 0);
