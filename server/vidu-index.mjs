import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViduServer } from './vidu-app.mjs';
import { DEFAULT_RESULT_HOSTS } from './vidu-provider.mjs';
import { DEFAULT_MINIMAX_RESULT_HOSTS } from './minimax-provider.mjs';
import { createMontagePresetStore } from './montage-preset-store.mjs';

export function isPrivateIpv4(host) {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
}

function resultHosts(value, variable, defaults) {
  const additional = (value || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (additional.some(host => !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host))) {
    throw new Error(`${variable} takes comma-separated exact DNS hostnames`);
  }
  return [...defaults, ...additional];
}

export async function startTransitionService(env = process.env) {
  const presets = createMontagePresetStore();
  const host = env.VIDU_HOST || '127.0.0.1';
  const port = Number(env.VIDU_PORT || 8788);
  const loopback = host === 'localhost' || host === '::1' || isIPv4(host) && host.startsWith('127.');
  const linkLocal = isIPv4(host) && host.startsWith('169.254.');
  if (!loopback && !linkLocal && !isPrivateIpv4(host)) {
    throw new Error('VIDU_HOST must be loopback or a specific private LAN IPv4 address');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIDU_PORT');
  const certFile = env.VIDU_TLS_CERT_FILE;
  const keyFile = env.VIDU_TLS_KEY_FILE;
  if (Boolean(certFile) !== Boolean(keyFile)) throw new Error('Set both VIDU_TLS_CERT_FILE and VIDU_TLS_KEY_FILE');
  if (!loopback && !certFile && env.VIDU_ALLOW_LAN_HTTP !== '1') {
    throw new Error('Use TLS for LAN access or explicitly set VIDU_ALLOW_LAN_HTTP=1 for the isolated demo');
  }
  const tls = certFile ? { cert: await readFile(certFile), key: await readFile(keyFile) } : undefined;
  const promptFile = env.VIDU_PROMPT_FILE;
  if (promptFile && (await stat(promptFile)).size > 20_000) throw new Error('Vidu prompt file exceeds 20,000 bytes');
  const server = await createViduServer({
    apiKey: env.VIDU_API_KEY,
    miniMaxApiKey: env.MINIMAX_API_KEY,
    miniMaxRegion: env.MINIMAX_API_REGION || undefined,
    clientToken: env.VIDU_CLIENT_TOKEN,
    jobDir: path.resolve(env.VIDU_JOB_DIR || '.runtime/vidu'),
    maxPaidJobs: Number(env.VIDU_MAX_PAID_JOBS || 0),
    durationSeconds: Number(env.VIDU_DURATION_SECONDS || 1),
    model: env.VIDU_MODEL || undefined,
    resolution: env.VIDU_RESOLUTION || undefined,
    prompt: promptFile ? await readFile(promptFile, 'utf8') : undefined,
    resultHosts: resultHosts(env.VIDU_RESULT_HOSTS, 'VIDU_RESULT_HOSTS', DEFAULT_RESULT_HOSTS),
    miniMaxResultHosts: resultHosts(env.MINIMAX_RESULT_HOSTS, 'MINIMAX_RESULT_HOSTS', DEFAULT_MINIMAX_RESULT_HOSTS),
    resolvePreset: presets.resolve,
    tls,
    onDiagnostic: (code, resultHost) => console.error(`Transition job status: ${code}${resultHost ? ` (${resultHost})` : ''}`),
  });
  await server.listen(port, host);
  return { server, origin: `${tls ? 'https' : 'http'}://${host === '::1' ? '[::1]' : host}:${port}` };
}

let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch {}
if (entry === fileURLToPath(import.meta.url)) {
  const { server, origin } = await startTransitionService();
  console.log(`Transition service: ${origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close(); });
}
