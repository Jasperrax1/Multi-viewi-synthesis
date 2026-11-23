import { createResultDownloader, ProviderError, responseJson } from './vidu-provider.mjs';

const API_ORIGINS = { cn: 'https://api.minimax.cn', global: 'https://api.minimax.io' };
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FRAME_ROLES = ['first_frame', 'last_frame'];

export const DEFAULT_MINIMAX_RESULT_HOSTS = [
  'cdn.hailuoai.com',
  'video-product.cdn.minimax.io',
  'algeng-video-infer.oss-cn-shanghai.aliyuncs.com',
];

export function createMiniMaxProvider({ apiKey, region = 'cn', resultHosts = DEFAULT_MINIMAX_RESULT_HOSTS,
  fetchImpl = fetch }) {
  if (!Object.hasOwn(API_ORIGINS, region)) throw new Error('MINIMAX_API_REGION must be cn or global');
  const origin = API_ORIGINS[region];
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  return {
    async submit(_requestId, images, { durationSeconds, prompt, model, resolution }) {
      const response = await fetchImpl(`${origin}/v2/video_generation`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, resolution, duration: durationSeconds, content: [
          { type: 'text', text: prompt },
          ...images.map((url, index) => ({
            type: 'image_url', role: FRAME_ROLES[index], image_url: { url },
          })),
        ] }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status)) {
          throw new ProviderError(`MINIMAX_REJECTED_${response.status}`);
        }
        throw new ProviderError('SUBMISSION_UNKNOWN');
      }
      const { task_id: taskId } = await responseJson(response);
      if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new ProviderError('SUBMISSION_UNKNOWN');
      return { providerTaskId: taskId };
    },

    async query(taskId) {
      if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new ProviderError('INVALID_PROVIDER_TASK_ID');
      const response = await fetchImpl(`${origin}/v2/query/video_generation/${taskId}`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(`MINIMAX_QUERY_${response.status}`);
      }
      const { task } = await responseJson(response);
      if (task?.id !== taskId) throw new ProviderError('PROVIDER_TASK_ID_MISMATCH');
      if (task.status === 'queued' || task.status === 'running') return { state: 'PROCESSING' };
      if (task.status === 'failed' || task.status === 'cancelled') {
        return { state: 'FAILED', error: 'MINIMAX_GENERATION_FAILED' };
      }
      const result = task.content?.url;
      if (task.status !== 'succeeded' || typeof result !== 'string') {
        throw new ProviderError('INVALID_PROVIDER_RESULT');
      }
      return { state: 'READY', result };
    },

    download: createResultDownloader({ resultHosts, fetchImpl, providerName: 'MINIMAX' }),
  };
}
