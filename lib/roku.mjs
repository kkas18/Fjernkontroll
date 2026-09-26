// Roku External Control Protocol (ECP) på port 8060.
// Tastenavn: https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
import { UserError } from './errors.mjs';

// Appens kommandonavn → Roku ECP-taster. Roku har ingen egen pause-tast; Play veksler.
export const ROKU_KEYS = Object.freeze({
  Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right', Select: 'Select', Back: 'Back', Home: 'Home',
  VolumeUp: 'VolumeUp', VolumeDown: 'VolumeDown', Mute: 'VolumeMute', PowerOff: 'PowerOff',
  Play: 'Play', Pause: 'Play', Rewind: 'Rev', FastForward: 'Fwd',
  ChannelUp: 'ChannelUp', ChannelDown: 'ChannelDown',
});

const decodeXml = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export async function rokuProbe(host, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(2500) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
    throw new UserError('Fikk ikke kontakt med Roku. Sjekk IP-adressen og at «Control by mobile apps» er på.', 502);
  }
  if (!response.ok) throw new UserError('Roku avviste tilkoblingen. Aktiver «Control by mobile apps» på TV-en.', 502);
  const xml = await response.text();
  const raw = xml.match(/<(?:user-device-name|friendly-device-name)>([^<]{1,120})<\//i)?.[1];
  return { type: 'roku', host, name: raw ? decodeXml(raw).trim() : `Roku · ${host}` };
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
