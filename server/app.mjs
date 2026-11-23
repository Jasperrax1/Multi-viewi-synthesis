import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_JPEG = 20 * 1024 * 1024;
const MAX_SIGNAL = 128 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, oversized = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) { oversized = true; chunks.length = 0; }
      if (!oversized) chunks.push(chunk);
    });
    req.once('end', () => oversized ? reject(new HttpError(413, 'Body too large')) : resolve(Buffer.concat(chunks)));
    req.once('error', reject);
    req.once('aborted', () => reject(new HttpError(400, 'Body aborted')));
  });
}
async function objectBody(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  try { const value = JSON.parse((await body(req, 4096)).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON object'); }
}
// Parse SOF dimensions without decoding or re-encoding the uploaded JPEG.
export function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new HttpError(400, 'Invalid JPEG boundaries');
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos++] !== 0xff) throw new HttpError(400, 'Invalid JPEG marker');
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) throw new HttpError(400, 'Truncated JPEG segment');
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8) throw new HttpError(400, 'Invalid JPEG frame');
      const height = bytes.readUInt16BE(pos + 3), width = bytes.readUInt16BE(pos + 5);
      if (!width || !height || width > 16384 || height > 16384) throw new HttpError(400, 'Invalid JPEG dimensions');
      return { width, height };
    }
    pos += length;
  }
  throw new HttpError(400, 'Missing JPEG frame dimensions');
}
function validSignal(m, role) {
  if (!m || m.v !== 1 || typeof m.sessionId !== 'string') return false;
  if (m.type === 'offer' || m.type === 'answer') return m.type === (role === 'sender' ? 'offer' : 'answer') && m.payload?.type === m.type && typeof m.payload.sdp === 'string' && m.payload.sdp.length > 0 && m.payload.sdp.length <= 100000;
  if (m.type !== 'ice') return false;
  const p = m.payload;
  return p === null || (p && typeof p === 'object' && typeof p.candidate === 'string' && p.candidate.length <= 16384 && (p.sdpMid === null || p.sdpMid === undefined || typeof p.sdpMid === 'string') && (p.sdpMLineIndex === undefined || p.sdpMLineIndex === null || (Number.isInteger(p.sdpMLineIndex) && p.sdpMLineIndex >= 0 && p.sdpMLineIndex <= 65535)));
}
export async function createCameraServer(options = {}) {
  const senderToken = options.senderToken ?? randomBytes(32).toString('hex');
  const receiverToken = randomBytes(32).toString('hex');
  const pairingCode = options.pairingCode ?? String(randomInt(100000, 1000000));
  const photoDir = options.photoDir ?? path.join(ROOT, '.runtime', randomUUID());
  const jobTimeoutMs = options.jobTimeoutMs ?? 30000;
  await mkdir(photoDir, { recursive: true, mode: 0o700 });
  const peers = { sender: null, receiver: null }, jobs = new Map();
  let paired = false, sessionId = null, pending = null, downloadBusy = false, pairAttempts = 0, pairWindow = Date.now(), closed = false;
  const roleFor = token => same(token, senderToken) ? 'sender' : paired && same(token, receiverToken) ? 'receiver' : null;
  const send = (ws, value) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const publicJob = job => {
    const { timer, file, uploading, ...value } = job; return value;
  };
  const failJob = (job, error) => { if (job?.state !== 'pending') return; clearTimeout(job.timer); job.state = 'failed'; job.error = error; job.uploading = false; if (pending === job.requestId) pending = null; };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { version: 1, source: 'desktop-test' });
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        if (Date.now() - pairWindow > 60000) { pairWindow = Date.now(); pairAttempts = 0; }
        if (++pairAttempts > 10) throw new HttpError(429, 'Pairing rate limit: retry after one minute');
        const data = await objectBody(req);
        if (paired || !same(data.code, pairingCode)) throw new HttpError(403, 'Invalid or already used pairing code');
        paired = true; return json(res, 200, { token: receiverToken });
      }
      if (url.pathname.startsWith('/api/')) {
        const authorization = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
        const role = roleFor(authorization?.[1]);
        if (!role) throw new HttpError(401, 'Bearer token required');
        if (url.pathname === '/api/jobs' && req.method === 'POST') {
          if (role !== 'receiver') throw new HttpError(403, 'Receiver only');
          const { requestId } = await objectBody(req);
          if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new HttpError(400, 'Invalid requestId');
          if (jobs.has(requestId)) return json(res, 202, publicJob(jobs.get(requestId)));
          if (pending) throw new HttpError(409, 'Capture busy');
          if (peers.sender?.readyState !== WebSocket.OPEN) throw new HttpError(503, 'Sender offline');
          if (jobs.size >= 100) throw new HttpError(507, 'P0 session limit reached: restart server (100 jobs maximum)');
          const job = { requestId, state: 'pending', uploading: false };
          jobs.set(requestId, job); pending = requestId;
          job.timer = setTimeout(() => failJob(job, 'Capture timed out'), jobTimeoutMs); job.timer.unref();
          send(peers.sender, { v: 1, type: 'capture', requestId });
          return json(res, 202, publicJob(job));
        }
        const match = /^\/api\/jobs\/([A-Za-z0-9_-]{8,80})(?:\/(photo|fail))?$/.exec(url.pathname);
        if (!match) throw new HttpError(404, 'Unknown API');
        const job = jobs.get(match[1]); if (!job) throw new HttpError(404, 'Unknown task');
        const action = match[2];
        if (!action && req.method === 'GET') return json(res, 200, publicJob(job));
        if (action === 'fail' && req.method === 'POST') {
          if (role !== 'sender') throw new HttpError(403, 'Sender only');
          const data = await objectBody(req); failJob(job, String(data.error ?? 'Capture failed').slice(0, 256)); return json(res, 200, publicJob(job));
        }
        if (action === 'photo' && req.method === 'POST') {
          if (role !== 'sender') throw new HttpError(403, 'Sender only');
          if (job.state !== 'pending' || job.uploading) throw new HttpError(409, 'Task not available for upload');
          if (req.headers['content-type'] !== 'image/jpeg') throw new HttpError(415, 'Expected image/jpeg');
          job.uploading = true;
          try {
            const bytes = await body(req, MAX_JPEG); const dims = jpegDimensions(bytes);
            if (job.state !== 'pending') throw new HttpError(409, 'Task expired during upload');
            const file = path.join(photoDir, `${job.requestId}.jpg`);
            await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
            if (job.state !== 'pending') { await rm(file, { force: true }); throw new HttpError(409, 'Task expired during write'); }
            clearTimeout(job.timer); Object.assign(job, dims, { state: 'ready', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), downloadPath: `/api/jobs/${job.requestId}/photo`, file });
            pending = null; return json(res, 201, publicJob(job));
          } catch (error) { failJob(job, error.message); throw error; } finally { job.uploading = false; }
        }
        if (action === 'photo' && req.method === 'GET') {
          if (role !== 'receiver') throw new HttpError(403, 'Receiver only');
          if (job.state !== 'ready') throw new HttpError(409, 'Photo not ready');
          if (downloadBusy) throw new HttpError(409, 'JPEG download busy');
          downloadBusy = true;
          let released = false; const release = () => { if (!released) { downloadBusy = false; released = true; } };
          res.once('close', release); res.once('finish', release);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': job.byteLength, 'Cache-Control': 'no-store', 'X-Photo-SHA256': job.sha256 });
          const stream = createReadStream(job.file); res.once('close', () => stream.destroy()); stream.once('error', () => { release(); res.destroy(); }); stream.pipe(res); return;
        }
        throw new HttpError(405, 'Method not allowed');
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const routes = { '/': 'web/receiver.html', '/receiver.html': 'web/receiver.html', '/receiver.js': 'web/receiver.js', '/receiver-browser.js': 'web/receiver-browser.js', '/webrtc-core.js': 'web/webrtc-core.js', '/sender.html': 'web/sender.html', '/sender.js': 'web/sender.js' };
      const file = routes[url.pathname]; if (!file) throw new HttpError(404, 'Not found');
      const bytes = await readFile(path.join(ROOT, file));
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'" }); res.end(bytes);
    } catch (error) { if (!res.headersSent && !res.destroyed) json(res, error.status ?? (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : 'Server error' }); else res.destroy(); }
  });
  server.requestTimeout = 35000; server.headersTimeout = 10000; server.maxRequestsPerSocket = 1000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL });
  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    let url; try { url = new URL(req.url, 'http://local'); } catch { return reject('400 Bad Request'); }
    const role = roleFor(url.searchParams.get('token'));
    if (url.pathname !== '/signal' || !role) return reject('401 Unauthorized');
    // Browser callers must come from this server origin; native NetworkKit may omit Origin.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return reject('403 Forbidden');
    if (peers[role]) return reject('409 Conflict');
    wss.handleUpgrade(req, socket, head, ws => {
      peers[role] = ws; ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      ws.on('message', (data, binary) => {
        if (binary) return ws.close(1003, 'JSON text required');
        let m; try { m = JSON.parse(data.toString()); } catch { return ws.close(1007, 'Invalid JSON'); }
        if (!validSignal(m, role)) return send(ws, { v: 1, type: 'error', message: 'Invalid signal schema or role' });
        if (m.sessionId !== sessionId || !sessionId) return;
        send(peers[role === 'sender' ? 'receiver' : 'sender'], { v: 1, type: m.type, sessionId, payload: m.payload });
      });
      ws.on('close', () => {
        if (peers[role] !== ws) return;
        peers[role] = null;
        if (sessionId) { const old = sessionId; sessionId = null; send(peers[role === 'sender' ? 'receiver' : 'sender'], { v: 1, type: 'peer-left', sessionId: old }); }
        if (role === 'sender' && pending) failJob(jobs.get(pending), 'Sender disconnected');
      });
      if (peers.sender && peers.receiver) {
        sessionId = randomUUID(); for (const r of ['sender', 'receiver']) send(peers[r], { v: 1, type: 'ready', sessionId, role: r });
      }
    });
  });
  const heartbeat = setInterval(() => { for (const ws of Object.values(peers)) if (ws) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 15000); heartbeat.unref();
  return {
    server, senderToken, pairingCode,
    async listen(port = 8787, host = '0.0.0.0') { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); }); return server.address(); },
    async close() { if (closed) return; closed = true; clearInterval(heartbeat); for (const job of jobs.values()) clearTimeout(job.timer); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); await rm(photoDir, { recursive: true, force: true }); }
  };
}
