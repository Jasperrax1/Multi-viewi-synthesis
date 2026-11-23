import { createHash } from 'node:crypto';

const API = 'https://api.vidu.cn/ent/v2';
export const DEFAULT_VIDU_PROMPT = '从给定首帧自然过渡到给定尾帧。保持场景与主体连贯，镜头运动平稳，无闪烁，不添加文字。';
export const DEFAULT_VIDU_RECIPE = Object.freeze({ model: 'viduq2-pro', resolution: '360p' });
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING = new Set(['created', 'queueing', 'processing']);

function creditsField(value) {
  return Number.isSafeInteger(value) && value >= 0 ? { providerCredits: value } : {};
}

export const DEFAULT_RESULT_HOSTS = [
  'prod-ss-vidu.s3.cn-northwest-1.amazonaws.com.cn',
  'prod-ss-vidu.s3.oss-cn-beijing.aliyuncs.com',
];

export class ProviderError extends Error {
  constructor(code, resultHost) { super(code); this.code = code; this.resultHost = resultHost; }
}

async function readBounded(response, limit) {
  if (!response.body) throw new ProviderError('EMPTY_PROVIDER_RESPONSE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

export async function responseJson(response) {
  return JSON.parse((await readBounded(response, 128 * 1024)).toString('utf8'));
}

function* boxes(bytes, start, end) {
  let count = 0;
  for (let pos = start; pos < end;) {
    if (++count > 4096 || end - pos < 8) throw new ProviderError('INVALID_MP4');
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    let size = bytes.readUInt32BE(pos);
    let header = 8;
    if (size === 1) {
      header = 16;
      if (end - pos < header) throw new ProviderError('INVALID_MP4');
      size = Number(bytes.readBigUInt64BE(pos + 8));
    } else if (size === 0) size = end - pos;
    if (size < header || size > end - pos) throw new ProviderError('INVALID_MP4');
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function verifyMp4(bytes) {
  const top = [...boxes(bytes, 0, bytes.length)];
  if (!top.some(box => box.type === 'ftyp' && box.end - box.start >= 8) ||
      !top.some(box => box.type === 'mdat' && box.end > box.start)) throw new ProviderError('INVALID_MP4');
  for (const moov of top.filter(box => box.type === 'moov')) {
    for (const trak of boxes(bytes, moov.start, moov.end)) {
      if (trak.type !== 'trak') continue;
      for (const mdia of boxes(bytes, trak.start, trak.end)) {
        if (mdia.type !== 'mdia') continue;
        for (const hdlr of boxes(bytes, mdia.start, mdia.end)) {
          if (hdlr.type === 'hdlr' && hdlr.end - hdlr.start >= 12 &&
              bytes.toString('ascii', hdlr.start + 8, hdlr.start + 12) === 'vide') return;
        }
      }
    }
  }
  throw new ProviderError('INVALID_MP4');
}

export function createResultDownloader({ resultHosts, fetchImpl, providerName }) {
  const downloadHosts = new Set(resultHosts);
  return async result => {
    let url;
    try { url = new URL(result); } catch { throw new ProviderError('INVALID_RESULT_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !downloadHosts.has(url.hostname)) {
      const hostname = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(url.hostname) ? url.hostname : undefined;
      throw new ProviderError('RESULT_HOST_NOT_ALLOWED', hostname);
    }
    // A signed result URL is self-authenticating. The provider key stays on its API host.
    const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(`${providerName}_DOWNLOAD_${response.status}`);
    }
    const bytes = await readBounded(response, MAX_VIDEO_BYTES);
    verifyMp4(bytes);
    return { bytes, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
}

export function createViduProvider({ apiKey, resultHosts = DEFAULT_RESULT_HOSTS, fetchImpl = fetch }) {
  const headers = { Authorization: `Token ${apiKey}`, Accept: 'application/json' };
  return {
    async submit(requestId, images, { durationSeconds, prompt, model, resolution }) {
      // Fetch rejects redirects so a paid POST cannot be replayed at a redirect target.
      const response = await fetchImpl(`${API}/start-end2video`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, images, prompt,
          duration: durationSeconds, resolution, bgm: false, off_peak: false, payload: requestId }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // These statuses explicitly reject the request. 5xx or a broken reply leaves it ambiguous.
        if ([400, 401, 403, 404, 413, 415, 422, 429].includes(response.status)) {
          throw new ProviderError(`VIDU_REJECTED_${response.status}`);
        }
        throw new ProviderError('SUBMISSION_UNKNOWN');
      }
      const { task_id: taskId, credits } = await responseJson(response);
      if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new ProviderError('SUBMISSION_UNKNOWN');
      return { providerTaskId: taskId, ...creditsField(credits) };
    },

    async query(taskId) {
      if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new ProviderError('INVALID_PROVIDER_TASK_ID');
      const response = await fetchImpl(`${API}/tasks/${taskId}/creations`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(`VIDU_QUERY_${response.status}`);
      }
      const data = await responseJson(response);
      if (data.id !== taskId) throw new ProviderError('PROVIDER_TASK_ID_MISMATCH');
      const state = data.state ?? data.status;
      const credits = creditsField(data.credits);
      if (PENDING.has(state)) return { state: 'PROCESSING', ...credits };
      if (state === 'failed') return { state: 'FAILED', error: 'VIDU_GENERATION_FAILED', ...credits };
      const result = data.creations?.[0]?.url;
      if (state !== 'success' || typeof result !== 'string') throw new ProviderError('INVALID_PROVIDER_RESULT');
      return { state: 'READY', result, ...credits };
    },

    download: createResultDownloader({ resultHosts, fetchImpl, providerName: 'VIDU' }),
  };
}
