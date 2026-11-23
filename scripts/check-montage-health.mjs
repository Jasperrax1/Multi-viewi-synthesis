import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { isPrivateIpv4 } from '../server/vidu-index.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fingerprint = cert => createHash('sha256')
  .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

async function main() {
  const port = Number(process.env.MONTAGE_EDITOR_PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('提示词工具端口无效。');
  const token = process.env.VIDU_CLIENT_TOKEN;
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token ?? '')) throw new Error('请先运行 setup:mac，配置本机连接令牌。');
  let snapshot;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/presets`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    snapshot = await response.json();
  } catch { throw new Error('本机启动器尚未就绪，请先启动 montage:lan。'); }
  if (!snapshot.status?.origin) throw new Error('成片服务正在等待可互访的同一热点或 Wi-Fi，请检查启动器中的网卡选择。');
  const origin = new URL(snapshot.status.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || !(isPrivateIpv4(origin.hostname) || origin.hostname === '127.0.0.1')) {
    throw new Error('启动器没有返回有效的局域网 HTTPS 地址。');
  }
  const cert = await readFile(path.join(root, '.runtime/montage-tls/cert.pem'));
  const pin = fingerprint(cert);
  await new Promise((resolve, reject) => {
    const request = https.get(new URL('/v1/health', origin), {
      ca: cert,
      checkServerIdentity: (_host, peer) => fingerprint(peer.raw) === pin ? undefined : new Error('Mac 证书指纹不匹配。'),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, response => {
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 32768) response.destroy(new Error('健康检查响应过大。'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`健康检查返回 HTTP ${response.statusCode}，请核对本机服务配置。`));
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (value?.service !== 'pura-montage' || value?.version !== 1) return reject(new Error('响应与成片服务不匹配。'));
        resolve();
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('健康检查超时。')));
  });
  console.log(JSON.stringify({ ok: true, origin: origin.origin, fingerprint: pin, cloudTasksCreated: 0 }));
  console.log('Mac 本机成片接口检查通过；手机端请另行扫码并检查连接。');
}

main().catch(error => {
  console.error(`成片服务检查失败：${error.message}`);
  process.exitCode = 1;
});
