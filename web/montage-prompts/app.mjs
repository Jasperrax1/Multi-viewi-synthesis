const models = document.querySelector('#models');
const versionList = document.querySelector('#prompt-versions');
const activateButton = document.querySelector('#activate-version');
const editor = document.querySelector('#prompt');
const saveButton = document.querySelector('#save');
const undoButton = document.querySelector('#undo');
const refreshButton = document.querySelector('#refresh');
const saveState = document.querySelector('#save-state');
const notice = document.querySelector('#notice');
const counter = document.querySelector('#counter');
const card = document.querySelector('#editor-card');
const drafts = new Map();
const selectedVersions = new Map();
let presets = [];
let selectedId = 'minimax-h3-highspeed';
let revision;
let busy = false;
let refreshing = false;
let polling = false;
let operationEpoch = 0;

function selected() { return presets.find(preset => preset.id === selectedId); }
function version(preset = selected()) {
  return preset?.versions.find(item => item.id === selectedVersions.get(preset.id));
}
function draftKey(preset, item) { return `${preset.id}:${item.id}`; }
function isDirty(preset, item) { return drafts.get(draftKey(preset, item)) !== item.prompt; }
function hasDrafts() { return presets.some(preset => preset.versions.some(item => isDirty(preset, item))); }
function versionLabel(item) {
  return item?.id === 'rotation' ? '旋转运镜（默认）' : item?.id === 'cinematic' ? '电影穿梭（新效果）' : item?.label || '';
}
function notify(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle('error', error);
  notice.hidden = !text;
}
function updateService(status) {
  document.querySelector('#service-dot').classList.toggle('ready', Boolean(status?.origin));
  document.querySelector('#service-message').textContent = status?.message ||
    (status?.origin ? '手机成片服务已启动' : '等待手机与 Mac 加入同一热点或 Wi-Fi');
  document.querySelector('#service-origin').textContent = status?.origin || '';
}
function renderModels() {
  models.replaceChildren();
  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-button';
    button.disabled = Boolean(busy || refreshing);
    button.setAttribute('aria-pressed', String(selectedId === preset.id));
    button.dataset.preset = preset.id;
    const title = document.createElement('span');
    title.className = 'model-name';
    title.textContent = preset.label;
    if (preset.versions.some(item => isDirty(preset, item))) {
      const dot = document.createElement('span');
      dot.className = 'draft-dot';
      dot.setAttribute('aria-label', '有未保存修改');
      title.append(dot);
    }
    const details = document.createElement('span');
    details.className = 'model-details';
    details.textContent = `${preset.resolution} · ${preset.durationSeconds} 秒生成`;
    button.append(title, details);
    button.addEventListener('click', () => { selectedId = preset.id; notify(''); render(); });
    models.append(button);
  }
}
function renderVersions() {
  const preset = selected();
  versionList.replaceChildren();
  for (const item of preset?.versions || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'prompt-version-button';
    button.dataset.version = item.id;
    button.disabled = Boolean(busy || refreshing);
    button.setAttribute('aria-pressed', String(version()?.id === item.id));
    const label = document.createElement('span');
    label.textContent = versionLabel(item);
    if (isDirty(preset, item)) {
      const dot = document.createElement('span');
      dot.className = 'draft-dot';
      dot.setAttribute('aria-label', '有未保存修改');
      label.append(dot);
    }
    button.append(label);
    if (preset.activeVersionId === item.id) {
      const badge = document.createElement('span');
      badge.className = 'prompt-version-badge';
      badge.textContent = '使用中';
      button.append(badge);
    }
    button.addEventListener('click', () => {
      selectedVersions.set(preset.id, item.id);
      notify('');
      render();
    });
    versionList.append(button);
  }
}
function renderControls() {
  const preset = selected(), item = version();
  const text = item ? drafts.get(draftKey(preset, item)) || '' : '';
  const count = [...text].length;
  const valid = preset && item && text.trim() && count <= preset.maxCharacters;
  const dirty = Boolean(item && isDirty(preset, item));
  const active = item && preset.activeVersionId === item.id;
  const working = Boolean(busy || refreshing);
  saveButton.disabled = working || !dirty || !valid;
  undoButton.disabled = working || !dirty;
  refreshButton.disabled = working;
  activateButton.disabled = working || !item || Boolean(active) || dirty;
  activateButton.textContent = active ? '正在使用' : '使用此版本';
  document.querySelector('#save-label').textContent = active ? '保存并生效' : '保存此版本';
  const activeItem = preset?.versions.find(entry => entry.id === preset.activeVersionId);
  document.querySelector('#active-version').textContent = activeItem ? `当前生效：${versionLabel(activeItem)}` : '尚未载入生效版本';
  document.querySelector('#version-help').textContent = dirty && !active ? '先保存或撤销当前修改，再使用此版本。' :
    preset?.versions.length > 1 ? '两版独立保存；选择编辑后，点击「使用此版本」切换下一笔新生成。' :
      'Vidu 保留现有旋转运镜；电影穿梭版本使用 MiniMax。';
  editor.disabled = working || !item;
  card.setAttribute('aria-busy', String(working));
  counter.textContent = preset ? `${count.toLocaleString()} / ${preset.maxCharacters.toLocaleString()} 字` : '—';
  counter.classList.toggle('invalid', Boolean(preset && count > preset.maxCharacters));
  editor.setAttribute('aria-invalid', String(Boolean(preset && (!text.trim() || count > preset.maxCharacters))));
  saveState.textContent = busy === 'activate' ? '正在切换…' : busy ? '正在保存…' : refreshing ? '正在读取…' : dirty ? '有未保存修改' : item ? '已保存' : '尚未载入';
  saveState.classList.toggle('dirty', dirty && !working);
  document.querySelector('#revision').textContent = revision ? revision.slice(0, 12) : '—';
}
function render() {
  const preset = selected(), item = version();
  document.querySelector('#editor-heading').textContent = preset?.label || '无法载入预设';
  document.querySelector('#recipe').textContent = preset ? `${preset.model} · ${preset.resolution} · ${preset.durationSeconds} 秒生成` : '';
  editor.value = item ? drafts.get(draftKey(preset, item)) || '' : '';
  editor.placeholder = preset ? '输入视频生成提示词' : '点击刷新，重新读取 Mac 上的预设。';
  renderModels(); renderVersions(); renderControls();
}
function applySnapshot(snapshot, savedKey) {
  const previouslyDirty = new Set(presets.flatMap(preset => preset.versions
    .filter(item => isDirty(preset, item)).map(item => draftKey(preset, item))));
  presets = snapshot.presets.map(preset => ({...preset,
    versions: preset.versions || [{id:'rotation', label:'旋转运镜', prompt:preset.prompt}],
    activeVersionId: preset.activeVersionId || 'rotation'}));
  revision = snapshot.revision;
  for (const preset of presets) {
    for (const item of preset.versions) {
      const key = draftKey(preset, item);
      if (key === savedKey || !previouslyDirty.has(key)) drafts.set(key, item.prompt);
    }
    if (!preset.versions.some(item => item.id === selectedVersions.get(preset.id))) {
      selectedVersions.set(preset.id, preset.activeVersionId);
    }
  }
  if (!selected()) selectedId = presets[0]?.id;
  updateService(snapshot.status);
}
async function getSnapshot() {
  const response = await fetch('/api/presets', {cache:'no-store'});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '读取提示词失败');
  return data;
}
async function refresh() {
  if (busy || refreshing) return;
  const epoch = ++operationEpoch;
  refreshing = true;
  renderModels(); renderVersions(); renderControls();
  try {
    const snapshot = await getSnapshot();
    if (epoch !== operationEpoch) return;
    const dirty = hasDrafts(), changed = revision && revision !== snapshot.revision;
    applySnapshot(snapshot);
    notify(changed && dirty ? 'Mac 上的已保存版本有更新。你的编辑已保留，请核对后保存或撤销修改。' : '已读取 Mac 上的最新版本。');
  } catch (error) {
    notify(error.message || '无法连接本地编辑服务，请检查 Mac 启动器。', true);
  } finally { refreshing = false; render(); }
}
async function write(path, value, action, savedKey) {
  ++operationEpoch;
  busy = action;
  notify('');
  renderModels(); renderVersions(); renderControls();
  try {
    const response = await fetch(path, {method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...value, revision})});
    const data = await response.json();
    if (response.status === 409) {
      applySnapshot(await getSnapshot());
      notify('Mac 上的已保存版本已更新。你的编辑已保留，请核对后再次操作。', true);
    } else if (!response.ok) throw new Error(data.error || '操作失败，请重试');
    else {
      applySnapshot(data, savedKey);
      const preset = selected(), item = version();
      notify(action === 'activate' ? `已切换为${versionLabel(item)}，下一笔新生成立即使用。` :
        preset.activeVersionId === item.id ? '已保存，下一笔新生成将使用这版提示词。' : '此版本已保存。点击「使用此版本」即可切换。');
    }
  } catch (error) { notify(error.message || '操作未完成，请检查本地服务后重试。', true); }
  finally { busy = false; render(); }
}
async function save() {
  if (saveButton.disabled) return;
  const preset = selected(), item = version();
  return write(`/api/presets/${encodeURIComponent(preset.id)}/versions/${encodeURIComponent(item.id)}`,
    {prompt:drafts.get(draftKey(preset,item))}, 'save', draftKey(preset,item));
}
async function activate() {
  if (activateButton.disabled) return;
  const preset = selected(), item = version();
  return write(`/api/presets/${encodeURIComponent(preset.id)}/active-version`, {versionId:item.id}, 'activate');
}
editor.addEventListener('input', () => {
  const preset = selected(), item = version();
  if (!item) return;
  drafts.set(draftKey(preset,item), editor.value);
  notify('');
  renderControls(); renderModels(); renderVersions();
});
saveButton.addEventListener('click', save);
activateButton.addEventListener('click', activate);
refreshButton.addEventListener('click', refresh);
undoButton.addEventListener('click', () => {
  const preset = selected(), item = version();
  if (!item) return;
  drafts.set(draftKey(preset,item),item.prompt);
  notify(''); render();
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
});
window.addEventListener('beforeunload', event => {
  if (!hasDrafts()) return;
  event.preventDefault(); event.returnValue = '';
});
async function poll() {
  if (busy || refreshing || polling || document.hidden) return;
  polling = true;
  const epoch = operationEpoch, observedRevision = revision;
  try {
    const snapshot = await getSnapshot();
    if (epoch !== operationEpoch) return;
    updateService(snapshot.status);
    if (!busy && !refreshing && revision === observedRevision && revision !== snapshot.revision) {
      const dirty = hasDrafts();
      applySnapshot(snapshot);
      if (dirty) notify('当前生效版本或已保存内容已更新，你的未保存编辑已保留。');
      render();
    }
  } catch {
    if (epoch !== operationEpoch) return;
    document.querySelector('#service-dot').classList.remove('ready');
    document.querySelector('#service-message').textContent = '本地编辑服务连接中断，请检查 Mac 启动器。';
    document.querySelector('#service-origin').textContent = '';
  } finally { polling = false; }
}
await refresh();
setInterval(poll, 8000);
