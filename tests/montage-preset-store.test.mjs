import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMontagePresetStore, MONTAGE_PRESET_FILE } from '../server/montage-preset-store.mjs';

test('prompt edits persist independently and stale tabs cannot overwrite a newer save', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'montage-preset-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'presets.json');
  await writeFile(file, await readFile(MONTAGE_PRESET_FILE));
  const store = createMontagePresetStore(file);
  const before = await store.read();
  const miniMax = before.presets.find(preset => preset.provider === 'minimax');
  const vidu = before.presets.find(preset => preset.provider === 'vidu');
  const prompt = '保持输入画面。\n镜头向左平移，然后稳定落位。';
  const saved = await store.save(miniMax.id, prompt, before.revision);
  assert.notEqual(saved.revision, before.revision);
  assert.equal((await createMontagePresetStore(file).resolve(miniMax.id)).prompt, prompt);
  assert.equal((await store.resolve(vidu.id)).prompt, vidu.prompt);
  await assert.rejects(store.save(miniMax.id, '过期窗口', before.revision), { status: 409 });
  await assert.rejects(store.save(miniMax.id, ' ', saved.revision), { status: 400 });
  await assert.rejects(store.save(miniMax.id, '😀'.repeat(7001), saved.revision), { status: 400 });
  assert.equal((await store.read()).revision, saved.revision);
  const concurrent = await Promise.allSettled([
    store.save(miniMax.id, '并发编辑 A', saved.revision),
    store.save(miniMax.id, '并发编辑 B', saved.revision),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.status, 409);
  assert.deepEqual(await readdir(directory), ['presets.json']);
});

test('prompt versions save independently, activate explicitly and survive a restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'montage-prompt-versions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'presets.json');
  await writeFile(file, await readFile(MONTAGE_PRESET_FILE));
  const store = createMontagePresetStore(file);
  const id = 'minimax-h3-highspeed';
  const before = await store.read();
  const original = before.presets.find(preset => preset.id === id);
  assert.equal(original.activeVersionId, 'rotation');
  assert.deepEqual(original.versions.map(version => version.id), ['rotation', 'cinematic']);
  assert.equal(original.prompt, original.versions[0].prompt);
  assert.match(original.versions[1].prompt, /^Picture 1 is the exact opening frame/);
  const snapshot = await store.resolve(id);
  const edited = 'Independent cinematic draft, fixed final frame.';
  const saved = await store.saveVersion(id, 'cinematic', edited, before.revision);
  assert.equal((await store.resolve(id)).prompt, original.prompt, 'Saving an inactive version cannot switch the live prompt');
  await assert.rejects(store.activateVersion(id, 'cinematic', before.revision), { status: 409 });
  const active = await store.activateVersion(id, 'cinematic', saved.revision);
  assert.equal(active.presets.find(preset => preset.id === id).activeVersionId, 'cinematic');
  assert.equal((await createMontagePresetStore(file).resolve(id)).prompt, edited);
  assert.equal(snapshot.prompt, original.prompt, 'Previously resolved job snapshot stays unchanged');
  const legacy = await store.save(id, 'Legacy edit of the active branch', active.revision);
  const miniMax = legacy.presets.find(preset => preset.id === id);
  assert.equal(miniMax.versions[1].prompt, miniMax.prompt);
  assert.equal(miniMax.versions[0].prompt, original.prompt);
  const rotated = await store.activateVersion(id, 'rotation', legacy.revision);
  assert.equal((await store.resolve(id)).prompt, original.prompt);
  await assert.rejects(store.saveVersion(id, 'missing', 'x', rotated.revision), { status: 404 });
  await assert.rejects(store.activateVersion(id, 'missing', rotated.revision), { status: 404 });
  const editedFile = JSON.parse(await readFile(file, 'utf8'));
  editedFile[id].promptVersions.cinematic.id = 'untrusted-alias';
  await writeFile(file, JSON.stringify(editedFile));
  assert.equal((await store.read()).presets.find(preset => preset.id === id).versions[1].id, 'cinematic');
  delete editedFile[id].promptVersions;
  editedFile[id].activeVersionId = 'cinematic';
  await writeFile(file, JSON.stringify(editedFile));
  await assert.rejects(store.read(), { status: 400 });
  assert.deepEqual(await readdir(directory), ['presets.json']);
});
