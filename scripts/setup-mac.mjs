import { randomBytes } from 'node:crypto';
import { open, readFile, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const names = ['.env.vidu', '.env.minimax'];

export async function setupMac(root = project) {
  const templates = [
    '# Local connection token; keep this file private.\nVIDU_API_KEY=\n' +
      `VIDU_CLIENT_TOKEN=${randomBytes(32).toString('base64url')}\n` +
      'VIDU_HOST=127.0.0.1\nVIDU_PORT=8788\nVIDU_ALLOW_LAN_HTTP=0\nVIDU_MAX_PAID_JOBS=0\n',
    '# Fill your key on this Mac; never commit the completed file.\nMINIMAX_API_KEY=\nMINIMAX_API_REGION=cn\n',
  ];
  const created = [], preserved = [];
  for (let index = 0; index < names.length; index++) {
    const file = path.join(root, names[index]);
    let writer;
    try { writer = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      preserved.push(names[index]);
      continue;
    }
    try { await writer.writeFile(templates[index]); await writer.sync(); }
    finally { await writer.close(); }
    created.push(names[index]);
  }
  return { created, preserved };
}

function privateIpv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 ||
      parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 ||
      parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

/** Read-only deployment checks. Providers are never contacted and runtime identity is not created. */
export async function checkMac({ root = project, platform = process.platform,
  nodeVersion = process.versions.node, interfaces = networkInterfaces(),
  run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }),
} = {}) {
  const errors = [], warnings = [];
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 22 || major === 22 && minor >= 9)) errors.push('需要 Node 22.9 及以上；推荐使用已验证的 Node 24。');
  if (platform !== 'darwin') errors.push('扫码启动器需要 macOS。');
  if (platform === 'darwin') {
    const available = (command, args) => { try { return run(command, args).status === 0; } catch { return false; } };
    const tools = available('/usr/bin/xcode-select', ['-p']);
    if (!tools) errors.push('缺少 Xcode Command Line Tools，请运行 xcode-select --install 并完成系统安装。');
    else if (!available('/usr/bin/swift', ['--version'])) errors.push('Swift 工具链不可用，请检查 Command Line Tools。');
    if (!available('/usr/bin/openssl', ['version'])) errors.push('系统 OpenSSL 不可用。');
    if (!available('/bin/test', ['-x', '/usr/bin/dns-sd'])) errors.push('系统 dns-sd 不可用。');
  }
  const configurations = [];
  for (const name of names) {
    try {
      const file = path.join(root, name), info = await lstat(file);
      if (!info.isFile()) { errors.push(`${name} 必须为本机常规文件。`); configurations.push({}); continue; }
      if (info.mode & 0o077) errors.push(`${name} 权限过宽，请在本机设为 600。`);
      configurations.push(parseEnv(await readFile(file, 'utf8')));
    } catch { configurations.push({}); errors.push(`无法读取 ${name}，请先运行 setup:mac。`); }
  }
  const env = { ...configurations[0], ...configurations[1] };
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(env.VIDU_CLIENT_TOKEN ?? '')) errors.push('本机连接令牌未配置或格式无效。');
  const configured = { miniMax: Boolean(env.MINIMAX_API_KEY), vidu: Boolean(env.VIDU_API_KEY) };
  if (!configured.miniMax && !configured.vidu) errors.push('请在本机填写至少一个模型的 API Key；默认模型需要 MINIMAX_API_KEY。');
  for (const key of ['MINIMAX_API_KEY', 'VIDU_API_KEY']) {
    if (env[key] && /\s/.test(env[key])) errors.push(`${key} 包含空白字符，请在本机检查。`);
  }
  if (!['cn', 'global'].includes(env.MINIMAX_API_REGION || 'cn')) errors.push('MINIMAX_API_REGION 只能为 cn 或 global。');
  for (const [name, fallback] of [['VIDU_PORT', 8788], ['MONTAGE_EDITOR_PORT', 8790]]) {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535) errors.push(`${name} 端口无效。`);
  }
  const networks = Object.entries(interfaces).filter(([name]) => /^en\d+$/.test(name)).flatMap(([name, entries]) =>
    entries.filter(info => info.family === 'IPv4' && !info.internal && privateIpv4(info.address))
      .map(info => ({ interface: name, address: info.address })));
  if (!networks.length) warnings.push('尚无可用的本机私有局域网 IPv4；请将 Mac 和手机加入同一热点或 Wi-Fi。');
  return { ok: !errors.length && Boolean(networks.length), exitCode: errors.length ? 1 : networks.length ? 0 : 2,
    nodeVersion, platform, configured, networks, errors, warnings };
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('用法：setup-mac.mjs [--check]');
  if (process.argv.includes('--check')) {
    const report = await checkMac();
    console.log(JSON.stringify(report, null, 2));
    console.log('检查只确认本机配置和环境；没有访问模型 API，也没有生成证书或视频。');
    process.exitCode = report.exitCode;
    return;
  }
  const result = await setupMac();
  for (const name of result.created) console.log(`已创建 ${name}（权限 600）`);
  for (const name of result.preserved) console.log(`已保留现有 ${name}`);
  console.log('请在本机 .env.minimax 填写 MINIMAX_API_KEY；需要 Vidu 时在 .env.vidu 填写 VIDU_API_KEY。');
  console.log('填写后运行 npm run check:mac，再按实际 Wi-Fi 网卡启动 montage:lan。');
}

let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch {}
if (entry === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('首次配置失败，请检查本机目录权限和配置文件；现有配置不会被覆盖。'); process.exitCode = 1; });
}
