import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge, SECURITY_HEADERS } from '../server.mjs';
import { UserError } from '../lib/errors.mjs';

const calls = [];
const fakeLg = {
  ready: false,
  state: 'Frakoblet',
  async connect(host) { this.host = host; this.ready = true; this.state = 'Tilkoblet'; },
  disconnect() { this.ready = false; this.state = 'Frakoblet'; },
  async command(key) { calls.push(['lg', key]); if (key === 'PowerOff') throw new UserError('TV-en avviste kommandoen.', 502); },
  async text(value) { calls.push(['lg-text', value]); },
};
const fakeFetch = async (url, options = {}) => {
  calls.push(['fetch', options.method || 'GET', url]);
  if (url.includes('192.168.1.99')) throw Object.assign(new Error('Tidsavbrudd'), { name: 'TimeoutError' });
  return { ok: true, text: async () => '<user-device-name>Roku Stue</user-device-name>' };
};

let server;
let port;
before(async () => {
  server = createBridge({ lg: fakeLg, fetchImpl: fakeFetch, discover: async () => [{ type: 'roku', host: '192.168.1.5', name: 'Roku' }], log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => server.close());

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

test('serverer appen fra public/ med sikkerhetshoder', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-cache');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name], value, name);
  assert.equal((await request('/app.js')).status, 200);
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
  assert.equal((await request('/api/finnes-ikke', { method: 'POST', body: {} })).status, 404);
  assert.equal((await request('/api/command', { method: 'GET' })).status, 405);
  assert.equal((await request('/api/scan', { method: 'POST', body: 'x'.repeat(20_000) })).status, 413);
});

test('Roku: kobler til, sender ECP-taster og tekst', async () => {
  const connect = await request('/api/connect', { method: 'POST', body: { device: { type: 'roku', host: '192.168.1.5' } } });
  assert.equal(connect.status, 200);
  assert.deepEqual(connect.json, { device: { type: 'roku', host: '192.168.1.5', name: 'Roku Stue' }, ready: true, state: 'Tilkoblet' });
  calls.length = 0;
  assert.equal((await request('/api/command', { method: 'POST', body: { key: 'FastForward' } })).status, 200);
  assert.deepEqual(calls.at(-1), ['fetch', 'POST', 'http://192.168.1.5:8060/keypress/Fwd']);
  assert.equal((await request('/api/text', { method: 'POST', body: { text: 'ab' } })).status, 200);
  assert.equal(calls.length, 3);
  assert.equal((await request('/api/command', { method: 'POST', body: { key: 'rm -rf' } })).json.error, 'Ukjent kommando.');
});

test('tidsavbrudd mot TV gir 504 med norsk melding', async () => {
  const res = await request('/api/connect', { method: 'POST', body: { device: { type: 'roku', host: '192.168.1.99' } } });
  assert.equal(res.status, 504);
  assert.match(res.json.error, /svarte ikke i tide/);
});

test('LG: kobler til, status og feil fra TV-en videreformidles', async () => {
  const connect = await request('/api/connect', { method: 'POST', body: { device: { type: 'lg', host: '192.168.1.42', name: 'Stue' } } });
  assert.deepEqual(connect.json, { device: { type: 'lg', host: '192.168.1.42', name: 'Stue' }, ready: true, state: 'Tilkoblet' });
  assert.equal((await request('/api/status')).json.ready, true);
  assert.equal((await request('/api/command', { method: 'POST', body: { key: 'Up' } })).status, 200);
  const power = await request('/api/command', { method: 'POST', body: { key: 'PowerOff' } });
  assert.equal(power.status, 502);
  assert.equal(power.json.error, 'TV-en avviste kommandoen.');
});

test('lokale IP-er er påkrevd', async () => {
  const res = await request('/api/connect', { method: 'POST', body: { device: { type: 'roku', host: '8.8.8.8' } } });
  assert.equal(res.status, 400);
});
