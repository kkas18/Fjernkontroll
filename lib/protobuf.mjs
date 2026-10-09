// Minimal protobuf-koding (proto2/proto3 wire format) for Android TV-protokollen, uten npm-avhengigheter.
// Bare det som trengs: varint (heltall, bool, enum) og lengdeprefikserte felt (strenger, bytes, meldinger).

export function encodeVarint(value) {
  let n = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0n);
  return Buffer.from(bytes);
}

// Leser en varint fra buffer[offset]. Gir { value, length }, eller null hvis bufferen ikke er komplett.
export function decodeVarint(buffer, offset = 0) {
  let result = 0n;
  let shift = 0n;
  for (let i = offset; i < buffer.length && i < offset + 10; i += 1) {
    const byte = buffer[i];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: Number(BigInt.asIntN(64, result)), length: i - offset + 1 };
    shift += 7n;
  }
  if (buffer.length - offset >= 10) throw new Error('Ugyldig varint');
  return null;
}

// Bygger en melding av felt: [nummer, verdi]. Tall/bool blir varint, Buffer/streng/melding blir lengdeprefiksert.
// Udefinerte verdier hoppes over; lister gir gjentatte felt.
export function encode(fields) {
  const parts = [];
  for (const [number, value] of fields) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'bigint') {
        parts.push(encodeVarint(number << 3), encodeVarint(typeof item === 'boolean' ? Number(item) : item));
      } else {
        const bytes = Buffer.isBuffer(item) ? item : Buffer.from(String(item), 'utf8');
        parts.push(encodeVarint((number << 3) | 2), encodeVarint(bytes.length), bytes);
      }
    }
  }
  return Buffer.concat(parts);
}

// Dekoder en melding til et Map: feltnummer → liste av verdier (tall for varint, Buffer for lengdeprefiksert).
export function decode(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    if (!key) throw new Error('Avkuttet protobuf-melding');
    offset += key.length;
    const number = key.value >>> 3;
    const wire = key.value & 7;
    let value;
    if (wire === 0) {
      const varint = decodeVarint(buffer, offset);
      if (!varint) throw new Error('Avkuttet protobuf-melding');
      value = varint.value;
      offset += varint.length;
    } else if (wire === 2) {
      const length = decodeVarint(buffer, offset);
      if (!length || offset + length.length + length.value > buffer.length) throw new Error('Avkuttet protobuf-melding');
      offset += length.length;
      value = buffer.subarray(offset, offset + length.value);
      offset += length.value;
    } else if (wire === 5) {
      value = buffer.readUInt32LE(offset);
      offset += 4;
    } else if (wire === 1) {
      value = buffer.readBigUInt64LE(offset);
      offset += 8;
    } else {
      throw new Error(`Ukjent protobuf-type ${wire}`);
    }
    if (!fields.has(number)) fields.set(number, []);
    fields.get(number).push(value);
  }
  return fields;
}

// Hjelpere for dekodede felt.
export const first = (fields, number) => fields?.get(number)?.[0];
export const message = (fields, number) => {
  const value = first(fields, number);
  return Buffer.isBuffer(value) ? decode(value) : null;
};
export const text = (fields, number) => {
  const value = first(fields, number);
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
};

// Strømmen er en rekke meldinger, hver med varint-lengde foran.
export const frame = (payload) => Buffer.concat([encodeVarint(payload.length), payload]);

export function createFrameReader(onMessage, { max = 64 * 1024 } = {}) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const length = decodeVarint(buffer, 0);
      if (!length) return;
      if (length.value < 0 || length.value > max) throw new Error('For stor melding fra TV-en');
      if (buffer.length < length.length + length.value) return;
      const payload = buffer.subarray(length.length, length.length + length.value);
      buffer = buffer.subarray(length.length + length.value);
      onMessage(payload);
    }
  };
}
