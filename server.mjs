// Fjern: lokal bro mellom PWA-en og TV-er på lokalnettet.
// Binder kun til 127.0.0.1 og godtar bare forespørsler fra egen opprinnelse.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UserError, toUserMessage } from './lib/errors.mjs';
import { validAppId, validCommand, validDevice, validInputId, validQuery, validText } from './lib/validate.mjs';
import { ROKU_EXTRA_KEYS, rokuApps, rokuCommand, rokuIcon, rokuLaunch, rokuPlayYoutube, rokuProbe, rokuText } from './lib/roku.mjs';
import { searchYoutube, suggestYoutube, thumbnailUrl, validVideoId } from './lib/youtube.mjs';
import { createIconCache, fetchBytes, sniffImage } from './lib/icons.mjs';
import { createDiscovery } from './lib/ssdp.mjs';
import { LG_EXTRA_KEYS, createKeyStore, createLgSession } from './lib/lg.mjs';
import { SAMSUNG_EXTRA_KEYS, createSamsungSession, samsungProbe } from './lib/samsung.mjs';
import { ANDROIDTV_EXTRA_KEYS, createAndroidTvSession, createIdentityStore } from './lib/androidtv.mjs';
import { searchAndroidTv } from './lib/mdns.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const MAX_BODY = 16_384;

const MEDIA = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
]);

export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
    "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'",
    "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new UserError('For stor forespørsel.', 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// De siste hendelsene i broen, slik at brukeren kan kopiere dem ved feilsøking. Ingen nøkler logges.
function createDiagnostics(print, max = 150) {
  const lines = [];
  const log = (message) => {
    lines.push(`${new Date().toTimeString().slice(0, 8)} ${message}`);
    if (lines.length > max) lines.shift();
    print(message);
  };
  return { log, lines };
}

export function createBridge({
  publicDir = path.join(root, 'public'),
  dataDir = path.join(root, 'data'),
  diagnostics = createDiagnostics((message) => console.log(message)),
  log = diagnostics.log,
  fetchImpl = fetch,
  keyStore = createKeyStore(path.join(dataDir, 'lg-keys.json')),
  lg = createLgSession({ keyStore, log }),
  samsung = createSamsungSession({ keyStore, log, fetchImpl }),
  // Appens eget klientsertifikat for Android TV; lages første gang det trengs.
  androidtv = createAndroidTvSession({ keyStore, identity: createIdentityStore(path.join(dataDir, 'androidtv-client.json')), log }),
  discover = createDiscovery({
    log,
    probeRoku: (host) => rokuProbe(host, { fetchImpl }),
    probeSamsung: (host) => samsungProbe(host, { fetchImpl }),
    extraSearches: [searchAndroidTv],
  }),
  rokuHealthTtl = 10_000,
} = {}) {
  let selected = null;
  let rokuHealth = { host: null, ok: false, at: 0 };
  let rokuAppList = [];
  const icons = createIconCache();
  keyStore.protect?.();

  // LG, Samsung og Android TV har en varig forbindelse med samme grensesnitt (connect, command, apps …);
  // Roku styres med enkeltkall.
  const sessions = { lg, samsung, androidtv };
  const LABELS = { lg: 'LG', samsung: 'Samsung', androidtv: 'Android TV' };
  const tvSession = (device = selected) => sessions[device?.type] || null;
  const disconnectOthers = (type) => {
    for (const [name, session] of Object.entries(sessions)) if (name !== type) session.disconnect();
  };

  // Standardnavn byttes ut med TV-ens modellnavn når det er kjent (brukerens egne navn settes i appen).
  const DEFAULT_NAMES = /^(LG-TV|LG webOS|Roku|Samsung-TV|Android TV)( · .*)?$/;
  const publicDevice = (device) => {
    if (!device) return device;
    const model = tvSession(device)?.model;
    const name = model && DEFAULT_NAMES.test(device.name) ? model : device.name;
    return { type: device.type, host: device.host, name };
  };

  async function icon(id) {
    if (!selected) throw new UserError('Velg en TV først.', 409);
    const key = `${selected.type}:${selected.host}:${id}`;
    const cached = icons.get(key);
    if (cached) return cached;
    let bytes;
    if (selected.type === 'samsung' || selected.type === 'androidtv') {
      // Samsung og Android TV deler ikke appikonene over nettet; grensesnittet viser merkefarge og kortnavn.
      throw new UserError('Fant ikke ikonet.', 404);
    } else if (selected.type === 'lg') {
      const url = lg.iconUrl(id);
      if (!url) throw new UserError('Fant ikke ikonet.', 404);
      try {
        bytes = await fetchBytes(url, { insecureTls: true });
      } catch (error) {
        // TV-er som bare har kryptert port, serverer de samme ressursene på https://…:3001.
        const secure = new URL(url);
        if (secure.protocol !== 'http:') throw error;
        secure.protocol = 'https:';
        secure.port = '3001';
        bytes = await fetchBytes(secure.href, { insecureTls: true });
      }
    } else {
      if (!rokuAppList.some((app) => app.id === id)) throw new UserError('Fant ikke ikonet.', 404);
      bytes = await rokuIcon(selected.host, id, { fetchImpl });
    }
    const type = sniffImage(bytes);
    if (!type) throw new UserError('Ikonet er ikke et bilde.', 415);
    const result = { type, bytes };
    icons.set(key, result);
    return result;
  }

  // Roku har ingen varig forbindelse, så vi spør TV-en jevnlig (bufret) om den svarer.
  async function rokuReachable() {
    const fresh = rokuHealth.host === selected.host && Date.now() - rokuHealth.at < rokuHealthTtl;
    if (fresh) return rokuHealth.ok;
    let ok = false;
    try {
      await rokuProbe(selected.host, { fetchImpl, timeout: 1500 });
      ok = true;
    } catch { /* svarer ikke */ }
    rokuHealth = { host: selected.host, ok, at: Date.now() };
    return ok;
  }
  const markRoku = (ok) => { rokuHealth = { host: selected.host, ok, at: Date.now() }; };

  // Hva grensesnittet skal vise for valgt TV.
  function capabilities() {
    if (selected.type === 'roku') {
      return {
        playPause: 'single', channels: selected.isTv !== false, powerOn: selected.isTv === true, apps: true,
        inputs: selected.isTv !== false, search: 'youtube', keys: [...ROKU_EXTRA_KEYS],
      };
    }
    if (selected.type === 'androidtv') {
      // En boks har ingen innganger å velge mellom.
      return { playPause: 'single', channels: true, powerOn: androidtv.canWake, apps: true, inputs: false, search: 'youtube', keys: [...ANDROIDTV_EXTRA_KEYS] };
    }
    const keys = selected.type === 'samsung' ? SAMSUNG_EXTRA_KEYS : LG_EXTRA_KEYS;
    return { playPause: 'single', channels: true, powerOn: tvSession().canWake, apps: true, inputs: true, search: 'youtube', keys: [...keys] };
  }

  async function status() {
    if (!selected) return { device: null, ready: false, state: 'Ingen TV valgt.' };
    if (selected.type === 'roku') {
      const ok = await rokuReachable();
      return {
        device: publicDevice(selected),
        ready: ok,
        state: ok ? 'Tilkoblet' : 'Roku svarer ikke. Sjekk at TV-en er på og på samme Wi‑Fi.',
        code: ok ? null : 'unreachable',
        capabilities: capabilities(),
      };
    }
    const tv = tvSession();
    return { device: publicDevice(selected), ready: tv.ready, state: tv.state, code: tv.code, capabilities: capabilities() };
  }

  async function withRoku(action) {
    try {
      const result = await action();
      markRoku(true);
      return result;
    } catch (error) {
      if (!(error instanceof UserError)) markRoku(false);
      throw error;
    }
  }

  async function api(req, res, route) {
    if (route.startsWith('/api/ytthumb/')) {
      if (req.method !== 'GET') throw new UserError('Metoden støttes ikke.', 405);
      const id = validVideoId(route.slice('/api/ytthumb/'.length));
      let cached = icons.get(`yt:${id}`);
      if (!cached) {
        const bytes = await fetchBytes(thumbnailUrl(id));
        const type = sniffImage(bytes);
        if (!type) throw new UserError('Bildet er ikke et bilde.', 415);
        cached = { type, bytes };
        icons.set(`yt:${id}`, cached);
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': cached.type, 'content-length': cached.bytes.length, 'cache-control': 'private, max-age=86400' });
      return res.end(cached.bytes);
    }
    if (route.startsWith('/api/icon/')) {
      if (req.method !== 'GET') throw new UserError('Metoden støttes ikke.', 405);
      let id;
      try { id = validAppId(decodeURIComponent(route.slice('/api/icon/'.length))); } catch { throw new UserError('Ukjent app.', 400); }
      const { type, bytes } = await icon(id);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': bytes.length, 'cache-control': 'private, max-age=86400' });
      return res.end(bytes);
    }
    if (route === '/api/inputs') {
      if (req.method !== 'GET') throw new UserError('Metoden støttes ikke.', 405);
      if (!selected) throw new UserError('Velg en TV først.', 409);
      if (tvSession()) return sendJson(res, 200, { inputs: await tvSession().inputs() });
      // Roku: innganger er «apper» av typen tvin (HDMI, antenne).
      if (!rokuAppList.length) rokuAppList = await withRoku(() => rokuApps(selected.host, { fetchImpl }));
      return sendJson(res, 200, { inputs: rokuAppList.filter((app) => app.id.startsWith('tvinput.')).map(({ id, name }) => ({ id, name, connected: true })) });
    }
    if (route === '/api/status' || route === '/api/apps' || route === '/api/diagnostics') {
      if (req.method !== 'GET') throw new UserError('Metoden støttes ikke.', 405);
      if (route === '/api/status') return sendJson(res, 200, await status());
      if (route === '/api/diagnostics') {
        return sendJson(res, 200, { about: `Fjern ${version} · Node ${process.version} · ${process.platform}`, lines: diagnostics.lines.slice() });
      }
      if (!selected) throw new UserError('Velg en TV først.', 409);
      const apps = tvSession() ? await tvSession().apps() : await withRoku(() => rokuApps(selected.host, { fetchImpl }));
      if (selected.type === 'roku') rokuAppList = apps;
      return sendJson(res, 200, { apps });
    }
    if (req.method !== 'POST') throw new UserError('Metoden støttes ikke.', 405);
    const input = await readJson(req);

    switch (route) {
      case '/api/scan':
        return sendJson(res, 200, { devices: await discover() });
      case '/api/connect': {
        const device = validDevice(input.device);
        if (device.type === 'roku') {
          const probed = await rokuProbe(device.host, { fetchImpl });
          disconnectOthers('roku');
          selected = probed;
          rokuAppList = [];
          markRoku(true);
        } else {
          disconnectOthers(device.type);
          selected = device;
          log(`${LABELS[device.type]}: kobler til ${device.host}`);
          await tvSession(device).connect(device.host);
        }
        return sendJson(res, 200, await status());
      }
      case '/api/repair': {
        // «Par på nytt» etter endret sertifikat: glem lagret nøkkel/token og avtrykk, og koble til.
        const tv = tvSession();
        if (!tv) throw new UserError('Bare LG, Samsung og Android TV kan pares på nytt.', 409);
        await tv.forget(selected.host);
        await tv.connect(selected.host);
        return sendJson(res, 200, await status());
      }
      case '/api/pair': {
        // Android TV: koden som vises på skjermen under paring.
        if (selected?.type !== 'androidtv') throw new UserError('Bare Android TV pares med kode.', 409);
        await androidtv.finishPairing(String(input.code ?? '').slice(0, 12));
        return sendJson(res, 200, await status());
      }
      case '/api/input': {
        if (!selected) throw new UserError('Velg en TV først.', 409);
        const id = validInputId(input.id);
        if (tvSession()) await tvSession().switchInput(id);
        else {
          if (!rokuAppList.some((app) => app.id === id && id.startsWith('tvinput.'))) throw new UserError('Ukjent inngang.', 404);
          await withRoku(() => rokuLaunch(selected.host, id, { fetchImpl }));
        }
        return sendJson(res, 200, { ok: true });
      }
      case '/api/ytsuggest':
        return sendJson(res, 200, { suggestions: await suggestYoutube(validQuery(input.query), { fetchImpl }) });
      case '/api/ytsearch':
        return sendJson(res, 200, { videos: await searchYoutube(validQuery(input.query), { fetchImpl }) });
      case '/api/ytplay': {
        if (!selected) throw new UserError('Velg en TV først.', 409);
        const id = validVideoId(input.id);
        if (tvSession()) await tvSession().playYoutube(id);
        else await withRoku(() => rokuPlayYoutube(selected.host, id, { fetchImpl }));
        return sendJson(res, 200, { ok: true });
      }
      case '/api/launch': {
        if (!selected) throw new UserError('Velg en TV først.', 409);
        const id = validAppId(input.id);
        if (tvSession()) await tvSession().launch(id);
        else {
          if (!rokuAppList.some((app) => app.id === id)) throw new UserError('Ukjent app.', 404);
          await withRoku(() => rokuLaunch(selected.host, id, { fetchImpl }));
        }
        return sendJson(res, 200, { ok: true });
      }
      case '/api/command': {
        if (!selected) throw new UserError('Velg en TV først.', 409);
        const key = validCommand(input.key);
        const tv = tvSession();
        if (tv) {
          if (key === 'PowerOn') await tv.powerOn(selected.host);
          else await tv.command(key);
        } else {
          await withRoku(() => rokuCommand(selected.host, key, { fetchImpl }));
        }
        return sendJson(res, 200, { ok: true });
      }
      case '/api/text': {
        if (!selected) throw new UserError('Velg en TV først.', 409);
        const text = validText(input.text);
        if (tvSession()) await tvSession().text(text);
        else await withRoku(() => rokuText(selected.host, text, { fetchImpl }));
        return sendJson(res, 200, { ok: true });
      }
      default:
        throw new UserError('Ukjent adresse.', 404);
    }
  }

  async function serveStatic(req, res, route) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new UserError('Metoden støttes ikke.', 405);
    let relative;
    try {
      relative = route === '/' ? 'index.html' : decodeURIComponent(route).replace(/^\/+/, '');
    } catch {
      throw new UserError('Ugyldig adresse.', 400);
    }
    const target = path.resolve(publicDir, relative);
    if (!target.startsWith(publicDir + path.sep)) throw new UserError('Ikke tillatt.', 403);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      throw new UserError('Finnes ikke.', 404);
    }
    if (!stat.isFile()) throw new UserError('Finnes ikke.', 404);
    const ext = path.extname(target);
    // HTML og service worker må alltid revalideres, ellers ser brukeren gamle versjoner.
    const fresh = ext === '.html' || relative === 'sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MEDIA.get(ext) || 'application/octet-stream',
      'cache-control': fresh ? 'no-cache' : 'public, max-age=3600',
      'content-length': stat.size,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(await fs.readFile(target));
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    // Host-sjekken stopper DNS-rebinding, Origin-sjekken stopper forespørsler fra andre nettsider.
    if (!allowedHosts.includes(req.headers.host)) return sendJson(res, 403, { error: 'Kun lokal tilkobling er tillatt.' });
    if (req.headers.origin && !allowedHosts.map((h) => `http://${h}`).includes(req.headers.origin)) {
      return sendJson(res, 403, { error: 'Ugyldig opphav.' });
    }
    const route = new URL(req.url, 'http://localhost').pathname;
    try {
      if (route.startsWith('/api/')) await api(req, res, route);
      else await serveStatic(req, res, route);
    } catch (error) {
      const { status, message, internal } = toUserMessage(error);
      if (internal) log(`Feil i ${req.method} ${route}: ${error?.stack || error}`);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.destroy();
    }
  });

  server.on('close', () => Object.values(sessions).forEach((session) => session.disconnect()));
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || 8765);
  const server = createBridge();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} er allerede i bruk. Kjører broen allerede?` : error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Fjern kjører: http://localhost:${port}`));
}
