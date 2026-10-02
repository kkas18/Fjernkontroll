// Samsung Tizen (2016 og nyere) via fjernkontroll-API-et over WebSocket, det samme som
// Samsungs SmartThings-app og samsungtvws/Home Assistant bruker. TV-er som krever token
// (TokenAuthSupport, de fleste fra 2018) bruker wss:// på port 8002 med et selvsignert
// sertifikat; eldre bruker ws:// på port 8001. Første gang viser TV-en «Tillat/Avvis».
// Tokenet og sertifikatavtrykket lagres (trust on first use), og en låst TV faller aldri
// tilbake til ukryptert ws://.
import { UserError } from './errors.mjs';
import { MAX_APPS, validAppId } from './validate.mjs';
import { openWebSocket } from './ws-client.mjs';
import { normalizeMac, sendWakeOnLan } from './wol.mjs';

// Navnet som vises på TV-en i forespørselen og under «Enhetsbehandling».
export const REMOTE_NAME = Buffer.from('Fjern').toString('base64');
export const YOUTUBE_APP_ID = '111299001912';

// Tastenavn fra Samsungs fjernkontroll-API (samme liste som samsungtvws).
export const SAMSUNG_KEYS = Object.freeze({
  Up: 'KEY_UP', Down: 'KEY_DOWN', Left: 'KEY_LEFT', Right: 'KEY_RIGHT', Select: 'KEY_ENTER', Back: 'KEY_RETURN', Home: 'KEY_HOME',
  VolumeUp: 'KEY_VOLUP', VolumeDown: 'KEY_VOLDOWN', Mute: 'KEY_MUTE', PowerOff: 'KEY_POWER',
  Play: 'KEY_PLAY', Pause: 'KEY_PAUSE', Rewind: 'KEY_REWIND', FastForward: 'KEY_FF',
  ChannelUp: 'KEY_CHUP', ChannelDown: 'KEY_CHDOWN', Enter: 'KEY_ENTER',
  Num0: 'KEY_0', Num1: 'KEY_1', Num2: 'KEY_2', Num3: 'KEY_3', Num4: 'KEY_4',
  Num5: 'KEY_5', Num6: 'KEY_6', Num7: 'KEY_7', Num8: 'KEY_8', Num9: 'KEY_9',
  // Samsungs blå tast heter CYAN.
  Red: 'KEY_RED', Green: 'KEY_GREEN', Yellow: 'KEY_YELLOW', Blue: 'KEY_CYAN',
  Info: 'KEY_INFO', Guide: 'KEY_GUIDE', List: 'KEY_CH_LIST', Dash: 'KEY_PLUS100', Exit: 'KEY_EXIT', Settings: 'KEY_MENU',
  Subtitles: 'KEY_CAPTION', Teletext: 'KEY_TTX_MIX', Aspect: 'KEY_PICTURE_SIZE',
});
export const SAMSUNG_EXTRA_KEYS = Object.freeze([
  'Num0', 'Num1', 'Num2', 'Num3', 'Num4', 'Num5', 'Num6', 'Num7', 'Num8', 'Num9', 'Red', 'Green', 'Yellow', 'Blue',
  'Info', 'Guide', 'List', 'Dash', 'Exit', 'Settings', 'Subtitles', 'Teletext', 'Aspect', 'Enter',
]);

// Tizen har ingen liste over innganger i dette API-et, men egne taster for hver HDMI-port og kildemenyen.
export const SAMSUNG_INPUTS = Object.freeze([
  { id: 'KEY_SOURCE', name: 'Kildemeny på TV-en', connected: true },
  ...[1, 2, 3, 4].map((n) => ({ id: `KEY_HDMI${n}`, name: `HDMI ${n}`, connected: true })),
]);

export const SAMSUNG_STATE = Object.freeze({
  idle: 'Frakoblet',
  connecting: 'Kobler til Samsung-TV …',
  reconnecting: 'Forbindelsen falt ut. Kobler til igjen …',
  waking: 'Slår på TV-en …',
  pairing: 'Trykk «Tillat» på TV-skjermen.',
  ready: 'Tilkoblet',
  unreachable: 'Fikk ikke kontakt med Samsung-TV-en. Sjekk at den er på, på samme Wi‑Fi, og at IP-adressen stemmer.',
  pairingTimeout: 'Tilkoblingen ble ikke godkjent i tide. Velg TV-en og prøv igjen.',
  rejected: 'TV-en avviste tilkoblingen. Tillat Fjern under Innstillinger → Generelt → Ekstern enhetsbehandling → Enhetstilkoblingsbehandling, og prøv igjen.',
  lost: 'Samsung-TV-en ble frakoblet. Velg TV-en for å koble til igjen.',
  certChanged: 'TV-ens sertifikat er endret siden forrige tilkobling. Det kan bety at noen utgir seg for TV-en. Par på nytt bare hvis TV-en er tilbakestilt eller oppdatert.',
});

export const NO_WAKE = 'Slå på krever at TV-en har vært tilkoblet én gang, og at «Slå på med mobil» er aktivert (Innstillinger → Generelt → Nettverk → Ekspertinnstillinger).';

// Lagres i samme nøkkelfil som LG, men under eget navn, så en IP-adresse som bytter TV ikke blandes.
export const storeKey = (host) => `samsung:${host}`;

export function remoteUrl(host, { secure, token } = {}) {
  const base = secure ? `wss://${host}:8002` : `ws://${host}:8001`;
  const query = `name=${encodeURIComponent(REMOTE_NAME)}${secure && token ? `&token=${encodeURIComponent(token)}` : ''}`;
  return `${base}/api/v2/channels/samsung.remote.control?${query}`;
}

export const keyMessage = (key) => ({
  method: 'ms.remote.control',
  params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
});

export const emitMessage = (event, data) => ({
  method: 'ms.channel.emit',
  params: { event, to: 'host', ...(data ? { data } : {}) },
});

// Grunninfo fra TV-ens REST-API: navn, modell, MAC (for Wake-on-LAN) og om token kreves.
export async function samsungInfo(host, { fetchImpl = fetch, timeout = 3000 } = {}) {
  const response = await fetchImpl(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new UserError('Fant ingen Samsung-TV på denne adressen.', 502);
  const body = await response.json().catch(() => null);
  const device = body?.device;
  if (!device || typeof device !== 'object') throw new UserError('Fant ingen Samsung-TV på denne adressen.', 502);
  const clean = (value, max) => String(value || '').replace(/^\[TV\]\s*/, '').trim().slice(0, max);
  return {
    name: clean(device.name || body.name, 70) || null,
    model: clean(device.modelName, 40) || null,
    mac: normalizeMac(device.wifiMac),
    tokenAuth: String(device.TokenAuthSupport) === 'true' ? true : String(device.TokenAuthSupport) === 'false' ? false : null,
    powerState: typeof device.PowerState === 'string' ? device.PowerState : null,
  };
}

// For TV-søket: bekrefter at adressen er en Samsung-TV og henter navnet den har fått.
export async function samsungProbe(host, options) {
  const info = await samsungInfo(host, options);
  return { type: 'samsung', host, name: info.name || 'Samsung-TV' };
}

export function parseApps(list) {
  const apps = [];
  for (const app of Array.isArray(list) ? list : []) {
    try {
      apps.push({
        id: validAppId(app?.appId),
        name: String(app?.name || app?.appId).slice(0, 80),
        system: false,
        color: null,
        // app_type 2 åpnes som dyplenke, 4 (og alt annet) som vanlig app.
        launch: Number(app?.app_type) === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH',
      });
    } catch { /* hopp over ugyldige id-er */ }
    if (apps.length >= MAX_APPS) break;
  }
  return apps;
}

export function createSamsungSession({
  keyStore,
  log = () => {},
  openSocket = openWebSocket,
  sendWol = sendWakeOnLan,
  fetchImpl = fetch,
  connectTimeout = 5000,
  pairingTimeout = 30_000,
  requestTimeout = 5000,
  reconnectDelays = [1000, 2000, 4000, 8000, 16_000],
  wakeDelays = [3000, 3000, 4000, 5000, 5000, 5000, 5000],
} = {}) {
  const session = { host: null, socket: null, ready: false, state: SAMSUNG_STATE.idle, code: null, generation: 0, canWake: false, model: null, apps: [] };
  const waiting = new Map();
  let pairingTimer = null;
  let reconnectTimer = null;
  // Tizen har ingen spill/pause-status i dette API-et. Første trykk pauser, siden det vanligste
  // er å trykke ⏯ mens noe spilles av.
  let playing = true;

  const current = (generation) => generation === session.generation;

  function rejectWaiting(reason) {
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(new UserError(reason, 502));
    }
    waiting.clear();
  }

  function disconnect() {
    session.generation += 1;
    clearTimeout(pairingTimer);
    clearTimeout(reconnectTimer);
    rejectWaiting(SAMSUNG_STATE.lost);
    try { session.socket?.close(); } catch { /* allerede lukket */ }
    Object.assign(session, { host: null, socket: null, ready: false, state: SAMSUNG_STATE.idle, code: null, canWake: false, model: null, apps: [] });
  }

  function scheduleReconnect(host, attempt, delays, state = SAMSUNG_STATE.reconnecting) {
    if (attempt >= delays.length) {
      session.state = SAMSUNG_STATE.unreachable;
      session.code = 'unreachable';
      return;
    }
    const generation = session.generation;
    session.state = state;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (current(generation)) connect(host, { auto: { attempt, delays, state } });
    }, delays[attempt]);
  }

  function send(message) {
    const socket = session.socket;
    if (!session.ready || !socket || socket.readyState !== 1) throw new UserError(session.state || 'Samsung-TV-en er ikke tilkoblet.', 409);
    socket.send(JSON.stringify(message));
  }

  // Svar fra TV-en kommer som hendelser med samme navn som forespørselen.
  function emitAndWait(event, data) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(event);
        reject(new UserError('Samsung-TV-en svarte ikke.', 504));
      }, requestTimeout);
      waiting.get(event)?.reject(new UserError('Avbrutt av en ny forespørsel.', 409));
      waiting.set(event, { resolve, reject, timer });
      try {
        send(emitMessage(event, data));
      } catch (error) {
        clearTimeout(timer);
        waiting.delete(event);
        reject(error);
      }
    });
  }

  async function openRemote(host, { stored, info }) {
    const pinned = stored?.fingerprint;
    const attempts = [];
    if (info?.tokenAuth !== false) attempts.push({ url: remoteUrl(host, { secure: true, token: stored?.token }), insecureTls: true, expectFingerprint: pinned });
    // En TV med låst sertifikat, eller som krever token, skal aldri nedgraderes til ukryptert forbindelse.
    if (!pinned && info?.tokenAuth !== true) attempts.push({ url: remoteUrl(host, { secure: false }), insecureTls: false });
    let lastError;
    for (const attempt of attempts) {
      const shown = attempt.url.replace(/token=[^&]+/, 'token=…');
      try {
        const socket = await openSocket(attempt.url, { timeout: connectTimeout, insecureTls: attempt.insecureTls, expectFingerprint: attempt.expectFingerprint });
        log(`Samsung: tilkoblet ${shown}`);
        return { socket, secure: attempt.url.startsWith('wss:') };
      } catch (error) {
        if (error?.name === 'CertificateMismatch') {
          log('Samsung: sertifikatet stemmer ikke med det som ble låst ved paring');
          throw error;
        }
        lastError = error;
        log(`Samsung: ${shown} feilet (${error.code || error.message})`);
      }
    }
    throw lastError || new Error('Ingen forbindelse');
  }

  function onMessage(generation, raw, socket, secure) {
    if (!current(generation)) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const event = message?.event;
    if (event === 'ms.channel.connect') {
      clearTimeout(pairingTimer);
      const patch = {};
      const token = message.data?.token;
      if (typeof token === 'string' && /^[\w-]{1,64}$/.test(token)) patch.token = token;
      else if (typeof token === 'number') patch.token = String(token);
      if (secure && socket.peerFingerprint) patch.fingerprint = socket.peerFingerprint;
      if (Object.keys(patch).length) keyStore.update(storeKey(session.host), patch).catch((error) => log(`Samsung: kunne ikke lagre token (${error.message})`));
      session.ready = true;
      session.state = SAMSUNG_STATE.ready;
      session.code = null;
      log('Samsung: klar');
      return;
    }
    if (event === 'ms.channel.unauthorized') {
      clearTimeout(pairingTimer);
      log('Samsung: tilkoblingen ble avvist på TV-en');
      session.state = SAMSUNG_STATE.rejected;
      session.code = 'rejected';
      try { socket.close(); } catch { /* allerede lukket */ }
      return;
    }
    if (event === 'ms.channel.timeOut') {
      clearTimeout(pairingTimer);
      session.state = SAMSUNG_STATE.pairingTimeout;
      try { socket.close(); } catch { /* allerede lukket */ }
      return;
    }
    const pending = event && waiting.get(event);
    if (pending) {
      waiting.delete(event);
      clearTimeout(pending.timer);
      pending.resolve(message.data);
    }
  }

  async function connect(host, { auto = null } = {}) {
    disconnect();
    const generation = session.generation;
    session.host = host;
    session.state = auto ? auto.state : SAMSUNG_STATE.connecting;

    const stored = await keyStore.get(storeKey(host));
    if (!current(generation)) return;
    session.canWake = Boolean(stored?.mac);

    let info = null;
    try {
      info = await samsungInfo(host, { fetchImpl });
      if (info.model) session.model = `Samsung ${info.model}`;
      if (info.mac) {
        session.canWake = true;
        if (info.mac !== stored?.mac) keyStore.update(storeKey(host), { mac: info.mac }).catch(() => {});
      }
    } catch (error) {
      // Svarer ikke REST-API-et, prøver vi likevel WebSocket (noen TV-er blokkerer port 8001 i hvilemodus).
      log(`Samsung: fant ikke TV-info (${error.code || error.message})`);
    }
    if (!current(generation)) return;

    let opened;
    try {
      opened = await openRemote(host, { stored, info });
    } catch (error) {
      if (!current(generation)) return;
      if (error?.name === 'CertificateMismatch') {
        session.state = SAMSUNG_STATE.certChanged;
        session.code = 'cert-changed';
      } else if (auto) {
        scheduleReconnect(host, auto.attempt + 1, auto.delays, auto.state);
      } else {
        session.state = SAMSUNG_STATE.unreachable;
        session.code = 'unreachable';
      }
      return;
    }
    if (!current(generation)) return opened.socket.close();
    const { socket, secure } = opened;
    session.socket = socket;
    session.state = SAMSUNG_STATE.pairing;
    socket.on('message', (raw) => onMessage(generation, raw, socket, secure));
    socket.on('error', (error) => log(`Samsung: ${error.code || error.message}`));
    socket.on('close', () => {
      if (!current(generation) || session.socket !== socket) return;
      const wasReady = session.ready;
      clearTimeout(pairingTimer);
      rejectWaiting(SAMSUNG_STATE.lost);
      session.ready = false;
      session.socket = null;
      if (wasReady) scheduleReconnect(host, 0, reconnectDelays);
      else if (![SAMSUNG_STATE.rejected, SAMSUNG_STATE.pairingTimeout].includes(session.state)) session.state = SAMSUNG_STATE.lost;
    });
    // Med gyldig token svarer TV-en med en gang. Ellers venter den på at noen trykker «Tillat».
    pairingTimer = setTimeout(() => {
      if (!current(generation) || session.ready) return;
      session.state = SAMSUNG_STATE.pairingTimeout;
      try { socket.close(); } catch { /* allerede lukket */ }
    }, pairingTimeout);
  }

  function ensureReady() {
    if (!session.ready) throw new UserError(session.state, 409);
  }

  async function command(key) {
    ensureReady();
    if (key === 'PlayPause') {
      send(keyMessage(playing ? 'KEY_PAUSE' : 'KEY_PLAY'));
      playing = !playing;
      return;
    }
    const name = SAMSUNG_KEYS[key];
    if (!name) throw new UserError('Denne kommandoen støttes ikke av Samsung.');
    if (key === 'Play') playing = true;
    if (key === 'Pause') playing = false;
    send(keyMessage(name));
  }

  async function powerOn(host) {
    const stored = await keyStore.get(storeKey(host));
    if (!stored?.mac) throw new UserError(NO_WAKE, 409);
    await sendWol(stored.mac, host, { log });
    disconnect();
    session.host = host;
    session.canWake = true;
    scheduleReconnect(host, 0, wakeDelays, SAMSUNG_STATE.waking);
  }

  // Skriver i tekstfeltet som er åpent på TV-en (skjermtastaturet må vises).
  async function text(value) {
    ensureReady();
    send({ method: 'ms.remote.control', params: { Cmd: Buffer.from(value, 'utf8').toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' } });
    send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
  }

  async function apps() {
    ensureReady();
    const data = await emitAndWait('ed.installedApp.get');
    session.apps = parseApps(data?.data);
    return session.apps.map(({ launch: _launch, ...app }) => app);
  }

  async function launch(id) {
    ensureReady();
    const app = session.apps.find((entry) => entry.id === id);
    if (!app) throw new UserError('Ukjent app.', 404);
    send(emitMessage('ed.apps.launch', { appId: app.id, action_type: app.launch }));
  }

  async function inputs() {
    ensureReady();
    return SAMSUNG_INPUTS.map((input) => ({ ...input }));
  }

  async function switchInput(id) {
    ensureReady();
    if (!SAMSUNG_INPUTS.some((input) => input.id === id)) throw new UserError('Ukjent inngang.', 404);
    send(keyMessage(id));
  }

  // YouTube på TV-en via DIAL (samme som «cast» fra mobilen). Svarer ikke DIAL, åpnes appen med dyplenke.
  async function playYoutube(videoId) {
    ensureReady();
    log(`Samsung: spiller YouTube-video ${videoId}`);
    try {
      const response = await fetchImpl(`http://${session.host}:8080/ws/apps/YouTube`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: `v=${videoId}`,
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) return;
      log(`Samsung: DIAL svarte ${response.status}, bruker dyplenke`);
    } catch (error) {
      log(`Samsung: DIAL feilet (${error.code || error.message}), bruker dyplenke`);
    }
    const id = session.apps.find((app) => /youtube/i.test(app.name) && !/kids|music/i.test(app.name))?.id || YOUTUBE_APP_ID;
    send(emitMessage('ed.apps.launch', { appId: id, action_type: 'DEEP_LINK', metaTag: `v=${videoId}` }));
  }

  async function forget(host) {
    await keyStore.remove(storeKey(host));
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
    inputs,
    switchInput,
    playYoutube,
    // Appikoner ligger som filer inne på TV-en og deles ikke over nettet; grensesnittet bruker merkefarger.
    iconUrl: () => null,
    get ready() { return session.ready; },
    get state() { return session.state; },
    get code() { return session.code; },
    get host() { return session.host; },
    get canWake() { return session.canWake; },
    get model() { return session.model; },
  };
}
