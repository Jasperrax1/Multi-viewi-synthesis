import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { setupMac, checkMac } from '../scripts/setup-mac.mjs';

async function folder(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mac-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const runtime = { platform: 'darwin', nodeVersion: '24.18.0', run: () => ({ status: 0 }),
  interfaces: { en0: [{ family: 'IPv4', internal: false, address: '192.168.42.8' }] } };
async function configured(root) {
  await setupMac(root);
  await writeFile(path.join(root, '.env.minimax'), 'MINIMAX_API_KEY=TEST_ONLY_NO_PROVIDER_ACCOUNT_123456\nMINIMAX_API_REGION=cn\n');
}

test('fresh Mac setup generates private local templates without a cloud task or runtime identity', async t => {
  const root = await folder(t), result = await setupMac(root);
  assert.deepEqual(result.created, ['.env.vidu', '.env.minimax']);
  const vidu = parseEnv(await readFile(path.join(root, '.env.vidu'), 'utf8'));
  assert.match(vidu.VIDU_CLIENT_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(vidu.VIDU_API_KEY, '');
  assert.equal(vidu.VIDU_MAX_PAID_JOBS, '0');
  assert.equal(parseEnv(await readFile(path.join(root, '.env.minimax'), 'utf8')).MINIMAX_API_KEY, '');
  for (const file of result.created) assert.equal((await stat(path.join(root, file))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['.env.minimax', '.env.vidu']);
  assert(!JSON.stringify(result).includes(vidu.VIDU_CLIENT_TOKEN));
});

test('repeating setup preserves existing credentials and connection identity byte for byte', async t => {
  const root = await folder(t);
  await configured(root);
  const before = await Promise.all(['.env.vidu', '.env.minimax'].map(name => readFile(path.join(root, name))));
  const result = await setupMac(root);
  assert.deepEqual(result.created, []);
  assert.equal(result.preserved.length, 2);
  const after = await Promise.all(['.env.vidu', '.env.minimax'].map(name => readFile(path.join(root, name))));
  assert.deepEqual(after, before);
});

test('read-only check reports missing configuration without creating files', async t => {
  const root = await folder(t), report = await checkMac({ ...runtime, root });
  assert.equal(report.exitCode, 1);
  assert(report.errors.some(error => error.includes('setup:mac')));
  assert.deepEqual(await readdir(root), []);
});

test('checks distinguish ready from waiting for LAN and never return credential values', async t => {
  const root = await folder(t);
  await configured(root);
  const token = parseEnv(await readFile(path.join(root, '.env.vidu'), 'utf8')).VIDU_CLIENT_TOKEN;
  const ready = await checkMac({ ...runtime, root });
  assert.equal(ready.exitCode, 0);
  assert.equal(ready.configured.miniMax, true);
  assert.equal(ready.configured.vidu, false);
  const serialized = JSON.stringify(ready);
  assert(!serialized.includes(token));
  assert(!serialized.includes('TEST_ONLY_NO_PROVIDER_ACCOUNT_123456'));
  const offline = await checkMac({ ...runtime, root, interfaces: {
    en0: [{ family: 'IPv4', internal: false, address: '7.1.2.3' }],
    utun4: [{ family: 'IPv4', internal: false, address: '10.8.0.2' }],
  } });
  assert.equal(offline.exitCode, 2);
  assert.deepEqual(offline.errors, []);
  assert.deepEqual(offline.networks, []);
  assert.equal((await checkMac({ ...runtime, root, nodeVersion: '22.8.0' })).exitCode, 1);
  const shared = await checkMac({ ...runtime, root, interfaces: {
    en0: [{ family: 'IPv4', internal: false, address: '100.125.5.57' }],
  } });
  assert.equal(shared.exitCode, 0);
  assert.equal(shared.networks.length, 1);
  assert.deepEqual((await readdir(root)).sort(), ['.env.minimax', '.env.vidu']);
});

test('installed macOS Bonjour executable is detected using the real system tools',
  { skip: process.platform !== 'darwin' }, async t => {
    const root = await folder(t);
    await configured(root);
    const report = await checkMac({ root, interfaces: runtime.interfaces });
    assert(!report.errors.some(error => error.includes('dns-sd')), JSON.stringify(report.errors));
  });

test('setup CLI reports paths and status while keeping the generated token out of output', async t => {
  const root = await folder(t);
  await mkdir(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts/setup-mac.mjs');
  await copyFile(new URL('../scripts/setup-mac.mjs', import.meta.url), script);
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const token = parseEnv(await readFile(path.join(root, '.env.vidu'), 'utf8')).VIDU_CLIENT_TOKEN;
  assert(!`${child.stdout}${child.stderr}`.includes(token));
  assert.match(child.stdout, /check:mac/);
});
