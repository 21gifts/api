/**
 * Local Nostr sink for the loan cycle.
 *
 * Accepts EVENT with OK and answers REQ with EOSE. Nothing is stored and
 * nothing is forwarded. The cycle points both relay lists here so a receipt
 * is not sent to a public relay.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

const port = Number(process.env['LOAN_E2E_RELAY_PORT'] ?? '3998');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @param {string} key
 * @returns {string}
 */
function acceptValue(key) {
  return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/**
 * @param {import('node:net').Socket} socket
 * @param {string} text
 */
function sendText(socket, text) {
  const payload = Buffer.from(text);
  /** @type {Buffer} */
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  }
  socket.write(Buffer.concat([header, payload]));
}

/**
 * @param {import('node:net').Socket} socket
 * @param {number} opcode
 * @param {Buffer} payload
 */
function onFrame(socket, opcode, payload) {
  if (opcode === 0x8) {
    socket.end();
    return;
  }
  if (opcode === 0x9) {
    const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
    socket.write(pong);
    return;
  }
  if (opcode !== 0x1) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    return;
  }
  if (parsed[0] === 'EVENT') {
    const event = parsed[1];
    if (typeof event === 'object' && event !== null && typeof event.id === 'string') {
      sendText(socket, JSON.stringify(['OK', event.id, true, '']));
    }
    return;
  }
  if (parsed[0] === 'REQ' && typeof parsed[1] === 'string') {
    sendText(socket, JSON.stringify(['EOSE', parsed[1]]));
  }
}

/**
 * @param {import('node:net').Socket} socket
 * @param {{ buf: Buffer }} state
 */
function takeFrames(socket, state) {
  while (state.buf.length >= 2) {
    const first = state.buf[0] ?? 0;
    const second = state.buf[1] ?? 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (state.buf.length < 4) {
        return;
      }
      length = state.buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      socket.destroy();
      return;
    }
    const maskLen = masked ? 4 : 0;
    if (state.buf.length < offset + maskLen + length) {
      return;
    }
    const raw = Buffer.from(state.buf.subarray(offset + maskLen, offset + maskLen + length));
    if (masked) {
      const mask = state.buf.subarray(offset, offset + 4);
      for (let i = 0; i < raw.length; i += 1) {
        raw[i] = (raw[i] ?? 0) ^ (mask[i & 3] ?? 0);
      }
    }
    state.buf = Buffer.from(state.buf.subarray(offset + maskLen + length));
    onFrame(socket, opcode, raw);
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key === '') {
    socket.destroy();
    return;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptValue(key)}\r\n\r\n`,
  );
  const state = { buf: Buffer.alloc(0) };
  socket.on('data', (chunk) => {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.buf = Buffer.concat([state.buf, piece]);
    takeFrames(socket, state);
  });
});

server.listen(port, '127.0.0.1');
