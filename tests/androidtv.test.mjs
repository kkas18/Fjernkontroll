import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  ANDROIDTV_EXTRA_KEYS, ANDROIDTV_KEYS, ANDROIDTV_APPS, ANDROIDTV_STATE, FEATURES, NEEDS_FOCUS, NO_APP_LINKS, NO_POWER,
  createAndroidTvSession, createIdentityStore, pairingSecret, storeKey,
} from '../lib/androidtv.mjs';
import { createFrameReader, decode, decodeVarint, encode, encodeVarint, first, frame, message, text } from '../lib/protobuf.mjs';
import { createSelfSignedCertificate } from '../lib/x509.mjs';
import { parseResponse, query, readName, SERVICE } from '../lib/mdns.mjs';
import { createDiscovery } from '../lib/ssdp.mjs';
import { COMMANDS } from '../lib/validate.mjs';
import { UserError } from '../lib/errors.mjs';

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Tidsavbrudd i test');
    await settle(10);
  }
};

// Samme identitet i alle tester (RSA-nøkler tar tid å lage).
const CLIENT = createSelfSignedCertificate({ commonName: 'Fjern' });
const memoryIdentity = (id = CLIENT) => ({ get: async () => id });

function memoryKeys(initial = {}) {
  const keys = new Map(Object.entries(initial));
  return {
    keys,
    get: async (h) => keys.get(h),
    update: async (h, patch) => { keys.set(h, { ...keys.get(h), ...patch }); },
    remove: async (h) => { keys.delete(h); },
  };
}

// Paringskoden regnes ut uavhengig av appens egen funksjon: SHA-256 over modulus/eksponent fra begge sertifikater.
function codeFor(clientPem, serverPem, nonce = crypto.randomBytes(2)) {
  const numbers = (pem) => {
    const jwk = new crypto.X509Certificate(pem).publicKey.export({ format: 'jwk' });
    return [Buffer.from(jwk.n, 'base64url'), Buffer.from(jwk.e, 'base64url')];
  };
  const hash = crypto.createHash('sha256').update(Buffer.concat([...numbers(clientPem), ...numbers(serverPem), nonce])).digest();
  return { code: Buffer.concat([hash.subarray(0, 1), nonce]).toString('hex').toUpperCase(), hash };
}

// Etterligner en Android TV-boks: paringstjeneste og fjernkontroll-tjeneste over ekte TLS med klientsertifikat.
async function fakeTv({ server = createSelfSignedCertificate({ commonName: 'atvremote' }), paired = new Set(), closeUnknown = true, rejectHandshake = false, features = 622 } = {}) {
  const tv = { paired, received: [], remoteSockets: [], code: null, secrets: [], server };
  const fingerprintOf = (socket) => socket.getPeerCertificate()?.fingerprint256;
  const options = { cert: server.cert, key: server.key, requestCert: true, rejectUnauthorized: false };

  const pairing = tls.createServer(options, (socket) => {
    const reply = (field, payload, status = 200) => socket.write(frame(encode([[1, 2], [2, status], [field, payload]])));
    socket.on('error', () => {});
    socket.on('data', createFrameReader((payload) => {
      const fields = decode(payload);
      if (fields.has(10)) {
        assert.equal(text(message(fields, 10), 1), 'atvremote');
        reply(11, encode([[1, 'Telia Play-boks']]));
      } else if (fields.has(20)) {
        reply(20, encode([[1, encode([[1, 3], [2, 6]])], [3, 1]]));
      } else if (fields.has(30)) {
        const client = new crypto.X509Certificate(socket.getPeerCertificate().raw).toString();
        tv.pairingCode = codeFor(client, server.cert);
        tv.code = tv.pairingCode.code;
        reply(31, Buffer.alloc(0));
      } else if (fields.has(40)) {
        const secret = first(message(fields, 40), 1);
        tv.secrets.push(secret);
        if (tv.pairingCode && secret.equals(tv.pairingCode.hash)) {
          tv.paired.add(fingerprintOf(socket));
          reply(41, encode([[1, secret]]));
        } else {
          reply(41, Buffer.alloc(0), 402);
        }
      }
    }));
  });

  // rejectHandshake: boksen avviser ukjente klientsertifikater allerede i TLS-håndtrykket (alert).
  const remoteOptions = rejectHandshake ? { ...options, rejectUnauthorized: true, ca: [server.cert] } : options;
  const remote = tls.createServer(remoteOptions, (socket) => {
    socket.on('error', () => {});
    if (!tv.paired.has(fingerprintOf(socket))) {
      if (closeUnknown) socket.destroy();
      return;
    }
    tv.remoteSockets.push(socket);
    const send = (payload) => socket.write(frame(payload));
    socket.on('data', createFrameReader((payload) => {
      const fields = decode(payload);
      tv.received.push(fields);
      // Klienten svarer på konfigurasjonen: da aktiverer boksen fjernkontrollen og sjekker at den lever.
      if (fields.has(1)) send(encode([[2, encode([[1, features]])]]));
      if (fields.has(2)) {
        send(encode([[8, encode([[1, 42]])]]));
        send(encode([[40, encode([[1, 1]])]]));
      }
    }));
    send(encode([[1, encode([[1, features], [2, encode([[1, 'Telia Play-boks'], [2, 'Telia']])]])]]));
  });

  await Promise.all([pairing, remote].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
  tv.ports = { pairing: pairing.address().port, remote: remote.address().port };
  tv.sendToAll = (payload) => tv.remoteSockets.forEach((socket) => socket.write(frame(payload)));
  tv.close = () => {
    for (const socket of tv.remoteSockets) socket.destroy();
    pairing.close();
    remote.close();
  };
  return tv;
}

const keyCodes = (tv) => tv.received.filter((f) => f.has(10)).map((f) => first(message(f, 10), 1));
const appLinks = (tv) => tv.received.filter((f) => f.has(90)).map((f) => text(message(f, 90), 1));

function session(tv, options = {}) {
  return createAndroidTvSession({
    keyStore: options.keyStore || memoryKeys(),
    identity: memoryIdentity(),
    ports: tv.ports,
    log: () => {},
    ...options,
  });
}

async function pairedSession(options = {}) {
  const tv = await fakeTv(options.tv);
  const keyStore = options.keyStore || memoryKeys();
  const atv = session(tv, { keyStore, ...options.session });
  await atv.connect('127.0.0.1');
  await waitFor(() => atv.code === 'needs-code');
  await atv.finishPairing(tv.code);
  await waitFor(() => atv.ready);
  return { tv, atv, keyStore };
}

test('protobuf: varint, felt og rammer', () => {
  for (const value of [0, 1, 127, 128, 300, 622, 2 ** 31 - 1]) assert.equal(decodeVarint(encodeVarint(value)).value, value, String(value));
  assert.equal(decodeVarint(encodeVarint(-1)).value, -1);
  assert.equal(decodeVarint(Buffer.from([0x80])), null, 'ufullstendig varint');
  const message1 = encode([[1, 2], [2, 200], [10, encode([[1, 'atvremote'], [2, 'Fjern']])], [5, undefined]]);
  assert.equal(message1.toString('hex'), '080210c80152120a0961747672656d6f74651205466a65726e');
  const fields = decode(message1);
  assert.equal(first(fields, 2), 200);
  assert.equal(text(message(fields, 10), 2), 'Fjern');
  assert.equal(fields.has(5), false);
  const got = [];
  const read = createFrameReader((payload) => got.push(payload.toString()));
  const stream = Buffer.concat([frame(Buffer.from('hei')), frame(Buffer.from('på deg'))]);
  read(stream.subarray(0, 2));
  read(stream.subarray(2));
  assert.deepEqual(got, ['hei', 'på deg']);
  assert.throws(() => createFrameReader(() => {}, { max: 4 })(frame(Buffer.alloc(10))), /For stor/);
});

test('klientsertifikatet er et gyldig, selvsignert X.509 v3 med 2048-bits RSA', () => {
  const x509 = new crypto.X509Certificate(CLIENT.cert);
  assert.equal(x509.subject, 'CN=Fjern');
  assert.equal(x509.verify(x509.publicKey), true);
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(CLIENT.key)), true);
  assert.equal(x509.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.ok(new Date(x509.validTo) > new Date(Date.now() + 19 * 365 * 24 * 3600 * 1000));
});

test('identiteten lagres med tilgang bare for eieren, og gjenbrukes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fjern-'));
  const file = path.join(dir, 'data', 'androidtv-client.json');
  const first1 = await createIdentityStore(file).get();
  const again = await createIdentityStore(file).get();
  assert.equal(again.cert, first1.cert);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.rm(dir, { recursive: true });
});

test('paringskoden sjekkes lokalt: riktig kode gir hemmeligheten, feil kode avvises', () => {
  const server = createSelfSignedCertificate({ commonName: 'tv' });
  const { code, hash } = codeFor(CLIENT.cert, server.cert);
  assert.deepEqual(pairingSecret(CLIENT.cert, server.cert, code.toLowerCase()), hash);
  const wrong = ((parseInt(code.slice(0, 2), 16) + 1) & 0xff).toString(16).padStart(2, '0') + code.slice(2);
  assert.equal(pairingSecret(CLIENT.cert, server.cert, wrong), null);
  assert.throws(() => pairingSecret(CLIENT.cert, server.cert, '12345'), UserError);
  assert.throws(() => pairingSecret(CLIENT.cert, server.cert, 'GHIJKL'), UserError);
});

test('alle ekstra taster har en Android-tast, og alle tastene er gyldige kommandoer', () => {
  for (const key of ANDROIDTV_EXTRA_KEYS) assert.ok(ANDROIDTV_KEYS[key] !== undefined, key);
  for (const key of Object.keys(ANDROIDTV_KEYS)) assert.ok(COMMANDS.includes(key), key);
  // Appene åpnes med pakkenavn via Play-butikken (https-lenker virket ikke på Telia-boksen).
  const ids = new Set();
  for (const app of ANDROIDTV_APPS) {
    assert.match(app.package, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, app.id);
    assert.equal(app.link, `market://launch?id=${app.package}`);
    assert.equal(app.icon, `/icons/apps/${app.id}.png`);
    assert.ok(!ids.has(app.id), app.id);
    ids.add(app.id);
  }
  assert.ok(ids.has('teliaplay'));
  assert.equal(FEATURES, 615);
});

test('første gang: boksen avviser ukjent klient, viser kode, og riktig kode gir paret og klar økt', async () => {
  const { tv, atv, keyStore } = await pairedSession();
  try {
    assert.equal(atv.state, ANDROIDTV_STATE.ready);
    assert.equal(atv.model, 'Telia Telia Play-boks');
    assert.equal(tv.paired.size, 1);
    const stored = keyStore.keys.get(storeKey('127.0.0.1'));
    assert.equal(stored.paired, true);
    assert.equal(stored.fingerprint, new crypto.X509Certificate(tv.server.cert).fingerprint256);
    // Boksens ping ble besvart, og konfigurasjonen ble sendt.
    assert.ok(tv.received.some((f) => f.has(9) && first(message(f, 9), 1) === 42));
    assert.ok(tv.received.some((f) => f.has(1)));
  } finally {
    atv.disconnect();
    tv.close();
  }
});

test('en tilbakestilt boks som har glemt appen ber om ny kode', async () => {
  const { tv, atv, keyStore } = await pairedSession();
  atv.disconnect();
  tv.paired.clear();
  const again = session(tv, { keyStore });
  try {
    await again.connect('127.0.0.1');
    await waitFor(() => again.code === 'needs-code');
    await again.finishPairing(tv.code);
    await waitFor(() => again.ready);
  } finally {
    again.disconnect();
    tv.close();
  }
});

test('boksen som avviser i TLS-håndtrykket starter også paring', async () => {
  const tv = await fakeTv({ rejectHandshake: true });
  const atv = session(tv);
  try {
    await atv.connect('127.0.0.1');
    await waitFor(() => atv.code === 'needs-code');
    assert.equal(atv.state, ANDROIDTV_STATE.needsCode);
  } finally {
    atv.disconnect();
    tv.close();
  }
});

test('feil kode avvises før noe sendes, og paringen kan fullføres etterpå', async () => {
  const tv = await fakeTv();
  const atv = session(tv);
  try {
    await atv.connect('127.0.0.1');
    await waitFor(() => atv.code === 'needs-code');
    assert.equal(atv.state, ANDROIDTV_STATE.needsCode);
    const wrong = ((parseInt(tv.code.slice(0, 2), 16) + 1) & 0xff).toString(16).padStart(2, '0') + tv.code.slice(2);
    await assert.rejects(atv.finishPairing(wrong), /Feil kode/);
    assert.equal(tv.secrets.length, 0, 'ingen hemmelighet sendt for feil kode');
    await atv.finishPairing(tv.code);
    await waitFor(() => atv.ready);
  } finally {
    atv.disconnect();
    tv.close();
  }
});

test('boksen avviser hemmeligheten: tydelig feil, og ingen kode venter lenger', async () => {
  const tv = await fakeTv();
  const atv = session(tv);
  try {
    await atv.connect('127.0.0.1');
    await waitFor(() => atv.code === 'needs-code');
    // Boksen bytter kode (f.eks. ny paring på TV-en) etter at brukeren har lest den.
    const old = tv.code;
    tv.pairingCode = codeFor(CLIENT.cert, tv.server.cert);
    await assert.rejects(atv.finishPairing(old), (error) => error instanceof UserError);
    await waitFor(() => atv.state === ANDROIDTV_STATE.pairingFailed);
    await assert.rejects(atv.finishPairing(old), /Ingen paring venter/);
  } finally {
    atv.disconnect();
    tv.close();
  }
});

test('neste tilkobling bruker sertifikatet uten ny kode', async () => {
  const { tv, atv, keyStore } = await pairedSession();
  try {
    atv.disconnect();
    const again = session(tv, { keyStore });
    await again.connect('127.0.0.1');
    await waitFor(() => again.ready);
    assert.equal(again.code, null);
    again.disconnect();
  } finally {
    tv.close();
  }
});

test('taster, ⏯, apper, YouTube og strøm sendes som Android-hendelser og applenker', async () => {
  const { tv, atv } = await pairedSession();
  try {
    for (const key of ['Up', 'Select', 'Back', 'Home', 'VolumeUp', 'Mute', 'PlayPause', 'Num5', 'Blue', 'Settings']) await atv.command(key);
    await atv.launch('netflix');
    await atv.playYoutube('n61ULEU7CO0');
    await atv.command('PowerOff');
    await settle(50);
    assert.deepEqual(keyCodes(tv), [19, 23, 4, 3, 24, 164, 85, 12, 186, 176, 26]);
    assert.ok(tv.received.filter((f) => f.has(10)).every((f) => first(message(f, 10), 2) === 3), 'kort trykk');
    assert.deepEqual(appLinks(tv), ['market://launch?id=com.netflix.ninja', 'https://www.youtube.com/watch?v=n61ULEU7CO0']);
    const apps = await atv.apps();
    assert.deepEqual(apps.map((a) => a.id), ANDROIDTV_APPS.map((a) => a.id));
    assert.deepEqual(apps.find((a) => a.id === 'teliaplay'), { id: 'teliaplay', name: 'Telia Play', system: false, color: null, icon: '/icons/apps/teliaplay.png' });
    await assert.rejects(atv.launch('evil'), /Ukjent app/);
    await assert.rejects(atv.command('Dash'), /støttes ikke av Android TV/);
    // Boksen er på (remote_start), så «Slå på» sender ingenting.
    await atv.powerOn();
    await settle(30);
    assert.equal(keyCodes(tv).length, 11);
  } finally {
    atv.disconnect();
    tv.close();
  }
});

test('funksjonene avtales med boksen: vi svarer med det begge støtter, og uten applenker får brukeren beskjed', async () => {
  const configured = (tv) => tv.received.filter((f) => f.has(1)).map((f) => first(message(f, 1), 1));
  const activated = (tv) => tv.received.filter((f) => f.has(2)).map((f) => first(message(f, 2), 1));
  // Boksen kan taster, skjermtastatur, strøm, volum og applenker (men ikke tale): vi bruker 615 & 614 = 614.
  const full = await pairedSession();
  try {
    await settle(30);
    assert.deepEqual(configured(full.tv), [614]);
    assert.deepEqual(activated(full.tv), [614]);
  } finally {
    full.atv.disconnect();
    full.tv.close();
  }
  // Boksen kan bare taster og skjermtastatur: apper og YouTube avvises med forklaring, taster virker.
  const lines = [];
  const limited = await pairedSession({ tv: { features: 2 | 4 }, session: { log: (line) => lines.push(line) } });
  try {
    await settle(30);
    assert.deepEqual(configured(limited.tv), [6]);
    await assert.rejects(limited.atv.launch('teliaplay'), (error) => error.message === NO_APP_LINKS && error.status === 409);
    await assert.rejects(limited.atv.playYoutube('n61ULEU7CO0'), (error) => error.message === NO_APP_LINKS);
    await limited.atv.command('Home');
    await settle(30);
    assert.deepEqual(appLinks(limited.tv), []);
    assert.deepEqual(keyCodes(limited.tv), [3]);
    assert.ok(lines.includes('Android TV: boksen støtter ikke applenker'), lines.join('\n'));
    // Boksen melder hvilken app som er åpen (remote_ime_key_inject.app_info.app_package).
    limited.tv.sendToAll(encode([[20, encode([[1, encode([[1, 1], [12, 'no.get.play.tv']])]])]]));
    await waitFor(() => limited.atv.currentApp === 'no.get.play.tv');
    assert.ok(lines.includes('Android TV: åpen app no.get.play.tv'));
  } finally {
    limited.atv.disconnect();
    limited.tv.close();
  }
});

test('tekst krever åpent tekstfelt, og sender tellerne fra boksen tilbake', async () => {
  const { tv, atv } = await pairedSession();
  try {
    await assert.rejects(atv.text('hei'), (error) => error.message === NEEDS_FOCUS);
    tv.sendToAll(encode([[21, encode([[1, 7], [2, 3]])]]));
    await settle(50);
    await atv.text('æøå');
    await settle(50);
    const edit = message(tv.received.find((f) => f.has(21)), 21);
    assert.deepEqual([first(edit, 1), first(edit, 2)], [7, 3]);
    const object = message(message(edit, 3), 2);
    assert.equal(text(object, 3), 'æøå');
    assert.equal(first(object, 1), 2);
  } finally {
    atv.disconnect();
    tv.close();
  }
});

test('kobler til igjen av seg selv når boksen lukker forbindelsen', async () => {
  const { tv, atv } = await pairedSession({ session: { reconnectDelays: [10, 10] } });
  try {
    tv.remoteSockets[0].destroy();
    await waitFor(() => !atv.ready);
    await waitFor(() => atv.ready);
    assert.equal(tv.remoteSockets.length, 2);
  } finally {
    atv.disconnect();
    tv.close();
  }
});

test('endret sertifikat stopper tilkoblingen og gir kode for ny paring', async () => {
  const { tv, atv, keyStore } = await pairedSession();
  atv.disconnect();
  tv.close();
  // Samme adresse, men en annen boks (nytt sertifikat) som også kjenner klienten.
  const impostor = await fakeTv({ paired: tv.paired });
  try {
    const again = session(impostor, { keyStore });
    await again.connect('127.0.0.1');
    await waitFor(() => again.code === 'cert-changed');
    assert.equal(again.state, ANDROIDTV_STATE.certChanged);
    assert.equal(impostor.received.length, 0, 'ingenting sendes til en ukjent motpart');
    await again.forget('127.0.0.1');
    assert.equal(keyStore.keys.has(storeKey('127.0.0.1')), false);
    again.disconnect();
  } finally {
    impostor.close();
  }
});

test('uten svar fra boksen: tydelig melding, og «Slå på» krever forbindelse', async () => {
  const atv = createAndroidTvSession({ keyStore: memoryKeys(), identity: memoryIdentity(), ports: { remote: 1, pairing: 1 }, log: () => {} });
  await atv.connect('127.0.0.1');
  assert.equal(atv.state, ANDROIDTV_STATE.unreachable);
  assert.equal(atv.code, 'unreachable');
  await assert.rejects(atv.powerOn(), (error) => error.message === NO_POWER);
  await assert.rejects(atv.finishPairing('ABCDEF'), /Ingen paring venter/);
});

// ---------- mDNS ----------

function dnsResponse(instance) {
  const name = (labels) => Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6); // ett svar
  const owner = name(SERVICE.split('.'));
  // PTR-data: instansnavnet + peker tilbake til tjenestenavnet (offset 12), slik mDNS komprimerer.
  const label = Buffer.from(instance);
  const rdata = Buffer.concat([Buffer.from([label.length]), label, Buffer.from([0xc0, 12])]);
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(12, 0);
  meta.writeUInt16BE(1, 2);
  meta.writeUInt32BE(120, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([header, owner, meta, rdata]);
}

test('mDNS: spørringen ber om PTR for Android TV, og svar med komprimerte navn leses', () => {
  const packet = query();
  assert.equal(readName(packet, 12).name, SERVICE);
  assert.equal(packet.readUInt16BE(packet.length - 4), 12);
  assert.deepEqual(parseResponse(dnsResponse('Telia Play-boks')), ['Telia Play-boks']);
  assert.deepEqual(parseResponse(Buffer.alloc(5)), []);
  const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 12])]);
  assert.throws(() => readName(loop, 12), /pekere/);
});

test('søket slår sammen SSDP og mDNS', async () => {
  const discover = createDiscovery({
    waitMs: 20,
    log: () => {},
    extraSearches: [async () => [{ type: 'androidtv', host: '192.168.1.60', name: 'Telia Play-boks' }], async () => { throw new Error('nede'); }],
  });
  const devices = await discover();
  assert.deepEqual(devices.filter((d) => d.type === 'androidtv'), [{ type: 'androidtv', host: '192.168.1.60', name: 'Telia Play-boks' }]);
});
