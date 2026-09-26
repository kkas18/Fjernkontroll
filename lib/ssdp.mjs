// TV-søk med SSDP (UDP multicast). Bare ett søk kjører om gangen; samtidige kall deler resultatet.
import dgram from 'node:dgram';
import { isPrivateIPv4 } from './validate.mjs';

const MULTICAST = '239.255.255.250';
const TARGETS = ['roku:ecp', 'urn:lge-com:service:webos-second-screen:1', 'ssdp:all'];

export function classify(message, host) {
  if (!isPrivateIPv4(host)) return null;
  const text = message.toLowerCase();
  if (text.includes('roku')) return { type: 'roku', host, name: `Roku · ${host}` };
  if (text.includes('webos') || text.includes('lge-com')) return { type: 'lg', host, name: `LG webOS · ${host}` };
  return null;
}

async function search({ waitMs, log }) {
  const found = new Map();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  // Lytteren må stå hele levetiden: en asynkron sendefeil uten lytter krasjer prosessen.
  socket.on('error', (error) => log?.(`SSDP-feil: ${error.code || error.message}`));
  socket.on('message', (buffer, remote) => {
    const device = classify(buffer.toString('utf8'), remote.address);
    if (device) found.set(`${device.type}:${device.host}`, device);
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => { socket.off('error', reject); resolve(); });
    });
    for (const target of TARGETS) {
      const packet = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${MULTICAST}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`);
      socket.send(packet, 1900, MULTICAST, (error) => { if (error) log?.(`SSDP-sending feilet: ${error.code || error.message}`); });
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } finally {
    try { socket.close(); } catch { /* allerede lukket */ }
  }
  return [...found.values()];
}

export function createDiscovery({ waitMs = 4500, log, probeRoku } = {}) {
  let running = null;
  return function discover() {
    if (!running) {
      running = search({ waitMs, log })
        .then((devices) => Promise.all(devices.map((d) => (d.type === 'roku' && probeRoku ? probeRoku(d.host).catch(() => d) : d))))
        .finally(() => { running = null; });
    }
    return running;
  };
}
