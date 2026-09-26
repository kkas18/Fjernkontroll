// LG webOS via SSAP over WebSocket. Nyere firmware krever wss:// på port 3001 med et
// selvsignert sertifikat; eldre modeller bruker ws:// på port 3000. Vi prøver begge.
import fs from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './errors.mjs';
import { openWebSocket } from './ws-client.mjs';

const PERMISSIONS = [
  'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL',
  'READ_INPUT_DEVICE_LIST', 'WRITE_NOTIFICATION_TOAST', 'CONTROL_INPUT_TEXT',
];

// Navigasjon går via pekersocketen, resten via SSAP-kall.
export const LG_BUTTONS = Object.freeze({ Up: 'UP', Down: 'DOWN', Left: 'LEFT', Right: 'RIGHT', Select: 'ENTER', Back: 'BACK', Home: 'HOME' });
export const LG_REQUESTS = Object.freeze({
  VolumeUp: 'ssap://audio/volumeUp',
  VolumeDown: 'ssap://audio/volumeDown',
  PowerOff: 'ssap://system/turnOff',
  Play: 'ssap://media.controls/play',
  Pause: 'ssap://media.controls/pause',
  Rewind: 'ssap://media.controls/rewind',
  FastForward: 'ssap://media.controls/fastForward',
  ChannelUp: 'ssap://tv/channelUp',
  ChannelDown: 'ssap://tv/channelDown',
});

export const LG_STATE = Object.freeze({
  idle: 'Frakoblet',
  connecting: 'Kobler til LG TV …',
  pairing: 'Godkjenn paringen på TV-skjermen.',
  preparing: 'Paring godkjent. Klargjør navigasjon …',
  ready: 'Tilkoblet',
  unreachable: 'Fikk ikke kontakt med LG TV. Sjekk at den er på og at IP-adressen stemmer.',
  pairingTimeout: 'Paringen ble ikke godkjent i tide. Velg TV-en og prøv igjen.',
  rejected: 'TV-en avviste paringen. Velg TV-en og prøv igjen.',
  noPointer: 'TV-en tilbyr ikke navigasjon via nettverket.',
  pointerLost: 'Navigasjonen ble frakoblet. Velg TV-en for å koble til igjen.',
  lost: 'LG TV ble frakoblet. Velg TV-en for å koble til igjen.',
});

export function createKeyStore(file) {
  const read = async () => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; }
  };
  return {
    async get(host) { return (await read())[host]; },
    async set(host, key) {
      const stored = await read();
      stored[host] = key;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      // Nøkkelen gir full kontroll over TV-en: bare eieren får lese filen.
      await fs.writeFile(temp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, file);
    },
  };
}

export function createLgSession({ keyStore, log = () => {}, openSocket = openWebSocket, connectTimeout = 5000, pairingTimeout = 30_000, requestTimeout = 4000 } = {}) {
  const session = { host: null, control: null, pointer: null, ready: false, state: LG_STATE.idle, generation: 0 };
  const pending = new Map();
  let sequence = 0;
  let pairingTimer = null;

  const current = (generation) => generation === session.generation;

  function rejectPending(reason) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new UserError(reason, 502));
    }
    pending.clear();
  }

  function disconnect() {
    session.generation += 1;
    clearTimeout(pairingTimer);
    rejectPending(LG_STATE.lost);
    for (const socket of [session.pointer, session.control]) {
      try { socket?.close(); } catch { /* allerede lukket */ }
    }
    Object.assign(session, { host: null, control: null, pointer: null, ready: false, state: LG_STATE.idle });
  }

  function request(uri, payload) {
    const control = session.control;
    if (!control || control.readyState !== 1) return Promise.reject(new UserError(session.state || 'LG TV er ikke tilkoblet.', 409));
    const id = `req_${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new UserError('LG TV svarte ikke på kommandoen.', 504));
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer });
      control.send(JSON.stringify({ type: 'request', id, uri, ...(payload ? { payload } : {}) }));
    });
  }

  async function openControl(host) {
    const attempts = [
      { url: `wss://${host}:3001/`, insecureTls: true },
      { url: `ws://${host}:3000/`, insecureTls: false },
    ];
    let lastError;
    for (const attempt of attempts) {
      try {
        const socket = await openSocket(attempt.url, { timeout: connectTimeout, insecureTls: attempt.insecureTls });
        return { socket, secure: attempt.url.startsWith('wss:') };
      } catch (error) {
        lastError = error;
        log(`LG: ${attempt.url} feilet (${error.code || error.message})`);
      }
    }
    throw lastError;
  }

  async function openPointer(generation, secure) {
    let socketPath;
    try {
      socketPath = (await request('ssap://com.webos.service.networkinput/getPointerInputSocket'))?.socketPath;
    } catch {
      socketPath = null;
    }
    if (!current(generation)) return;
    if (!/^wss?:\/\//.test(socketPath || '')) {
      session.state = LG_STATE.noPointer;
      return;
    }
    try {
      const pointer = await openSocket(socketPath, { timeout: connectTimeout, insecureTls: secure || socketPath.startsWith('wss:') });
      if (!current(generation)) return pointer.close();
      session.pointer = pointer;
      session.ready = true;
      session.state = LG_STATE.ready;
      const lost = () => {
        if (!current(generation)) return;
        session.ready = false;
        session.pointer = null;
        session.state = LG_STATE.pointerLost;
      };
      pointer.on('error', lost);
      pointer.on('close', lost);
    } catch (error) {
      log(`LG: pekersocket feilet (${error.code || error.message})`);
      if (current(generation)) session.state = LG_STATE.pointerLost;
    }
  }

  function onMessage(generation, raw, secure) {
    if (!current(generation)) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const waiting = message.id && pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.type === 'error' || message.payload?.returnValue === false) {
        waiting.reject(new UserError('TV-en avviste kommandoen.', 502));
      } else {
        waiting.resolve(message.payload);
      }
      return;
    }
    if (message.id !== 'register_0') return;
    if (message.type === 'registered') {
      clearTimeout(pairingTimer);
      const key = message.payload?.['client-key'];
      if (key) keyStore.set(session.host, key).catch((error) => log(`LG: kunne ikke lagre nøkkel (${error.message})`));
      session.state = LG_STATE.preparing;
      openPointer(generation, secure);
    } else if (message.type === 'error') {
      clearTimeout(pairingTimer);
      session.state = LG_STATE.rejected;
    }
  }

  async function connect(host) {
    disconnect();
    const generation = session.generation;
    session.host = host;
    session.state = LG_STATE.connecting;
    let opened;
    try {
      opened = await openControl(host);
    } catch {
      if (current(generation)) session.state = LG_STATE.unreachable;
      return;
    }
    if (!current(generation)) return opened.socket.close();
    const { socket, secure } = opened;
    session.control = socket;
    socket.on('message', (raw) => onMessage(generation, raw, secure));
    socket.on('error', (error) => log(`LG: ${error.code || error.message}`));
    socket.on('close', () => {
      if (!current(generation)) return;
      clearTimeout(pairingTimer);
      rejectPending(LG_STATE.lost);
      session.ready = false;
      session.control = null;
      session.state = LG_STATE.lost;
    });

    const clientKey = await keyStore.get(host);
    if (!current(generation)) return;
    const payload = {
      forcePairing: false,
      pairingType: 'PROMPT',
      manifest: { manifestVersion: 1, appVersion: '1.0', permissions: PERMISSIONS, signatures: [{ signatureVersion: 1, signature: 'dummy_signature' }] },
      ...(clientKey ? { 'client-key': clientKey } : {}),
    };
    session.state = LG_STATE.pairing;
    socket.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
    pairingTimer = setTimeout(() => {
      if (!current(generation) || session.ready || session.state !== LG_STATE.pairing) return;
      // close() utløser close-lytteren over, så den mer presise meldingen settes etterpå.
      try { socket.close(); } catch { /* allerede lukket */ }
      session.state = LG_STATE.pairingTimeout;
    }, pairingTimeout);
  }

  function pressButton(name) {
    if (!session.ready || session.pointer?.readyState !== 1) throw new UserError(session.state, 409);
    session.pointer.send(`type:button\nname:${name}\n\n`);
  }

  async function command(key) {
    if (!session.ready) throw new UserError(session.state, 409);
    if (LG_BUTTONS[key]) return pressButton(LG_BUTTONS[key]);
    if (key === 'Mute') {
      // Les faktisk lydstatus, slik at appen ikke kommer i utakt med den vanlige fjernkontrollen.
      try {
        const status = await request('ssap://audio/getStatus');
        await request('ssap://audio/setMute', { mute: !status?.mute });
      } catch {
        pressButton('MUTE');
      }
      return;
    }
    if (!LG_REQUESTS[key]) throw new UserError('Denne kommandoen støttes ikke av LG.');
    await request(LG_REQUESTS[key]);
  }

  async function text(value) {
    if (!session.ready) throw new UserError(session.state, 409);
    await request('ssap://com.webos.service.ime/insertText', { text: value, replace: 0 });
  }

  return {
    connect,
    disconnect,
    command,
    text,
    get ready() { return session.ready; },
    get state() { return session.state; },
    get host() { return session.host; },
  };
}
