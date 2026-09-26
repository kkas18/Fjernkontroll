// LG webOS via SSAP over WebSocket. Nyere firmware krever wss:// på port 3001 med et
// selvsignert sertifikat; eldre modeller bruker ws:// på port 3000. Sertifikatet låses ved
// første paring (trust on first use), og en låst TV faller aldri tilbake til ukryptert ws://.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './errors.mjs';
import { MAX_APPS, validAppId } from './validate.mjs';
import { openWebSocket } from './ws-client.mjs';
import { normalizeMac, sendWakeOnLan } from './wol.mjs';

// Samme tillatelser som LG-biblioteket i Home Assistant (aiowebostv). CONTROL_MOUSE_AND_KEYBOARD
// er påkrevd for pekersocketen (navigasjon); uten den svarer TV-en «401 insufficient permissions».
export const PERMISSIONS = [
  'APP_TO_APP', 'CLOSE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
  'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT', 'CONTROL_INPUT_TV',
  'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'CONTROL_TV_SCREEN', 'LAUNCH', 'LAUNCH_WEBAPP',
  'READ_APP_STATUS', 'READ_COUNTRY_INFO', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST',
  'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_LGE_TV_INPUT_EVENTS', 'READ_NETWORK_STATE',
  'READ_NOTIFICATIONS', 'READ_POWER_STATE', 'READ_RUNNING_APPS', 'READ_SETTINGS', 'READ_TV_CHANNEL_LIST',
  'READ_TV_CURRENT_TIME', 'READ_UPDATE_INFO', 'SEARCH', 'TEST_OPEN', 'TEST_PROTECTED', 'TEST_SECURE',
  'UPDATE_FROM_REMOTE_APP', 'WRITE_NOTIFICATION_ALERT', 'WRITE_NOTIFICATION_TOAST', 'WRITE_SETTINGS',
];

// Økes når tillatelsene endres. En nøkkel fra en eldre revisjon gir ikke de nye tillatelsene,
// så da parer vi på nytt (TV-en viser forespørselen igjen) i stedet for å gjenbruke den.
export const MANIFEST_REVISION = 2;

export function registrationPayload(stored) {
  const reuseKey = stored?.key && stored.rev === MANIFEST_REVISION;
  return {
    forcePairing: false,
    pairingType: 'PROMPT',
    manifest: { manifestVersion: 1, appVersion: '1.1', permissions: PERMISSIONS },
    ...(reuseKey ? { 'client-key': stored.key } : {}),
  };
}

// Navigasjon går via pekersocketen, resten via SSAP-kall.
export const LG_BUTTONS = Object.freeze({ Up: 'UP', Down: 'DOWN', Left: 'LEFT', Right: 'RIGHT', Select: 'ENTER', Back: 'BACK', Home: 'HOME' });
export const LG_REQUESTS = Object.freeze({
  VolumeUp: ['ssap://audio/volumeUp'],
  VolumeDown: ['ssap://audio/volumeDown'],
  PowerOff: ['ssap://system/turnOff'],
  Play: ['ssap://media.controls/play'],
  Pause: ['ssap://media.controls/pause'],
  Rewind: ['ssap://media.controls/rewind'],
  FastForward: ['ssap://media.controls/fastForward'],
  ChannelUp: ['ssap://tv/channelUp'],
  ChannelDown: ['ssap://tv/channelDown'],
  Backspace: ['ssap://com.webos.service.ime/deleteCharacters', { count: 1 }],
});

export const LG_STATE = Object.freeze({
  idle: 'Frakoblet',
  connecting: 'Kobler til LG TV …',
  reconnecting: 'Forbindelsen falt ut. Kobler til igjen …',
  waking: 'Slår på TV-en …',
  pairing: 'Godkjenn paringen på TV-skjermen.',
  preparing: 'Paring godkjent. Klargjør navigasjon …',
  ready: 'Tilkoblet',
  unreachable: 'Fikk ikke kontakt med LG TV. Sjekk at den er på og at IP-adressen stemmer.',
  pairingTimeout: 'Paringen ble ikke godkjent i tide. Velg TV-en og prøv igjen.',
  rejected: 'TV-en avviste paringen. Velg TV-en og prøv igjen.',
  noPointer: 'TV-en ga ikke tilgang til navigasjon. Trykk «Par på nytt» og godkjenn forespørselen på TV-en.',
  pointerLost: 'Navigasjonen ble frakoblet. Velg TV-en for å koble til igjen.',
  lost: 'LG TV ble frakoblet. Velg TV-en for å koble til igjen.',
  certChanged: 'TV-ens sertifikat er endret siden paringen. Det kan bety at noen utgir seg for TV-en. Par på nytt bare hvis TV-en er tilbakestilt eller oppdatert.',
});

export const NO_WAKE = 'Slå på krever at TV-en har vært tilkoblet én gang, og at «Slå på via Wi‑Fi» er aktivert i TV-ens innstillinger.';

// Lagring av paringsnøkkel, sertifikatavtrykk og MAC per TV. Skrivinger går i kø, så
// samtidige oppdateringer ikke overskriver hverandre.
export function createKeyStore(file) {
  let queue = Promise.resolve();
  const read = async () => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; }
  };
  // Eldre versjoner lagret bare nøkkelen som tekst.
  const normalize = (value) => (typeof value === 'string' ? { key: value } : value && typeof value === 'object' ? value : undefined);
  const write = (mutate) => {
    const next = queue.then(async () => {
      const stored = await read();
      mutate(stored);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      // Nøkkelen gir full kontroll over TV-en: bare eieren får lese filen.
      await fs.writeFile(temp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, file);
    });
    queue = next.catch(() => {});
    return next;
  };
  return {
    async get(host) {
      await queue;
      return normalize((await read())[host]);
    },
    update(host, patch) {
      return write((stored) => { stored[host] = { ...normalize(stored[host]), ...patch }; });
    },
    remove(host) {
      return write((stored) => { delete stored[host]; });
    },
    async protect() {
      await fs.chmod(file, 0o600).catch(() => {});
    },
  };
}

export function createLgSession({
  keyStore,
  log = () => {},
  openSocket = openWebSocket,
  sendWol = sendWakeOnLan,
  connectTimeout = 5000,
  pairingTimeout = 30_000,
  requestTimeout = 4000,
  reconnectDelays = [1000, 2000, 4000, 8000, 16_000],
  wakeDelays = [3000, 3000, 4000, 5000, 5000, 5000, 5000],
} = {}) {
  const session = { host: null, control: null, pointer: null, ready: false, state: LG_STATE.idle, code: null, generation: 0, canWake: false, apps: [] };
  const pending = new Map();
  let sequence = 0;
  let pairingTimer = null;
  let reconnectTimer = null;

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
    clearTimeout(reconnectTimer);
    rejectPending(LG_STATE.lost);
    for (const socket of [session.pointer, session.control]) {
      try { socket?.close(); } catch { /* allerede lukket */ }
    }
    Object.assign(session, { host: null, control: null, pointer: null, ready: false, state: LG_STATE.idle, code: null, canWake: false, apps: [], model: null });
  }

  function scheduleReconnect(host, attempt, delays, state = LG_STATE.reconnecting) {
    if (attempt >= delays.length) {
      session.state = LG_STATE.unreachable;
      return;
    }
    const generation = session.generation;
    session.state = state;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (current(generation)) connect(host, { auto: { attempt, delays, state } });
    }, delays[attempt]);
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

  async function openControl(host, pinned) {
    const attempts = [{ url: `wss://${host}:3001/`, insecureTls: true, expectFingerprint: pinned }];
    // En TV med låst sertifikat skal aldri nedgraderes til ukryptert forbindelse.
    if (!pinned) attempts.push({ url: `ws://${host}:3000/`, insecureTls: false });
    let lastError;
    for (const attempt of attempts) {
      try {
        const socket = await openSocket(attempt.url, { timeout: connectTimeout, insecureTls: attempt.insecureTls, expectFingerprint: attempt.expectFingerprint });
        log(`LG: tilkoblet ${attempt.url}`);
        return { socket, secure: attempt.url.startsWith('wss:') };
      } catch (error) {
        if (error?.name === 'CertificateMismatch') {
          log('LG: sertifikatet stemmer ikke med det som ble låst ved paring');
          throw error;
        }
        lastError = error;
        log(`LG: ${attempt.url} feilet (${error.code || error.message})`);
      }
    }
    throw lastError;
  }

  async function rememberMac(host) {
    try {
      const info = await request('ssap://com.webos.service.connectionmanager/getinfo');
      const mac = normalizeMac(info?.wifiInfo?.macAddress) || normalizeMac(info?.wiredInfo?.macAddress);
      if (mac) {
        session.canWake = true;
        await keyStore.update(host, { mac });
      }
    } catch (error) {
      log(`LG: fant ikke MAC-adresse (${error.message})`);
    }
  }

  async function openPointer(generation, secure, { retry = true } = {}) {
    let socketPath;
    try {
      socketPath = (await request('ssap://com.webos.service.networkinput/getPointerInputSocket'))?.socketPath;
    } catch (error) {
      log(`LG: pekersocket avvist (${error.detail || error.message})`);
      socketPath = null;
    }
    if (!current(generation)) return;
    if (!/^wss?:\/\//.test(socketPath || '')) {
      session.state = LG_STATE.noPointer;
      session.code = 'needs-repair';
      return;
    }
    try {
      const pointer = await openSocket(socketPath, { timeout: connectTimeout, insecureTls: secure || socketPath.startsWith('wss:') });
      if (!current(generation)) return pointer.close();
      session.pointer = pointer;
      session.ready = true;
      session.state = LG_STATE.ready;
      log('LG: klar (navigasjon tilkoblet)');
      const lost = () => {
        if (!current(generation) || session.pointer !== pointer) return;
        session.ready = false;
        session.pointer = null;
        session.state = LG_STATE.pointerLost;
        // Kontrollforbindelsen lever ofte videre: prøv å hente en ny pekersocket én gang.
        if (session.control?.readyState === 1) setTimeout(() => current(generation) && openPointer(generation, secure, { retry: false }), 1000);
      };
      pointer.on('error', lost);
      pointer.on('close', lost);
      if (retry) {
        rememberMac(session.host);
        rememberModel();
      }
    } catch (error) {
      log(`LG: pekersocket feilet (${error.code || error.message})`);
      if (current(generation)) session.state = LG_STATE.pointerLost;
    }
  }

  function onMessage(generation, raw, socket, secure) {
    if (!current(generation)) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const waiting = message.id && pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.type === 'error' || message.payload?.returnValue === false) {
        waiting.reject(Object.assign(new UserError('TV-en avviste kommandoen.', 502), { detail: message.error || null }));
      } else {
        waiting.resolve(message.payload);
      }
      return;
    }
    if (message.id !== 'register_0') return;
    if (message.type === 'registered') {
      clearTimeout(pairingTimer);
      const patch = {};
      const key = message.payload?.['client-key'];
      if (key) Object.assign(patch, { key, rev: MANIFEST_REVISION });
      if (secure && socket.peerFingerprint) patch.fingerprint = socket.peerFingerprint;
      if (Object.keys(patch).length) keyStore.update(session.host, patch).catch((error) => log(`LG: kunne ikke lagre nøkkel (${error.message})`));
      session.state = LG_STATE.preparing;
      log('LG: paring godkjent');
      openPointer(generation, secure);
    } else if (message.type === 'error') {
      clearTimeout(pairingTimer);
      log(`LG: registrering avvist (${message.error || 'ukjent'})`);
      session.state = LG_STATE.rejected;
    }
  }

  async function connect(host, { auto = null } = {}) {
    disconnect();
    const generation = session.generation;
    session.host = host;
    session.state = auto ? auto.state : LG_STATE.connecting;

    const stored = await keyStore.get(host);
    if (!current(generation)) return;
    session.canWake = Boolean(stored?.mac);

    let opened;
    try {
      opened = await openControl(host, stored?.fingerprint);
    } catch (error) {
      if (!current(generation)) return;
      if (error?.name === 'CertificateMismatch') {
        session.state = LG_STATE.certChanged;
        session.code = 'cert-changed';
      } else if (auto) {
        scheduleReconnect(host, auto.attempt + 1, auto.delays, auto.state);
      } else {
        session.state = LG_STATE.unreachable;
      }
      return;
    }
    if (!current(generation)) return opened.socket.close();
    const { socket, secure } = opened;
    session.control = socket;
    socket.on('message', (raw) => onMessage(generation, raw, socket, secure));
    socket.on('error', (error) => log(`LG: ${error.code || error.message}`));
    socket.on('close', () => {
      if (!current(generation)) return;
      const wasReady = session.ready || session.pointer !== null;
      clearTimeout(pairingTimer);
      rejectPending(LG_STATE.lost);
      session.ready = false;
      session.control = null;
      session.pointer = null;
      if (wasReady) scheduleReconnect(host, 0, reconnectDelays);
      else if (session.state !== LG_STATE.pairingTimeout) session.state = LG_STATE.lost;
    });

    const payload = registrationPayload(stored);
    session.state = LG_STATE.pairing;
    socket.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
    pairingTimer = setTimeout(() => {
      if (!current(generation) || session.ready || session.state !== LG_STATE.pairing) return;
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
    const call = LG_REQUESTS[key];
    if (!call) throw new UserError('Denne kommandoen støttes ikke av LG.');
    await request(...call);
  }

  async function powerOn(host) {
    const stored = await keyStore.get(host);
    if (!stored?.mac) throw new UserError(NO_WAKE, 409);
    await sendWol(stored.mac, host, { log });
    disconnect();
    session.host = host;
    session.canWake = true;
    scheduleReconnect(host, 0, wakeDelays, LG_STATE.waking);
  }

  async function text(value) {
    if (!session.ready) throw new UserError(session.state, 409);
    await request('ssap://com.webos.service.ime/insertText', { text: value, replace: 0 });
  }

  async function apps() {
    if (!session.ready) throw new UserError(session.state, 409);
    const result = await request('ssap://com.webos.applicationManager/listLaunchPoints');
    const list = [];
    for (const point of result?.launchPoints || []) {
      try {
        list.push({
          id: validAppId(point.id),
          name: String(point.title || point.id).slice(0, 80),
          system: point.systemApp === true,
          color: /^#[0-9a-f]{6}$/i.test(point.bgColor || '') ? point.bgColor : null,
          // largeIcon er skarpere på telefoner med høy oppløsning.
          icon: [point.largeIcon, point.icon].find((url) => typeof url === 'string' && url) || null,
        });
      } catch { /* hopp over ugyldige id-er */ }
      if (list.length >= MAX_APPS) break;
    }
    session.apps = list;
    // Ikonadressen er intern: grensesnittet henter ikonet via broen.
    return list.map(({ icon, ...app }) => app);
  }

  // Bare ikoner som ligger på TV-en selv, over http eller https.
  function iconUrl(id) {
    const url = session.apps.find((app) => app.id === id)?.icon;
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== session.host) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  // Modellnavnet brukes som TV-navn når brukeren ikke har valgt et eget.
  async function rememberModel() {
    try {
      const info = await request('ssap://system/getSystemInfo');
      const model = String(info?.modelName || '').trim().slice(0, 40);
      if (model) session.model = `LG ${model}`;
    } catch (error) {
      log(`LG: fant ikke modellnavn (${error.message})`);
    }
  }

  async function launch(id) {
    if (!session.ready) throw new UserError(session.state, 409);
    if (!session.apps.some((app) => app.id === id)) throw new UserError('Ukjent app.', 404);
    await request('ssap://system.launcher/launch', { id });
  }

  async function forget(host) {
    await keyStore.remove(host);
  }

  return {
    connect: (host) => connect(host),
    disconnect,
    command,
    powerOn,
    text,
    apps,
    launch,
    forget,
    get ready() { return session.ready; },
    get state() { return session.state; },
    get code() { return session.code; },
    get host() { return session.host; },
    get canWake() { return session.canWake; },
    get model() { return session.model; },
    iconUrl,
  };
}
