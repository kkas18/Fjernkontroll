import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESULTS, parseSearchPage, searchYoutube, thumbnailUrl, tvVideoTarget, validVideoId } from '../lib/youtube.mjs';
import { UserError } from '../lib/errors.mjs';

// Forenklet utdrag av YouTubes søkeside: data ligger i ytInitialData, dypt nestet.
export function searchPage(videos) {
  const data = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: videos.map((videoRenderer) => ({ videoRenderer })) } },
  ] } } } } };
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}

const LOFI = {
  videoId: 'n61ULEU7CO0',
  title: { runs: [{ text: 'Best of lofi hip hop 2021' }] },
  ownerText: { runs: [{ text: 'Lofi Girl' }] },
  lengthText: { simpleText: '6:10:58' },
  shortViewCountText: { simpleText: '57 mill.' },
};
const LIVE = {
  videoId: 'rFZHOHl-L8A',
  title: { runs: [{ text: 'lofi hip hop radio' }] },
  ownerText: { runs: [{ text: 'Lofi Girl' }] },
  badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } }],
  viewCountText: { runs: [{ text: '8,5k' }, { text: ' ser på' }] },
};

test('søkesiden tolkes: tittel, kanal, lengde, visninger og direkte', () => {
  assert.deepEqual(parseSearchPage(searchPage([LOFI, LIVE])), [
    { id: 'n61ULEU7CO0', title: 'Best of lofi hip hop 2021', channel: 'Lofi Girl', duration: '6:10:58', views: '57 mill.' },
    { id: 'rFZHOHl-L8A', title: 'lofi hip hop radio', channel: 'Lofi Girl', duration: 'Direkte', views: '8,5k ser på' },
  ]);
});

test('ugyldige id-er hoppes over, og antallet har tak', () => {
  assert.deepEqual(parseSearchPage(searchPage([{ ...LOFI, videoId: '"><script>' }])), []);
  const many = Array.from({ length: 60 }, (_, i) => ({ ...LOFI, videoId: `abcdefghi${String(i).padStart(2, '0')}` }));
  assert.equal(parseSearchPage(searchPage(many)).length, MAX_RESULTS);
});

test('side uten data gir norsk feil', () => {
  assert.throws(() => parseSearchPage('<html>samtykke</html>'), UserError);
  assert.throws(() => parseSearchPage('var ytInitialData = {ødelagt;</script>'), UserError);
});

test('søket sender riktige hoder og koder søket', async () => {
  let seen;
  const fetchImpl = async (url, options) => { seen = { url, options }; return new Response(searchPage([LOFI])); };
  const videos = await searchYoutube('lofi & øl', { fetchImpl });
  assert.equal(videos.length, 1);
  assert.equal(new URL(seen.url).searchParams.get('search_query'), 'lofi & øl');
  assert.match(seen.options.headers.cookie, /SOCS=CAI/, 'hopper over samtykkesiden');
  await assert.rejects(searchYoutube('x', { fetchImpl: async () => { throw new TypeError('offline'); } }), /Fikk ikke kontakt med YouTube/);
});

test('video-id valideres før den brukes i adresser', () => {
  assert.equal(tvVideoTarget('rFZHOHl-L8A'), 'https://www.youtube.com/tv?v=rFZHOHl-L8A');
  assert.equal(thumbnailUrl('rFZHOHl-L8A'), 'https://i.ytimg.com/vi/rFZHOHl-L8A/mqdefault.jpg');
  for (const bad of ['', 'kort', 'rFZHOHl-L8A&x=1', '../../etc/pa', null]) assert.throws(() => validVideoId(bad), UserError, String(bad));
});
