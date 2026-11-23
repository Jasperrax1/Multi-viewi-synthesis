import http from 'node:http';
import { readFile } from 'node:fs/promises';

const MAX_BODY_BYTES = 32 * 1024;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
]);

class EditorError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req, fields = ['prompt', 'revision']) {
  if (String(req.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new EditorError(415, '请使用 JSON 格式保存提示词。');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new EditorError(413, '提示词内容过大。');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new EditorError(413, '提示词内容过大。');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new EditorError(400, '无法读取保存内容，请刷新后重试。'); }
  if (!value || Array.isArray(value) || fields.some(field => typeof value[field] !== 'string') ||
      Object.keys(value).length !== fields.length) {
    throw new EditorError(400, '请求内容或当前版本不完整。');
  }
  return value;
}

/** The editor stays available on this Mac while the phone-facing service changes networks. */
export async function startPromptEditor({ port = 8790, store,
  status = () => ({ origin: null, message: '等待成片服务连接' }) }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('提示词工具端口无效。');
  if (typeof store?.read !== 'function' || typeof store?.save !== 'function') throw new Error('提示词存储不可用。');
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host ||
          (req.headers.origin !== undefined && req.headers.origin !== origin)) {
        throw new EditorError(403, '请从本机提示词工具打开此页面。');
      }
      if (req.method === 'GET' && req.url === '/api/presets') {
        return json(res, 200, { ...await store.read(), status: status() });
      }
      const match = /^\/api\/presets\/([a-z0-9-]+)$/.exec(req.url);
      if (match && req.method === 'PUT') {
        if (req.headers.origin !== origin) throw new EditorError(403, '保存请求需要来自本机提示词页面。');
        const value = await body(req);
        return json(res, 200, { ...await store.save(match[1], value.prompt, value.revision), status: status() });
      }
      const versionMatch = /^\/api\/presets\/([a-z0-9-]+)\/versions\/([a-z0-9-]+)$/.exec(req.url);
      const activeMatch = /^\/api\/presets\/([a-z0-9-]+)\/active-version$/.exec(req.url);
      if ((versionMatch || activeMatch) && req.method === 'PUT') {
        if (req.headers.origin !== origin) throw new EditorError(403, '保存请求需要来自本机提示词页面。');
        const value = await body(req, activeMatch ? ['versionId', 'revision'] : ['prompt', 'revision']);
        const saved = activeMatch ? await store.activateVersion(activeMatch[1], value.versionId, value.revision)
          : await store.saveVersion(versionMatch[1], versionMatch[2], value.prompt, value.revision);
        return json(res, 200, { ...saved, status: status() });
      }
      const asset = assets.get(req.url);
      if (asset && req.method === 'GET') {
        const bytes = await readFile(new URL(`../web/montage-prompts/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': bytes.length });
        return res.end(bytes);
      }
      if (match || versionMatch || activeMatch || req.url === '/api/presets' || asset) throw new EditorError(405, '此操作不受支持。');
      throw new EditorError(404, '页面不存在。');
    } catch (error) {
      req.resume();
      if (res.destroyed) return;
      const expected = [400, 403, 404, 405, 409, 413, 415, 422].includes(error.status);
      json(res, expected ? error.status : 500, { error: expected ? error.message : '提示词工具暂时不可用，请稍后重试。' });
    }
  });
  server.maxConnections = 12;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  let closing;
  return {
    origin,
    close() {
      return closing ??= new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
