import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startPromptEditor } from '../server/montage-prompt-editor.mjs';
import { createMontagePresetStore, MONTAGE_PRESET_FILE } from '../server/montage-preset-store.mjs';

function request(origin, { path = '/api/presets', method = 'GET', headers = {}, value, raw } = {}) {
  const bytes = raw ?? (value === undefined ? undefined : JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, origin), { method, headers: {
      ...(bytes !== undefined && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }),
      ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)).on('error', reject).on('end', () => resolve({
        status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function fixture(t) {
  let revision = 'first';
  let prompt = '逆时针滚转';
  let saves = 0;
  const read = async () => ({ revision, presets: [{ id: 'minimax-h3-highspeed', label: 'MiniMax H3 Highspeed',
    provider: 'minimax', model: 'MiniMax-H3-Highspeed', resolution: '768P', durationSeconds: 4,
    prompt, maxCharacters: 7000 }] });
  const editor = await startPromptEditor({ port: 0, status: () => ({ origin: null, message: '等待热点' }), store: {
    read,
    async save(id, next, expected) {
      if (id !== 'minimax-h3-highspeed') throw Object.assign(new Error('找不到这个模型。'), { status: 404 });
      if (expected !== revision) throw Object.assign(new Error('提示词已经更新，请先读取最新版本。'), { status: 409 });
      prompt = next;
      revision = 'second';
      saves++;
      return read();
    },
  } });
  t.after(() => editor.close());
  return { ...editor, saves: () => saves };
}

test('local editor reads presets and saves with version conflicts preserved', async t => {
  const editor = await fixture(t);
  const current = await request(editor.origin);
  assert.equal(current.status, 200);
  assert.equal(current.headers['cache-control'], 'no-store');
  assert.equal(current.headers['access-control-allow-origin'], undefined);
  assert.equal(JSON.parse(current.text).status.message, '等待热点');
  assert.match(current.headers['content-security-policy'], /frame-ancestors 'none'/);
  const saved = await request(editor.origin, { path: '/api/presets/minimax-h3-highspeed', method: 'PUT',
    headers: { Origin: editor.origin }, value: { prompt: '向左翻转一周', revision: 'first' } });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.text).presets[0].prompt, '向左翻转一周');
  const conflict = await request(editor.origin, { path: '/api/presets/minimax-h3-highspeed', method: 'PUT',
    headers: { Origin: editor.origin }, value: { prompt: '旧窗口', revision: 'first' } });
  assert.equal(conflict.status, 409);
  assert.match(JSON.parse(conflict.text).error, /已经更新/);
  assert.equal(editor.saves(), 1);
});

test('local editor rejects cross-site, missing-origin and rebinding requests before writes', async t => {
  const editor = await fixture(t);
  for (const headers of [{}, { Origin: 'https://elsewhere.test' },
    { Host: 'evil.test', Origin: editor.origin }, { Origin: 'null' }]) {
    const result = await request(editor.origin, { path: '/api/presets/minimax-h3-highspeed', method: 'PUT',
      headers, value: { prompt: '覆盖', revision: 'first' } });
    assert.equal(result.status, 403);
  }
  assert.equal((await request(editor.origin, { headers: { Host: 'evil.test' } })).status, 403);
  assert.equal((await request(editor.origin, { headers: { Origin: 'https://elsewhere.test' } })).status, 403);
  assert.equal(editor.saves(), 0);
});

test('local editor bounds request bodies and exposes only its fixed pages and API', async t => {
  const editor = await fixture(t);
  const options = { path: '/api/presets/minimax-h3-highspeed', method: 'PUT', headers: { Origin: editor.origin } };
  assert.equal((await request(editor.origin, { ...options, raw: 'x'.repeat(32 * 1024 + 1) })).status, 413);
  assert.equal((await request(editor.origin, { ...options, raw: 'not json' })).status, 400);
  assert.equal((await request(editor.origin, { ...options, value: { prompt: 'x', revision: 'first', apiKey: 'ignored' } })).status, 400);
  assert.equal((await request(editor.origin, { ...options, raw: 'text', headers: { Origin: editor.origin, 'Content-Type': 'text/plain' } })).status, 415);
  for (const path of ['/.env.vidu', '/server/vidu-index.mjs', '/api/presets/../../config/montage-presets.json', '/favicon.ico']) {
    assert.equal((await request(editor.origin, { path })).status, 404);
  }
  assert.equal((await request(editor.origin, { method: 'POST' })).status, 405);
  assert.equal(editor.saves(), 0);
});

test('version HTTP routes keep saves separate from explicit activation and guard revisions', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'montage-version-http-'));
  const file = path.join(directory, 'presets.json');
  await writeFile(file, await readFile(MONTAGE_PRESET_FILE));
  const editor = await startPromptEditor({ port: 0, store: createMontagePresetStore(file) });
  t.after(async () => { await editor.close(); await rm(directory, { recursive: true, force: true }); });
  const id = 'minimax-h3-highspeed';
  const before = JSON.parse((await request(editor.origin)).text);
  const original = before.presets.find(preset => preset.id === id).prompt;
  const savePath = `/api/presets/${id}/versions/cinematic`;
  const activePath = `/api/presets/${id}/active-version`;
  const options = { method: 'PUT', headers: { Origin: editor.origin } };
  const savedResponse = await request(editor.origin, { ...options, path: savePath,
    value: { prompt: 'New branch text', revision: before.revision } });
  assert.equal(savedResponse.status, 200);
  const saved = JSON.parse(savedResponse.text);
  assert.equal(saved.presets.find(preset => preset.id === id).prompt, original);
  const activatedResponse = await request(editor.origin, { ...options, path: activePath,
    value: { versionId: 'cinematic', revision: saved.revision } });
  assert.equal(activatedResponse.status, 200);
  const activated = JSON.parse(activatedResponse.text);
  assert.equal(activated.presets.find(preset => preset.id === id).prompt, 'New branch text');
  assert.equal((await request(editor.origin, { ...options, path: activePath,
    value: { versionId: 'rotation', revision: saved.revision } })).status, 409);
  assert.equal((await request(editor.origin, { method: 'PUT', path: activePath,
    value: { versionId: 'rotation', revision: activated.revision } })).status, 403);
  assert.equal((await request(editor.origin, { ...options, path: activePath,
    value: { versionId: 3, revision: activated.revision } })).status, 400);
  assert.equal((await request(editor.origin, { ...options, path: `/api/presets/${id}/versions/missing`,
    value: { prompt: 'x', revision: activated.revision } })).status, 404);
  assert.equal((await request(editor.origin, { path: activePath })).status, 405);
});
