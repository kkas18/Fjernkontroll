// Appikoner hentes fra TV-en og leveres fra broens egen opprinnelse, slik at CSP-en
// (img-src 'self') kan beholdes. Bare ekte bildefiler med tak på størrelse slippes gjennom.
import http from 'node:http';
import https from 'node:https';
import { UserError } from './errors.mjs';

export const MAX_ICON_BYTES = 256 * 1024;

// Innholdet avgjør typen, ikke TV-ens Content-Type: aldri SVG eller HTML fra lokalnettet.
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Henter bytes med tak og tidsavbrudd. `insecureTls` brukes bare mot TV-ens egen adresse
// (LG serverer ikoner over https med selvsignert sertifikat på nyere modeller).
export function fetchBytes(url, { insecureTls = false, max = MAX_ICON_BYTES, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, { timeout, rejectUnauthorized: !insecureTls }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new UserError('TV-en ga ikke ut ikonet.', 502));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) {
          req.destroy();
          reject(new UserError('Ikonet er for stort.', 502));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Tidsavbrudd'), { name: 'TimeoutError' })));
    req.on('error', reject);
  });
}

export function createIconCache(max = 96) {
  const cache = new Map();
  return {
    get: (key) => cache.get(key),
    set(key, value) {
      cache.delete(key);
      cache.set(key, value);
      if (cache.size > max) cache.delete(cache.keys().next().value);
    },
  };
}
