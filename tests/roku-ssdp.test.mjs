import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESPONSE_BYTES, ROKU_EXTRA_KEYS, ROKU_KEYS, parseRokuApps, readLimited, rokuCommand, rokuPlayYoutube, rokuProbe, rokuText } from '../lib/roku.mjs';
import { LG_BUTTONS, LG_EXTRA_KEYS, LG_REQUESTS } from '../lib/lg.mjs';
import { COMMANDS } from '../lib/validate.mjs';
import { MAX_DEVICES, classify, createCollector, createDiscovery } from '../lib/ssdp.mjs';
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

test('alle kommandoer støttes av minst én TV-type, og capabilities stemmer med tastene', () => {
  const lgSupports = (key) => Boolean(LG_BUTTONS[key] || LG_REQUESTS[key] || key === 'Mute' || key === 'PowerOn');
  for (const command of COMMANDS) assert.ok(ROKU_KEYS[command] || lgSupports(command), command);
  for (const key of ROKU_EXTRA_KEYS) assert.ok(ROKU_KEYS[key], `Roku mangler ${key}`);
  for (const key of LG_EXTRA_KEYS) assert.ok(lgSupports(key), `LG mangler ${key}`);
  assert.equal(ROKU_KEYS.Num7, 'Lit_7');
  assert.equal(ROKU_KEYS.PlayPause, 'Play', 'Roku har én play/pause-tast');
  assert.equal(LG_BUTTONS.Guide, 'PROGRAM');
  assert.equal(LG_BUTTONS.Settings, 'MENU');
  assert.equal(LG_BUTTONS.Red, 'RED');
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
  const { impl } = fakeFetch(() => ok('<device-info><user-device-name>Stue &amp; kjøkken</user-device-name><is-tv>true</is-tv></device-info>'));
  assert.deepEqual(await rokuProbe('192.168.1.5', { fetchImpl: impl }), { type: 'roku', host: '192.168.1.5', name: 'Stue & kjøkken', isTv: true });
  assert.equal((await rokuProbe('192.168.1.7', { fetchImpl: fakeFetch(() => ok('<device-info/>')).impl })).name, 'Roku');
  const player = fakeFetch(() => ok('<device-info><is-tv>false</is-tv></device-info>'));
  assert.equal((await rokuProbe('192.168.1.6', { fetchImpl: player.impl })).isTv, false);
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

test('store svar fra lokalnettet avvises', async () => {
  const big = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
  await assert.rejects(readLimited({ text: async () => big }), UserError);
  const stream = new Response(big);
  await assert.rejects(readLimited(stream), UserError);
  assert.equal(await readLimited(new Response('liten')), 'liten');
});

test('Roku-applisten parses med gyldige id-er og tak', () => {
  const xml = '<apps><app id="12" type="appl">Netflix</app><app id="837" type="appl">YouTube &amp; mer</app><app id="bad id" type="appl">X</app></apps>';
  assert.deepEqual(parseRokuApps(xml), [{ id: '12', name: 'Netflix', system: false, color: null }, { id: '837', name: 'YouTube & mer', system: false, color: null }]);
  assert.equal(parseRokuApps('<app id="tvinput.hdmi1" type="tvin">HDMI 1</app>')[0].system, true, 'innganger sorteres som system');
  const many = Array.from({ length: 100 }, (_, i) => `<app id="${i}">A${i}</app>`).join('');
  assert.equal(parseRokuApps(many).length, 48);
});

test('SSDP-søket godtar maks 32 enheter, uten duplikater', () => {
  const collector = createCollector();
  for (let i = 0; i < 300; i++) collector.add('ST: roku:ecp', `192.168.${i >> 8}.${i & 255}`);
  collector.add('ST: roku:ecp', '192.168.0.0');
  assert.equal(collector.devices().length, MAX_DEVICES);
});

test('ikoner: bare ekte bildeformater godtas', async () => {
  const { sniffImage } = await import('../lib/icons.mjs');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(sniffImage(Buffer.from('ffd8ffe000104a4649460001', 'hex')), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html><body>x</body></html>')), null);
  assert.equal(sniffImage(Buffer.alloc(3)), null);
});

test('ikoner: henting har tak på størrelse og sjekker svarstatus', async () => {
  const http = await import('node:http');
  const { fetchBytes, MAX_ICON_BYTES } = await import('../lib/icons.mjs');
  const server = http.createServer((req, res) => {
    if (req.url === '/stor') { res.end(Buffer.alloc(MAX_ICON_BYTES + 10)); return; }
    if (req.url === '/mangler') { res.writeHead(404); res.end(); return; }
    res.end(Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetchBytes(`${base}/ok`)).length, 12);
    await assert.rejects(fetchBytes(`${base}/stor`), /for stort/);
    await assert.rejects(fetchBytes(`${base}/mangler`), UserError);
  } finally {
    server.close();
  }
});

test('Roku: YouTube-video via dyplenke til YouTube-kanalen', async () => {
  const { impl, calls } = fakeFetch(() => ok());
  await rokuPlayYoutube('192.168.1.5', 'rFZHOHl-L8A', { fetchImpl: impl });
  assert.deepEqual(calls[0], { url: 'http://192.168.1.5:8060/launch/837?contentID=rFZHOHl-L8A&mediaType=movie', method: 'POST' });
  await assert.rejects(rokuCommand('192.168.1.5', 'Red', { fetchImpl: impl }), /støttes ikke av Roku/);
});

