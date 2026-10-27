// Online PvP room server. Zero dependencies (Node >= 20).
//
//   * Serves the built game (dist/) over HTTP, AND
//   * runs a tiny WebSocket relay at /ws that pairs two players by a 4-letter room code.
//
// The server never simulates the fight. Both browsers run the same deterministic simulation and only exchange
// inputs, so the server just forwards small messages between the two players in a room.
//
//   node server/server.mjs [dir] [port]       dir is relative to the current folder; PORT env var also works (Render, Fly, Railway set it)
//   ALLOWED_ORIGINS=https://my.site,https://other.site   optional: restrict which web pages may connect
import { createServer } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, normalize, resolve } from 'node:path';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const MAX_PAYLOAD = 4096; // bytes per message; inputs are tiny
const MAX_ROOMS = 1000;
const ROOM_IDLE_MS = 10 * 60 * 1000; // an unjoined room is dropped after 10 minutes
const HEARTBEAT_MS = 15000;
const MAX_MSGS_PER_SEC = 1500; // a match sends ~60/s per player (a post-stall catch-up burst can reach ~300/s)

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
};

/** Create the server. Returns { server, rooms, close } so tests can run it on any port. */
export function createGameServer({ dir, allowedOrigins = [] } = {}) {
  /** @type {Map<string, {host: Peer, guest: Peer|null, created: number}>} */
  const rooms = new Map();

  const http = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    if (!dir) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      let file = normalize(join(dir, urlPath));
      if (!file.startsWith(dir)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });

  http.on('upgrade', (req, socket) => {
    const url = (req.url ?? '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    const originOk = allowedOrigins.length === 0 || (origin && allowedOrigins.includes(origin));
    if (url !== '/ws' || typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !originOk) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    new Peer(socket);
  });

  class Peer {
    constructor(socket) {
      this.socket = socket;
      this.buf = Buffer.alloc(0);
      this.fragments = [];
      this.room = null;
      this.role = null;
      this.alive = true;
      this.closed = false;
      this.windowStart = Date.now();
      this.windowCount = 0;
      socket.on('data', (d) => this.onData(d));
      socket.on('close', () => this.onClose());
      socket.on('error', () => this.onClose());
    }

    onData(chunk) {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      for (;;) {
        const f = parseFrame(this.buf);
        if (f === 'bad') return this.close(1002);
        if (!f) return;
        this.buf = this.buf.subarray(f.size);
        if (!this.onFrame(f)) return;
      }
    }

    onFrame(f) {
      if (f.opcode === 0x8) { this.close(1000); return false; }
      if (f.opcode === 0x9) { this.sendRaw(0xa, f.payload); return true; }
      if (f.opcode === 0xa) { this.alive = true; return true; }
      if (f.opcode === 0x1 || f.opcode === 0x0) {
        if (f.opcode === 0x1) this.fragments = [];
        this.fragments.push(f.payload);
        if (this.fragments.reduce((n, p) => n + p.length, 0) > MAX_PAYLOAD) { this.close(1009); return false; }
        if (f.fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onMessage(text);
        }
        return !this.closed;
      }
      this.close(1003); // binary and anything else is not used
      return false;
    }

    onMessage(text) {
      const now = Date.now();
      if (now - this.windowStart > 1000) { this.windowStart = now; this.windowCount = 0; }
      if (++this.windowCount > MAX_MSGS_PER_SEC) { this.close(1008); return; }
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (!m || typeof m !== 'object') return;
      this.alive = true;
      if (m.t === 'create') return this.create();
      if (m.t === 'join') return this.join(String(m.code ?? '').toUpperCase().trim());
      if (m.t === 'msg' && this.room?.guest) {
        // Opaque relay to the other player. Only players in the same room can ever reach each other.
        const other = this.role === 'host' ? this.room.guest : this.room.host;
        other?.send({ t: 'msg', d: m.d });
      }
    }

    create() {
      if (this.room) return;
      if (rooms.size >= MAX_ROOMS) return this.send({ t: 'error', reason: 'busy' });
      let code = '';
      for (let tries = 0; tries < 50; tries++) {
        const c = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
        if (!rooms.has(c)) { code = c; break; }
      }
      if (!code) return this.send({ t: 'error', reason: 'busy' });
      this.room = { code, host: this, guest: null, created: Date.now() };
      this.role = 'host';
      rooms.set(code, this.room);
      this.send({ t: 'created', code });
    }

    join(code) {
      if (this.room) return;
      const room = rooms.get(code);
      if (!room) return this.send({ t: 'error', reason: 'no-room' });
      if (room.guest) return this.send({ t: 'error', reason: 'full' });
      room.guest = this;
      this.room = room;
      this.role = 'guest';
      room.host.send({ t: 'peer' });
      this.send({ t: 'joined' });
    }

    send(obj) {
      this.sendRaw(0x1, Buffer.from(JSON.stringify(obj)));
    }

    sendRaw(opcode, payload) {
      if (this.closed || this.socket.destroyed) return;
      const n = payload.length;
      const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
      this.socket.write(Buffer.concat([head, payload]));
    }

    close(code = 1000) {
      if (this.closed) return;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      this.sendRaw(0x8, p);
      this.socket.end();
      this.onClose();
    }

    onClose() {
      if (this.closed) return;
      this.closed = true;
      const room = this.room;
      if (!room) return;
      const other = this.role === 'host' ? room.guest : room.host;
      other?.send({ t: 'left' });
      other?.close(1000);
      rooms.delete(room.code);
    }
  }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (!room.guest && now - room.created > ROOM_IDLE_MS) room.host.close(1000);
      for (const p of [room.host, room.guest]) {
        if (!p) continue;
        if (!p.alive) { p.close(1001); continue; }
        p.alive = false;
        p.sendRaw(0x9, Buffer.alloc(0));
      }
    }
  }, HEARTBEAT_MS);
  timer.unref();

  return {
    server: http,
    rooms,
    close: () => new Promise((r) => { clearInterval(timer); for (const room of [...rooms.values()]) { room.host.close(1001); room.guest?.close(1001); } http.close(() => r()); http.closeAllConnections?.(); }),
  };
}

/** Parse one WebSocket frame from the start of `buf` (client frames must be masked). */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (!masked) return 'bad';
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    return 'bad'; // 64-bit lengths are far beyond anything this protocol needs
  }
  if (len > MAX_PAYLOAD) return 'bad';
  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, size: off + 4 + len };
}

// ---- run as a program
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.cwd(), process.argv[2] ?? 'dist'); // relative to where you run it
  const port = Number(process.argv[3] ?? process.env.PORT ?? 8080);
  const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const { server } = createGameServer({ dir, allowedOrigins: allowed });
  server.listen(port, () => {
    console.log(`Game + online server: http://localhost:${port}   (WebSocket at /ws, health at /healthz)`);
    if (allowed.length) console.log(`Only these origins may connect: ${allowed.join(', ')}`);
  });
}
