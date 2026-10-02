import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  NO_WAKE, REMOTE_NAME, SAMSUNG_EXTRA_KEYS, SAMSUNG_INPUTS, SAMSUNG_KEYS, SAMSUNG_STATE, YOUTUBE_APP_ID,
  createSamsungSession, keyMessage, parseApps, remoteUrl, samsungInfo, samsungProbe, storeKey,
} from '../lib/samsung.mjs';
import { classify } from '../lib/ssdp.mjs';
import { COMMANDS } from '../lib/validate.mjs';
import { UserError } from '../lib/errors.mjs';

const HOST = '192.168.1.50';
const TV_CERT = 'SA:MS:UN:G0';
const KEY = storeKey(HOST);

const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const INFO = {
  device: { name: '[TV] Stue', modelName: 'QE55Q80B', wifiMac: 'A0:D0:5B:01:02:03', TokenAuthSupport: 'true', PowerState: 'on' },
};

// Etterligner TV-ens REST-API (port 8001) og DIAL-tjeneste (port 8080).
function fakeFetch({ info = INFO, dial = 201, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
    if (url.endsWith(':8001/api/v2/')) return new Response(JSON.stringify(info));
    if (url.includes(':8080/ws/apps/YouTube')) {
      if (dial === 'error') throw new TypeError('fetch failed');
      return new Response('', { status: dial });
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls };
}

// Etterligner fjernkontroll-kanalen: tillater (med token), avviser eller venter på svar på TV-en.
function fakeTv({ approve = true, token = '29384756', fingerprint = TV_CERT, failSecure = false, failAll = false, apps = null, answerApps = true } = {}) {
  const opened = [];
  const sockets = [];
  const sent = [];
  class FakeSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.peerFingerprint = url.startsWith('wss:') ? fingerprint : null;
    }
    // Som den ekte klienten (ws-client.mjs): meldinger leveres først etter at den som åpnet har lagt til lyttere.
    reply(data) {
      setImmediate(() => this.emit('message', JSON.stringify(data)));
    }
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      if (message.params?.event === 'ed.installedApp.get' && answerApps) {
        this.reply({ event: 'ed.installedApp.get', from: 'host', data: { data: apps || [
          { appId: '111299001912', app_type: 2, name: 'YouTube' },
          { appId: '3201907018807', app_type: 2, name: 'Netflix' },
          { appId: 'org.tizen.browser', app_type: 4, name: 'Internett' },
          { appId: 'bad id!', app_type: 2, name: 'Ugyldig' },
        ] } });
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close');
    }
  }
  const openSocket = async (url, options = {}) => {
    opened.push(url);
    if (failAll || (failSecure && url.startsWith('wss:'))) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    if (url.startsWith('wss:') && options.expectFingerprint && options.expectFingerprint !== fingerprint) {
      throw Object.assign(new Error('mismatch'), { name: 'CertificateMismatch' });
    }
    const socket = new FakeSocket(url);
    sockets.push(socket);
    // Med gyldig token (eller etter «Tillat») svarer TV-en med ms.channel.connect.
    if (approve === true) socket.reply({ event: 'ms.channel.connect', data: { ...(token ? { token } : {}), clients: [] } });
    if (approve === false) socket.reply({ event: 'ms.channel.unauthorized' });
    return socket;
  };
  return { openSocket, opened, sent, sockets };
}

function memoryKeys(initial = {}) {
  const keys = new Map(Object.entries(initial));
  return {
    keys,
    get: async (h) => keys.get(h),
    update: async (h, patch) => { keys.set(h, { ...keys.get(h), ...patch }); },
    remove: async (h) => { keys.delete(h); },
  };
}

async function readySession(options = {}) {
  const tv = fakeTv(options.tv);
  const http = fakeFetch(options.http);
  const keyStore = options.keyStore || memoryKeys();
  const samsung = createSamsungSession({ keyStore, openSocket: tv.openSocket, fetchImpl: http.fetchImpl, log: () => {}, ...options.session });
  await samsung.connect(HOST);
  await settle();
  return { tv, http, keyStore, samsung };
}

const keysSent = (tv) => tv.sent.filter((m) => m.params?.TypeOfRemote === 'SendRemoteKey').map((m) => m.params.DataOfCmd);

test('adresse, navn og meldinger følger Samsungs fjernkontroll-API', () => {
  assert.equal(REMOTE_NAME, Buffer.from('Fjern').toString('base64'));
  assert.equal(remoteUrl(HOST, { secure: true, token: '123' }), `wss://${HOST}:8002/api/v2/channels/samsung.remote.control?name=Rmplcm4%3D&token=123`);
  assert.equal(remoteUrl(HOST, { secure: false, token: '123' }), `ws://${HOST}:8001/api/v2/channels/samsung.remote.control?name=Rmplcm4%3D`, 'token sendes aldri ukryptert');
  assert.deepEqual(keyMessage('KEY_UP'), { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_UP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
  assert.equal(storeKey(HOST), `samsung:${HOST}`);
});

test('alle ekstra taster i capabilities har en Samsung-tast, og alle tastene er gyldige kommandoer', () => {
  for (const key of SAMSUNG_EXTRA_KEYS) assert.ok(SAMSUNG_KEYS[key], key);
  for (const key of Object.keys(SAMSUNG_KEYS)) assert.ok(COMMANDS.includes(key), key);
  assert.equal(SAMSUNG_KEYS.Blue, 'KEY_CYAN');
  assert.equal(SAMSUNG_KEYS.Back, 'KEY_RETURN');
});

test('samsungInfo leser navn, modell, MAC og om token kreves', async () => {
  const { fetchImpl } = fakeFetch();
  assert.deepEqual(await samsungInfo(HOST, { fetchImpl }), { name: 'Stue', model: 'QE55Q80B', mac: 'a0:d0:5b:01:02:03', tokenAuth: true, powerState: 'on' });
  assert.deepEqual(await samsungProbe(HOST, { fetchImpl }), { type: 'samsung', host: HOST, name: 'Stue' });
  const other = fakeFetch({ info: { hello: 'world' } });
  await assert.rejects(samsungInfo(HOST, { fetchImpl: other.fetchImpl }), UserError);
});

test('appene parses med gyldige id-er, starttype og tak', () => {
  const apps = parseApps([{ appId: '111299001912', app_type: 2, name: 'YouTube' }, { appId: 'org.tizen.browser', app_type: 4, name: 'Internett' }, { appId: '../x', name: 'x' }]);
  assert.deepEqual(apps.map((a) => [a.id, a.launch]), [['111299001912', 'DEEP_LINK'], ['org.tizen.browser', 'NATIVE_LAUNCH']]);
  assert.equal(parseApps(Array.from({ length: 100 }, (_, i) => ({ appId: `app${i}`, name: `App ${i}` }))).length, 48);
  assert.deepEqual(parseApps(null), []);
});

test('SSDP gjenkjenner Samsung-TV-er, men ikke andre Samsung-enheter', () => {
  assert.deepEqual(classify('HTTP/1.1 200 OK\r\nST: urn:samsung.com:device:RemoteControlReceiver:1\r\n', HOST), { type: 'samsung', host: HOST, name: 'Samsung-TV' });
  assert.equal(classify('HTTP/1.1 200 OK\r\nSERVER: Samsung Galaxy\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n', HOST), null);
  assert.equal(classify('ST: urn:samsung.com:device:RemoteControlReceiver:1', '8.8.8.8'), null);
});

test('første tilkobling: venter på «Tillat», lagrer token, sertifikat og MAC, og blir klar', async () => {
  const tv = fakeTv({ approve: null });
  const keyStore = memoryKeys();
  const samsung = createSamsungSession({ keyStore, openSocket: tv.openSocket, fetchImpl: fakeFetch().fetchImpl, log: () => {} });
  await samsung.connect(HOST);
  assert.equal(samsung.ready, false);
  assert.equal(samsung.state, SAMSUNG_STATE.pairing);
  assert.equal(tv.opened[0], remoteUrl(HOST, { secure: true }), 'TV-er med token bruker wss:// på port 8002');
  tv.sockets[0].reply({ event: 'ms.channel.connect', data: { token: '29384756' } });
  await settle();
  assert.equal(samsung.ready, true);
  assert.equal(samsung.state, SAMSUNG_STATE.ready);
  assert.equal(samsung.model, 'Samsung QE55Q80B');
  assert.equal(samsung.canWake, true);
  assert.deepEqual(keyStore.keys.get(KEY), { mac: 'a0:d0:5b:01:02:03', token: '29384756', fingerprint: TV_CERT });
});

test('neste tilkobling sender lagret token, så TV-en ikke spør igjen', async () => {
  const keyStore = memoryKeys({ [KEY]: { token: '29384756', fingerprint: TV_CERT } });
  const { tv, samsung } = await readySession({ keyStore });
  assert.equal(tv.opened[0], remoteUrl(HOST, { secure: true, token: '29384756' }));
  assert.equal(samsung.ready, true);
});

test('eldre TV-er uten token-krav bruker ws:// på port 8001', async () => {
  const info = { device: { ...INFO.device, TokenAuthSupport: 'false' } };
  const { tv, samsung } = await readySession({ http: { info }, tv: { token: null } });
  assert.deepEqual(tv.opened, [remoteUrl(HOST, { secure: false })]);
  assert.equal(samsung.ready, true);
});

test('TV-er som krever token, eller er låst, nedgraderes aldri til ukryptert ws://', async () => {
  const locked = memoryKeys({ [KEY]: { token: 't', fingerprint: TV_CERT } });
  const first = await readySession({ keyStore: locked, tv: { failSecure: true }, http: { down: true } });
  assert.deepEqual(first.tv.opened, [remoteUrl(HOST, { secure: true, token: 't' })]);
  assert.equal(first.samsung.state, SAMSUNG_STATE.unreachable);
  const second = await readySession({ tv: { failSecure: true } });
  assert.equal(second.tv.opened.length, 1, 'TokenAuthSupport=true gir bare wss://');
  // Ukjent TV (REST svarer ikke) og ikke låst: wss:// først, så ws://.
  const third = await readySession({ tv: { failSecure: true }, http: { down: true } });
  assert.deepEqual(third.tv.opened, [remoteUrl(HOST, { secure: true }), remoteUrl(HOST, { secure: false })]);
  assert.equal(third.samsung.ready, true);
});

test('endret sertifikat stopper tilkoblingen, og «Par på nytt» glemmer token og avtrykk', async () => {
  const keyStore = memoryKeys({ [KEY]: { token: 'gammel', fingerprint: 'GAMMELT' } });
  const { tv, samsung } = await readySession({ keyStore });
  assert.equal(samsung.state, SAMSUNG_STATE.certChanged);
  assert.equal(samsung.code, 'cert-changed');
  assert.equal(tv.sockets.length, 0, 'tokenet sendes ikke til en ukjent motpart');
  await samsung.forget(HOST);
  await samsung.connect(HOST);
  await settle();
  assert.equal(samsung.ready, true);
  assert.equal(keyStore.keys.get(KEY).fingerprint, TV_CERT);
});

test('«Avvis» på TV-en og tidsavbrudd gir tydelige meldinger', async () => {
  const rejected = await readySession({ tv: { approve: false } });
  assert.equal(rejected.samsung.ready, false);
  assert.equal(rejected.samsung.state, SAMSUNG_STATE.rejected);
  const waiting = await readySession({ tv: { approve: null }, session: { pairingTimeout: 10 } });
  await settle(30);
  assert.equal(waiting.samsung.state, SAMSUNG_STATE.pairingTimeout);
  assert.equal(waiting.tv.sockets[0].readyState, 3, 'forbindelsen lukkes');
});

test('taster sendes som SendRemoteKey, og ⏯ veksler mellom pause og spill', async () => {
  const { tv, samsung } = await readySession();
  for (const key of ['Up', 'Select', 'Back', 'VolumeUp', 'Mute', 'Blue', 'Num7', 'PowerOff', 'PlayPause', 'PlayPause']) await samsung.command(key);
  assert.deepEqual(keysSent(tv), ['KEY_UP', 'KEY_ENTER', 'KEY_RETURN', 'KEY_VOLUP', 'KEY_MUTE', 'KEY_CYAN', 'KEY_7', 'KEY_POWER', 'KEY_PAUSE', 'KEY_PLAY']);
  await assert.rejects(samsung.command('Recent'), /støttes ikke av Samsung/);
});

test('kommandoer før TV-en er klar gir tilstanden som feil', async () => {
  const { samsung } = await readySession({ tv: { approve: null } });
  await assert.rejects(samsung.command('Up'), (error) => error instanceof UserError && error.message === SAMSUNG_STATE.pairing);
});

test('tekst sendes base64-kodet til feltet på TV-en', async () => {
  const { tv, samsung } = await readySession();
  await samsung.text('Hei æøå');
  const input = tv.sent.find((m) => m.params?.TypeOfRemote === 'SendInputString');
  assert.equal(Buffer.from(input.params.Cmd, 'base64').toString('utf8'), 'Hei æøå');
  assert.equal(input.params.DataOfCmd, 'base64');
  assert.equal(tv.sent.at(-1).params.TypeOfRemote, 'SendInputEnd');
});

test('apper hentes fra TV-en og startes med riktig type; ukjente apper avvises', async () => {
  const { tv, samsung } = await readySession();
  const apps = await samsung.apps();
  assert.deepEqual(apps.map((a) => a.name), ['YouTube', 'Netflix', 'Internett']);
  assert.equal('launch' in apps[0], false, 'intern starttype sendes ikke til grensesnittet');
  await samsung.launch('org.tizen.browser');
  assert.deepEqual(tv.sent.at(-1), { method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: 'org.tizen.browser', action_type: 'NATIVE_LAUNCH' } } });
  await assert.rejects(samsung.launch('com.evil'), /Ukjent app/);
});

test('applisten: tom liste er gyldig, og TV-en som ikke svarer gir tidsavbrudd', async () => {
  const empty = await readySession({ tv: { apps: [] } });
  assert.deepEqual(await empty.samsung.apps(), []);
  const silent = await readySession({ tv: { answerApps: false }, session: { requestTimeout: 10 } });
  await assert.rejects(silent.samsung.apps(), (error) => error instanceof UserError && error.status === 504);
});

test('innganger: kildemenyen og HDMI 1–4 som taster', async () => {
  const { tv, samsung } = await readySession();
  assert.deepEqual((await samsung.inputs()).map((i) => i.id), SAMSUNG_INPUTS.map((i) => i.id));
  await samsung.switchInput('KEY_HDMI2');
  assert.deepEqual(keysSent(tv), ['KEY_HDMI2']);
  await assert.rejects(samsung.switchInput('KEY_POWER'), /Ukjent inngang/);
});

test('YouTube: DIAL først, dyplenke som reserve', async () => {
  const dial = await readySession();
  await dial.samsung.playYoutube('n61ULEU7CO0');
  const call = dial.http.calls.find((c) => c.url.includes(':8080/'));
  assert.deepEqual([call.method, call.url, call.body], ['POST', `http://${HOST}:8080/ws/apps/YouTube`, 'v=n61ULEU7CO0']);
  assert.equal(dial.tv.sent.length, 0);

  const fallback = await readySession({ http: { dial: 'error' } });
  await fallback.samsung.playYoutube('n61ULEU7CO0');
  assert.deepEqual(fallback.tv.sent.at(-1).params.data, { appId: YOUTUBE_APP_ID, action_type: 'DEEP_LINK', metaTag: 'v=n61ULEU7CO0' });
});

test('slå på: Wake-on-LAN med lagret MAC, og tydelig melding uten', async () => {
  const wol = [];
  const tv = fakeTv();
  const http = fakeFetch({ down: true });
  const keyStore = memoryKeys({ [KEY]: { mac: 'a0:d0:5b:01:02:03' } });
  const samsung = createSamsungSession({ keyStore, openSocket: tv.openSocket, fetchImpl: http.fetchImpl, log: () => {}, sendWol: async (mac, host) => wol.push([mac, host]), wakeDelays: [5] });
  await samsung.powerOn(HOST);
  assert.deepEqual(wol, [['a0:d0:5b:01:02:03', HOST]]);
  assert.equal(samsung.state, SAMSUNG_STATE.waking);
  await settle(40);
  assert.equal(samsung.ready, true);
  const empty = createSamsungSession({ keyStore: memoryKeys(), openSocket: tv.openSocket, fetchImpl: http.fetchImpl, log: () => {} });
  await assert.rejects(empty.powerOn(HOST), (error) => error.message === NO_WAKE);
});

test('kobler til igjen automatisk når en klar forbindelse faller ut', async () => {
  const { tv, samsung } = await readySession({ session: { reconnectDelays: [5, 5] } });
  tv.sockets[0].close();
  assert.equal(samsung.state, SAMSUNG_STATE.reconnecting);
  await settle(40);
  assert.equal(samsung.ready, true);
  assert.equal(tv.sockets.length, 2);
});

test('frakobling stopper alt og avviser ventende forespørsler', async () => {
  const { samsung } = await readySession({ tv: { answerApps: false } });
  const pending = samsung.apps();
  samsung.disconnect();
  await assert.rejects(pending, UserError);
  assert.equal(samsung.ready, false);
  assert.equal(samsung.state, SAMSUNG_STATE.idle);
});

test('ekte WebSocket: en TV som svarer i samme pakke som håndtrykket gir klar økt', async () => {
  const net = await import('node:net');
  const crypto = await import('node:crypto');
  const { openWebSocket } = await import('../lib/ws-client.mjs');
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC11B85';
  const greeting = Buffer.from(JSON.stringify({ event: 'ms.channel.connect', data: { clients: [] } }));
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const key = /sec-websocket-key:\s*(.+)/i.exec(chunk.toString())[1].trim();
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const head = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.concat([head, Buffer.from([0x81, greeting.length]), greeting]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const info = { device: { ...INFO.device, TokenAuthSupport: 'false' } };
  const samsung = createSamsungSession({
    keyStore: memoryKeys(),
    fetchImpl: fakeFetch({ info }).fetchImpl,
    // Samme klient som i broen, men pekt mot testserveren i stedet for TV-ens port 8001.
    openSocket: (url, options) => openWebSocket(url.replace(`ws://${HOST}:8001`, `ws://127.0.0.1:${port}`), options),
    log: () => {},
  });
  try {
    await samsung.connect(HOST);
    await settle(50);
    assert.equal(samsung.ready, true);
  } finally {
    samsung.disconnect();
    server.close();
  }
});
