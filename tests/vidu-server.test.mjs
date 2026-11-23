import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import presets from '../config/montage-presets.json' with { type: 'json' };
import { createViduServer } from '../server/vidu-app.mjs';
import { watchMontageAddress } from '../scripts/montage-lan.mjs';
import { createMontagePresetStore, MONTAGE_PRESET_FILE } from '../server/montage-preset-store.mjs';

const API_KEY = 'mock-provider-key';
const MINIMAX_KEY = 'mock-minimax-key';
const CLIENT_TOKEN = 'mock-client-token-0123456789';
const RESULT_HOST = 'vidu-result.test';
const MINIMAX_RESULT_HOST = 'cdn.hailuoai.com';
const VIDU_PRESET = 'vidu-q2-pro-fast';
const MINIMAX_PRESET = 'minimax-h3-highspeed';
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=', 'base64');
const DATA_URI = `data:image/jpeg;base64,${JPEG.toString('base64')}`;

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
}
// Bounded structural fixture. Android separately tests decoding a real video.
const MP4 = Buffer.concat([box('ftyp', Buffer.from('isom0000')),
  box('moov', box('trak', box('mdia', box('hdlr', Buffer.from('00000000vide'))))),
  box('mdat', Buffer.from([1, 2, 3, 4]))]);
const MINIMAX_MP4 = Buffer.concat([box('ftyp', Buffer.from('isom0000')),
  box('moov', Buffer.concat(['vide', 'soun'].map(track =>
    box('trak', box('mdia', box('hdlr', Buffer.from(`00000000${track}`))))))),
  box('mdat', Buffer.from([5, 6, 7, 8]))]);

async function fixture(t, { submitStatus = 200, resultHost = RESULT_HOST, durationSeconds, prompt, model, resolution,
  withVidu = true, withMiniMax = false, maxPaidJobs = 1, resolvePreset } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lan-camera-vidu-'));
  const submits = [], queries = [], downloads = [];
  const miniMaxSubmits = [], miniMaxQueries = [], miniMaxDownloads = [];
  const mock = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/ent/v2/start-end2video') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submits.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      res.statusCode = submitStatus;
      return res.end(JSON.stringify(submitStatus === 200 ? { task_id: 'provider-task-1', credits: 14 } : { detail: API_KEY }));
    }
    if (req.url === '/ent/v2/tasks/provider-task-1/creations') {
      queries.push(req.headers.authorization);
      return res.end(JSON.stringify(queries.length === 1 ? { id: 'provider-task-1', state: 'processing' } : {
        id: 'provider-task-1', state: 'success', credits: 12, creations: [{ url: `https://${resultHost}/output.mp4?secret=signed-url` }],
      }));
    }
    if (req.url.startsWith('/output.mp4?')) {
      downloads.push(req.headers.authorization);
      res.setHeader('Content-Type', 'video/mp4');
      return res.end(MP4);
    }
    if (req.url === '/v2/video_generation') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      miniMaxSubmits.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      res.statusCode = submitStatus;
      return res.end(JSON.stringify(submitStatus === 200 ? { task_id: 'minimax-task-1' } : { detail: MINIMAX_KEY }));
    }
    if (req.url === '/v2/query/video_generation/minimax-task-1') {
      miniMaxQueries.push(req.headers.authorization);
      return res.end(JSON.stringify({ task: { id: 'minimax-task-1',
        ...(miniMaxQueries.length === 1 ? { status: 'running' } : {
          status: 'succeeded', content: { url: `https://${MINIMAX_RESULT_HOST}/mini-output.mp4?secret=signed-url` },
        }),
      } }));
    }
    if (req.url.startsWith('/mini-output.mp4?')) {
      miniMaxDownloads.push(req.headers.authorization);
      res.setHeader('Content-Type', 'video/mp4');
      return res.end(MINIMAX_MP4);
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const providerOrigin = `http://127.0.0.1:${mock.address().port}`;
  const fetchImpl = (input, options) => {
    const url = new URL(input);
    assert(['api.vidu.cn', RESULT_HOST, 'api.minimax.cn', MINIMAX_RESULT_HOST].includes(url.hostname));
    return fetch(providerOrigin + url.pathname + url.search, options);
  };
  let service, origin;
  async function start(miniMaxRegion = 'cn') {
    service = await createViduServer({ apiKey: withVidu ? API_KEY : undefined, clientToken: CLIENT_TOKEN, jobDir: dir,
      miniMaxApiKey: withMiniMax ? MINIMAX_KEY : undefined, miniMaxRegion, miniMaxPollMs: 5,
      resultHosts: [RESULT_HOST], fetchImpl, pollMs: 5, durationSeconds, prompt, model, resolution, maxPaidJobs,
      resolvePreset });
    origin = `http://127.0.0.1:${(await service.listen(0)).port}`;
  }
  async function restart(miniMaxRegion) { await service.close(); await start(miniMaxRegion); }
  t.after(async () => {
    await service?.close();
    await new Promise(resolve => mock.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  function request(route, { body, token = CLIENT_TOKEN } = {}) {
    return fetch(origin + route, { method: body ? 'POST' : 'GET', headers: {
      ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }),
    }, body: body ? JSON.stringify(body) : undefined });
  }
  async function wait(id, predicate) {
    for (let attempts = 0; attempts < 200; attempts++) {
      const job = await (await request(`/v1/transitions/${id}`)).json();
      if (predicate(job)) return job;
      await sleep(5);
    }
    assert.fail('Vidu mock job did not reach expected state');
  }
  return { dir, start, restart, submits, queries, downloads, miniMaxSubmits, miniMaxQueries, miniMaxDownloads,
    request, wait };
}

test('health requires the client token and does not create a transition job', async t => {
  const f = await fixture(t);
  await f.start();
  assert.equal((await f.request('/v1/health', { token: 'wrong' })).status, 401);
  assert.equal((await f.request('/v1/health', { token: null })).status, 401);
  const health = await f.request('/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), { service: 'pura-montage', version: 1 });
  assert.deepEqual(await readdir(f.dir), ['.lock']);
  assert.equal(f.submits.length + f.miniMaxSubmits.length, 0);
});

test('zero local job limit accepts new jobs after restart without replaying earlier requests', async t => {
  const f = await fixture(t, { maxPaidJobs: 0 });
  await f.start();
  const images = [DATA_URI, DATA_URI];
  const first = { requestId: randomUUID(), images };
  assert.equal((await f.request('/v1/transitions', { body: first })).status, 202);
  await f.wait(first.requestId, job => job.state === 'READY');
  await f.restart();
  assert.equal((await f.request('/v1/transitions', { body: first })).status, 200);
  const second = { requestId: randomUUID(), images };
  assert.equal((await f.request('/v1/transitions', { body: second })).status, 202);
  await f.wait(second.requestId, job => job.state === 'READY');
  assert.equal(f.submits.length, 2);
});

test('LAN listener releases the old address before rebinding and recovers after DHCP loses an address', async () => {
  const first = '192.168.1.15';
  const second = '10.130.244.167';
  const addresses = [undefined, first, first, undefined, second, second];
  const events = [];
  const controller = new AbortController();
  let active, changedAddressAttempts = 0;
  await watchMontageAddress({
    signal: controller.signal,
    intervalMs: 1,
    readAddress() {
      if (addresses.length === 0) controller.abort();
      const address = addresses.shift();
      if (!address) throw new Error('no address');
      return address;
    },
    onUnavailable: problem => events.push(problem),
    async bind(address) {
      assert.equal(active, undefined);
      if (address === second && ++changedAddressAttempts === 1) {
        throw Object.assign(new Error('address briefly unavailable'), { code: 'EADDRNOTAVAIL' });
      }
      events.push(`bind ${address}`);
      active = address;
      return async () => {
        await sleep(1);
        assert.equal(active, address);
        active = undefined;
        events.push(`close ${address}`);
      };
    },
  });
  assert.deepEqual(events, [
    'no address', `bind ${first}`, 'no address', `close ${first}`,
    '网络地址正在切换，等待成片服务重新绑定。', `bind ${second}`, 'no address', `close ${second}`,
  ]);
});

test('validates ordered images, authenticates, persists one idempotent Vidu result, and downloads exact bytes', async t => {
  const f = await fixture(t);
  await f.start();
  const requestId = randomUUID();
  const images = [DATA_URI, DATA_URI];
  const body = { requestId, images };
  assert.equal((await f.request('/v1/transitions', { body, token: null })).status, 401);
  assert.equal((await f.request('/v1/transitions', { body: { ...body, images: [DATA_URI, 'https://example.test/x.jpg'] } })).status, 400);
  const starts = await Promise.all([f.request('/v1/transitions', { body }), f.request('/v1/transitions', { body })]);
  assert(starts.every(res => res.status === 202 || res.status === 200));
  const ready = await f.wait(requestId, job => job.state === 'READY');
  assert.equal(f.submits.length, 1);
  assert.deepEqual(f.submits[0], { auth: `Token ${API_KEY}`, body: { model: 'viduq2-pro', images,
    prompt: f.submits[0].body.prompt, duration: 1, resolution: '360p', bgm: false, off_peak: false, payload: requestId } });
  assert(f.submits[0].body.prompt.length > 0);
  assert.deepEqual(f.queries, [`Token ${API_KEY}`, `Token ${API_KEY}`]);
  assert.deepEqual(f.downloads, [undefined]);
  assert.equal(ready.sha256, createHash('sha256').update(MP4).digest('hex'));
  assert.equal(ready.byteLength, MP4.length);
  assert.equal((await f.request(ready.downloadPath, { token: 'wrong' })).status, 401);
  const video = await f.request(ready.downloadPath);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('x-video-sha256'), ready.sha256);
  assert.deepEqual(Buffer.from(await video.arrayBuffer()), MP4);
  const persisted = await readFile(path.join(f.dir, `${requestId}.json`), 'utf8');
  assert(!persisted.includes(DATA_URI) && !persisted.includes(API_KEY) && !persisted.includes('signed-url'));

  const changed = Buffer.from(JPEG);
  changed[10] ^= 1;
  assert.equal((await f.request('/v1/transitions', { body: { requestId,
    images: [DATA_URI, `data:image/jpeg;base64,${changed.toString('base64')}`] } })).status, 409);
  assert.equal((await f.request('/v1/transitions', { body: { requestId: randomUUID(), images } })).status, 429);
  await f.restart();
  const repeated = await f.request('/v1/transitions', { body });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), ready);
  assert.equal(f.submits.length, 1);
});

test('an ambiguous paid POST remains unknown across retries and restart', async t => {
  const f = await fixture(t, { submitStatus: 503 });
  await f.start();
  const requestId = randomUUID();
  const body = { requestId, images: [DATA_URI, DATA_URI] };
  assert.equal((await f.request('/v1/transitions', { body })).status, 202);
  const job = await f.wait(requestId, item => item.state === 'SUBMISSION_UNKNOWN');
  assert.deepEqual(job, { requestId, state: 'SUBMISSION_UNKNOWN', error: 'SUBMISSION_UNKNOWN' });
  await f.restart();
  assert.deepEqual(await (await f.request('/v1/transitions', { body })).json(), job);
  assert.equal(f.submits.length, 1);
});

test('uses the exact custom Q2 Pro Fast 720p recipe and records ordered Vidu timings once', async t => {
  const prompt = '输入首帧 → 环绕翻转 → 输入尾帧\n 保留换行。\n';
  const f = await fixture(t, { durationSeconds: 2, prompt, model: 'viduq2-pro-fast', resolution: '720p' });
  await f.start();
  const requestId = randomUUID();
  await f.request('/v1/transitions', { body: { requestId, images: [DATA_URI, DATA_URI] } });
  await f.wait(requestId, item => item.state === 'READY');
  assert.equal(f.submits.length, 1);
  assert.equal(f.submits[0].body.prompt, prompt);
  assert.equal(f.submits[0].body.duration, 2);
  assert.equal(f.submits[0].body.model, 'viduq2-pro-fast');
  assert.equal(f.submits[0].body.resolution, '720p');
  const record = JSON.parse(await readFile(path.join(f.dir, `${requestId}.json`), 'utf8'));
  assert.equal(record.durationSeconds, 2);
  assert.equal(record.model, 'viduq2-pro-fast');
  assert.equal(record.resolution, '720p');
  assert.equal(record.promptSha256, createHash('sha256').update(prompt).digest('hex'));
  assert.equal(record.prompt, undefined);
  assert.equal(record.providerCredits, 12);
  const stamps = [record.createdAt, record.providerSubmitStartedAt, record.providerAcceptedAt,
    record.providerSuccessObservedAt, record.resultDownloadedAt, record.readyAt];
  assert(stamps.every((stamp, index) => Number.isSafeInteger(stamp) && (!index || stamp >= stamps[index - 1])));
});

test('a process restart never replays an in-flight paid submission', async t => {
  const f = await fixture(t);
  const requestId = randomUUID();
  await writeFile(path.join(f.dir, `${requestId}.json`), JSON.stringify({ requestId, state: 'SUBMITTING',
    createdAt: Date.now(), digest: '0'.repeat(64) }));
  await f.start();
  const job = await f.wait(requestId, item => item.state === 'SUBMISSION_UNKNOWN');
  assert.equal(job.error, 'SUBMISSION_UNKNOWN');
  assert.equal(f.submits.length, 0);
});

test('a persisted provider task resumes polling and prevents a second worker', async t => {
  const f = await fixture(t);
  const requestId = randomUUID();
  await writeFile(path.join(f.dir, `${requestId}.json`), JSON.stringify({ requestId, state: 'PROCESSING',
    providerTaskId: 'provider-task-1', createdAt: Date.now(), digest: '0'.repeat(64) }));
  await f.start();
  await assert.rejects(createViduServer({ apiKey: API_KEY, clientToken: CLIENT_TOKEN, jobDir: f.dir }), /locked/);
  await f.wait(requestId, job => job.state === 'READY');
  assert.equal(f.submits.length, 0);
  assert.equal(f.queries.length, 2);
});

test('result URLs outside the allowlist stay pending without downloading or exposing the URL', async t => {
  const f = await fixture(t, { resultHost: 'blocked.test' });
  await f.start();
  const requestId = randomUUID();
  await f.request('/v1/transitions', { body: { requestId, images: [DATA_URI, DATA_URI] } });
  const job = await f.wait(requestId, item => item.error === 'RESULT_HOST_NOT_ALLOWED');
  assert.deepEqual(job, { requestId, state: 'PROCESSING', error: 'RESULT_HOST_NOT_ALLOWED' });
  assert.equal(f.downloads.length, 0);
  assert.equal((await f.request(`/v1/transitions/${requestId}/video`)).status, 409);
});

test('APK preset switches providers, preserves exact recipes and keeps each request bound to its preset', async t => {
  const f = await fixture(t, { withMiniMax: true, maxPaidJobs: 2, prompt: 'Legacy configuration override' });
  await f.start();
  const changed = Buffer.from(JPEG);
  changed[10] ^= 1;
  const images = [DATA_URI, `data:image/jpeg;base64,${changed.toString('base64')}`];
  const first = { requestId: randomUUID(), images, preset: VIDU_PRESET };
  const second = { requestId: randomUUID(), images, preset: MINIMAX_PRESET };

  const unknown = await f.request('/v1/transitions', { body: { ...first, preset: '__proto__' } });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'UNKNOWN_TRANSITION_PRESET' });
  assert.equal((await f.request('/v1/transitions', { body: { ...first, prompt: 'other prompt' } })).status, 400);
  assert.equal((await f.request('/v1/transitions', { body: first })).status, 202);
  const starts = await Promise.all([f.request('/v1/transitions', { body: second }),
    f.request('/v1/transitions', { body: second })]);
  assert(starts.every(res => res.status === 202 || res.status === 200));
  const vidu = await f.wait(first.requestId, job => job.state === 'READY');
  const miniMax = await f.wait(second.requestId, job => job.state === 'READY');
  assert.equal(vidu.preset, VIDU_PRESET);
  assert.equal(miniMax.preset, MINIMAX_PRESET);
  assert.deepEqual(f.submits, [{ auth: `Token ${API_KEY}`, body: {
    model: 'viduq2-pro-fast', images, prompt: presets[VIDU_PRESET].prompt, duration: 2,
    resolution: '720p', bgm: false, off_peak: false, payload: first.requestId,
  } }]);
  assert.deepEqual(f.miniMaxSubmits, [{ auth: `Bearer ${MINIMAX_KEY}`, body: {
    model: 'MiniMax-H3-Highspeed', resolution: '768P', duration: 4, content: [
      { type: 'text', text: presets[MINIMAX_PRESET].prompt },
      { type: 'image_url', role: 'first_frame', image_url: { url: images[0] } },
      { type: 'image_url', role: 'last_frame', image_url: { url: images[1] } },
    ],
  } }]);
  assert.deepEqual(f.miniMaxQueries, [`Bearer ${MINIMAX_KEY}`, `Bearer ${MINIMAX_KEY}`]);
  assert.deepEqual(f.miniMaxDownloads, [undefined]);
  const download = await f.request(miniMax.downloadPath);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), MINIMAX_MP4);
  const persisted = await readFile(path.join(f.dir, `${second.requestId}.json`), 'utf8');
  assert(!persisted.includes(DATA_URI) && !persisted.includes(MINIMAX_KEY) && !persisted.includes('signed-url'));
  assert.equal(JSON.parse(persisted).providerRegion, 'cn');

  await f.restart();
  assert.deepEqual(await (await f.request('/v1/transitions', { body: second })).json(), miniMax);
  const conflict = await f.request('/v1/transitions', { body: { ...second, preset: VIDU_PRESET } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'REQUEST_CONTENT_CHANGED' });
  assert.equal(f.miniMaxSubmits.length, 1);
});

test('a MiniMax-only service rejects a Vidu selection without using quota', async t => {
  const f = await fixture(t, { withVidu: false, withMiniMax: true });
  await f.start();
  const request = { requestId: randomUUID(), images: [DATA_URI, DATA_URI], preset: VIDU_PRESET };
  const unavailable = await f.request('/v1/transitions', { body: request });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'PROVIDER_NOT_CONFIGURED' });
  const miniMax = await f.request('/v1/transitions', { body: { ...request, preset: MINIMAX_PRESET } });
  assert.equal(miniMax.status, 202);
  await f.wait(request.requestId, job => job.state === 'READY');
  assert.equal(f.submits.length, 0);
  assert.equal(f.miniMaxSubmits.length, 1);
});

test('MiniMax resumes an in-flight job only in its original region', async t => {
  const f = await fixture(t, { withVidu: false, withMiniMax: true });
  const requestId = randomUUID();
  await writeFile(path.join(f.dir, `${requestId}.json`), JSON.stringify({ requestId, state: 'PROCESSING',
    preset: MINIMAX_PRESET, provider: 'minimax', providerRegion: 'cn',
    providerTaskId: 'minimax-task-1', createdAt: Date.now(), digest: '0'.repeat(64) }));
  await f.start('global');
  await f.wait(requestId, job => job.error === 'PROVIDER_REGION_CHANGED');
  assert.equal(f.miniMaxQueries.length, 0);
  await f.restart('cn');
  await f.wait(requestId, job => job.state === 'READY');
  assert.equal(f.miniMaxSubmits.length, 0);
  assert.equal(f.miniMaxQueries.length, 2);
});

test('live prompt saves affect new jobs while existing requests keep their original prompt snapshot', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'montage-live-prompts-'));
  const file = path.join(directory, 'presets.json');
  await writeFile(file, await readFile(MONTAGE_PRESET_FILE));
  const store = createMontagePresetStore(file);
  const original = (await store.resolve(MINIMAX_PRESET)).prompt;
  const edited = '保持人物稳定，镜头向左移动，再平稳进入尾帧。';
  let editedAfterSnapshot = false;
  const f = await fixture(t, { withMiniMax: true, maxPaidJobs: 0,
    resolvePreset: async id => {
      const snapshot = await store.resolve(id);
      if (!editedAfterSnapshot) {
        editedAfterSnapshot = true;
        await store.save(id, edited, (await store.read()).revision);
      }
      return snapshot;
    },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await f.start();
  const first = { requestId: randomUUID(), images: [DATA_URI, DATA_URI], preset: MINIMAX_PRESET };
  await f.request('/v1/transitions', { body: first });
  await f.wait(first.requestId, job => job.state === 'READY');
  const second = { ...first, requestId: randomUUID() };
  await f.request('/v1/transitions', { body: second });
  await f.wait(second.requestId, job => job.state === 'READY');
  assert.deepEqual(f.miniMaxSubmits.map(item => item.body.content[0].text), [original, edited]);
  await f.restart();
  await f.request('/v1/transitions', { body: first });
  assert.equal(f.miniMaxSubmits.length, 2);
  for (const [request, prompt] of [[first, original], [second, edited]]) {
    const saved = JSON.parse(await readFile(path.join(f.dir, request.requestId + '.json')));
    assert.equal(saved.promptSha256, createHash('sha256').update(prompt).digest('hex'));
  }
});

test('activating a prompt branch affects only new provider submissions', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'montage-live-versions-'));
  const file = path.join(directory, 'presets.json');
  await writeFile(file, await readFile(MONTAGE_PRESET_FILE));
  const store = createMontagePresetStore(file);
  const before = await store.read();
  const original = before.presets.find(preset => preset.id === MINIMAX_PRESET);
  const cinematic = original.versions.find(version => version.id === 'cinematic').prompt;
  const f = await fixture(t, { withMiniMax: true, maxPaidJobs: 0, resolvePreset: store.resolve });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await f.start();
  const first = { requestId: randomUUID(), images: [DATA_URI, DATA_URI], preset: MINIMAX_PRESET };
  await f.request('/v1/transitions', { body: first });
  await f.wait(first.requestId, job => job.state === 'READY');
  await store.activateVersion(MINIMAX_PRESET, 'cinematic', before.revision);
  const second = { ...first, requestId: randomUUID() };
  await f.request('/v1/transitions', { body: second });
  await f.wait(second.requestId, job => job.state === 'READY');
  await f.restart();
  await f.request('/v1/transitions', { body: first });
  assert.deepEqual(f.miniMaxSubmits.map(item => item.body.content[0].text), [original.prompt, cinematic]);
  const savedFirst = JSON.parse(await readFile(path.join(f.dir, `${first.requestId}.json`)));
  assert.equal(savedFirst.promptSha256, createHash('sha256').update(original.prompt).digest('hex'));
});
