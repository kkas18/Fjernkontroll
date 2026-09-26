// Roku External Control Protocol (ECP) på port 8060.
// Tastenavn: https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
import { UserError } from './errors.mjs';
import { MAX_APPS, validAppId } from './validate.mjs';

// Appens kommandonavn → Roku ECP-taster. Roku har ingen egen pause-tast; Play veksler.
export const ROKU_KEYS = Object.freeze({
  Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right', Select: 'Select', Back: 'Back', Home: 'Home',
  VolumeUp: 'VolumeUp', VolumeDown: 'VolumeDown', Mute: 'VolumeMute', PowerOff: 'PowerOff', PowerOn: 'PowerOn',
  Play: 'Play', Pause: 'Play', PlayPause: 'Play', Rewind: 'Rev', FastForward: 'Fwd',
  ChannelUp: 'ChannelUp', ChannelDown: 'ChannelDown', Backspace: 'Backspace', Enter: 'Enter',
  Num0: 'Lit_0', Num1: 'Lit_1', Num2: 'Lit_2', Num3: 'Lit_3', Num4: 'Lit_4',
  Num5: 'Lit_5', Num6: 'Lit_6', Num7: 'Lit_7', Num8: 'Lit_8', Num9: 'Lit_9',
  Info: 'Info', Search: 'Search', Replay: 'InstantReplay',
});
export const ROKU_EXTRA_KEYS = Object.freeze([
  'Num0', 'Num1', 'Num2', 'Num3', 'Num4', 'Num5', 'Num6', 'Num7', 'Num8', 'Num9', 'Info', 'Search', 'Replay', 'Enter',
]);
// YouTube-kanalen på Roku.
export const ROKU_YOUTUBE_ID = '837';

// ECP-søk som åpner YouTube med søkeordet (launch=true).
export async function rokuSearch(host, query, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ keyword: query, 'provider-id': ROKU_YOUTUBE_ID, launch: 'true' });
  const response = await fetchImpl(`http://${host}:8060/search/browse?${params}`, { method: 'POST', signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new UserError('Roku kunne ikke søke.', 502);
}

// Svar fra lokalnettet leses med tak, slik at en feilaktig enhet ikke kan fylle minnet.
export const MAX_RESPONSE_BYTES = 64 * 1024;
const TOO_LARGE = 'For stort svar fra TV-en.';

export async function readLimited(response, max = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) throw new UserError(TOO_LARGE, 502);
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new UserError(TOO_LARGE, 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const decodeXml = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export async function rokuProbe(host, { fetchImpl = fetch, timeout = 2500 } = {}) {
  let response;
  try {
    response = await fetchImpl(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
    throw new UserError('Fikk ikke kontakt med Roku. Sjekk IP-adressen og at «Control by mobile apps» er på.', 502);
  }
  if (!response.ok) throw new UserError('Roku avviste tilkoblingen. Aktiver «Control by mobile apps» på TV-en.', 502);
  const xml = await readLimited(response);
  const raw = xml.match(/<(?:user-device-name|friendly-device-name)>([^<]{1,120})<\//i)?.[1];
  const isTv = /<is-tv>\s*true\s*<\/is-tv>/i.test(xml);
  return { type: 'roku', host, name: raw ? decodeXml(raw).trim() : 'Roku', isTv };
}

async function keypress(host, rokuKey, fetchImpl, timeout) {
  const response = await fetchImpl(`http://${host}:8060/keypress/${rokuKey}`, { method: 'POST', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new UserError('Roku avviste kommandoen.', 502);
}

export async function rokuCommand(host, command, { fetchImpl = fetch } = {}) {
  const rokuKey = ROKU_KEYS[command];
  if (!rokuKey) throw new UserError('Denne kommandoen støttes ikke av Roku.');
  await keypress(host, rokuKey, fetchImpl, 2500);
}

// Roku tar imot tekst ett tegn om gangen. Kort tidsavbrudd per tegn og stopp ved første feil.
export async function rokuText(host, text, { fetchImpl = fetch } = {}) {
  for (const char of text) await keypress(host, `Lit_${encodeURIComponent(char)}`, fetchImpl, 1200);
}

export function parseRokuApps(xml) {
  const apps = [];
  for (const match of xml.matchAll(/<app\s+id="([^"]{1,80})"([^>]*)>([^<]{1,80})<\/app>/g)) {
    try {
      // type="tvin" er innganger (HDMI, antenne); de sorteres sammen med systemapper.
      const type = /type="([^"]*)"/.exec(match[2])?.[1];
      apps.push({ id: validAppId(match[1]), name: decodeXml(match[3]).trim(), system: Boolean(type && type !== 'appl'), color: null });
    } catch { /* hopp over ugyldige id-er */ }
    if (apps.length >= MAX_APPS) break;
  }
  return apps;
}

export async function rokuApps(host, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`http://${host}:8060/query/apps`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new UserError('Roku ga ikke ut applisten.', 502);
  return parseRokuApps(await readLimited(response));
}

export async function rokuLaunch(host, id, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`http://${host}:8060/launch/${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new UserError('Roku kunne ikke åpne appen.', 502);
}

export async function rokuIcon(host, id, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`http://${host}:8060/query/icon/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new UserError('Roku ga ikke ut ikonet.', 502);
  return Buffer.from(await readLimitedBytes(response, 256 * 1024));
}

async function readLimitedBytes(response, max) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > max) throw new UserError('Ikonet er for stort.', 502);
    return buffer;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new UserError('Ikonet er for stort.', 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
