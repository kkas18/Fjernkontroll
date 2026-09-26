import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { openWebSocket, OPEN, CLOSED } from '../lib/ws-client.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC11B85';

function frame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.from(payload);
  const header = body.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, body.length])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

function readClientFrame(buffer) {
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]));
  return { opcode, masked: (buffer[1] & 0x80) !== 0, payload, size: offset + 4 + length };
}

// En liten testserver som oppfører seg som en WebSocket-server.
function startServer({ accept = true, onFrame } = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const key = /sec-websocket-key:\s*(.+)/i.exec(buffer.subarray(0, end).toString())[1].trim();
        buffer = buffer.subarray(end + 4);
        const digest = accept ? crypto.createHash('sha1').update(key + GUID).digest('base64') : 'feil';
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`);
        upgraded = true;
      }
      while (buffer.length >= 6) {
        const parsed = readClientFrame(buffer);
        if (buffer.length < parsed.size) return;
        buffer = buffer.subarray(parsed.size);
        onFrame?.(socket, parsed);
      }
    });
  });
  // Lukk alle forbindelser også når en test feiler, ellers henger testkjøringen.
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of sockets) socket.destroy();
    return close(callback);
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const waitFor = async (condition, ms = 1000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Tidsavbrudd i test');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('kobler til, sender maskerte rammer og mottar tekst', async () => {
  const frames = [];
  const server = await startServer({
    onFrame(socket, parsed) {
      frames.push(parsed);
      if (parsed.opcode === 1) socket.write(frame(1, `ekko:${parsed.payload}`));
    },
  });
  const client = await openWebSocket(`ws://127.0.0.1:${server.address().port}/`);
  assert.equal(client.readyState, OPEN);
  const reply = new Promise((resolve) => client.once('message', resolve));
  client.send('hei æøå');
  assert.equal(await reply, 'ekko:hei æøå');
  assert.equal(frames[0].masked, true, 'klientrammer må være maskerte');
  client.close();
  assert.equal(client.readyState, CLOSED);
  server.close();
});

test('setter sammen fragmenterte meldinger og svarer på ping', async () => {
  const pongs = [];
  const server = await startServer({
    onFrame(socket, parsed) {
      if (parsed.opcode === 0xa) pongs.push(parsed.payload.toString());
      if (parsed.opcode === 1) {
        socket.write(frame(9, 'p1'));
        socket.write(Buffer.concat([frame(1, 'del1-', { fin: false }), frame(0, 'x'.repeat(200))]));
      }
    },
  });
  const client = await openWebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const message = new Promise((resolve) => client.once('message', resolve));
  client.send('start');
  try {
    assert.equal(await message, `del1-${'x'.repeat(200)}`);
    await waitFor(() => pongs.length > 0);
    assert.deepEqual(pongs, ['p1']);
  } finally {
    client.close();
    server.close();
  }
});

test('avviser feil håndtrykk', async () => {
  const server = await startServer({ accept: false });
  await assert.rejects(openWebSocket(`ws://127.0.0.1:${server.address().port}/`), /avvist/);
  server.close();
});

test('avviser når ingen lytter på porten', async () => {
  const server = await startServer();
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(openWebSocket(`ws://127.0.0.1:${port}/`, { timeout: 1000 }));
});

test('tidsavbrudd når serveren aldri svarer', async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await assert.rejects(openWebSocket(`ws://127.0.0.1:${server.address().port}/`, { timeout: 100 }), (e) => e.name === 'TimeoutError');
  server.close();
});
