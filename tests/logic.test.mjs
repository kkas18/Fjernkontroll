import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BRIDGE_DOWN, isPrivateIPv4, isValidDevice, newDevices, noticeFor, rememberDevice, transportMode } from '../public/logic.js';
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
});

test('service worker-cachen følger versjonen i package.json', () => {
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const sw = fs.readFileSync('public/sw.js', 'utf8');
  assert.match(sw, new RegExp(`const CACHE = 'fjern-${version.replace(/\./g, '\\.')}';`));
  for (const file of ['app.js', 'logic.js', 'style.css']) assert.ok(sw.includes(`'/${file}'`), `${file} er forhåndslagret`);
});
