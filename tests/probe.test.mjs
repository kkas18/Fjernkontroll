import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { identifyTv, NOT_FOUND, PROBE_PORTS, tcpOpen } from '../lib/probe.mjs';
import { UserError } from '../lib/errors.mjs';

const ROKU_XML = '<device-info><user-device-name>Stue-Roku</user-device-name><is-tv>true</is-tv></device-info>';
const SAMSUNG_JSON = JSON.stringify({ device: { name: '[TV] Samsung Q80', modelName: 'QE55Q80', wifiMac: 'aa:bb:cc:dd:ee:ff' } });

// Falsk nettverk: hvilke tjenester som «svarer» på adressen.
function network({ roku = false, samsung = false, open = [] } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes(':8060/') && roku) return new Response(ROKU_XML);
      if (url.includes(':8001/') && samsung) return new Response(SAMSUNG_JSON);
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
    portOpen: async (host, port) => {
      calls.push(`tcp:${port}`);
      return open.includes(port);
    },
  };
}

test('Roku, Samsung, Android TV og LG gjenkjennes fra IP-adressen alene', async () => {
  let net1 = network({ roku: true, open: [3000] });
  assert.deepEqual(await identifyTv('192.168.1.5', net1), { type: 'roku', host: '192.168.1.5', name: 'Stue-Roku', isTv: true });
  net1 = network({ samsung: true });
  assert.deepEqual(await identifyTv('192.168.1.50', net1), { type: 'samsung', host: '192.168.1.50', name: 'Samsung Q80' });
  net1 = network({ open: [6466] });
  assert.deepEqual(await identifyTv('192.168.1.60', net1), { type: 'androidtv', host: '192.168.1.60', name: 'Android TV' });
  net1 = network({ open: [3001] });
  assert.deepEqual(await identifyTv('192.168.1.42', net1), { type: 'lg', host: '192.168.1.42', name: 'LG-TV' });
  net1 = network({ open: [3000] });
  assert.equal((await identifyTv('192.168.1.42', net1)).type, 'lg', 'eldre LG uten TLS (port 3000)');
});

test('alle kjennetegn sjekkes samtidig, og det mest entydige vinner', async () => {
  // En Android TV-basert TV som også har en åpen port 3000: fjernkontrolltjenesten (6466) avgjør.
  const both = network({ open: [6466, 3000] });
  assert.equal((await identifyTv('192.168.1.61', both)).type, 'androidtv');
  for (const expected of [':8060/', ':8001/', 'tcp:6466', 'tcp:3001', 'tcp:3000']) {
    assert.ok(both.calls.some((call) => call.includes(expected)), expected);
  }
  assert.deepEqual(PROBE_PORTS, { androidtv: [6466], lg: [3001, 3000] });
});

test('ingen TV på adressen gir en tydelig melding, og bare lokale adresser godtas', async () => {
  await assert.rejects(identifyTv('192.168.1.99', network()), (error) => error instanceof UserError && error.status === 404 && error.message === NOT_FOUND);
  for (const bad of ['8.8.8.8', 'localhost', '', '192.168.1']) {
    await assert.rejects(identifyTv(bad, network()), UserError, bad);
  }
});

test('tcpOpen: åpen port gir true, lukket port gir false', async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await tcpOpen('127.0.0.1', port, 1000), true);
  server.close();
  await new Promise((resolve) => server.once('close', resolve));
  assert.equal(await tcpOpen('127.0.0.1', port, 1000), false);
});
