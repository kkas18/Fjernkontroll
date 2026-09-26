// Ren logikk uten DOM, delt mellom grensesnittet og testene (node:test).

export const typeLabel = (type) => (type === 'lg' ? 'LG webOS' : 'Roku');

export const sameDevice = (a, b) => Boolean(a && b && a.type === b.type && a.host === b.host);

export const isValidDevice = (d) => Boolean(d && ['roku', 'lg'].includes(d.type) && typeof d.host === 'string' && isPrivateIPv4(d.host));

export function isPrivateIPv4(ip) {
  if (typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (!parts.every((n) => n <= 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export const BRIDGE_DOWN = 'Broen svarer ikke. Start den i Termux med «npm start».';

const ERROR_WORDS = /ikke|feil|avvist|avviste|frakoblet|kontakt|endret|svarer/i;

// Hva statuslinjen skal vise, og hvilken handling den eventuelt tilbyr.
export function noticeFor({ bridge, device, ready, message, code }) {
  if (!bridge) return { text: BRIDGE_DOWN, tone: 'err', action: null };
  if (!device || ready) return { text: '', tone: 'info', action: null };
  const text = message || 'Kobler til …';
  if (code === 'cert-changed' || code === 'needs-repair') return { text, tone: 'err', action: { id: 'repair', label: 'Par på nytt' } };
  // Alle feiltilstander får en vei videre, ikke bare en melding.
  if (code === 'unreachable' || ERROR_WORDS.test(text)) return { text, tone: 'err', action: { id: 'retry', label: 'Prøv igjen' } };
  return { text, tone: 'busy', action: null };
}

export const transportMode = (capabilities) => (capabilities?.playPause === 'toggle' ? 'toggle' : 'separate');

export const newDevices = (found, saved) => found.filter((d) => !saved.some((s) => sameDevice(s, d)));

export function rememberDevice(saved, device) {
  const entry = { type: device.type, host: device.host, name: device.name };
  return [entry, ...saved.filter((d) => !sameDevice(d, entry))];
}
