// Android TV / Google TV (for eksempel Telia-boksen) via Android TV Remote-protokollen versjon 2,
// den samme som Google Home-appen og androidtvremote2/Home Assistant bruker.
//   Paring:          TLS på port 6467. Boksen viser en sekstegnskode som brukeren skriver inn.
//   Fjernkontroll:   TLS på port 6466 med appens klientsertifikat (boksen kjenner det igjen etter paring).
// Meldingene er protobuf med varint-lengde foran. Boksens sertifikat låses etter første tilkobling.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { UserError } from './errors.mjs';
import { createFrameReader, decode, encode, first, frame, message, text } from './protobuf.mjs';
import { createSelfSignedCertificate, rsaNumbers } from './x509.mjs';

export const PORTS = Object.freeze({ remote: 6466, pairing: 6467 });

// Android KeyEvent-koder (developer.android.com/reference/android/view/KeyEvent).
export const ANDROIDTV_KEYS = Object.freeze({
  Up: 19, Down: 20, Left: 21, Right: 22, Select: 23, Back: 4, Home: 3,
  VolumeUp: 24, VolumeDown: 25, Mute: 164,
  Play: 126, Pause: 127, PlayPause: 85, Rewind: 89, FastForward: 90,
  ChannelUp: 166, ChannelDown: 167, Enter: 66, Backspace: 67,
  Num0: 7, Num1: 8, Num2: 9, Num3: 10, Num4: 11, Num5: 12, Num6: 13, Num7: 14, Num8: 15, Num9: 16,
  Red: 183, Green: 184, Yellow: 185, Blue: 186,
  Info: 165, Guide: 172, Settings: 176, Subtitles: 175, Teletext: 233, Recent: 187, Search: 84,
});
const KEYCODE_POWER = 26;
export const ANDROIDTV_EXTRA_KEYS = Object.freeze([
  'Num0', 'Num1', 'Num2', 'Num3', 'Num4', 'Num5', 'Num6', 'Num7', 'Num8', 'Num9', 'Red', 'Green', 'Yellow', 'Blue',
  'Info', 'Guide', 'Settings', 'Subtitles', 'Teletext', 'Recent', 'Search', 'Enter',
]);

// Protokollen har ingen appliste. Appene åpnes med pakkenavnet via market://launch?id=…, som Play-butikken på
// boksen sender videre til appen (samme som androidtvremote2/Home Assistant). Nettadresser (https://…) virker
// ikke på alle bokser: uten nettleser er det ingen som tar imot dem, og da skjer ingenting.
// Ikonene er appenes egne butikkikoner (128 px), lagt i public/icons/apps/.
export const ANDROIDTV_APPS = Object.freeze([
  { id: 'teliaplay', name: 'Telia Play', package: 'no.get.play.tv' },
  { id: 'nrktv', name: 'NRK TV', package: 'no.nrk.tv' },
  { id: 'tv2play', name: 'TV 2 Play', package: 'no.tv2.sumo' },
  { id: 'netflix', name: 'Netflix', package: 'com.netflix.ninja' },
  { id: 'youtube', name: 'YouTube', package: 'com.google.android.youtube.tv' },
  { id: 'disneyplus', name: 'Disney+', package: 'com.disney.disneyplus' },
  { id: 'max', name: 'HBO Max', package: 'com.wbd.stream' },
  { id: 'primevideo', name: 'Prime Video', package: 'com.amazon.amazonvideo.livingroom' },
  { id: 'viaplay', name: 'Viaplay', package: 'com.viaplay.android' },
  { id: 'spotify', name: 'Spotify', package: 'com.spotify.tv.android' },
  { id: 'appletv', name: 'Apple TV', package: 'com.apple.atve.androidtv.appletv' },
].map((app) => Object.freeze({ ...app, link: `market://launch?id=${app.package}`, icon: `/icons/apps/${app.id}.png` })));

export const ANDROIDTV_STATE = Object.freeze({
  idle: 'Frakoblet',
  connecting: 'Kobler til Android TV …',
  reconnecting: 'Forbindelsen falt ut. Kobler til igjen …',
  pairing: 'Starter paring. Se på TV-en …',
  needsCode: 'Skriv inn koden som vises på TV-en.',
  checking: 'Sjekker koden …',
  ready: 'Tilkoblet',
  unreachable: 'Fikk ikke kontakt med Android TV-en. Sjekk at den er på, på samme Wi‑Fi, og at IP-adressen stemmer.',
  pairingFailed: 'Paringen ble avbrutt. Velg enheten og prøv igjen.',
  pairingTimeout: 'Koden ble ikke skrevet inn i tide. Velg enheten og prøv igjen.',
  lost: 'Android TV-en ble frakoblet. Velg enheten for å koble til igjen.',
  certChanged: 'Sertifikatet til Android TV-en er endret. Det kan bety at noen utgir seg for den. Par på nytt bare hvis enheten er tilbakestilt eller oppdatert.',
});

export const NO_POWER = 'Android TV-en kan bare slås på mens appen er koblet til den. Bruk fjernkontrollen eller TV-en.';
export const NO_APP_LINKS = 'Boksen tillater ikke at fjernkontroller åpner apper. Bruk Hjem-knappen og velg appen på TV-en.';
export const NEEDS_FOCUS = 'Åpne et tekstfelt på TV-en først, så skjermtastaturet vises.';

export const storeKey = (host) => `androidtv:${host}`;

// ---------- Meldinger ----------

const STATUS_OK = 200;
const HEX = 3; // Options.Encoding.ENCODING_TYPE_HEXADECIMAL
const ROLE_INPUT = 1; // Options.RoleType.ROLE_TYPE_INPUT
// Funksjoner vi ber om (RemoteConfigure.code1). Boksen svarer med sine; vi bruker bare det begge støtter.
export const FEATURE = Object.freeze({ PING: 1, KEY: 2, IME: 4, POWER: 32, VOLUME: 64, APP_LINK: 512 });
export const FEATURES = Object.values(FEATURE).reduce((all, bit) => all | bit, 0); // 615, som androidtvremote2 uten tale
export const activeFeatures = (supported) => (supported ? FEATURES & supported : FEATURES);
const encoding = () => encode([[1, HEX], [2, 6]]);
const outer = (field, payload) => encode([[1, 2], [2, STATUS_OK], [field, payload]]);

export const pairingMessages = Object.freeze({
  request: (clientName = 'Fjern') => outer(10, encode([[1, 'atvremote'], [2, clientName]])),
  options: () => outer(20, encode([[1, encoding()], [3, ROLE_INPUT]])),
  configuration: () => outer(30, encode([[1, encoding()], [2, ROLE_INPUT]])),
  secret: (secret) => outer(40, encode([[1, secret]])),
});

export const remoteMessages = Object.freeze({
  configure: (features = FEATURES) => encode([[1, encode([[1, features], [2, encode([
    [1, 'Fjern'], [2, 'Fjern'], [3, 1], [4, '1'], [5, 'atvremote'], [6, '1.0.0'],
  ])]])]]),
  setActive: (features = FEATURES) => encode([[2, encode([[1, features]])]]),
  pingResponse: (value) => encode([[9, encode([[1, value]])]]),
  // direction 3 = SHORT (trykk og slipp)
  key: (code) => encode([[10, encode([[1, code], [2, 3]])]]),
  appLink: (link) => encode([[90, encode([[1, link]])]]),
  text: (value, imeCounter, fieldCounter) => {
    const end = value.length - 1;
    return encode([[21, encode([
      [1, imeCounter], [2, fieldCounter],
      [3, encode([[1, 1], [2, encode([[1, end], [2, end], [3, value]])]])],
    ])]]);
  },
});

// Paringskoden er seks heksadesimale tegn. De fire siste er tilfeldige; de to første er første byte av
// SHA-256(klientmodulus ‖ klienteksponent ‖ boksmodulus ‖ bokseksponent ‖ de fire siste), som sjekk.
export function pairingSecret(clientKey, serverKey, code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(clean)) throw new UserError('Koden er seks tegn (0–9 og A–F), slik den vises på TV-en.');
  const bytes = Buffer.from(clean, 'hex');
  const client = rsaNumbers(clientKey);
  const server = rsaNumbers(serverKey);
  const hash = crypto.createHash('sha256')
    .update(client.modulus).update(client.exponent)
    .update(server.modulus).update(server.exponent)
    .update(bytes.subarray(1))
    .digest();
  return hash[0] === bytes[0] ? hash : null;
}

// ---------- Klientidentitet ----------

// Appens eget sertifikat og nøkkel. Lages første gang og lagres med tilgang bare for eieren.
export function createIdentityStore(file) {
  let cached = null;
  return {
    async get() {
      if (cached) return cached;
      try {
        const stored = JSON.parse(await fs.readFile(file, 'utf8'));
        if (stored?.cert && stored?.key) {
          cached = { cert: stored.cert, key: stored.key };
          return cached;
        }
      } catch { /* ingen identitet ennå */ }
      const identity = createSelfSignedCertificate({ commonName: 'Fjern' });
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(identity), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, file);
      cached = identity;
      return cached;
    },
  };
}

// ---------- TLS ----------

const NETWORK_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL']);
const isNetworkError = (error) => error?.name === 'TimeoutError' || NETWORK_CODES.has(error?.code);

export function openTls(host, port, { cert, key, timeout = 5000, expectFingerprint = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, cert, key, rejectUnauthorized: false, timeout });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('timeout', () => fail(Object.assign(new Error('Tidsavbrudd mot Android TV'), { name: 'TimeoutError' })));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      socket.off('error', fail);
      const peer = socket.getPeerCertificate();
      socket.peerFingerprint = peer?.fingerprint256 || null;
      socket.peerKey = peer?.raw ? new crypto.X509Certificate(peer.raw).publicKey : null;
      if (expectFingerprint && socket.peerFingerprint !== expectFingerprint) {
        fail(Object.assign(new Error('Sertifikatet til Android TV-en er endret'), { name: 'CertificateMismatch' }));
        return;
      }
      resolve(socket);
    });
  });
}

// ---------- Økt ----------

export function createAndroidTvSession({
  keyStore,
  identity,
  log = () => {},
  connect: connectTls = openTls,
  ports = PORTS,
  connectTimeout = 5000,
  readyTimeout = 8000,
  pairingTimeout = 180_000,
  answerTimeout = 8000,
  reconnectDelays = [1000, 2000, 4000, 8000, 16_000],
} = {}) {
  const session = {
    host: null, socket: null, pairing: null, serverKey: null, ready: false, state: ANDROIDTV_STATE.idle, code: null,
    generation: 0, model: null, on: null, ime: null, features: FEATURES, currentApp: null,
  };
  let readyTimer = null;
  let pairingTimer = null;
  let reconnectTimer = null;
  let secretWaiter = null;

  const current = (generation) => generation === session.generation;
  const close = (socket) => { try { socket?.destroy(); } catch { /* allerede lukket */ } };

  function disconnect() {
    session.generation += 1;
    clearTimeout(readyTimer);
    clearTimeout(pairingTimer);
    clearTimeout(reconnectTimer);
    secretWaiter?.reject(new UserError(ANDROIDTV_STATE.lost, 409));
    secretWaiter = null;
    close(session.socket);
    close(session.pairing);
    Object.assign(session, { host: null, socket: null, pairing: null, serverKey: null, ready: false, state: ANDROIDTV_STATE.idle, code: null, model: null, on: null, ime: null, features: FEATURES, currentApp: null });
  }

  function scheduleReconnect(host, attempt, delays) {
    if (attempt >= delays.length) {
      session.state = ANDROIDTV_STATE.unreachable;
      session.code = 'unreachable';
      return;
    }
    const generation = session.generation;
    session.state = ANDROIDTV_STATE.reconnecting;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (current(generation)) connect(host, { auto: { attempt, delays } });
    }, delays[attempt]);
  }

  function send(payload) {
    const socket = session.socket;
    if (!session.ready || !socket || socket.destroyed) throw new UserError(session.state || 'Android TV-en er ikke tilkoblet.', 409);
    socket.write(frame(payload));
  }

  // --- Fjernkontroll-kanalen ---

  function onRemoteMessage(generation, socket, payload) {
    if (!current(generation)) return;
    const fields = decode(payload);
    if (fields.has(1)) {
      // Boksen presenterer seg (modell og produsent) og venter på vår konfigurasjon.
      const info = message(message(fields, 1), 2);
      const model = [text(info, 2), text(info, 1)].filter(Boolean).join(' ').trim().slice(0, 40);
      if (model) session.model = model;
      session.features = activeFeatures(first(message(fields, 1), 1) ?? 0);
      log(`Android TV: boksen støtter funksjoner ${first(message(fields, 1), 1) ?? 'ukjent'}, bruker ${session.features}`);
      if (!(session.features & FEATURE.APP_LINK)) log('Android TV: boksen støtter ikke applenker');
      socket.write(frame(remoteMessages.configure(session.features)));
    }
    if (fields.has(2)) {
      socket.write(frame(remoteMessages.setActive(session.features)));
      if (!session.ready) {
        clearTimeout(readyTimer);
        session.ready = true;
        session.state = ANDROIDTV_STATE.ready;
        session.code = null;
        const patch = { paired: true };
        if (socket.peerFingerprint) patch.fingerprint = socket.peerFingerprint;
        keyStore.update(storeKey(session.host), patch).catch((error) => log(`Android TV: kunne ikke lagre (${error.message})`));
        log('Android TV: klar');
      }
    }
    if (fields.has(3)) log('Android TV: boksen meldte feil');
    if (fields.has(8)) socket.write(frame(remoteMessages.pingResponse(first(message(fields, 8), 1) ?? 0)));
    if (fields.has(40)) session.on = Boolean(first(message(fields, 40), 1));
    if (fields.has(20)) {
      // Boksen forteller hvilken app som er åpen (pakkenavn). Logges for feilsøking.
      const app = text(message(message(fields, 20), 1), 12);
      if (app && app !== session.currentApp) {
        session.currentApp = app;
        log(`Android TV: åpen app ${app.slice(0, 80)}`);
      }
    }
    if (fields.has(21)) {
      // Skjermtastaturet er åpent; tellerne må sendes tilbake når vi skriver tekst.
      const edit = message(fields, 21);
      session.ime = { ime: first(edit, 1) ?? 0, field: first(edit, 2) ?? 0 };
    }
  }

  async function openRemote(host, stored, generation, auto) {
    const id = await identity.get();
    let socket;
    try {
      socket = await connectTls(host, ports.remote, { cert: id.cert, key: id.key, timeout: connectTimeout, expectFingerprint: stored?.fingerprint });
    } catch (error) {
      if (!current(generation)) return;
      if (error?.name === 'CertificateMismatch') {
        log('Android TV: sertifikatet stemmer ikke med det som ble låst');
        session.state = ANDROIDTV_STATE.certChanged;
        session.code = 'cert-changed';
      } else if (isNetworkError(error)) {
        log(`Android TV: fikk ikke kontakt (${error.code || error.message})`);
        if (auto) scheduleReconnect(host, auto.attempt + 1, auto.delays);
        else {
          session.state = ANDROIDTV_STATE.unreachable;
          session.code = 'unreachable';
        }
      } else {
        // Boksen avviser ukjente klientsertifikater under håndtrykket: da må vi pare.
        log(`Android TV: ikke paret (${error.code || error.message}), starter paring`);
        startPairing(host, generation);
      }
      return;
    }
    if (!current(generation)) return close(socket);
    session.socket = socket;
    let received = false;
    const reader = createFrameReader((payload) => {
      received = true;
      try { onRemoteMessage(generation, socket, payload); } catch (error) { log(`Android TV: ugyldig melding (${error.message})`); }
    });
    socket.on('data', (chunk) => {
      try { reader(chunk); } catch (error) {
        log(`Android TV: ${error.message}`);
        close(socket);
      }
    });
    socket.on('error', (error) => log(`Android TV: ${error.code || error.message}`));
    socket.on('close', () => {
      if (!current(generation) || session.socket !== socket) return;
      const wasReady = session.ready;
      clearTimeout(readyTimer);
      session.ready = false;
      session.socket = null;
      if (wasReady) scheduleReconnect(host, 0, reconnectDelays);
      else if (!received) {
        // Med TLS 1.3 avviser boksen et ukjent klientsertifikat først etter håndtrykket, ved å lukke uten å
        // sende noe. Det gjelder også en boks som er tilbakestilt og har glemt appen: da må vi pare (på nytt).
        log('Android TV: lukket før første melding, starter paring');
        startPairing(host, generation);
      } else if (auto) scheduleReconnect(host, auto.attempt + 1, auto.delays);
      else session.state = ANDROIDTV_STATE.lost;
    });
    readyTimer = setTimeout(() => {
      if (!current(generation) || session.ready) return;
      log('Android TV: svarte ikke etter tilkobling');
      close(socket);
    }, readyTimeout);
  }

  async function connect(host, { auto = null } = {}) {
    disconnect();
    const generation = session.generation;
    session.host = host;
    session.state = auto ? ANDROIDTV_STATE.reconnecting : ANDROIDTV_STATE.connecting;
    const stored = await keyStore.get(storeKey(host));
    if (!current(generation)) return;
    await openRemote(host, stored, generation, auto);
  }

  // --- Paring ---

  async function startPairing(host, generation) {
    if (!current(generation)) return;
    session.state = ANDROIDTV_STATE.pairing;
    session.code = null;
    let socket;
    try {
      const id = await identity.get();
      socket = await connectTls(host, ports.pairing, { cert: id.cert, key: id.key, timeout: connectTimeout });
    } catch (error) {
      if (!current(generation)) return;
      log(`Android TV: paring feilet (${error.code || error.message})`);
      session.state = ANDROIDTV_STATE.unreachable;
      session.code = 'unreachable';
      return;
    }
    if (!current(generation)) return close(socket);
    session.pairing = socket;
    session.serverKey = socket.peerKey;
    const fail = (state, reason) => {
      if (!current(generation) || session.pairing !== socket) return;
      log(`Android TV: ${reason}`);
      clearTimeout(pairingTimer);
      secretWaiter?.reject(new UserError(state === ANDROIDTV_STATE.pairingFailed ? 'Feil kode. Sjekk koden på TV-en og prøv igjen.' : state, 409));
      secretWaiter = null;
      session.pairing = null;
      session.state = state;
      session.code = null;
      close(socket);
    };
    const reader = createFrameReader((payload) => {
      if (!current(generation)) return;
      const fields = decode(payload);
      const status = first(fields, 2);
      if (status !== STATUS_OK) return fail(ANDROIDTV_STATE.pairingFailed, `paring avvist (status ${status})`);
      if (fields.has(11)) socket.write(frame(pairingMessages.options()));
      else if (fields.has(20)) socket.write(frame(pairingMessages.configuration()));
      else if (fields.has(31)) {
        session.state = ANDROIDTV_STATE.needsCode;
        session.code = 'needs-code';
        log('Android TV: venter på kode fra skjermen');
      } else if (fields.has(41)) {
        clearTimeout(pairingTimer);
        log('Android TV: paret');
        session.pairing = null;
        socket.end();
        const waiter = secretWaiter;
        secretWaiter = null;
        keyStore.update(storeKey(host), { paired: true })
          .catch(() => {})
          .then(() => connect(host))
          .then(() => waiter?.resolve(), (error) => waiter?.reject(error));
      }
    });
    socket.on('data', (chunk) => {
      try { reader(chunk); } catch (error) { fail(ANDROIDTV_STATE.pairingFailed, error.message); }
    });
    socket.on('error', (error) => log(`Android TV: ${error.code || error.message}`));
    socket.on('close', () => fail(ANDROIDTV_STATE.pairingFailed, 'paringen ble lukket'));
    pairingTimer = setTimeout(() => fail(ANDROIDTV_STATE.pairingTimeout, 'koden ble ikke skrevet inn i tide'), pairingTimeout);
    socket.write(frame(pairingMessages.request()));
  }

  // Brukeren har skrevet inn koden fra skjermen. Feil kode avvises lokalt før noe sendes.
  async function finishPairing(code) {
    const socket = session.pairing;
    if (!socket || session.code !== 'needs-code') throw new UserError('Ingen paring venter på kode. Velg enheten på nytt.', 409);
    const id = await identity.get();
    const secret = pairingSecret(id.cert, session.serverKey, code);
    if (!secret) {
      log('Android TV: koden stemte ikke med sjekksummen, ble ikke sendt');
      throw new UserError('Feil kode. Sjekk koden på TV-en og prøv igjen.');
    }
    log('Android TV: kode sendt til boksen');
    session.state = ANDROIDTV_STATE.checking;
    session.code = null;
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new UserError('Android TV-en svarte ikke på koden.', 504)), answerTimeout);
      secretWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
    socket.write(frame(pairingMessages.secret(secret)));
    await done;
  }

  // --- Kommandoer ---

  function ensureReady() {
    if (!session.ready) throw new UserError(session.state, 409);
  }

  async function command(key) {
    ensureReady();
    if (key === 'PowerOff') {
      if (session.on !== false) send(remoteMessages.key(KEYCODE_POWER));
      return;
    }
    const code = ANDROIDTV_KEYS[key];
    if (code === undefined) throw new UserError('Denne kommandoen støttes ikke av Android TV.');
    send(remoteMessages.key(code));
  }

  // Android TV støtter ikke Wake-on-LAN, men en tilkoblet boks i hvilemodus våkner av strømtasten.
  async function powerOn() {
    if (!session.ready) throw new UserError(NO_POWER, 409);
    if (session.on !== true) send(remoteMessages.key(KEYCODE_POWER));
  }

  async function sendText(value) {
    ensureReady();
    if (!session.ime) throw new UserError(NEEDS_FOCUS, 409);
    send(remoteMessages.text(value, session.ime.ime, session.ime.field));
  }

  async function apps() {
    ensureReady();
    return ANDROIDTV_APPS.map(({ id, name, icon }) => ({ id, name, system: false, color: null, icon }));
  }

  function ensureAppLinks() {
    if (!(session.features & FEATURE.APP_LINK)) throw new UserError(NO_APP_LINKS, 409);
  }

  async function launch(id) {
    ensureReady();
    const app = ANDROIDTV_APPS.find((entry) => entry.id === id);
    if (!app) throw new UserError('Ukjent app.', 404);
    ensureAppLinks();
    log(`Android TV: åpner ${app.package}`);
    send(remoteMessages.appLink(app.link));
  }

  async function playYoutube(videoId) {
    ensureReady();
    ensureAppLinks();
    log(`Android TV: spiller YouTube-video ${videoId}`);
    send(remoteMessages.appLink(`https://www.youtube.com/watch?v=${videoId}`));
  }

  async function forget(host) {
    await keyStore.remove(storeKey(host));
  }

  return {
    connect: (host) => connect(host),
    disconnect,
    finishPairing,
    command,
    powerOn,
    text: sendText,
    apps,
    launch,
    forget,
    inputs: async () => [],
    switchInput: async () => { throw new UserError('Android TV har ingen innganger å velge.', 404); },
    playYoutube,
    iconUrl: () => null,
    get ready() { return session.ready; },
    get state() { return session.state; },
    get code() { return session.code; },
    get host() { return session.host; },
    get canWake() { return session.ready; },
    get model() { return session.model; },
    get currentApp() { return session.currentApp; },
  };
}
