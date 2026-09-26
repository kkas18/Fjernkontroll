// Minimal WebSocket-klient (RFC 6455) for ws:// og wss:// uten npm-avhengigheter.
// Nodes innebygde WebSocket kan ikke godta selvsignerte sertifikater, og LG webOS
// bruker nettopp det på port 3001. Klienten støtter tekstmeldinger, ping/pong og close.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC11B85';
const MAX_MESSAGE = 1024 * 1024;

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSED = 3;

export class WsClient extends EventEmitter {
  constructor(url, { timeout = 5000, insecureTls = false } = {}) {
    super();
    const target = new URL(url);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') throw new Error(`Ugyldig WebSocket-adresse: ${url}`);
    this.url = url;
    this.readyState = CONNECTING;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;

    const secure = target.protocol === 'wss:';
    const port = Number(target.port || (secure ? 443 : 80));
    const options = { host: target.hostname, port };
    this.socket = secure
      ? tls.connect({ ...options, rejectUnauthorized: !insecureTls, servername: net.isIP(target.hostname) ? undefined : target.hostname })
      : net.connect(options);
    this.socket.setNoDelay(true);

    this.timer = setTimeout(() => this.fail(Object.assign(new Error('Tidsavbrudd mot WebSocket'), { name: 'TimeoutError' })), timeout);
    this.socket.once(secure ? 'secureConnect' : 'connect', () => this.handshake(target));
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => this.finish());
  }

  handshake(target) {
    this.key = crypto.randomBytes(16).toString('base64');
    const lines = [
      `GET ${target.pathname || '/'}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.key}`,
      'Sec-WebSocket-Version: 13',
      '', '',
    ];
    this.socket.write(lines.join('\r\n'));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.readyState === CONNECTING) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (this.buffer.length > 16_384) this.fail(new Error('For stort WebSocket-svar'));
        return;
      }
      const head = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + 4);
      const expected = crypto.createHash('sha1').update(this.key + GUID).digest('base64');
      const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim();
      if (!/^HTTP\/1\.1 101/.test(head) || accept !== expected) {
        this.fail(new Error('WebSocket-håndtrykk ble avvist'));
        return;
      }
      clearTimeout(this.timer);
      this.readyState = OPEN;
      this.emit('open');
    }
    this.parseFrames();
  }

  parseFrames() {
    while (this.readyState === OPEN && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.fail(new Error('For stor WebSocket-melding'));
        length = Number(big);
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.onFrame(fin, opcode, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.writeFrame(0x8, payload.subarray(0, 2));
      this.socket.end();
      return;
    }
    if (opcode === 0x9) return this.writeFrame(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      return this.fail(new Error(`Ukjent WebSocket-opcode ${opcode}`));
    }
    const size = this.fragments.reduce((sum, part) => sum + part.length, 0);
    if (size > MAX_MESSAGE) return this.fail(new Error('For stor WebSocket-melding'));
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    this.emit('message', this.fragmentOpcode === 0x1 ? message.toString('utf8') : message);
  }

  writeFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.socket.destroyed) return;
    const length = payload.length;
    const header = [0x80 | opcode];
    if (length < 126) header.push(0x80 | length);
    else if (length < 65_536) header.push(0x80 | 126, length >> 8, length & 0xff);
    else throw new Error('For stor WebSocket-melding');
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    this.socket.write(Buffer.concat([Buffer.from(header), mask, body]));
  }

  send(text) {
    if (this.readyState !== OPEN) throw new Error('WebSocket er ikke åpen');
    this.writeFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close() {
    if (this.readyState === OPEN) this.writeFrame(0x8, Buffer.from([0x03, 0xe8]));
    this.socket.end();
    this.socket.destroySoon?.();
    this.finish();
  }

  fail(error) {
    if (this.readyState === CLOSED) return;
    // Et 'error'-event uten lytter ville krasjet hele broen.
    if (this.listenerCount('error') > 0) this.emit('error', error);
    this.socket.destroy();
    this.finish();
  }

  finish() {
    if (this.readyState === CLOSED) return;
    clearTimeout(this.timer);
    this.readyState = CLOSED;
    this.emit('close');
  }
}

// Venter til forbindelsen er åpen, eller avviser med feilen som stoppet den.
export function openWebSocket(url, options) {
  return new Promise((resolve, reject) => {
    const client = new WsClient(url, options);
    const onError = (error) => reject(error);
    client.once('error', onError);
    client.once('open', () => {
      client.off('error', onError);
      resolve(client);
    });
    client.once('close', () => reject(new Error('WebSocket ble lukket før den åpnet')));
  });
}
