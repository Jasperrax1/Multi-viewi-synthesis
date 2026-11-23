import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import presets from '../config/montage-presets.json' with { type: 'json' };
import { jpegDimensions } from './app.mjs';
import { createViduProvider, DEFAULT_VIDU_PROMPT, DEFAULT_VIDU_RECIPE, ProviderError } from './vidu-provider.mjs';
import { createMiniMaxProvider } from './minimax-provider.mjs';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REQUEST_ID = new RegExp(`^${ID}$`);
const JOB_ROUTE = new RegExp(`^/v1/transitions/(${ID})(/video)?$`);
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_JPEG_BYTES / 3) * 4;
const MAX_BODY_BYTES = MAX_BASE64_LENGTH * 2 + 512;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const TERMINAL = new Set(['READY', 'FAILED', 'SUBMISSION_UNKNOWN']);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function readRequest(req) {
  if (String(req.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'EXPECTED_JSON');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON'); }
}

function requestSpec(body) {
  if (!body || typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId) ||
      !Array.isArray(body.images) || body.images.length !== 2 ||
      Object.keys(body).some(key => !['requestId', 'images', 'preset'].includes(key))) {
    throw new HttpError(400, 'EXPECTED_REQUEST_ID_AND_TWO_IMAGES');
  }
  const preset = body.preset;
  if (preset !== undefined && (typeof preset !== 'string' || !Object.hasOwn(presets, preset))) {
    throw new HttpError(400, 'UNKNOWN_TRANSITION_PRESET');
  }
  const digest = createHash('sha256');
  const dimensions = body.images.map(image => {
    if (typeof image !== 'string' || !image.startsWith(JPEG_PREFIX)) throw new HttpError(400, 'EXPECTED_JPEG_DATA_URI');
    const encoded = image.slice(JPEG_PREFIX.length);
    if (encoded.length > MAX_BASE64_LENGTH) throw new HttpError(413, 'IMAGE_TOO_LARGE');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_JPEG_BYTES) throw new HttpError(413, 'IMAGE_TOO_LARGE');
    if (bytes.toString('base64') !== encoded) throw new HttpError(400, 'INVALID_BASE64');
    digest.update(createHash('sha256').update(bytes).digest());
    try { return jpegDimensions(bytes); } catch { throw new HttpError(400, 'INVALID_JPEG'); }
  });
  const [{ width, height }, end] = dimensions;
  if (width !== end.width || height !== end.height || width > 4096 || height > 4096 ||
      width >= 4 * height || height >= 4 * width) throw new HttpError(400, 'INCOMPATIBLE_IMAGE_DIMENSIONS');
  return { requestId: body.requestId, images: body.images, digest: digest.digest('hex'), ...(preset && { preset }) };
}

async function atomicWrite(file, data) {
  const temp = `${file}.part`;
  const writer = await open(temp, 'w', 0o600);
  try { await writer.writeFile(data); await writer.sync(); } finally { await writer.close(); }
  await rename(temp, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
  } finally { await directory.close(); }
}

function publicJob(job) {
  const { requestId, state, preset, error, byteLength, sha256 } = job;
  return { requestId, state, ...(preset && { preset }), ...(error && { error }),
    ...(state === 'READY' && { byteLength, sha256, downloadPath: `/v1/transitions/${requestId}/video` }) };
}

function supportedRecipe(model, resolution) {
  return (model === DEFAULT_VIDU_RECIPE.model && resolution === DEFAULT_VIDU_RECIPE.resolution) ||
    (model === 'viduq2-pro-fast' && resolution === '720p');
}

export async function createViduServer({ apiKey, clientToken, jobDir, maxPaidJobs = 0, tls,
  resultHosts, fetchImpl, pollMs = 3000, onDiagnostic = () => {}, durationSeconds = 1, prompt = DEFAULT_VIDU_PROMPT,
  model = DEFAULT_VIDU_RECIPE.model, resolution = DEFAULT_VIDU_RECIPE.resolution,
  miniMaxApiKey, miniMaxRegion = 'cn', miniMaxResultHosts, miniMaxPollMs = 10000,
  resolvePreset = id => structuredClone(presets[id]) }) {
  for (const [name, key] of [['VIDU_API_KEY', apiKey], ['MINIMAX_API_KEY', miniMaxApiKey]]) {
    if (key != null && (typeof key !== 'string' || /\s/.test(key))) throw new Error(`Invalid ${name}`);
  }
  if (!apiKey && !miniMaxApiKey) throw new Error('Set VIDU_API_KEY or MINIMAX_API_KEY');
  if (!['cn', 'global'].includes(miniMaxRegion)) throw new Error('MINIMAX_API_REGION must be cn or global');
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(clientToken ?? '')) throw new Error('Set a random VIDU_CLIENT_TOKEN (24–128 URL-safe characters)');
  if (!Number.isSafeInteger(maxPaidJobs) || maxPaidJobs < 0) throw new Error('Invalid VIDU_MAX_PAID_JOBS');
  if (durationSeconds !== 1 && durationSeconds !== 2) throw new Error('VIDU_DURATION_SECONDS must be 1 or 2');
  if (!supportedRecipe(model, resolution)) throw new Error('Unsupported VIDU_MODEL and VIDU_RESOLUTION combination');
  if (typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > 5000) {
    throw new Error('Vidu prompt must contain 1 to 5000 characters');
  }
  const promptSha256 = createHash('sha256').update(prompt).digest('hex');
  const authorization = Buffer.from(`Bearer ${clientToken}`);
  const providers = {
    vidu: apiKey ? createViduProvider({ apiKey, resultHosts, fetchImpl }) : undefined,
    minimax: miniMaxApiKey ? createMiniMaxProvider({
      apiKey: miniMaxApiKey, region: miniMaxRegion, resultHosts: miniMaxResultHosts, fetchImpl,
    }) : undefined,
  };
  const jobs = new Map(), timers = new Map(), work = new Set();
  const jobFile = id => path.join(jobDir, `${id}.json`);
  const videoFile = id => path.join(jobDir, `${id}.mp4`);
  let closed = false, createTail = Promise.resolve(), closeTask;

  async function save(job) {
    await atomicWrite(jobFile(job.requestId), JSON.stringify(job));
    jobs.set(job.requestId, job);
  }

  await mkdir(jobDir, { mode: 0o700, recursive: true });
  if ((await stat(jobDir)).mode & 0o077) throw new Error('VIDU_JOB_DIR must be private (mode 700)');
  const lockPath = path.join(jobDir, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('VIDU_JOB_DIR is locked by another process or a prior unclean exit');
    throw error;
  }
  async function releaseLock() { await lock.close(); await unlink(lockPath); }

  try {
    await lock.writeFile(`${process.pid}\n`);
    for (const file of await readdir(jobDir)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (!REQUEST_ID.test(id)) throw new Error('Invalid job record filename');
      let job;
      try { job = JSON.parse(await readFile(jobFile(id), 'utf8')); }
      catch { throw new Error('Invalid persisted Vidu job'); }
      if (!job || job.requestId !== id || !/^[0-9a-f]{64}$/.test(job.digest) ||
          !Number.isFinite(job.createdAt) || !['QUEUED', 'SUBMITTING', 'PROCESSING', ...TERMINAL].includes(job.state)) {
        throw new Error('Invalid persisted Vidu job');
      }
      const preset = job.preset === undefined ? undefined
        : typeof job.preset === 'string' && Object.hasOwn(presets, job.preset) && presets[job.preset];
      if ((job.preset !== undefined && (!preset || job.provider !== preset.provider)) ||
          (job.preset === undefined && job.provider !== undefined) ||
          (job.provider === 'minimax' && !['cn', 'global'].includes(job.providerRegion))) {
        throw new Error('Invalid persisted transition provider');
      }
      if (job.state === 'QUEUED') {
        const { digest } = requestSpec({ requestId: id, images: job.images, preset: job.preset });
        if (digest !== job.digest) throw new Error('Persisted Vidu image digest mismatch');
        const invalidRecipe = preset
          ? job.model !== preset.model || job.resolution !== preset.resolution || job.durationSeconds !== preset.durationSeconds
          : !supportedRecipe(job.model ?? DEFAULT_VIDU_RECIPE.model, job.resolution ?? DEFAULT_VIDU_RECIPE.resolution);
        if (invalidRecipe) {
          throw new Error('Invalid persisted transition recipe');
        }
        if ((preset || job.prompt !== undefined) && (typeof job.prompt !== 'string' || !job.prompt.trim() ||
            [...job.prompt].length > (job.provider === 'minimax' ? 7000 : 5000) ||
            (!preset && ![1, 2].includes(job.durationSeconds)) ||
            createHash('sha256').update(job.prompt).digest('hex') !== job.promptSha256)) {
          throw new Error('Invalid persisted transition prompt');
        }
      }
      if (job.state === 'SUBMITTING') await save({ ...job, state: 'SUBMISSION_UNKNOWN', error: 'SUBMISSION_UNKNOWN' });
      else jobs.set(id, job);
    }
  } catch (error) {
    await releaseLock();
    throw error;
  }

  function schedule(id, delay) {
    if (closed) return;
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      const task = advance(id).catch(() => onDiagnostic('JOB_STORAGE_FAILURE'));
      work.add(task);
      void task.finally(() => work.delete(task));
    }, delay));
  }

  async function advance(id) {
    let job = jobs.get(id);
    const provider = providers[job.provider ?? 'vidu'];
    const interval = job.provider === 'minimax' ? miniMaxPollMs : pollMs;
    const configurationError = !provider ? 'PROVIDER_NOT_CONFIGURED'
      : job.provider === 'minimax' && job.providerRegion !== miniMaxRegion ? 'PROVIDER_REGION_CHANGED' : undefined;
    if (configurationError) {
      if (job.error !== configurationError) {
        await save({ ...job, error: configurationError });
        onDiagnostic(configurationError);
      }
      return;
    }
    if (job.state === 'QUEUED') {
      const { images, prompt: jobPrompt = prompt, ...audit } = job;
      const submitting = { ...audit, durationSeconds: job.durationSeconds ?? durationSeconds,
        model: job.model ?? DEFAULT_VIDU_RECIPE.model, resolution: job.resolution ?? DEFAULT_VIDU_RECIPE.resolution,
        promptSha256: job.promptSha256 ?? promptSha256, state: 'SUBMITTING', error: undefined, providerSubmitStartedAt: Date.now() };
      await save(submitting); // Once persisted, neither a timeout nor a restart can repeat this POST.
      try {
        const receipt = await provider.submit(id, images, { durationSeconds: submitting.durationSeconds,
          prompt: jobPrompt, model: submitting.model, resolution: submitting.resolution });
        await save({ ...submitting, ...receipt, state: 'PROCESSING', providerAcceptedAt: Date.now() });
        schedule(id, interval);
      } catch (error) {
        const rejected = error instanceof ProviderError && /^(?:VIDU|MINIMAX)_REJECTED_/.test(error.code);
        const code = rejected ? error.code : 'SUBMISSION_UNKNOWN';
        await save({ ...submitting, state: rejected ? 'FAILED' : 'SUBMISSION_UNKNOWN',
          error: code, submitFinishedAt: Date.now() });
        onDiagnostic(code);
      }
      return;
    }
    if (job.state !== 'PROCESSING') return;
    if (Date.now() - job.createdAt >= 24 * 60 * 60 * 1000) {
      await save({ ...job, state: 'FAILED', error: 'RESULT_WAIT_LIMIT' });
      return;
    }
    try {
      const { result, ...status } = await provider.query(job.providerTaskId);
      if (status.state === 'FAILED') await save({ ...job, ...status });
      else if (status.state === 'READY') {
        if (!job.providerSuccessObservedAt || status.providerCredits !== undefined && status.providerCredits !== job.providerCredits) {
          job = { ...job, providerSuccessObservedAt: job.providerSuccessObservedAt ?? Date.now(),
            providerCredits: status.providerCredits ?? job.providerCredits };
          await save(job);
        }
        const { bytes, byteLength, sha256 } = await provider.download(result);
        const resultDownloadedAt = Date.now();
        await atomicWrite(videoFile(id), bytes);
        await save({ ...job, state: 'READY', byteLength, sha256, resultDownloadedAt, readyAt: Date.now(), error: undefined });
      } else {
        if (job.error || status.providerCredits !== undefined && status.providerCredits !== job.providerCredits) {
          await save({ ...job, ...status, error: undefined });
        }
        schedule(id, interval);
      }
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'PROVIDER_TEMPORARILY_UNAVAILABLE';
      if (job.error !== code) {
        await save({ ...job, error: code });
        onDiagnostic(code, error instanceof ProviderError ? error.resultHost : undefined);
      }
      schedule(id, Math.max(interval, 15000));
    }
  }

  function create(spec) {
    const task = createTail.then(async () => {
      const previous = jobs.get(spec.requestId);
      if (previous) {
        if (previous.digest !== spec.digest || previous.preset !== spec.preset) {
          throw new HttpError(409, 'REQUEST_CONTENT_CHANGED');
        }
        return previous;
      }
      const recipe = spec.preset && await resolvePreset(spec.preset);
      if (spec.preset && !recipe) throw new HttpError(500, 'INVALID_PRESET_CONFIGURATION');
      if (recipe && (recipe.provider !== presets[spec.preset].provider ||
          recipe.model !== presets[spec.preset].model || recipe.resolution !== presets[spec.preset].resolution ||
          recipe.durationSeconds !== presets[spec.preset].durationSeconds ||
          typeof recipe.prompt !== 'string' || !recipe.prompt.trim() ||
          [...recipe.prompt].length > (recipe.provider === 'minimax' ? 7000 : 5000))) {
        throw new HttpError(500, 'INVALID_PRESET_CONFIGURATION');
      }
      if (!providers[recipe?.provider ?? 'vidu']) throw new HttpError(503, 'PROVIDER_NOT_CONFIGURED');
      if (maxPaidJobs > 0 && jobs.size >= maxPaidJobs) throw new HttpError(429, 'DEMO_JOB_LIMIT');
      const job = { ...spec, state: 'QUEUED', createdAt: Date.now(), durationSeconds, model, resolution, prompt, promptSha256 };
      if (recipe) {
        Object.assign(job, {
          provider: recipe.provider, model: recipe.model, resolution: recipe.resolution,
          durationSeconds: recipe.durationSeconds, prompt: recipe.prompt,
          promptSha256: createHash('sha256').update(recipe.prompt).digest('hex'),
          ...(recipe.provider === 'minimax' && { providerRegion: miniMaxRegion }),
        });
      }
      await save(job);
      schedule(job.requestId, 0);
      return job;
    });
    createTail = task.catch(() => {});
    return task;
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        throw new HttpError(401, 'AUTHORIZATION_REQUIRED');
      }
      if (req.url === '/v1/health' && req.method === 'GET') {
        return json(res, 200, { service: 'pura-montage', version: 1 });
      }
      if (req.url === '/v1/transitions' && req.method === 'POST') {
        const job = await create(requestSpec(await readRequest(req)));
        return json(res, TERMINAL.has(job.state) ? 200 : 202, publicJob(job));
      }
      const match = JOB_ROUTE.exec(req.url);
      if (!match || req.method !== 'GET') throw new HttpError(404, 'NOT_FOUND');
      const job = jobs.get(match[1]);
      if (!job) throw new HttpError(404, 'UNKNOWN_JOB');
      if (!match[2]) return json(res, 200, publicJob(job));
      if (job.state !== 'READY') throw new HttpError(409, 'VIDEO_NOT_READY');
      const file = videoFile(job.requestId);
      if ((await stat(file)).size !== job.byteLength) throw new HttpError(500, 'STORED_VIDEO_UNAVAILABLE');
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': job.byteLength, 'X-Video-SHA256': job.sha256 });
      const stream = createReadStream(file);
      stream.once('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      req.resume();
      if (!res.destroyed) json(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'INTERNAL_ERROR' });
    }
  }

  let server;
  try { server = tls ? https.createServer(tls, handle) : http.createServer(handle); }
  catch (error) { await releaseLock(); throw error; }
  server.maxConnections = 16;
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  function close({ disconnectClients = false } = {}) {
    return closeTask ??= (async () => {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await new Promise(resolve => {
        server.close(resolve);
        if (disconnectClients) server.closeAllConnections();
      });
      await createTail;
      await Promise.all(work);
      await releaseLock();
    })();
  }
  return {
    async listen(port, host = '127.0.0.1') {
      if (closed) throw new Error('Vidu service closed');
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => { server.off('error', reject); resolve(); });
        });
      } catch (error) { await close(); throw error; }
      for (const job of jobs.values()) if (!TERMINAL.has(job.state)) schedule(job.requestId, 0);
      return server.address();
    },
    close,
  };
}
