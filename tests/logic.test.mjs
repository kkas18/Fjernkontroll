import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addRecent, MAX_RECENT, BRIDGE_DOWN, DEFAULT_NAMES, brandFor, defaultFavorites, displayName, fallbackColor, favoriteApps, initials, isPrivateIPv4, isSystemApp, isValidDevice, MAX_FAVORITES, newDevices, normalizeName, noticeFor, rememberDevice, sortApps, toggleFavorite, transportMode, typeLabel } from '../public/logic.js';
import { isPrivateIPv4 as serverIsPrivate } from '../lib/validate.mjs';

test('klient og bro er enige om hva som er en lokal IP', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.32.0.1', '192.168.1.1', '192.169.1.1', '127.0.0.1', '8.8.8.8', '300.1.1.1', 'x']) {
    assert.equal(isPrivateIPv4(ip), serverIsPrivate(ip), ip);
  }
});

test('isValidDevice krever kjent type og lokal IP', () => {
  assert.equal(isValidDevice({ type: 'lg', host: '192.168.1.2' }), true);
  assert.equal(isValidDevice({ type: 'lg', host: '8.8.8.8' }), false);
  assert.equal(isValidDevice({ type: 'sony', host: '192.168.1.2' }), false);
  assert.equal(isValidDevice(null), false);
});

test('statuslinjen: tekst, tone og handling', () => {
  const tv = { type: 'lg', host: '192.168.1.2', name: 'Stue' };
  assert.deepEqual(noticeFor({ bridge: false }), { text: BRIDGE_DOWN, tone: 'err', action: null });
  assert.equal(noticeFor({ bridge: true, device: tv, ready: true }).text, '');
  assert.equal(noticeFor({ bridge: true, device: null }).text, '');
  assert.equal(noticeFor({ bridge: true, device: tv, ready: false, message: 'Godkjenn paringen på TV-skjermen.' }).tone, 'busy');
  assert.deepEqual(noticeFor({ bridge: true, device: tv, ready: false, message: 'Fikk ikke kontakt med LG TV.' }), { text: 'Fikk ikke kontakt med LG TV.', tone: 'err', action: { id: 'retry', label: 'Prøv igjen' } });
  assert.equal(noticeFor({ bridge: true, device: tv, ready: false, message: 'Forbindelsen falt ut. Kobler til igjen …' }).tone, 'busy');
  assert.equal(noticeFor({ bridge: true, device: tv, ready: false, message: 'Slår på TV-en …' }).action, null);
  assert.equal(noticeFor({ bridge: true, device: tv, ready: false, message: 'x', code: 'cert-changed' }).action.id, 'repair');
  assert.equal(noticeFor({ bridge: true, device: tv, ready: false, message: 'x', code: 'needs-repair' }).action.id, 'repair');
  assert.equal(noticeFor({ bridge: true, device: tv, ready: false, message: 'x', code: 'unreachable' }).action.id, 'retry');
});

test('avspillingsknapper følger TV-ens capabilities', () => {
  assert.equal(transportMode({ playPause: 'toggle' }), 'toggle');
  assert.equal(transportMode({ playPause: 'separate' }), 'separate');
  assert.equal(transportMode(null), 'separate');
});

test('lister: nye enheter og huske sist brukte først', () => {
  const a = { type: 'roku', host: '192.168.1.2', name: 'A' };
  const b = { type: 'lg', host: '192.168.1.3', name: 'B' };
  assert.deepEqual(newDevices([a, b], [a]), [b]);
  assert.deepEqual(rememberDevice([a, b], { ...b, isTv: true }), [b, a], 'lagrer bare type, host og navn');
  const renamed = [{ ...a, customName: 'Stue' }];
  assert.deepEqual(rememberDevice(renamed, { ...a, name: 'Roku Ultra' }), [{ ...a, name: 'Roku Ultra', customName: 'Stue' }], 'brukerens navn beholdes');
});

test('service worker-cachen følger versjonen i package.json', () => {
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const sw = fs.readFileSync('public/sw.js', 'utf8');
  assert.match(sw, new RegExp(`const CACHE = 'fjern-${version.replace(/\./g, '\\.')}';`));
  for (const file of ['app.js', 'logic.js', 'style.css']) assert.ok(sw.includes(`'/${file}'`), `${file} er forhåndslagret`);
});

// Applisten fra brukerens LG-TV (runde 3).
const TV_APPS = ['Apps', 'YouTube', 'LG Channels', 'Netflix', 'NRK TV', 'Telia Play', 'Hjemmehubb', 'Nettleser', 'Mediespiller',
  'Amazon Alexa', 'Sport', 'Developer Mode', 'Kamera', 'LG Gallery+', 'Live TV'].map((name, i) => ({ id: `a${i}`, name, system: false }));

test('favoritter: kjente strømmeapper velges som standard', () => {
  assert.deepEqual(favoriteApps(TV_APPS, undefined).map((a) => a.name), ['YouTube', 'Netflix', 'NRK TV', 'Telia Play']);
  assert.deepEqual(defaultFavorites([{ id: 'x', name: 'Ukjent app' }]), ['x'], 'ingen kjente apper: de første vanlige');
});

test('favoritter: brukerens valg, rekkefølge og tak', () => {
  let stored = toggleFavorite(TV_APPS, undefined, 'a1');
  assert.deepEqual(stored, ['a3', 'a4', 'a5'], 'YouTube fjernet');
  stored = toggleFavorite(TV_APPS, stored, 'a14');
  assert.deepEqual(favoriteApps(TV_APPS, stored).map((a) => a.name), ['Netflix', 'NRK TV', 'Telia Play', 'Live TV']);
  assert.deepEqual(favoriteApps(TV_APPS, ['finnes-ikke', 'a3']).map((a) => a.id), ['a3'], 'apper som er borte hoppes over');
  let many = [];
  for (const app of TV_APPS) many = toggleFavorite(TV_APPS, many, app.id);
  assert.equal(many.length, MAX_FAVORITES);
});

test('systemapper sorteres nederst', () => {
  const { regular, system } = sortApps(TV_APPS);
  assert.deepEqual(regular.map((a) => a.name), ['YouTube', 'Netflix', 'NRK TV', 'Telia Play']);
  assert.ok(system.some((a) => a.name === 'Developer Mode'));
  assert.equal(isSystemApp({ name: 'Hva som helst', system: true }), true);
});

test('bokstavikon og navn', () => {
  assert.equal(initials('NRK TV'), 'NRK');
  assert.equal(initials('Netflix'), 'N');
  assert.equal(initials('telia play'), 'T');
  assert.equal(normalizeName({ type: 'lg', name: 'LG webOS · 192.168.0.3' }), 'LG-TV');
  assert.equal(normalizeName({ type: 'roku', name: 'Roku · 192.168.0.9' }), 'Roku');
  assert.equal(normalizeName({ type: 'lg', name: 'LG OLED55C1' }), 'LG OLED55C1');
  const tv = { type: 'lg', host: '192.168.0.3', name: 'LG OLED55C1' };
  assert.equal(displayName(tv, [{ ...tv, customName: 'Stue' }]), 'Stue');
  assert.equal(displayName(tv, []), 'LG OLED55C1');
});

test('Android TV: gyldig type, og kode på skjermen gir handlingen «Skriv inn kode»', () => {
  assert.equal(isValidDevice({ type: 'androidtv', host: '192.168.1.60' }), true);
  assert.equal(typeLabel('androidtv'), 'Android TV');
  assert.equal(DEFAULT_NAMES.androidtv, 'Android TV');
  const notice = noticeFor({ bridge: true, device: {}, ready: false, message: 'Skriv inn koden som vises på TV-en.', code: 'needs-code' });
  assert.deepEqual([notice.tone, notice.action.id], ['busy', 'pair']);
});

test('Samsung er en gyldig TV-type med eget navn og etikett', () => {
  assert.equal(isValidDevice({ type: 'samsung', host: '192.168.1.50' }), true);
  assert.equal(isValidDevice({ type: 'sony', host: '192.168.1.50' }), false);
  assert.equal(typeLabel('samsung'), 'Samsung');
  assert.equal(normalizeName({ type: 'samsung', host: '192.168.1.50' }), DEFAULT_NAMES.samsung);
  assert.equal(noticeFor({ bridge: true, device: {}, ready: false, message: 'Trykk «Tillat» på TV-skjermen.' }).tone, 'busy', 'venting på «Tillat» er ikke en feil');
  assert.equal(noticeFor({ bridge: true, device: {}, ready: false, message: 'x', code: 'cert-changed' }).action.id, 'repair');
});

test('reserveikoner for kjente apper har merkefarge, kortnavn og lesbar hvit tekst', () => {
  assert.equal(initials('YouTube'), 'YT');
  assert.equal(initials('TV 2 Play'), 'TV2');
  assert.equal(initials('HBO Max'), 'max');
  assert.equal(brandFor('Telia Play'), null);
  assert.equal(fallbackColor({ id: 'x', name: 'Netflix' }), brandFor('Netflix').color);
  assert.equal(fallbackColor({ id: 'x', name: 'Netflix', color: '#123456' }), '#123456', 'TV-ens egen farge vinner');
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const names = ['Netflix', 'YouTube', 'NRK TV', 'TV 2 Play', 'Disney+', 'HBO Max', 'Prime Video', 'Spotify', 'Viaplay', 'Apple TV', 'Twitch', 'Plex'];
  for (const name of names) {
    const { color } = brandFor(name);
    const contrast = 1.05 / (luminance(color) + 0.05);
    assert.ok(contrast >= 4.5, `${name}: kontrast ${contrast.toFixed(2)} mot hvit`);
  }
});

test('siste YouTube-søk: nyeste først, uten duplikater, med tak', () => {
  assert.deepEqual(addRecent(['lofi', 'nrk'], 'NRK'), ['NRK', 'lofi']);
  assert.deepEqual(addRecent([], '  katter  '), ['katter']);
  assert.deepEqual(addRecent(['a'], '   '), ['a'], 'tomt søk lagres ikke');
  assert.deepEqual(addRecent('ødelagt', 'x'), ['x'], 'ødelagt lagring tåles');
  let list = [];
  for (let i = 0; i < 20; i++) list = addRecent(list, `søk ${i}`);
  assert.equal(list.length, MAX_RECENT);
  assert.equal(list[0], 'søk 19');
});

