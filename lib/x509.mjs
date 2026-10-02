// Selvsignert klientsertifikat (X.509 v3, RSA 2048, SHA-256) uten npm-avhengigheter.
// Android TV kjenner igjen appen på sertifikatet: hver installasjon lager sitt eget nøkkelpar,
// og boksen husker det etter paringen.
import crypto from 'node:crypto';

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let value = n; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...content) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...items) => tlv(0x30, ...items);
const set = (...items) => tlv(0x31, ...items);
const nul = () => Buffer.from([0x05, 0x00]);

function integer(bytes) {
  let value = Buffer.from(bytes);
  while (value.length > 1 && value[0] === 0 && value[1] < 0x80) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const part of rest) {
    const chunk = [];
    let value = part;
    do {
      chunk.unshift(value & 0x7f);
      value = Math.floor(value / 128);
    } while (value > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const utf8 = (value) => tlv(0x0c, Buffer.from(value, 'utf8'));

// UTCTime gjelder til og med 2049; GeneralizedTime etter det (RFC 5280).
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const SHA256_WITH_RSA = sequence(oid('1.2.840.113549.1.1.11'), nul());
const name = (commonName) => sequence(set(sequence(oid('2.5.4.3'), utf8(commonName))));

export function createSelfSignedCertificate({ commonName = 'Fjern', years = 20, now = new Date() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  const tbs = sequence(
    tlv(0xa0, integer([2])), // versjon 3
    integer(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(15)])), // positivt serienummer
    SHA256_WITH_RSA,
    name(commonName),
    sequence(time(notBefore), time(notAfter)),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = sequence(tbs, SHA256_WITH_RSA, tlv(0x03, Buffer.from([0]), signature));
  const base64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// Modulus og eksponent som rå, store-endian byte uten fortegnsbyte (brukes i paringskoden).
export function rsaNumbers(keyLike) {
  const key = keyLike instanceof crypto.KeyObject && keyLike.type === 'public' ? keyLike : crypto.createPublicKey(keyLike);
  const jwk = key.export({ format: 'jwk' });
  return { modulus: Buffer.from(jwk.n, 'base64url'), exponent: Buffer.from(jwk.e, 'base64url') };
}
