const api = window.desktop;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let activePanel = null;
let repository = '';
let createdWorktree = null;
let dragDepth = 0;

function call(action, payload) {
  return api.invoke(action, payload);
}

function setPanel(name) {
  activePanel = activePanel === name ? null : name;
  $('#context-drawer').classList.toggle('hidden', activePanel !== 'context');
  $('#git-drawer').classList.toggle('hidden', activePanel !== 'git');
  void call('panel:set', { panel: activePanel });
  if (activePanel === 'context') void refreshContext();
}

function source(title, value, detail = '') {
  return `<div class="source"><div class="source-title"><span>${title}</span><span class="dot">${value}</span></div>${detail ? `<div class="source-detail">${detail}</div>` : ''}</div>`;
}

function bytes(value) {
  if (!value) return '0 B';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

async function refreshContext() {
  const data = await call('context:get');
  const items = [
    source('工作模式', data.mode === 'work' ? '工作' : '对话', `快捷呼出：${escapeHtml(data.shortcut)}`),
    source('DSH.md', data.instructions.available ? '已启用' : '缺失', bytes(data.instructions.bytes)),
    source('长期记忆', data.memory.available ? '已启用' : '缺失', `${bytes(data.memory.bytes)} · ${data.topics} 个话题文件`),
    source('按需技能', `${data.skills} 个`),
    source('知识库', `${data.knowledgeBases} 个`),
    source('子智能体', '标准模式可用', '支持独立创建、上下文分叉和后台运行'),
  ];
  if (data.browser) items.push(source('引用网页', escapeHtml(data.browser.title || '未命名网页'), escapeHtml(data.browser.url)));
  if (data.files.length) items.push(source('最近文件', `${data.files.length} 个`, data.files.map(item => escapeHtml(item.path)).join('<br>')));
  if (data.worktree) items.push(source('Git 隔离工作区', escapeHtml(data.worktree.branch), escapeHtml(data.worktree.path)));
  $('#context-list').innerHTML = items.join('');
}

function renderState(state) {
  $$('.mode').forEach(button => button.classList.toggle('active', button.dataset.mode === state.mode));
  const ready = state.phase === 'ready';
  $('#status').classList.toggle('hidden', ready);
  if (!ready) {
    $('#status-title').textContent = state.phase === 'error' ? '本地服务连接失败' : '正在启动 DSH Desktop';
    $('#status-message').textContent = state.message;
    $('#spinner').classList.toggle('hidden', state.phase === 'error');
    $('#status-actions').classList.toggle('hidden', state.phase !== 'error');
  }
}

function renderBrowser(state) {
  $('#browser-controls').classList.toggle('hidden', !state.open);
  $('#browser-button').textContent = state.open ? '关闭浏览器' : '浏览器';
  if (state.url && document.activeElement !== $('#browser-address')) $('#browser-address').value = state.url;
  $('#browser-back').disabled = !state.canGoBack;
  $('#browser-forward').disabled = !state.canGoForward;
}

async function insertFiles(files) {
  const paths = api.filePaths(files);
  if (paths.length) await call('files:insert', { paths });
}

$$('.mode').forEach(button => button.addEventListener('click', async () => renderState(await call('mode:set', { mode: button.dataset.mode }))));
$('#files-button').addEventListener('click', () => call('files:choose'));
$('#browser-button').addEventListener('click', () => call('browser:toggle'));
$('#context-button').addEventListener('click', () => setPanel('context'));
$('#git-button').addEventListener('click', () => setPanel('git'));
$$('[data-close]').forEach(button => button.addEventListener('click', () => setPanel(activePanel)));
$('#context-refresh').addEventListener('click', refreshContext);
$('#retry-button').addEventListener('click', () => call('retry'));
$('#logs-button').addEventListener('click', () => call('logs'));
$('#browser-back').addEventListener('click', () => call('browser:back'));
$('#browser-forward').addEventListener('click', () => call('browser:forward'));
$('#browser-reload').addEventListener('click', () => call('browser:reload'));
$('#browser-capture').addEventListener('click', async () => {
  const result = await call('browser:capture');
  $('#browser-capture').textContent = result ? '已加入' : '无法读取';
  setTimeout(() => { $('#browser-capture').textContent = '加入上下文'; }, 1600);
});
$('#browser-form').addEventListener('submit', event => {
  event.preventDefault();
  void call('browser:navigate', { value: $('#browser-address').value });
});
$('#git-choose').addEventListener('click', async () => {
  const result = await call('git:choose');
  if (result) { repository = result; $('#git-repository').value = result; }
});
$('#git-create').addEventListener('click', async () => {
  const resultBox = $('#git-result');
  try {
    resultBox.classList.remove('hidden');
    resultBox.textContent = '正在创建隔离工作区…';
    const result = await call('git:create', { repository, task: $('#git-task').value });
    createdWorktree = result;
    resultBox.innerHTML = `<strong>创建成功</strong><br>${escapeHtml(result.branch)}<br>${escapeHtml(result.path)}`;
    $('#git-result-actions').classList.remove('hidden');
  } catch (error) {
    resultBox.classList.remove('hidden');
    resultBox.textContent = error.message;
  }
});
$('#git-open').addEventListener('click', () => { if (createdWorktree) void call('git:open', { path: createdWorktree.path }); });
$('#git-remove').addEventListener('click', async () => {
  if (!createdWorktree) return;
  try {
    const result = await call('git:remove', createdWorktree);
    if (!result) return;
    $('#git-result').textContent = '隔离工作区已安全清理。';
    $('#git-result-actions').classList.add('hidden');
    createdWorktree = null;
  } catch (error) { $('#git-result').textContent = error.message; }
});

document.addEventListener('dragenter', event => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  $('#drop-overlay').classList.remove('hidden');
});
document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', event => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').classList.add('hidden');
});
document.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.add('hidden');
  void insertFiles(event.dataTransfer.files);
});

api.onState(renderState);
api.onBrowser(renderBrowser);
void call('state').then(renderState);
void call('browser:state').then(renderBrowser);
void call('panel:set', { panel: null });
