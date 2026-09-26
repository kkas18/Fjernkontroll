import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKeyStore, createLgSession, LG_STATE, NO_WAKE } from '../lib/lg.mjs';
import { magicPacket, normalizeMac } from '../lib/wol.mjs';
import { UserError } from '../lib/errors.mjs';

const HOST = '192.168.1.42';
const TV_CERT = 'AA:BB:CC';

// Etterligner en LG-TV: svarer på registrering, pekersocket og SSAP-kall.
function fakeTv({ failSecure = false, failAll = false, approve = true, muted = false, fingerprint = TV_CERT } = {}) {
  const opened = [];
  const sockets = [];
  const sent = { control: [], pointer: [] };
  class FakeSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.kind = url.includes('pointer') ? 'pointer' : 'control';
      this.peerFingerprint = url.startsWith('wss:') ? fingerprint : null;
    }
    send(text) {
      sent[this.kind].push(text);
      if (this.kind !== 'control') return;
      const message = JSON.parse(text);
      const reply = (data) => queueMicrotask(() => this.emit('message', JSON.stringify(data)));
      if (message.type === 'register') {
        if (approve) reply({ type: 'registered', id: 'register_0', payload: { 'client-key': 'nøkkel-123' } });
        return;
      }
      const uri = message.uri;
      if (uri.endsWith('getPointerInputSocket')) reply({ type: 'response', id: message.id, payload: { socketPath: `ws://${HOST}:3000/pointer` } });
      else if (uri.endsWith('getStatus')) reply({ type: 'response', id: message.id, payload: { mute: muted } });
      else if (uri.endsWith('connectionmanager/getinfo')) reply({ type: 'response', id: message.id, payload: { wifiInfo: { macAddress: 'A8-23-FE-01-02-03' } } });
      else if (uri.endsWith('listLaunchPoints')) reply({ type: 'response', id: message.id, payload: { launchPoints: [{ id: 'netflix', title: 'Netflix' }, { id: 'bad id!', title: 'Ugyldig' }] } });
      else if (uri.endsWith('channelUp')) reply({ type: 'error', id: message.id, error: '401 insufficient permissions' });
      else reply({ type: 'response', id: message.id, payload: { returnValue: true } });
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

const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

async function readySession(options = {}) {
  const tv = fakeTv(options.tv);
  const keyStore = options.keyStore || memoryKeys();
  const lg = createLgSession({ keyStore, openSocket: tv.openSocket, log: () => {}, ...options.session });
  await lg.connect(HOST);
  await settle();
  return { tv, keyStore, lg };
}

test('parer, lagrer nøkkel, sertifikatavtrykk og MAC, og blir klar', async () => {
  const { tv, keyStore, lg } = await readySession();
  assert.equal(lg.ready, true);
  assert.equal(lg.state, LG_STATE.ready);
  assert.deepEqual(keyStore.keys.get(HOST), { key: 'nøkkel-123', fingerprint: TV_CERT, mac: 'a8:23:fe:01:02:03' });
  assert.equal(lg.canWake, true);
  assert.equal(tv.opened[0], `wss://${HOST}:3001/`, 'prøver sikker port først');
});

test('faller tilbake til ws://:3000 for TV-er som ikke er låst', async () => {
  const { tv, lg } = await readySession({ tv: { failSecure: true } });
  assert.deepEqual(tv.opened.slice(0, 2), [`wss://${HOST}:3001/`, `ws://${HOST}:3000/`]);
  assert.equal(lg.ready, true);
});

test('en låst TV nedgraderes aldri til ukryptert ws://', async () => {
  const tv = fakeTv({ failSecure: true });
  const lg = createLgSession({ keyStore: memoryKeys({ [HOST]: { key: 'k', fingerprint: TV_CERT } }), openSocket: tv.openSocket, log: () => {} });
  await lg.connect(HOST);
  assert.deepEqual(tv.opened, [`wss://${HOST}:3001/`]);
  assert.equal(lg.ready, false);
  assert.equal(lg.state, LG_STATE.unreachable);
});

test('endret sertifikat stopper tilkoblingen og gir kode for ny paring', async () => {
  const keyStore = memoryKeys({ [HOST]: { key: 'k', fingerprint: 'GAMMELT' } });
  const tv = fakeTv();
  const lg = createLgSession({ keyStore, openSocket: tv.openSocket, log: () => {} });
  await lg.connect(HOST);
  assert.equal(lg.state, LG_STATE.certChanged);
  assert.equal(lg.code, 'cert-changed');
  assert.equal(tv.sent.control.length, 0, 'ingen nøkkel sendes til en ukjent motpart');
  await lg.forget(HOST);
  await lg.connect(HOST);
  await settle();
  assert.equal(lg.ready, true);
  assert.equal(keyStore.keys.get(HOST).fingerprint, TV_CERT);
});

test('kobler til igjen automatisk når en klar forbindelse faller ut', async () => {
  const { tv, lg } = await readySession({ session: { reconnectDelays: [5, 5] } });
  const control = tv.sockets.find((s) => s.kind === 'control');
  control.close();
  assert.equal(lg.state, LG_STATE.reconnecting);
  await settle(40);
  assert.equal(lg.ready, true);
  assert.ok(tv.sockets.filter((s) => s.kind === 'control').length >= 2);
});

test('gir tydelig tilstand når TV-en ikke kan nås', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv({ failAll: true }).openSocket, log: () => {} });
  await lg.connect(HOST);
  assert.equal(lg.ready, false);
  assert.equal(lg.state, LG_STATE.unreachable);
});

test('tidsavbrudd når paringen ikke godkjennes', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv({ approve: false }).openSocket, pairingTimeout: 20, log: () => {} });
  await lg.connect(HOST);
  assert.equal(lg.state, LG_STATE.pairing);
  await settle(40);
  assert.equal(lg.state, LG_STATE.pairingTimeout);
});

test('navigasjon via pekersocket, volum og slett via SSAP', async () => {
  const { tv, lg } = await readySession();
  await lg.command('Up');
  assert.equal(tv.sent.pointer.at(-1), 'type:button\nname:UP\n\n');
  await lg.command('VolumeUp');
  assert.equal(JSON.parse(tv.sent.control.at(-1)).uri, 'ssap://audio/volumeUp');
  await lg.command('Backspace');
  assert.deepEqual(JSON.parse(tv.sent.control.at(-1)).payload, { count: 1 });
});

test('Lyd av leser faktisk status før den veksler', async () => {
  const { tv, lg } = await readySession({ tv: { muted: true } });
  await lg.command('Mute');
  const last = JSON.parse(tv.sent.control.at(-1));
  assert.equal(last.uri, 'ssap://audio/setMute');
  assert.deepEqual(last.payload, { mute: false });
});

test('avvist kommando gir norsk feil', async () => {
  const { lg } = await readySession();
  await assert.rejects(lg.command('ChannelUp'), (e) => e instanceof UserError && /avviste/.test(e.message));
});

test('kommandoer før tilkobling avvises med tilstanden', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv().openSocket, log: () => {} });
  await assert.rejects(lg.command('Up'), (e) => e instanceof UserError && e.message === LG_STATE.idle);
});

test('apper: bare gyldige id-er, og bare kjente apper kan startes', async () => {
  const { tv, lg } = await readySession();
  assert.deepEqual(await lg.apps(), [{ id: 'netflix', name: 'Netflix' }]);
  await lg.launch('netflix');
  assert.deepEqual(JSON.parse(tv.sent.control.at(-1)).payload, { id: 'netflix' });
  await assert.rejects(lg.launch('com.webos.app.hack'), UserError);
});

test('slå på sender Wake-on-LAN til lagret MAC og kobler til igjen', async () => {
  const wol = [];
  const tv = fakeTv();
  const lg = createLgSession({
    keyStore: memoryKeys({ [HOST]: { key: 'k', mac: 'a8:23:fe:01:02:03' } }),
    openSocket: tv.openSocket,
    sendWol: async (mac, host) => { wol.push([mac, host]); },
    wakeDelays: [5],
    log: () => {},
  });
  await lg.powerOn(HOST);
  assert.deepEqual(wol, [['a8:23:fe:01:02:03', HOST]]);
  assert.equal(lg.state, LG_STATE.waking);
  await settle(40);
  assert.equal(lg.ready, true);
});

test('slå på uten kjent MAC gir forklaring', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv().openSocket, log: () => {} });
  await assert.rejects(lg.powerOn(HOST), (e) => e instanceof UserError && e.message === NO_WAKE);
});

test('Wake-on-LAN-pakken har riktig format', () => {
  assert.equal(normalizeMac('A8-23-FE-01-02-03'), 'a8:23:fe:01:02:03');
  assert.equal(normalizeMac('ikke en mac'), null);
  const packet = magicPacket('a8:23:fe:01:02:03');
  assert.equal(packet.length, 102);
  assert.ok(packet.subarray(0, 6).every((b) => b === 0xff));
  assert.equal(packet.subarray(96).toString('hex'), 'a823fe010203');
  assert.throws(() => magicPacket('x'), UserError);
});

test('nøkkellager: samtidige skrivinger går ikke tapt, filen er privat, gammelt format leses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fjern-'));
  const file = path.join(dir, 'data', 'lg-keys.json');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify({ '10.0.0.1': 'gammel-nøkkel' }), { mode: 0o644 });
  const store = createKeyStore(file);
  await store.protect();
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await store.get('10.0.0.1'), { key: 'gammel-nøkkel' });
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.update(`10.0.0.${i + 2}`, { key: `k${i}` })));
  const all = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(all).length, 11);
  await store.remove('10.0.0.1');
  assert.equal(await store.get('10.0.0.1'), undefined);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp')), []);
  await fs.rm(dir, { recursive: true, force: true });
});
