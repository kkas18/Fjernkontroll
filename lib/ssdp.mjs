// TV-søk med SSDP (UDP multicast). Bare ett søk kjører om gangen; samtidige kall deler resultatet.
import dgram from 'node:dgram';
import { isPrivateIPv4 } from './validate.mjs';

const MULTICAST = '239.255.255.250';
const TARGETS = ['roku:ecp', 'urn:lge-com:service:webos-second-screen:1', 'urn:samsung.com:device:RemoteControlReceiver:1', 'ssdp:all'];
// Et søk på lokalnettet skal aldri kunne fylle minnet: maks antall enheter per søk.
export const MAX_DEVICES = 32;

export function classify(message, host) {
  if (!isPrivateIPv4(host)) return null;
  const text = message.toLowerCase();
  if (text.includes('roku')) return { type: 'roku', host, name: 'Roku' };
  if (text.includes('webos') || text.includes('lge-com')) return { type: 'lg', host, name: 'LG-TV' };
  // Bare Samsungs fjernkontrolltjeneste: mobiler, lydplanker og skrivere fra Samsung svarer også på SSDP.
  if (text.includes('urn:samsung.com:device:remotecontrolreceiver')) return { type: 'samsung', host, name: 'Samsung-TV' };
  return null;
}

// Samler svar fra SSDP-søket, med tak på antall enheter.
export function createCollector(max = MAX_DEVICES) {
  const found = new Map();
  return {
    add(message, host) {
      const device = classify(message, host);
      if (!device) return;
      const key = `${device.type}:${device.host}`;
      if (found.size < max || found.has(key)) found.set(key, device);
    },
    devices: () => [...found.values()],
  };
}

async function search({ waitMs, log }) {
  const collector = createCollector();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  // Lytteren må stå hele levetiden: en asynkron sendefeil uten lytter krasjer prosessen.
  socket.on('error', (error) => log?.(`SSDP-feil: ${error.code || error.message}`));
  socket.on('message', (buffer, remote) => {
    collector.add(buffer.toString('utf8'), remote.address);
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
  return collector.devices();
}

// Funne enheter bekreftes og får navnet sitt fra TV-en selv (probe per type); feiler det, beholdes standardnavnet.
export function createDiscovery({ waitMs = 4500, log, probeRoku, probeSamsung } = {}) {
  let running = null;
  const probes = { roku: probeRoku, samsung: probeSamsung };
  return function discover() {
    if (!running) {
      running = search({ waitMs, log })
        .then((devices) => Promise.all(devices.map((d) => (probes[d.type] ? probes[d.type](d.host).catch(() => d) : d))))
        .finally(() => { running = null; });
    }
    return running;
  };
}
