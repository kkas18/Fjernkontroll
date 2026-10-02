import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge, SECURITY_HEADERS } from '../server.mjs';
import { UserError } from '../lib/errors.mjs';

const calls = [];
let rokuOnline = true;

const fakeLg = {
  ready: false,
  state: 'Frakoblet',
  code: null,
  canWake: false,
  async connect(host) { calls.push(['lg-connect', host]); this.ready = true; this.state = 'Tilkoblet'; this.code = null; },
  disconnect() { this.ready = false; this.state = 'Frakoblet'; },
  async command(key) { calls.push(['lg', key]); if (key === 'PowerOff') throw new UserError('TV-en avviste kommandoen.', 502); },
  async powerOn(host) { calls.push(['lg-wake', host]); },
  async text(value) { calls.push(['lg-text', value]); },
  model: null,
  async apps() { return [{ id: 'netflix', name: 'Netflix', system: false, color: null }]; },
  async inputs() { return [{ id: 'HDMI_1', name: 'HDMI 1', connected: true }]; },
  async switchInput(id) { calls.push(['lg-input', id]); },
  async playYoutube(id) { calls.push(['lg-yt', id]); },
  iconUrl(id) { return id === 'netflix' ? `http://127.0.0.1:${iconPort}/netflix.png` : null; },
  async launch(id) { if (id !== 'netflix') throw new UserError('Ukjent app.', 404); calls.push(['lg-launch', id]); },
  async forget(host) { calls.push(['lg-forget', host]); },
};

const fakeSamsung = {
  ready: false,
  state: 'Frakoblet',
  code: null,
  canWake: true,
  model: null,
  disconnects: 0,
  async connect(host) { calls.push(['samsung-connect', host]); this.ready = true; this.state = 'Tilkoblet'; this.model = 'Samsung QE55Q80B'; },
  disconnect() { this.disconnects += 1; this.ready = false; this.state = 'Frakoblet'; this.model = null; },
  async command(key) { calls.push(['samsung', key]); },
  async powerOn(host) { calls.push(['samsung-wake', host]); },
  async text(value) { calls.push(['samsung-text', value]); },
  async apps() { return [{ id: '3201907018807', name: 'Netflix', system: false, color: null }]; },
  async launch(id) { calls.push(['samsung-launch', id]); },
  async inputs() { return [{ id: 'KEY_HDMI1', name: 'HDMI 1', connected: true }]; },
  async switchInput(id) { calls.push(['samsung-input', id]); },
  async playYoutube(id) { calls.push(['samsung-yt', id]); },
  iconUrl: () => null,
  async forget(host) { calls.push(['samsung-forget', host]); },
};

const fakeFetch = async (url, options = {}) => {
  calls.push(['fetch', options.method || 'GET', url]);
  if (url.startsWith('https://www.youtube.com/results')) {
    const video = { videoId: 'n61ULEU7CO0', title: { runs: [{ text: 'Lofi' }] }, lengthText: { simpleText: '3:00' } };
    return new Response(`<script>var ytInitialData = ${JSON.stringify({ a: [{ videoRenderer: video }] })};</script>`);
  }
  if (url.includes('192.168.1.99')) throw Object.assign(new Error('Tidsavbrudd'), { name: 'TimeoutError' });
  if (!rokuOnline) throw new TypeError('fetch failed');
  if (url.endsWith('/query/apps')) return new Response('<apps><app id="12">Netflix</app></apps>');
  if (url.endsWith('/query/icon/12')) return new Response(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  return new Response('<user-device-name>Roku Stue</user-device-name><is-tv>false</is-tv>');
};

let server;
let port;
let iconServer;
let iconPort;
before(async () => {
  // Etterligner TV-ens ikonserver: ett ekte PNG-hode og én «ikon»-fil som egentlig er HTML.
  iconServer = http.createServer((req, res) => {
    res.end(req.url === '/netflix.png' ? Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') : '<html>ikke et bilde</html>');
  });
  await new Promise((resolve) => iconServer.listen(0, '127.0.0.1', resolve));
  iconPort = iconServer.address().port;
  server = createBridge({
    lg: fakeLg,
    samsung: fakeSamsung,
    keyStore: { protect: async () => {} },
    fetchImpl: fakeFetch,
    discover: async () => [{ type: 'roku', host: '192.168.1.5', name: 'Roku' }],
    rokuHealthTtl: 0,
    diagnostics: (() => { const lines = []; return { lines, log: (m) => lines.push(`00:00:00 ${m}`) }; })(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => {
  server.close();
  iconServer.close();
});

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { /* ikke JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const post = (path, body = {}) => request(path, { method: 'POST', body });

test('serverer appen fra public/ med sikkerhetshoder', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-cache');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name], value, name);
  assert.match(SECURITY_HEADERS['content-security-policy'], /img-src 'self';/);
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/logic.js')).status, 200);
  assert.equal((await request('/sw.js')).headers['cache-control'], 'no-cache');
});

test('avviser fremmed Host og Origin', async () => {
  assert.equal((await request('/', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { origin: `http://localhost:${port}` } })).status, 200);
});

test('slipper ikke ut filer utenfor public/', async () => {
  assert.equal((await request('/..%2Fserver.mjs')).status, 403);
  assert.equal((await request('/%2e%2e%2fdata%2flg-keys.json')).status, 403);
  assert.equal((await request('/%E0%A4%A')).status, 400);
  assert.equal((await request('/finnes-ikke.js')).status, 404);
});

test('ugyldig JSON og ukjente ruter gir norske feil', async () => {
  const bad = await request('/api/scan', { method: 'POST', body: '{ugyldig' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'Ugyldig forespørsel.');
  assert.equal((await post('/api/finnes-ikke')).status, 404);
  assert.equal((await request('/api/command')).status, 405);
  assert.equal((await request('/api/scan', { method: 'POST', body: 'x'.repeat(20_000) })).status, 413);
});

test('Roku: capabilities, ECP-taster, tekst og helsesjekk', async () => {
  rokuOnline = true;
  const connect = await post('/api/connect', { device: { type: 'roku', host: '192.168.1.5' } });
  assert.equal(connect.status, 200);
  assert.deepEqual(connect.json.device, { type: 'roku', host: '192.168.1.5', name: 'Roku Stue' });
  assert.equal(connect.json.ready, true);
  assert.equal(connect.json.capabilities.playPause, 'single');
  assert.equal(connect.json.capabilities.channels, false);
  assert.equal(connect.json.capabilities.powerOn, false);
  assert.equal(connect.json.capabilities.search, 'youtube');
  assert.ok(connect.json.capabilities.keys.includes('Num1'));
  assert.ok(!connect.json.capabilities.keys.includes('Red'), 'Roku har ikke fargetaster');

  calls.length = 0;
  assert.equal((await post('/api/command', { key: 'FastForward' })).status, 200);
  assert.deepEqual(calls.at(-1), ['fetch', 'POST', 'http://192.168.1.5:8060/keypress/Fwd']);
  assert.equal((await post('/api/command', { key: 'Backspace' })).status, 200);
  assert.deepEqual(calls.at(-1), ['fetch', 'POST', 'http://192.168.1.5:8060/keypress/Backspace']);
  assert.equal((await post('/api/text', { text: 'ab' })).status, 200);
  assert.equal((await post('/api/command', { key: 'rm -rf' })).json.error, 'Ukjent kommando.');

  rokuOnline = false;
  const offline = await request('/api/status');
  assert.equal(offline.json.ready, false);
  assert.equal(offline.json.code, 'unreachable');
  assert.match(offline.json.state, /Roku svarer ikke/);
  rokuOnline = true;
  assert.equal((await request('/api/status')).json.ready, true);
});

test('Roku: apper hentes og bare kjente apper kan startes', async () => {
  await post('/api/connect', { device: { type: 'roku', host: '192.168.1.5' } });
  assert.equal((await post('/api/launch', { id: '12' })).status, 404, 'må hente listen først');
  assert.deepEqual((await request('/api/apps')).json.apps, [{ id: '12', name: 'Netflix', system: false, color: null }]);
  assert.equal((await post('/api/launch', { id: '12' })).status, 200);
  assert.deepEqual(calls.at(-1), ['fetch', 'POST', 'http://192.168.1.5:8060/launch/12']);
  assert.equal((await post('/api/launch', { id: '../x' })).status, 400);
});

test('tidsavbrudd mot TV gir 504 med norsk melding', async () => {
  const res = await post('/api/connect', { device: { type: 'roku', host: '192.168.1.99' } });
  assert.equal(res.status, 504);
  assert.match(res.json.error, /svarte ikke i tide/);
});

test('LG: kobler til, capabilities, feil, slå på, apper og ny paring', async () => {
  const connect = await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42', name: 'Stue' } });
  assert.deepEqual(connect.json.device, { type: 'lg', host: '192.168.1.42', name: 'Stue' });
  assert.equal(connect.json.ready, true);
  assert.equal(connect.json.capabilities.playPause, 'single');
  assert.equal(connect.json.capabilities.inputs, true);
  for (const key of ['Num0', 'Red', 'Blue', 'Guide', 'Settings', 'Info']) assert.ok(connect.json.capabilities.keys.includes(key), key);
  assert.equal((await post('/api/command', { key: 'Up' })).status, 200);

  const power = await post('/api/command', { key: 'PowerOff' });
  assert.equal(power.status, 502);
  assert.equal(power.json.error, 'TV-en avviste kommandoen.');

  calls.length = 0;
  assert.equal((await post('/api/command', { key: 'PowerOn' })).status, 200);
  assert.deepEqual(calls.at(-1), ['lg-wake', '192.168.1.42']);

  assert.deepEqual((await request('/api/apps')).json.apps, [{ id: 'netflix', name: 'Netflix', system: false, color: null }]);
  assert.equal((await post('/api/launch', { id: 'netflix' })).status, 200);

  calls.length = 0;
  const repair = await post('/api/repair');
  assert.equal(repair.status, 200);
  assert.deepEqual(calls, [['lg-forget', '192.168.1.42'], ['lg-connect', '192.168.1.42']]);
});

test('Samsung: kobler til, capabilities, taster, apper, innganger, YouTube, tekst og ny paring', async () => {
  const connect = await post('/api/connect', { device: { type: 'samsung', host: '192.168.1.50', name: 'Samsung-TV' } });
  assert.equal(connect.status, 200);
  assert.deepEqual(connect.json.device, { type: 'samsung', host: '192.168.1.50', name: 'Samsung QE55Q80B' }, 'modellnavnet erstatter standardnavnet');
  assert.equal(connect.json.ready, true);
  assert.equal(connect.json.capabilities.powerOn, true);
  assert.ok(connect.json.capabilities.keys.includes('Blue'));
  assert.ok(!connect.json.capabilities.keys.includes('Recent'), 'Samsung har ingen «siste apper»-tast');
  assert.equal(fakeLg.ready, false, 'LG kobles fra når Samsung velges');

  calls.length = 0;
  await post('/api/command', { key: 'Up' });
  await post('/api/command', { key: 'PowerOn' });
  await post('/api/launch', { id: '3201907018807' });
  await post('/api/input', { id: 'KEY_HDMI1' });
  await post('/api/ytplay', { id: 'n61ULEU7CO0' });
  await post('/api/text', { text: 'hei' });
  assert.deepEqual(calls, [
    ['samsung', 'Up'], ['samsung-wake', '192.168.1.50'], ['samsung-launch', '3201907018807'],
    ['samsung-input', 'KEY_HDMI1'], ['samsung-yt', 'n61ULEU7CO0'], ['samsung-text', 'hei'],
  ]);
  assert.deepEqual((await request('/api/apps')).json.apps.map((a) => a.name), ['Netflix']);
  assert.deepEqual((await request('/api/inputs')).json.inputs.map((i) => i.id), ['KEY_HDMI1']);
  assert.equal((await request('/api/icon/3201907018807')).status, 404, 'merkefarge i stedet for ikon');

  calls.length = 0;
  assert.equal((await post('/api/repair')).status, 200);
  assert.deepEqual(calls, [['samsung-forget', '192.168.1.50'], ['samsung-connect', '192.168.1.50']]);

  const before = fakeSamsung.disconnects;
  await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42' } });
  assert.equal(fakeSamsung.disconnects, before + 1, 'Samsung kobles fra når LG velges');
});

test('ny paring er ikke for Roku', async () => {
  await post('/api/connect', { device: { type: 'roku', host: '192.168.1.5' } });
  assert.equal((await post('/api/repair')).status, 409);
});

test('feilsøkingsloggen viser versjon og hendelser', async () => {
  await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42' } });
  const res = await request('/api/diagnostics');
  assert.equal(res.status, 200);
  assert.match(res.json.about, /^Fjern \d+\.\d+\.\d+ · Node /);
  assert.ok(res.json.lines.some((line) => line.includes('LG: kobler til 192.168.1.42')));
});

test('ikoner: hentes fra TV-en, sjekkes som bilde og mellomlagres', async () => {
  await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42' } });
  const res = await request('/api/icon/netflix');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.match(res.headers['cache-control'], /private/);
  assert.ok(res.headers['content-security-policy']);
  assert.equal((await request('/api/icon/ukjent')).status, 404);
  assert.equal((await request('/api/icon/..%2F..%2Fetc')).status, 400);

  await post('/api/connect', { device: { type: 'roku', host: '192.168.1.5' } });
  assert.equal((await request('/api/icon/12')).status, 404, 'Roku: bare apper fra listen');
  await request('/api/apps');
  const roku = await request('/api/icon/12');
  assert.equal(roku.status, 200);
  assert.equal(roku.headers['content-type'], 'image/png');
});

test('LG: modellnavnet erstatter standardnavnet, men ikke et eget navn', async () => {
  fakeLg.model = 'LG OLED55C14LB';
  assert.equal((await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42', name: 'LG-TV' } })).json.device.name, 'LG OLED55C14LB');
  assert.equal((await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42', name: 'LG webOS · 192.168.1.42' } })).json.device.name, 'LG OLED55C14LB');
  assert.equal((await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42', name: 'Soverom' } })).json.device.name, 'Soverom');
  fakeLg.model = null;
});

test('søk og innganger', async () => {
  await post('/api/connect', { device: { type: 'lg', host: '192.168.1.42' } });
  const search = await post('/api/ytsearch', { query: '  lofi  ' });
  assert.equal(search.status, 200);
  assert.deepEqual(search.json.videos, [{ id: 'n61ULEU7CO0', title: 'Lofi', channel: '', duration: '3:00', views: '' }]);
  assert.equal((await post('/api/ytsearch', { query: '   ' })).status, 400);
  calls.length = 0;
  assert.equal((await post('/api/ytplay', { id: 'n61ULEU7CO0' })).status, 200);
  assert.deepEqual(calls.at(-1), ['lg-yt', 'n61ULEU7CO0']);
  assert.equal((await post('/api/ytplay', { id: 'x&y' })).status, 400);
  assert.equal((await request('/api/ytthumb/..%2F..%2Fetc')).status, 400);
  assert.deepEqual((await request('/api/inputs')).json.inputs, [{ id: 'HDMI_1', name: 'HDMI 1', connected: true }]);
  assert.equal((await post('/api/input', { id: 'HDMI_1' })).status, 200);
  assert.equal((await post('/api/input', { id: '../x' })).status, 400);
  assert.equal((await post('/api/command', { key: 'Guide' })).status, 200);

  await post('/api/connect', { device: { type: 'roku', host: '192.168.1.5' } });
  calls.length = 0;
  assert.equal((await post('/api/ytplay', { id: 'n61ULEU7CO0' })).status, 200);
  assert.equal(calls.at(-1)[2], 'http://192.168.1.5:8060/launch/837?contentID=n61ULEU7CO0&mediaType=movie');
});

test('lokale IP-er er påkrevd', async () => {
  const res = await post('/api/connect', { device: { type: 'roku', host: '8.8.8.8' } });
  assert.equal(res.status, 400);
});
