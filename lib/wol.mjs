// Wake-on-LAN: «magisk pakke» som vekker en TV med «Slå på via Wi‑Fi/LAN» aktivert.
import dgram from 'node:dgram';
import { UserError } from './errors.mjs';

export function normalizeMac(mac) {
  const hex = String(mac ?? '').replace(/[:-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g).join(':') : null;
}

export function magicPacket(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) throw new UserError('Ugyldig MAC-adresse.');
  const address = Buffer.from(normalized.replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)]);
}

// Sendes både til global kringkasting og til /24-nettet TV-en står på.
export async function sendWakeOnLan(mac, host, { log } = {}) {
  const packet = magicPacket(mac);
  const targets = ['255.255.255.255'];
  if (host) targets.push(`${host.split('.').slice(0, 3).join('.')}.255`);
  const socket = dgram.createSocket('udp4');
  socket.on('error', (error) => log?.(`WOL-feil: ${error.code || error.message}`));
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => { socket.off('error', reject); resolve(); });
    });
    socket.setBroadcast(true);
    await Promise.all(targets.flatMap((target) => [9, 7].map((port) => new Promise((resolve) => {
      socket.send(packet, port, target, (error) => {
        if (error) log?.(`WOL til ${target}:${port} feilet: ${error.code || error.message}`);
        resolve();
      });
    }))));
  } finally {
    try { socket.close(); } catch { /* allerede lukket */ }
  }
}
