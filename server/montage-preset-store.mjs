import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import defaults from '../config/montage-presets.json' with { type: 'json' };

export const MONTAGE_PRESET_FILE = path.resolve(import.meta.dirname, '../config/montage-presets.json');
const LIMITS = { minimax: 7000, vidu: 5000 };

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validate(id, recipe) {
  const fixed = defaults[id];
  if (!fixed || !recipe || ['label', 'provider', 'model', 'resolution', 'durationSeconds']
    .some(key => recipe[key] !== fixed[key])) {
    throw problem(400, '模型参数与当前预设不匹配，请检查配置文件。');
  }
  if (typeof recipe.prompt !== 'string' || !recipe.prompt.trim() ||
      [...recipe.prompt].length > LIMITS[recipe.provider]) {
    throw problem(400, `提示词应包含 1–${LIMITS[fixed.provider]} 个字符。`);
  }
  if (recipe.promptVersions !== undefined) {
    const versions = recipe.promptVersions;
    if (!versions || typeof versions !== 'object' || Array.isArray(versions) ||
        !Object.hasOwn(versions, recipe.activeVersionId) ||
        Object.entries(versions).some(([versionId, version]) => !/^[a-z0-9-]+$/.test(versionId) ||
          !version || typeof version.label !== 'string' || !version.label.trim() ||
          typeof version.prompt !== 'string' || !version.prompt.trim() ||
          [...version.prompt].length > LIMITS[fixed.provider]) ||
        versions[recipe.activeVersionId].prompt !== recipe.prompt) {
      throw problem(400, '提示词版本配置无效，请检查当前生效版本。');
    }
  } else if (recipe.activeVersionId !== undefined && recipe.activeVersionId !== 'rotation') {
    throw problem(400, '提示词版本配置无效，请检查当前生效版本。');
  }
  return recipe;
}

function versionsFor(recipe) {
  return recipe.promptVersions ?? { rotation: { label: '旋转运镜', prompt: recipe.prompt } };
}

function activeVersionFor(recipe) { return recipe.activeVersionId ?? 'rotation'; }

/** The file is shared by the editor and new submissions. Each submitted job keeps its own snapshot. */
export function createMontagePresetStore(file = MONTAGE_PRESET_FILE) {
  let writing = Promise.resolve();

  async function snapshot() {
    let bytes, values;
    try {
      bytes = await readFile(file);
      values = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw problem(500, '无法读取提示词配置，请检查配置文件是否完整。');
    }
    for (const id of Object.keys(defaults)) validate(id, values[id]);
    return { values, revision: revision(bytes) };
  }

  function publicSnapshot(saved) {
    const ids = ['minimax-h3-highspeed', 'vidu-q2-pro-fast'];
    return {
      revision: saved.revision,
      presets: ids.map(id => {
        const { label, provider, model, resolution, durationSeconds, prompt } = saved.values[id];
        return { id, label, provider, model, resolution, durationSeconds, prompt,
          activeVersionId: activeVersionFor(saved.values[id]),
          versions: Object.entries(versionsFor(saved.values[id])).map(([versionId, version]) => ({ ...version, id: versionId })),
          maxCharacters: LIMITS[provider] };
      }),
    };
  }

  async function read() {
    return publicSnapshot(await snapshot());
  }

  async function resolve(id) {
    if (!Object.hasOwn(defaults, id)) throw problem(404, '未找到这个模型。');
    return structuredClone((await snapshot()).values[id]);
  }

  function update(id, expectedRevision, change) {
    const task = writing.then(async () => {
      if (!Object.hasOwn(defaults, id)) throw problem(404, '未找到这个模型。');
      const before = await snapshot();
      if (typeof expectedRevision !== 'string' || expectedRevision !== before.revision) {
        throw problem(409, '提示词已在其他窗口修改，请先载入最新版本。');
      }
      const recipe = structuredClone(before.values[id]);
      change(recipe);
      validate(id, recipe);
      const values = { ...before.values, [id]: recipe };
      const content = Buffer.from(JSON.stringify(values, null, 2) + '\n');
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.part`);
      let writer;
      try {
        writer = await open(temporary, 'wx', 0o600);
        await writer.writeFile(content);
        await writer.sync();
        await writer.close();
        writer = undefined;
        if ((await snapshot()).revision !== before.revision) {
          throw problem(409, '提示词刚刚发生变更，请先载入最新版本。');
        }
        await rename(temporary, file);
        const directory = await open(path.dirname(file), 'r');
        try { await directory.sync(); }
        catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
        finally { await directory.close(); }
      } finally {
        await writer?.close();
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return publicSnapshot({ values, revision: revision(content) });
    });
    writing = task.catch(() => {});
    return task;
  }

  function saveVersion(id, versionId, prompt, expectedRevision) {
    return update(id, expectedRevision, recipe => {
      const versions = versionsFor(recipe);
      if (!Object.hasOwn(versions, versionId)) throw problem(404, '未找到这个提示词版本。');
      versions[versionId].prompt = prompt;
      if (recipe.promptVersions) recipe.promptVersions = versions;
      if (activeVersionFor(recipe) === versionId) recipe.prompt = prompt;
    });
  }

  function activateVersion(id, versionId, expectedRevision) {
    return update(id, expectedRevision, recipe => {
      const versions = versionsFor(recipe);
      if (!Object.hasOwn(versions, versionId)) throw problem(404, '未找到这个提示词版本。');
      if (recipe.promptVersions) recipe.activeVersionId = versionId;
      recipe.prompt = versions[versionId].prompt;
    });
  }

  function save(id, prompt, expectedRevision) {
    return update(id, expectedRevision, recipe => {
      recipe.prompt = prompt;
      if (recipe.promptVersions) recipe.promptVersions[activeVersionFor(recipe)].prompt = prompt;
    });
  }

  return { read, resolve, save, saveVersion, activateVersion };
}
