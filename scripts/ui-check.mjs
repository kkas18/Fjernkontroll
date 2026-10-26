// Grensesnittest i ekte nettleser, mot en falsk bro (ingen TV trengs):
//  1. Oppsett: forsiden skal aldri overlappe, rulle eller havne utenfor skjermen, uansett TV-type,
//     telefonstørrelse, antall favoritter, varsler og «Spilles nå».
//  2. Funksjoner: app-ikonene står fast, favorittraden har tak, «Åpner …», frakoblet tilstand og
//     fjerning av TV-en som er i bruk.
// Grensesnittet kjøres mot en falsk bro (ingen TV trengs). Kjøres i CI med Chrome og playwright-core:
//   npm install --no-save playwright-core && CHROME_PATH=$(which google-chrome) npm run check:ui
// Lokalt kan PLAYWRIGHT_MODULE peke på en installert playwright (for eksempel global).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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
const APPS = ['NRK TV', 'Netflix', 'Viaplay', 'Prime Video', 'Uyanik TV', 'YouTube', 'TV 2 Play', 'Disney+', 'HBO Max', 'Spotify']
  .map((name, i) => ({ id: `app${i}`, name, system: false, color: null }));
const KEYS = ['Num0', 'Num1', 'Red', 'Green', 'Yellow', 'Blue', 'Info', 'Guide', 'Settings', 'Subtitles', 'Teletext', 'Recent', 'Search', 'Enter'];
const CAPS = {
  androidtv: { playPause: 'single', channels: true, powerOn: true, apps: true, inputs: false, search: 'youtube', keys: KEYS },
  lg: { playPause: 'split', channels: true, powerOn: true, apps: true, inputs: true, search: 'youtube', keys: KEYS },
  samsung: { playPause: 'single', channels: true, powerOn: true, apps: true, inputs: true, search: 'youtube', keys: KEYS },
  roku: { playPause: 'single', channels: false, powerOn: true, apps: true, inputs: true, search: 'youtube', keys: ['Info', 'Search'] },
};
let scenario = null;
const calls = [];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const route = url.pathname.slice(5);
    res.setHeader('content-type', 'application/json');
    calls.push(route);
    const device = scenario.disconnected ? null : { type: scenario.type, host: '192.168.1.60', name: 'Stue' };
    const status = scenario.notice
      ? { device, ready: false, state: 'Forbindelsen falt ut. Kobler til igjen …', code: 'unreachable', capabilities: CAPS[scenario.type] }
      : { device, ready: true, state: 'Tilkoblet', capabilities: CAPS[scenario.type] };
    if (route === 'apps') return res.end(JSON.stringify({ apps: APPS }));
    if (route === 'ytsearch') return res.end(JSON.stringify({ videos: [{ id: 'n61ULEU7CO0', title: 'Lofi', channel: 'Kanal', duration: '3:00', views: '' }] }));
    if (route === 'ytsuggest') return res.end(JSON.stringify({ suggestions: [] }));
    if (route.startsWith('icon') || route.startsWith('ytthumb')) { res.statusCode = 404; return res.end('{}'); }
    if (route === 'status' || route === 'connect') return res.end(JSON.stringify(device ? status : { device: null, ready: false, state: 'Ingen TV valgt.' }));
    if (route === 'disconnect') { scenario.disconnected = true; return res.end(JSON.stringify({ device: null, ready: false })); }
    if (route === 'launch') return setTimeout(() => res.end('{"ok":true}'), scenario.launchDelay || 0);
    return res.end('{"ok":true}');
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---------- Målinger ----------
const SIZES = [[320, 568], [360, 640], [360, 732], [384, 784], [412, 868], [412, 915]];
const VARIANTS = [
  { name: 'enkel', favorites: 0 },
  { name: 'full', favorites: 9, nowPlaying: true },
  { name: 'frakoblet', favorites: 9, notice: true, nowPlaying: true },
];

function measure() {
  const regions = ['.bar', '#notice', '.search-pill', '#nowHome', '#apps', '.deck', '.dock'];
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
  const small = [...document.querySelectorAll('#remote button')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.width < 40 || r.height < 40);
  }).map((el) => el.getAttribute('aria-label') || el.textContent.trim());
  if (small.length) problems.push(`for små knapper: ${small.slice(0, 4).join(', ')}`);
  const dpad = document.querySelector('.dpad')?.getBoundingClientRect().width || 0;
  if (dpad < 120) problems.push(`styrekorset er bare ${Math.round(dpad)} px`);
  const rows = new Set([...document.querySelectorAll('#appGrid .fav')].map((el) => Math.round(el.getBoundingClientRect().top))).size;
  if (rows > 1) problems.push(`favorittene går over ${rows} rader`);
  return { problems, dpad: Math.round(dpad) };
}

const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath: chromePath() });
let failures = 0;
let checks = 0;
try {
  for (const type of Object.keys(CAPS)) {
    for (const variant of VARIANTS) {
      scenario = { type, ...variant };
      for (const [width, height] of SIZES) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.addInitScript(({ type, favorites, ids }) => {
          const device = { type, host: '192.168.1.60', name: 'Stue' };
          localStorage.setItem('fjern-devices', JSON.stringify([device]));
          localStorage.setItem('fjern-selected', JSON.stringify(`${type}:192.168.1.60`));
          if (favorites) localStorage.setItem('fjern-favorites', JSON.stringify({ [`${type}:192.168.1.60`]: ids.slice(0, favorites) }));
        }, { type, favorites: variant.favorites, ids: APPS.map((app) => app.id) });
        await page.goto(base);
        await page.waitForTimeout(500);
        const steps = [];
        if (variant.nowPlaying) {
          // «Spilles nå»: søk og spill en video, og gå tilbake til fjernkontrollen. Et trykk som ikke når fram
          // (fordi noe ligger over knappen), er også en feil.
          try {
            await page.click('#searchOpen', { timeout: 3000 });
            await page.fill('#ytQuery', 'lofi');
            await page.press('#ytQuery', 'Enter');
            await page.click('.yt-item', { timeout: 3000 });
            await page.click('#ytBack', { timeout: 3000 });
            await page.waitForTimeout(150);
          } catch {
            steps.push('søkefeltet kunne ikke trykkes på (dekket av noe annet)');
          }
        }
        const { problems, dpad } = await page.evaluate(measure);
        problems.unshift(...steps);
        if (errors.length) problems.push(`JS-feil: ${errors.join('; ')}`);
        checks += 1;
        const label = `${type.padEnd(9)} ${variant.name.padEnd(9)} ${`${width}×${height}`.padEnd(8)}`;
        if (problems.length) {
          failures += 1;
          console.log(`✗ ${label} ${problems.join(' · ')}`);
        } else {
          console.log(`✓ ${label} styrekors ${dpad} px`);
        }
        await page.close();
      }
    }
  }

  // ---------- Funksjoner ----------
  const check = (ok, text) => {
    checks += 1;
    if (!ok) failures += 1;
    console.log(`${ok ? '✓' : '✗'} ${text}`);
  };
  async function open(sc, { favorites = 4, width = 360 } = {}) {
    scenario = { type: 'lg', ...sc };
    calls.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 732 } });
    await page.addInitScript(({ favorites, ids }) => {
      localStorage.setItem('fjern-devices', JSON.stringify([{ type: 'lg', host: '192.168.1.60', name: 'Stue' }]));
      localStorage.setItem('fjern-selected', JSON.stringify('lg:192.168.1.60'));
      localStorage.setItem('fjern-favorites', JSON.stringify({ 'lg:192.168.1.60': ids.slice(0, favorites) }));
      localStorage.setItem('fjern-yt-recent', JSON.stringify(['lofi']));
    }, { favorites, ids: APPS.map((app) => app.id) });
    await page.goto(base);
    await page.waitForTimeout(700);
    return page;
  }
  const toastText = (page) => page.evaluate(() => document.querySelector('#toast').textContent);

  // App-ikonene skal ikke bygges på nytt ved hver statusoppdatering (da kan trykk gå tapt).
  let page = await open({});
  await page.evaluate(() => { window.__tile = document.querySelector('#appGrid .fav'); });
  await page.waitForTimeout(3200); // mer enn én statusoppdatering (2,5 s)
  check(await page.evaluate(() => Boolean(window.__tile) && document.querySelector('#appGrid .fav') === window.__tile), 'app-ikonene står fast mellom statusoppdateringer');
  check(await page.evaluate(() => !document.querySelector('#homeRecent') && !document.querySelector('.home-recent')), '«Siste søk» står ikke på forsiden');
  await page.close();

  // Favorittraden: 4 på vanlige telefoner, 5 på brede. Full rad gir beskjed, og ingenting endres.
  page = await open({}, { favorites: 9 });
  check(await page.$$eval('#appGrid .fav', (els) => els.length) === 5, '360 px: 4 favoritter og «Alle apper»');
  await page.click('button.fav:has-text("Alle apper")');
  await page.waitForTimeout(300);
  check((await page.textContent('#favAppsTitle')) === 'På forsiden (4 av 4)', '«Alle apper» viser «På forsiden (4 av 4)»');
  await page.click('#allApps .app-star >> nth=0');
  check(/plass til 4 favoritter/.test(await toastText(page)), 'full rad: beskjed om at forsiden har plass til 4');
  check(await page.$$eval('#favApps .app-row', (els) => els.length) === 4, 'full rad: fortsatt 4 favoritter');
  await page.click('#favApps .app-star >> nth=0');
  check(await page.$$eval('#favApps .app-row', (els) => els.length) === 3, 'stjerne av: 3 favoritter');
  await page.close();
  page = await open({}, { favorites: 9, width: 412 });
  check(await page.$$eval('#appGrid .fav', (els) => els.length) === 6, '412 px: 5 favoritter og «Alle apper»');
  await page.close();

  // «Åpner …» mens appen startes, og bare én åpning ved dobbelttrykk.
  page = await open({ launchDelay: 1200 });
  await page.click('#appGrid .fav >> nth=0');
  await page.waitForTimeout(500);
  check((await page.textContent('#appGrid .fav >> nth=0')).includes('Åpner …'), 'flisen viser «Åpner …» mens appen startes');
  await page.click('#appGrid .fav >> nth=0');
  await page.waitForTimeout(1200);
  check(calls.filter((route) => route === 'launch').length === 1, 'dobbelttrykk gir bare én åpning');
  check(!(await page.textContent('#appGrid .fav >> nth=0')).includes('Åpner'), 'flisen får navnet tilbake etterpå');
  await page.close();

  // Forbindelsen faller etter at appene er lastet: appraden står nedtonet (ingen hopp), og trykk gir beskjed
  // i stedet for å sende.
  page = await open({});
  scenario.notice = true;
  await page.waitForTimeout(3000); // neste statusoppdatering ser at TV-en er borte
  check(await page.evaluate(() => !document.querySelector('#apps').hidden && document.querySelector('#apps').classList.contains('is-offline')), 'frakoblet: appraden står nedtonet');
  calls.length = 0;
  await page.click('#appGrid .fav >> nth=0', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  check(!calls.includes('launch') && /Forbindelsen falt ut/.test(await toastText(page)), 'frakoblet: trykk på app gir beskjed og sender ingenting');
  await page.close();

  // Fjerne TV-en som er i bruk: broen kobler fra, og TV-en kommer ikke tilbake ved neste statusoppdatering.
  page = await open({});
  await page.click('#deviceButton');
  await page.click('#savedList .device-remove >> nth=1');
  await page.click('#removeConfirm');
  await page.waitForTimeout(3000);
  check(calls.includes('disconnect'), 'fjern TV i bruk: broen kobles fra');
  check(await page.evaluate(() => document.querySelector('#remote').hidden && !document.querySelector('#empty').hidden), 'fjern TV i bruk: tomtilstand, og TV-en kommer ikke tilbake');
  await page.close();
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${checks - failures}/${checks} grensesnittsjekker OK`);
process.exit(failures ? 1 : 0);
