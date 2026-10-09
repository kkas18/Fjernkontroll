// Ren logikk uten DOM, delt mellom grensesnittet og testene (node:test).

export const DEVICE_TYPES = Object.freeze(['roku', 'lg', 'samsung', 'androidtv']);
const TYPE_LABELS = Object.freeze({ roku: 'Roku', lg: 'LG webOS', samsung: 'Samsung', androidtv: 'Android TV' });
// Standardnavn for en TV som legges til uten navn (brukeren kan gi den eget navn senere).
export const DEFAULT_NAMES = Object.freeze({ roku: 'Roku', lg: 'LG-TV', samsung: 'Samsung-TV', androidtv: 'Android TV' });

export const typeLabel = (type) => TYPE_LABELS[type] || 'Roku';

export const sameDevice = (a, b) => Boolean(a && b && a.type === b.type && a.host === b.host);

export const isValidDevice = (d) => Boolean(d && DEVICE_TYPES.includes(d.type) && typeof d.host === 'string' && isPrivateIPv4(d.host));

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
  // Android TV viser en kode på skjermen som må skrives inn i appen.
  if (code === 'needs-code') return { text, tone: 'busy', action: { id: 'pair', label: 'Skriv inn kode' } };
  if (code === 'cert-changed' || code === 'needs-repair') return { text, tone: 'err', action: { id: 'repair', label: 'Par på nytt' } };
  // Alle feiltilstander får en vei videre, ikke bare en melding.
  if (code === 'unreachable' || ERROR_WORDS.test(text)) return { text, tone: 'err', action: { id: 'retry', label: 'Prøv igjen' } };
  return { text, tone: 'busy', action: null };
}

export const transportMode = (capabilities) => (capabilities?.playPause === 'toggle' ? 'toggle' : 'separate');

export const newDevices = (found, saved) => found.filter((d) => !saved.some((s) => sameDevice(s, d)));

export function rememberDevice(saved, device) {
  const previous = saved.find((d) => sameDevice(d, device));
  const entry = { type: device.type, host: device.host, name: normalizeName(device) };
  if (previous?.customName) entry.customName = previous.customName;
  return [entry, ...saved.filter((d) => !sameDevice(d, entry))];
}

// ---------- Apper og favoritter ----------

// Kjente strømmetjenester blir standardfavoritter. Brukeren kan endre dem i «Alle apper».
const STREAMING = /netflix|youtube|nrk|tv ?2|telia|disney|\bmax\b|hbo|viaplay|prime video|amazon prime|apple tv|spotify|plex|tv4|discovery|skyshowtime|allente|strim|paramount/i;
// LG merker ikke alltid systemapper; disse navnene sorteres likevel nederst.
const SYSTEM_NAMES = /developer|kamera|camera|hjemmehubb|home ?hub|nettleser|browser|mediespiller|media ?player|^apps$|innstillinger|settings|gallery|alexa|brukerveiledning|user guide|lg channels|live tv|sport/i;

export const MAX_FAVORITES = 9;

export const isSystemApp = (app) => Boolean(app.system) || SYSTEM_NAMES.test(app.name);

export function sortApps(apps) {
  const regular = apps.filter((app) => !isSystemApp(app));
  const system = apps.filter(isSystemApp);
  return { regular, system };
}

export function defaultFavorites(apps, max = 4) {
  const streaming = apps.filter((app) => STREAMING.test(app.name) && !isSystemApp(app));
  const picked = streaming.length ? streaming : apps.filter((app) => !isSystemApp(app));
  return picked.slice(0, max).map((app) => app.id);
}

// Lagrede favoritter i brukerens rekkefølge, bare apper som fortsatt finnes på TV-en.
export function favoriteApps(apps, stored) {
  const ids = Array.isArray(stored) ? stored : defaultFavorites(apps);
  return ids.map((id) => apps.find((app) => app.id === id)).filter(Boolean).slice(0, MAX_FAVORITES);
}

export function toggleFavorite(apps, stored, id) {
  const current = Array.isArray(stored) ? stored.slice() : defaultFavorites(apps);
  const index = current.indexOf(id);
  if (index >= 0) current.splice(index, 1);
  else if (current.length < MAX_FAVORITES) current.push(id);
  return current;
}

// Kjente apper får merkefarge og kortnavn i reserveikonet. Fargene er mørk nok til hvit tekst (minst 4,5:1).
const BRANDS = [
  [/^netflix/i, '#c80711', 'N'],
  [/^youtube/i, '#d6002b', 'YT'],
  [/^nrk/i, '#1d3f73', 'NRK'],
  [/^tv\s?2/i, '#c3001a', 'TV2'],
  [/^disney/i, '#1438b8', 'D+'],
  [/^(hbo\s?)?max$|^hbo/i, '#0f2fd6', 'max'],
  [/^prime|amazon/i, '#0b6fc0', 'PV'],
  [/^spotify/i, '#15803d', 'S'],
  [/^viaplay/i, '#5a1f8f', 'V'],
  [/^telia/i, '#6a0ea8', 'TP'],
  [/^apple\s?tv/i, '#2a2a2e', 'tv'],
  [/^twitch/i, '#7432e0', 'T'],
  [/^plex/i, '#8a5a00', 'P'],
];
export function brandFor(name) {
  const text = String(name || '').trim();
  const hit = BRANDS.find(([pattern]) => pattern.test(text));
  return hit ? { color: hit[1], label: hit[2] } : null;
}

// Medfølgende appikon (public/icons/apps/). Bare egne, faste stier godtas.
export function bundledIcon(app) {
  const icon = app?.icon;
  return typeof icon === 'string' && /^\/icons\/apps\/[a-z0-9]{1,32}\.png$/.test(icon) ? icon : null;
}

// Bokstavikon brukes til TV-ens eget ikon er lastet, eller hvis det mangler.
export function initials(name) {
  const brand = brandFor(name);
  if (brand) return brand.label;
  const words = String(name || '?').trim().split(/\s+/);
  if (/^[A-ZÆØÅ0-9+]{2,3}$/.test(words[0])) return words[0];
  return words[0].slice(0, 1).toUpperCase();
}

const FALLBACK_COLORS = ['#3a4a6b', '#4b3a6b', '#6b3a4f', '#6b513a', '#3a6b5a', '#3a5f6b'];
export function fallbackColor(app) {
  if (app.color) return app.color;
  const brand = brandFor(app.name);
  if (brand) return brand.color;
  let hash = 0;
  for (const char of String(app.id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

// ---------- TV-navn ----------

// Eldre versjoner lagret navn som «LG webOS · 192.168.0.3». IP-en vises nå på egen linje.
export function normalizeName(device) {
  const name = String(device.name || '');
  if (/^LG webOS( · .*)?$/.test(name)) return 'LG-TV';
  if (/^Roku · /.test(name)) return 'Roku';
  return name || DEFAULT_NAMES[device.type] || 'Roku';
}

export const displayName = (device, saved = []) =>
  saved.find((d) => sameDevice(d, device))?.customName || device?.name || 'Ingen TV';

// ---------- YouTube: siste søk ----------

export const MAX_RECENT = 8;

// Nyeste først, uten duplikater (uavhengig av store og små bokstaver), med tak.
export function addRecent(list, query, max = MAX_RECENT) {
  const q = String(query || '').trim().slice(0, 100);
  const clean = (Array.isArray(list) ? list : []).filter((item) => typeof item === 'string' && item.trim());
  if (!q) return clean.slice(0, max);
  return [q, ...clean.filter((item) => item.toLowerCase() !== q.toLowerCase())].slice(0, max);
}
