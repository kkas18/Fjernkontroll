// Gjenkjenner hvilken TV som står på en IP-adresse, så brukeren bare trenger å skrive inn adressen.
// Alle kjennetegn sjekkes samtidig (tar høyst et par sekunder), og det mest entydige vinner:
//   1. Roku: HTTP 8060 /query/device-info svarer med Roku-XML
//   2. Samsung (Tizen): HTTP 8001 /api/v2/ svarer med enhetsinfo
//   3. Android TV / Google TV: fjernkontrolltjenesten lytter på TCP 6466
//   4. LG webOS: SSAP lytter på TCP 3001 (wss) eller 3000 (ws)
import net from 'node:net';
import { rokuProbe } from './roku.mjs';
import { samsungProbe } from './samsung.mjs';
import { UserError } from './errors.mjs';
import { isPrivateIPv4 } from './validate.mjs';

export const PROBE_PORTS = Object.freeze({ androidtv: [6466], lg: [3001, 3000] });
export const NOT_FOUND = 'Fant ingen TV som Fjern støtter på denne adressen. Sjekk at TV-en er på og på samme Wi‑Fi, og at adressen stemmer.';

// Åpner og lukker en TCP-forbindelse. Gir true hvis porten svarer innen fristen.
export function tcpOpen(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const DEFAULT_NAMES = { androidtv: 'Android TV', lg: 'LG-TV' };

export async function identifyTv(host, { fetchImpl = fetch, portOpen = tcpOpen, timeout = 2500 } = {}) {
  if (!isPrivateIPv4(host)) throw new UserError('Skriv en lokal IP-adresse, for eksempel 192.168.1.42.');
  const anyOpen = async (ports) => (await Promise.all(ports.map((port) => portOpen(host, port, timeout)))).some(Boolean);
  const [roku, samsung, androidtv, lg] = await Promise.all([
    rokuProbe(host, { fetchImpl, timeout }).catch(() => null),
    samsungProbe(host, { fetchImpl, timeout }).catch(() => null),
    anyOpen(PROBE_PORTS.androidtv),
    anyOpen(PROBE_PORTS.lg),
  ]);
  if (roku) return roku;
  if (samsung) return samsung;
  if (androidtv) return { type: 'androidtv', host, name: DEFAULT_NAMES.androidtv };
  if (lg) return { type: 'lg', host, name: DEFAULT_NAMES.lg };
  throw new UserError(NOT_FOUND, 404);
}
