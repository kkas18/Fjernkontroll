// YouTube-modus: søk på mobilen, spill av på TV-en.
// Søket leser YouTubes offentlige søkeside (samme data som nettsiden viser), uten API-nøkkel.
import { UserError } from './errors.mjs';
import { readLimited } from './roku.mjs';

export const MAX_RESULTS = 20;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const isVideoId = (id) => typeof id === 'string' && /^[\w-]{11}$/.test(id);

export function validVideoId(id) {
  if (!isVideoId(id)) throw new UserError('Ukjent video.');
  return id;
}

const text = (node) => node?.simpleText ?? node?.runs?.map((run) => run.text).join('') ?? '';

// Finner alle videoRenderer-objekter, uansett hvor YouTube har plassert dem i strukturen.
function collectVideos(node, out) {
  if (out.length >= MAX_RESULTS || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideos(item, out);
    return;
  }
  if (node.videoRenderer) {
    out.push(node.videoRenderer);
    return;
  }
  for (const value of Object.values(node)) collectVideos(value, out);
}

export function parseSearchPage(html) {
  const start = html.indexOf('var ytInitialData = ');
  if (start === -1) throw new UserError('Fant ikke resultater fra YouTube akkurat nå.', 502);
  const end = html.indexOf(';</script>', start);
  let data;
  try {
    data = JSON.parse(html.slice(start + 'var ytInitialData = '.length, end));
  } catch {
    throw new UserError('Fant ikke resultater fra YouTube akkurat nå.', 502);
  }
  const renderers = [];
  collectVideos(data, renderers);
  return renderers
    .filter((video) => isVideoId(video.videoId))
    .map((video) => {
      const live = !video.lengthText && JSON.stringify(video.badges || []).includes('LIVE');
      return {
        id: video.videoId,
        title: text(video.title).slice(0, 200),
        channel: text(video.ownerText || video.longBylineText).slice(0, 100),
        duration: live ? 'Direkte' : text(video.lengthText).slice(0, 12),
        views: text(video.shortViewCountText || video.viewCountText).slice(0, 40),
      };
    });
}

export async function searchYoutube(query, { fetchImpl = fetch } = {}) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=nb&gl=NO`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'nb-NO,nb;q=0.9,en;q=0.5',
        // Hopper over samtykkesiden YouTube viser i EØS.
        cookie: 'SOCS=CAI; CONSENT=YES+',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw error;
    throw new UserError('Fikk ikke kontakt med YouTube. Sjekk at telefonen er på nett.', 502);
  }
  if (!response.ok) throw new UserError('YouTube svarte ikke på søket.', 502);
  return parseSearchPage(await readLimited(response, MAX_PAGE_BYTES));
}

// Forslag til søkeord mens brukeren skriver (samme kilde som søkefeltet på YouTube). Svaret er
// ["spørring", ["forslag 1", "forslag 2", …], …].
export const MAX_SUGGESTIONS = 6;
export const suggestUrl = (query) =>
  `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=nb&gl=no&ie=utf-8&oe=utf-8&q=${encodeURIComponent(query)}`;

export function parseSuggestions(body, query = '') {
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
  const seen = new Set([query.trim().toLowerCase()]);
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item.trim().slice(0, 100);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

export async function suggestYoutube(query, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(suggestUrl(query), { signal: AbortSignal.timeout(4000) });
  } catch {
    return []; // forslag er en bonus: feiler de, vises bare ingen
  }
  if (!response.ok) return [];
  try {
    return parseSuggestions(await readLimited(response, 64 * 1024), query);
  } catch {
    return [];
  }
}

export const thumbnailUrl = (id) => `https://i.ytimg.com/vi/${validVideoId(id)}/mqdefault.jpg`;
export const tvVideoTarget = (id) => `https://www.youtube.com/tv?v=${validVideoId(id)}`;
