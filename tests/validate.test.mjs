import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIPv4, validCommand, validDevice, validText, MAX_TEXT_LENGTH } from '../lib/validate.mjs';
import { UserError, toUserMessage } from '../lib/errors.mjs';

test('isPrivateIPv4 godtar bare RFC 1918-adresser', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.42']) assert.equal(isPrivateIPv4(ip), true, ip);
  for (const ip of ['127.0.0.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.254.1.1', '256.1.1.1', '1.2.3', 'localhost', '', null]) {
    assert.equal(isPrivateIPv4(ip), false, String(ip));
  }
});

test('validDevice normaliserer og avviser ugyldige enheter', () => {
  assert.deepEqual(validDevice({ type: 'lg', host: '192.168.1.2' }), { type: 'lg', host: '192.168.1.2', name: 'LG webOS' });
  assert.equal(validDevice({ type: 'roku', host: '10.0.0.5', name: 'x'.repeat(200) }).name.length, 70);
  assert.deepEqual(validDevice({ type: 'samsung', host: '192.168.1.3' }), { type: 'samsung', host: '192.168.1.3', name: 'Samsung-TV' });
  assert.throws(() => validDevice({ type: 'sony', host: '192.168.1.2' }), UserError);
  assert.throws(() => validDevice({ type: 'roku', host: '8.8.8.8' }), UserError);
  assert.throws(() => validDevice(null), UserError);
});

test('validCommand bruker hviteliste', () => {
  assert.equal(validCommand('VolumeUp'), 'VolumeUp');
  assert.throws(() => validCommand('Lit_a'), UserError);
  assert.throws(() => validCommand(undefined), UserError);
});

test('validText kutter lang tekst og avviser tom tekst', () => {
  assert.equal(validText('a'.repeat(500)).length, MAX_TEXT_LENGTH);
  assert.throws(() => validText('   '), UserError);
});

test('toUserMessage gir norske meldinger og skjuler interne feil', () => {
  assert.deepEqual(toUserMessage(new UserError('Hei', 409)), { status: 409, message: 'Hei', internal: false });
  assert.equal(toUserMessage(Object.assign(new Error('x'), { name: 'TimeoutError' })).status, 504);
  assert.equal(toUserMessage(new SyntaxError('Unexpected token')).message, 'Ugyldig forespørsel.');
  assert.equal(toUserMessage(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })).status, 502);
  const internal = toUserMessage(new Error('secret stack detail'));
  assert.equal(internal.internal, true);
  assert.doesNotMatch(internal.message, /secret/);
});
