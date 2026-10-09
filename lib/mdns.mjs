// Søk etter Android TV med mDNS (DNS-SD): spør etter tjenesten _androidtvremote2._tcp.local.
// Spørringen sendes fra en vilkårlig port, så enhetene svarer direkte til oss (RFC 6762 §6.7).
import dgram from 'node:dgram';
import { isPrivateIPv4 } from './validate.mjs';

export const SERVICE = '_androidtvremote2._tcp.local';
const MULTICAST = '224.0.0.251';
const PTR = 12;
export const MAX_DEVICES = 32;

function encodeName(name) {
  const parts = name.split('.').map((label) => {
    const bytes = Buffer.from(label, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

export function query(service = SERVICE) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // ett spørsmål
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(PTR, 0);
  tail.writeUInt16BE(0x8001, 2); // IN, med ønske om direkte svar (QU)
  return Buffer.concat([header, encodeName(service), tail]);
}

// Leser et DNS-navn med komprimering. Gir { name, end }, der end er posisjonen etter navnet i meldingen.
export function readName(buffer, offset) {
  const labels = [];
  let position = offset;
  let end = null;
  for (let jumps = 0; jumps < 32; jumps += 1) {
    if (position >= buffer.length) throw new Error('Avkuttet DNS-navn');
    const length = buffer[position];
    if (length === 0) {
      return { name: labels.join('.'), end: end ?? position + 1 };
    }
    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= buffer.length) throw new Error('Avkuttet DNS-peker');
      if (end === null) end = position + 2;
      position = ((length & 0x3f) << 8) | buffer[position + 1];
      continue;
    }
    if (position + 1 + length > buffer.length) throw new Error('Avkuttet DNS-etikett');
    labels.push(buffer.subarray(position + 1, position + 1 + length).toString('utf8'));
    position += 1 + length;
  }
  throw new Error('For mange DNS-pekere');
}

// Finner instansnavnene i et svar (for eksempel «Telia Play-boks» fra «Telia Play-boks._androidtvremote2._tcp.local»).
export function parseResponse(buffer, service = SERVICE) {
  if (buffer.length < 12) return [];
  const questions = buffer.readUInt16BE(4);
  const records = buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < questions; i += 1) offset = readName(buffer, offset).end + 4;
  const names = [];
  const suffix = `.${service}`.toLowerCase();
  for (let i = 0; i < records && offset + 10 <= buffer.length; i += 1) {
    const owner = readName(buffer, offset);
    offset = owner.end;
    if (offset + 10 > buffer.length) break;
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 8);
    const data = offset + 10;
    offset = data + length;
    if (type === PTR && owner.name.toLowerCase() === service.toLowerCase()) {
      const target = readName(buffer, data).name;
      if (target.toLowerCase().endsWith(suffix)) names.push(target.slice(0, -suffix.length).slice(0, 70));
    }
  }
  return names;
}

export async function searchAndroidTv({ waitMs = 3000, log } = {}) {
  const found = new Map();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (error) => log?.(`mDNS-feil: ${error.code || error.message}`));
  socket.on('message', (buffer, remote) => {
    if (!isPrivateIPv4(remote.address)) return;
    let names;
    try { names = parseResponse(buffer); } catch { return; }
    if (!names.length) return;
    if (found.size < MAX_DEVICES || found.has(remote.address)) {
      found.set(remote.address, { type: 'androidtv', host: remote.address, name: names[0] || 'Android TV' });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => { socket.off('error', reject); resolve(); });
    });
    const packet = query();
    // To forsøk, siden UDP kan gå tapt.
    for (const delay of [0, 600]) {
      setTimeout(() => {
        try {
          socket.send(packet, 5353, MULTICAST, (error) => { if (error) log?.(`mDNS-sending feilet: ${error.code || error.message}`); });
        } catch { /* allerede lukket */ }
      }, delay);
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } finally {
    try { socket.close(); } catch { /* allerede lukket */ }
  }
  return [...found.values()];
}
