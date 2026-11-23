import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isPrivateIpv4, startTransitionService } from '../server/vidu-index.mjs';
import { createMontagePresetStore } from '../server/montage-preset-store.mjs';
import { startPromptEditor } from '../server/montage-prompt-editor.mjs';

const root = path.resolve(import.meta.dirname, '..');

export async function montageIdentity(directory) {
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  let create = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    create = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const folder = await lstat(directory);
  if (!folder.isDirectory() || (folder.mode & 0o077) !== 0) throw new Error('成片身份目录必须是仅当前用户可访问的真实目录');
  if (create) {
    await writeFile(keyFile, '', { flag: 'wx', mode: 0o600 });
    await writeFile(certFile, '', { flag: 'wx', mode: 0o600 });
    execFileSync('/usr/bin/openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile],
      { stdio: 'pipe', timeout: 15000 });
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-new', '-sha256', '-key', keyFile, '-days', '3650',
      '-subj', '/CN=Pura Montage Mac', '-out', certFile], { stdio: 'pipe', timeout: 15000 });
    await chmod(keyFile, 0o600);
    await chmod(certFile, 0o600);
  }
  const files = await Promise.all([lstat(keyFile), lstat(certFile)]).catch(() => []);
  if (files.length !== 2 || files.some(file => !file.isFile() || !file.size || (file.mode & 0o077) !== 0)) {
    throw new Error('成片身份文件缺失、未完成或权限过宽，请恢复原证书和密钥');
  }
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const identity = new X509Certificate(cert);
  if (!identity.checkPrivateKey(createPrivateKey(key))) throw new Error('成片证书和密钥不匹配');
  if (Date.now() < Date.parse(identity.validFrom) || Date.now() > Date.parse(identity.validTo)) {
    throw new Error('成片证书当前无效，请检查 Mac 时间或恢复有效身份');
  }
  const pin = createHash('sha256').update(identity.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { keyFile, certFile, pin };
}

function localAddress(iface, selected, previous) {
  const addresses = (networkInterfaces()[iface] ?? [])
    .filter(info => info.family === 'IPv4' && !info.internal && isPrivateIpv4(info.address))
    .map(info => info.address);
  if (selected && addresses.includes(selected)) return selected;
  if (!selected && addresses.includes(previous)) return previous;
  if (!selected && addresses.length === 1) return addresses[0];
  const note = addresses.length ? `（可用地址 ${addresses.join('、')}，用 --address 选择）` : '';
  throw new Error(`网络接口 ${iface} 没有唯一可用的局域网 IPv4${note}`);
}

export function montageQrPng(pin, token, host, port) {
  if (!/^[a-f0-9]{64}$/.test(pin) || !/^[A-Za-z0-9_-]{24,128}$/.test(token ?? '') ||
      !isPrivateIpv4(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('二维码配置无效，请检查局域网地址、端口和客户端令牌');
  }
  // Supply the credential over stdin so it never appears in process arguments or logs.
  return execFileSync('/usr/bin/swift', [path.join(import.meta.dirname, 'montage-qr.swift')], {
    input: `pura-montage:v1:${pin}:${token}:${host}:${port}`,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 45000,
  });
}

function publishMontageService(pin, host, port) {
  let child, retry;
  let childClosed = Promise.resolve();
  let stopped = false, warned = false;
  const start = () => {
    child = spawn('/usr/bin/dns-sd', [
      '-R', `Pura Montage ${pin.slice(0, 12)}`, '_puramontage._tcp', 'local.', String(port),
      `fp=${pin}`, `ip=${host}`,
    ], { stdio: 'ignore' });
    childClosed = new Promise(resolve => {
      child.once('close', () => {
        resolve();
        if (stopped) return;
        if (!warned) console.error('Bonjour 广播已中断，将自动恢复。扫码仍可使用。');
        warned = true;
        retry = setTimeout(start, 5000);
      });
    });
    child.on('error', () => {});
  };
  start();
  return async () => {
    stopped = true;
    clearTimeout(retry);
    child?.kill('SIGTERM');
    await childClosed;
  };
}

/** Keep one listener and one durable job-directory owner, even during DHCP changes. */
export async function watchMontageAddress({ readAddress, bind, signal, onUnavailable, intervalMs = 1500 }) {
  let address, close;
  let lastProblem;
  function report(problem) {
    if (problem !== lastProblem) onUnavailable(problem);
    lastProblem = problem;
  }
  try {
    while (!signal.aborted) {
      let next;
      try { next = readAddress(address); }
      catch (error) { report(error.message); }
      if (close && address !== next) {
        await close();
        close = address = undefined;
      }
      if (signal.aborted) break;
      if (next && !close) {
        try {
          close = await bind(next);
          address = next;
          lastProblem = undefined;
        } catch (error) {
          if (error.code !== 'EADDRNOTAVAIL') throw error;
          report('网络地址正在切换，等待成片服务重新绑定。');
        }
      }
      await sleep(intervalMs, undefined, { signal }).catch(error => {
        if (!signal.aborted) throw error;
      });
    }
  } finally {
    await close?.();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      interface: { type: 'string', default: 'en0' },
      address: { type: 'string' },
      'no-open': { type: 'boolean' },
    },
  });
  const port = Number(process.env.VIDU_PORT || 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('成片服务端口无效');
  if (values.address && !isPrivateIpv4(values.address)) throw new Error('--address 必须为局域网 IPv4');
  const identity = await montageIdentity(path.join(root, '.runtime', 'montage-tls'));
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  let editorStatus = { origin: null, message: '等待手机热点或同一 Wi-Fi' };
  const editor = await startPromptEditor({
    port: Number(process.env.MONTAGE_EDITOR_PORT || 8790),
    store: createMontagePresetStore(),
    status: () => editorStatus,
  });
  console.log(`提示词编辑器 ${editor.origin}`);
  if (!values['no-open']) {
    try { execFileSync('/usr/bin/open', [editor.origin], { stdio: 'pipe', timeout: 15000 }); }
    catch { console.error('请在 Mac 浏览器打开提示词编辑器地址。'); }
  }
  let serial = 0;
  try {
    await watchMontageAddress({
      signal: controller.signal,
      readAddress: previous => localAddress(values.interface, values.address, previous),
      onUnavailable: message => {
        editorStatus = { origin: null, message: '等待手机热点或同一 Wi-Fi' };
        console.log(message);
      },
      bind: async host => {
        const png = montageQrPng(identity.pin, process.env.VIDU_CLIENT_TOKEN, host, port);
        const qrFile = path.join(path.dirname(identity.certFile), `pairing-${process.pid}-${++serial}.png`);
        await writeFile(qrFile, png, { mode: 0o600, flag: 'wx' });
        let started;
        try {
          started = await startTransitionService({
            ...process.env,
            VIDU_HOST: host,
            VIDU_PORT: String(port),
            VIDU_TLS_CERT_FILE: identity.certFile,
            VIDU_TLS_KEY_FILE: identity.keyFile,
            VIDU_JOB_DIR: process.env.VIDU_JOB_DIR || path.join(root, '.runtime', 'montage'),
          });
        } catch (error) {
          await unlink(qrFile).catch(() => {});
          throw error;
        }
        const unpublish = publishMontageService(identity.pin, host, port);
        editorStatus = { origin: started.origin, message: '手机成片服务已启动' };
        console.log(`成片服务 ${started.origin}（${values.interface}）`);
        console.log(`Mac 指纹 ${identity.pin}`);
        console.log(`配对二维码 ${qrFile}`);
        if (!values['no-open'] && !controller.signal.aborted) {
          try { execFileSync('/usr/bin/open', ['-a', 'Preview', qrFile], { stdio: 'pipe', timeout: 15000 }); }
          catch { console.error('请手动打开上述二维码图片。'); }
        }
        return async () => {
          editorStatus = { origin: null, message: '等待手机热点或同一 Wi-Fi' };
          await unpublish();
          await unlink(qrFile).catch(() => {});
          await started.server.close({ disconnectClients: true });
        };
      },
    });
  } finally {
    await editor.close();
  }
}

let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch {}
if (entry === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`成片服务启动失败：${error.message}`); process.exitCode = 1; }
}
