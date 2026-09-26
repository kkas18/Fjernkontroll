import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROKU_KEYS, rokuCommand, rokuProbe, rokuText } from '../lib/roku.mjs';
import { COMMANDS } from '../lib/validate.mjs';
import { classify, createDiscovery } from '../lib/ssdp.mjs';
import { UserError } from '../lib/errors.mjs';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    return handler(url, options);
  };
  return { impl, calls };
}
const ok = (body = '') => ({ ok: true, text: async () => body });

test('alle appkommandoer har en gyldig Roku ECP-tast', () => {
  for (const command of COMMANDS) assert.ok(ROKU_KEYS[command], command);
  assert.equal(ROKU_KEYS.Rewind, 'Rev');
  assert.equal(ROKU_KEYS.FastForward, 'Fwd');
  assert.equal(ROKU_KEYS.Pause, 'Play');
  assert.equal(ROKU_KEYS.Mute, 'VolumeMute');
});

test('rokuCommand sender riktig ECP-tast', async () => {
  const { impl, calls } = fakeFetch(() => ok());
  await rokuCommand('192.168.1.5', 'Rewind', { fetchImpl: impl });
  assert.deepEqual(calls, [{ url: 'http://192.168.1.5:8060/keypress/Rev', method: 'POST' }]);
});

test('rokuCommand gir norsk feil når TV-en avviser', async () => {
  const { impl } = fakeFetch(() => ({ ok: false }));
  await assert.rejects(rokuCommand('192.168.1.5', 'Up', { fetchImpl: impl }), (e) => e instanceof UserError && /avviste/.test(e.message));
});

test('rokuText sender tegn for tegn og stopper ved første feil', async () => {
  let n = 0;
  const { impl, calls } = fakeFetch(() => (++n === 2 ? { ok: false } : ok()));
  await assert.rejects(rokuText('192.168.1.5', 'æb c', { fetchImpl: impl }), UserError);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://192.168.1.5:8060/keypress/Lit_%C3%A6');
});

test('rokuProbe leser og dekoder navnet', async () => {
  const { impl } = fakeFetch(() => ok('<device-info><user-device-name>Stue &amp; kjøkken</user-device-name></device-info>'));
  assert.deepEqual(await rokuProbe('192.168.1.5', { fetchImpl: impl }), { type: 'roku', host: '192.168.1.5', name: 'Stue & kjøkken' });
});

test('rokuProbe oversetter nettverksfeil til norsk', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(rokuProbe('192.168.1.5', { fetchImpl: impl }), (e) => e instanceof UserError && /Roku/.test(e.message));
});

test('classify gjenkjenner Roku og LG, og ignorerer offentlige adresser', () => {
  assert.equal(classify('ST: roku:ecp', '192.168.1.2')?.type, 'roku');
  assert.equal(classify('SERVER: WebOS/4.1', '10.0.0.3')?.type, 'lg');
  assert.equal(classify('ST: roku:ecp', '8.8.8.8'), null);
  assert.equal(classify('SERVER: Sonos', '192.168.1.9'), null);
});

test('samtidige søk deler ett SSDP-søk', async () => {
  const discover = createDiscovery({ waitMs: 20, log: () => {} });
  const first = discover();
  const second = discover();
  assert.equal(first, second);
  assert.ok(Array.isArray(await first));
  assert.notEqual(discover(), first, 'nytt søk etter at det forrige er ferdig');
});
