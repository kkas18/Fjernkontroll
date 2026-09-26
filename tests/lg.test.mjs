import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLgSession, LG_STATE } from '../lib/lg.mjs';
import { UserError } from '../lib/errors.mjs';

// Etterligner en LG-TV: svarer på registrering, pekersocket og SSAP-kall.
function fakeTv({ failSecure = false, failAll = false, approve = true, muted = false } = {}) {
  const opened = [];
  const sent = { control: [], pointer: [] };
  class FakeSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.kind = url.includes('pointer') ? 'pointer' : 'control';
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
      if (message.uri.endsWith('getPointerInputSocket')) reply({ type: 'response', id: message.id, payload: { socketPath: 'ws://192.168.1.42:3000/pointer' } });
      else if (message.uri.endsWith('getStatus')) reply({ type: 'response', id: message.id, payload: { mute: muted } });
      else if (message.uri.endsWith('channelUp')) reply({ type: 'error', id: message.id, error: '401 insufficient permissions' });
      else reply({ type: 'response', id: message.id, payload: { returnValue: true } });
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  const openSocket = async (url) => {
    opened.push(url);
    if (failAll || (failSecure && url.startsWith('wss:'))) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    return new FakeSocket(url);
  };
  return { openSocket, opened, sent };
}

function memoryKeys() {
  const keys = new Map();
  return { keys, get: async (h) => keys.get(h), set: async (h, k) => { keys.set(h, k); } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('parer, lagrer nøkkel og blir klar', async () => {
  const tv = fakeTv();
  const keyStore = memoryKeys();
  const lg = createLgSession({ keyStore, openSocket: tv.openSocket, log: () => {} });
  await lg.connect('192.168.1.42');
  await settle();
  assert.equal(lg.ready, true);
  assert.equal(lg.state, LG_STATE.ready);
  assert.equal(keyStore.keys.get('192.168.1.42'), 'nøkkel-123');
  assert.equal(tv.opened[0], 'wss://192.168.1.42:3001/', 'prøver sikker port først');
});

test('faller tilbake til ws://:3000 når wss://:3001 ikke svarer', async () => {
  const tv = fakeTv({ failSecure: true });
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: tv.openSocket, log: () => {} });
  await lg.connect('192.168.1.42');
  await settle();
  assert.deepEqual(tv.opened.slice(0, 2), ['wss://192.168.1.42:3001/', 'ws://192.168.1.42:3000/']);
  assert.equal(lg.ready, true);
});

test('gir tydelig tilstand når TV-en ikke kan nås', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv({ failAll: true }).openSocket, log: () => {} });
  await lg.connect('192.168.1.42');
  assert.equal(lg.ready, false);
  assert.equal(lg.state, LG_STATE.unreachable);
});

test('tidsavbrudd når paringen ikke godkjennes', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv({ approve: false }).openSocket, pairingTimeout: 20, log: () => {} });
  await lg.connect('192.168.1.42');
  assert.equal(lg.state, LG_STATE.pairing);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lg.state, LG_STATE.pairingTimeout);
});

test('navigasjon går via pekersocket, volum via SSAP', async () => {
  const tv = fakeTv();
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: tv.openSocket, log: () => {} });
  await lg.connect('192.168.1.42');
  await settle();
  await lg.command('Up');
  await lg.command('VolumeUp');
  assert.equal(tv.sent.pointer.at(-1), 'type:button\nname:UP\n\n');
  assert.equal(JSON.parse(tv.sent.control.at(-1)).uri, 'ssap://audio/volumeUp');
});

test('Lyd av leser faktisk status før den veksler', async () => {
  const tv = fakeTv({ muted: true });
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: tv.openSocket, log: () => {} });
  await lg.connect('192.168.1.42');
  await settle();
  await lg.command('Mute');
  const last = JSON.parse(tv.sent.control.at(-1));
  assert.equal(last.uri, 'ssap://audio/setMute');
  assert.deepEqual(last.payload, { mute: false });
});

test('avvist kommando gir norsk feil', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv().openSocket, log: () => {} });
  await lg.connect('192.168.1.42');
  await settle();
  await assert.rejects(lg.command('ChannelUp'), (e) => e instanceof UserError && /avviste/.test(e.message));
});

test('kommandoer før tilkobling avvises med tilstanden', async () => {
  const lg = createLgSession({ keyStore: memoryKeys(), openSocket: fakeTv().openSocket, log: () => {} });
  await assert.rejects(lg.command('Up'), (e) => e instanceof UserError && e.message === LG_STATE.idle);
});
