import { app, BrowserWindow, Menu, WebContentsView, dialog, globalShortcut, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend, isInternalUrl } from './backend.js';
import { addContextFiles, inspectContextSources, prepareDesktopState, readDesktopSettings, updateDesktopContext, writeDesktopSettings } from './desktop-state.js';
import { GitIsolation } from './git-isolation.js';
import { prepareDshHome } from './user-home.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const shellPage = fileURLToPath(new URL('./shell.html', import.meta.url));
const HEADER_HEIGHT = 64;
const DRAWER_WIDTH = 360;
let win, harnessView, browserView, backend, origin, userData, home, workspace, git;
let quitting = false, booting = false, activePanel = null;
const state = { phase: 'starting', message: '正在准备本地工作环境…', mode: 'chat' };
const browserState = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };

function send(channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function update(phase, message) {
  Object.assign(state, { phase, message, mode: home ? readDesktopSettings(home).mode : state.mode });
  send('desktop:state', state);
  layoutViews();
  return state;
}

function sendBrowser() {
  if (browserView && !browserView.webContents.isDestroyed()) {
    Object.assign(browserState, {
      open: true,
      url: browserView.webContents.getURL(),
      title: browserView.webContents.getTitle(),
      loading: browserView.webContents.isLoading(),
      canGoBack: browserView.webContents.navigationHistory.canGoBack(),
      canGoForward: browserView.webContents.navigationHistory.canGoForward(),
    });
  } else Object.assign(browserState, { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
  send('desktop:browser', browserState);
  return browserState;
}

function layoutViews() {
  if (!win || win.isDestroyed() || !harnessView) return;
  const [width, height] = win.getContentSize();
  const drawer = activePanel ? Math.min(DRAWER_WIDTH, Math.max(0, width - 620)) : 0;
  const contentWidth = Math.max(0, width - drawer);
  const contentHeight = Math.max(0, height - HEADER_HEIGHT);
  const ready = state.phase === 'ready';
  harnessView.setVisible(ready);
  browserView?.setVisible(ready);
  if (!ready) return;
  if (browserView) {
    const harnessWidth = Math.max(480, Math.floor(contentWidth * 0.55));
    const browserWidth = Math.max(0, contentWidth - harnessWidth - 1);
    harnessView.setBounds({ x: 0, y: HEADER_HEIGHT, width: harnessWidth, height: contentHeight });
    browserView.setBounds({ x: harnessWidth + 1, y: HEADER_HEIGHT, width: browserWidth, height: contentHeight });
    browserView.setVisible(browserWidth > 0);
  } else harnessView.setBounds({ x: 0, y: HEADER_HEIGHT, width: contentWidth, height: contentHeight });
}

function showAndFocus() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  harnessView?.webContents.send('desktop:focus-composer');
}

function browserUrl(value) {
  const input = String(value ?? '').trim();
  if (!input) return 'https://www.bing.com/';
  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('内置浏览器只允许 HTTP(S) 页面。');
    return parsed.href;
  } catch (error) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(input)) throw error;
    if (/^[^\s]+\.[^\s]+$/.test(input)) return new URL(`https://${input}`).href;
    return `https://www.bing.com/search?q=${encodeURIComponent(input)}`;
  }
}

function configureRemoteView(view, kind) {
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (kind === 'harness') void openBrowser(url);
    else {
      try { void view.webContents.loadURL(browserUrl(url)); } catch { void shell.openExternal(url); }
    }
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (kind === 'harness') {
      if (!isInternalUrl(url, origin)) { event.preventDefault(); void openBrowser(url); }
      return;
    }
    try { browserUrl(url); } catch { event.preventDefault(); }
  });
}

function createHarnessView() {
  harnessView = new WebContentsView({ webPreferences: {
    preload: join(root, 'src/harness-preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    partition: 'persist:dsh-harness',
  } });
  win.contentView.addChildView(harnessView);
  harnessView.setBackgroundColor('#f8f9fb');
  harnessView.setVisible(false);
  configureRemoteView(harnessView, 'harness');
  harnessView.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  harnessView.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
  harnessView.webContents.on('render-process-gone', () => { if (!quitting) void failure(new Error('界面进程已退出，请重新连接。')); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 960, minHeight: 640,
    title: 'DSH Desktop', backgroundColor: '#f4f6f9', show: false,
    webPreferences: { preload: join(root, 'src/shell-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void win.loadFile(shellPage);
  createHarnessView();
  win.once('ready-to-show', () => win.show());
  win.on('resize', layoutViews);
  win.on('closed', () => {
    if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close();
    if (harnessView && !harnessView.webContents.isDestroyed()) harnessView.webContents.close();
    browserView = null;
    harnessView = null;
    win = null;
  });
}

async function failure(error) {
  origin = null;
  update('error', error.message);
}

async function boot() {
  if (booting || quitting) return;
  booting = true;
  try {
    origin = null;
    update('starting', '正在启动 DeepSeek Harness…');
    harnessView?.setVisible(false);
    await backend.stop();
    const url = await backend.start();
    if (quitting) return;
    origin = url;
    await harnessView.webContents.loadURL(url);
    update('ready', '本地服务已连接');
  } catch (error) {
    await backend.stop();
    if (!quitting) await failure(error);
  } finally { booting = false; }
}

async function ensureBrowser() {
  if (browserView) return browserView;
  browserView = new WebContentsView({ webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    partition: 'persist:dsh-browser',
  } });
  win.contentView.addChildView(browserView);
  browserView.setBackgroundColor('#ffffff');
  configureRemoteView(browserView, 'browser');
  browserView.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) {
    browserView.webContents.on(event, () => sendBrowser());
  }
  browserView.webContents.on('render-process-gone', () => closeBrowser());
  layoutViews();
  return browserView;
}

async function openBrowser(value) {
  let url;
  try { url = browserUrl(value); }
  catch (error) { await dialog.showMessageBox(win, { type: 'warning', message: error.message }); return null; }
  const view = await ensureBrowser();
  if (view.webContents.getURL() !== url) await view.webContents.loadURL(url);
  sendBrowser();
  layoutViews();
  return browserState;
}

function closeBrowser() {
  if (browserView) {
    win?.contentView.removeChildView(browserView);
    if (!browserView.webContents.isDestroyed()) browserView.webContents.close();
    browserView = null;
  }
  sendBrowser();
  layoutViews();
}

function insertText(value) {
  showAndFocus();
  harnessView?.webContents.send('desktop:insert-text', value);
}

async function insertFiles(paths) {
  const valid = paths.filter(path => typeof path === 'string' && existsSync(path)).slice(0, 20);
  if (!valid.length) return [];
  addContextFiles(home, valid);
  insertText(`请读取并结合以下本地文件完成我的问题：\n${valid.map(path => `- ${path}`).join('\n')}`);
  return valid;
}

async function chooseFiles() {
  const result = await dialog.showOpenDialog(win, { title: '选择要加入当前会话的文件', properties: ['openFile', 'multiSelections'] });
  if (!result.canceled && result.filePaths.length) await insertFiles(result.filePaths);
  return result.filePaths;
}

async function captureBrowser() {
  if (!browserView) return null;
  const captured = await browserView.webContents.executeJavaScript(`(() => {
    const selection = window.getSelection()?.toString().trim() || '';
    const body = document.body?.innerText || '';
    return { title: document.title, url: location.href, text: (selection || body).slice(0, 12000) };
  })()`);
  const browser = { ...captured, capturedAt: new Date().toISOString() };
  updateDesktopContext(home, { browser });
  insertText(`请结合我在内置浏览器中加入的网页内容回答。来源：${browser.title || browser.url}（${browser.url}）`);
  return browser;
}

function validateShellSender(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unsupported sender');
}

function registerIpc() {
  ipcMain.handle('desktop:invoke', async (event, action, payload = {}) => {
    validateShellSender(event);
    if (action === 'state') return { ...state, mode: readDesktopSettings(home).mode };
    if (action === 'retry') { void boot(); return state; }
    if (action === 'logs') { const path = join(userData, 'logs'); mkdirSync(path, { recursive: true }); await shell.openPath(path); return true; }
    if (action === 'mode:set') {
      const settings = writeDesktopSettings(home, { mode: payload.mode });
      state.mode = settings.mode;
      send('desktop:state', state);
      return { ...state };
    }
    if (action === 'panel:set') { activePanel = ['context', 'git'].includes(payload.panel) ? payload.panel : null; layoutViews(); return activePanel; }
    if (action === 'context:get') return inspectContextSources(home);
    if (action === 'files:choose') return chooseFiles();
    if (action === 'files:insert') return insertFiles(Array.isArray(payload.paths) ? payload.paths : []);
    if (action === 'browser:state') return sendBrowser();
    if (action === 'browser:toggle') { if (browserView) closeBrowser(); else await openBrowser(''); return sendBrowser(); }
    if (action === 'browser:navigate') return openBrowser(payload.value);
    if (action === 'browser:back') { if (browserView?.webContents.navigationHistory.canGoBack()) browserView.webContents.navigationHistory.goBack(); return sendBrowser(); }
    if (action === 'browser:forward') { if (browserView?.webContents.navigationHistory.canGoForward()) browserView.webContents.navigationHistory.goForward(); return sendBrowser(); }
    if (action === 'browser:reload') { browserView?.webContents.reload(); return sendBrowser(); }
    if (action === 'browser:capture') return captureBrowser();
    if (action === 'git:choose') {
      const result = await dialog.showOpenDialog(win, { title: '选择 Git 仓库', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      return git.repositoryRoot(result.filePaths[0]);
    }
    if (action === 'git:create') {
      if (!payload.repository) throw new Error('请先选择 Git 仓库。');
      if (!String(payload.task ?? '').trim()) throw new Error('请填写任务名称。');
      const created = await git.create(payload.repository, payload.task);
      updateDesktopContext(home, { worktree: created });
      writeDesktopSettings(home, { mode: 'work' });
      state.mode = 'work';
      send('desktop:state', state);
      insertText(`请在下面的 Git 隔离工作区中完成任务。工作目录：${created.path}\n分支：${created.branch}`);
      return created;
    }
    if (action === 'git:open') { if (payload.path) await shell.openPath(payload.path); return true; }
    if (action === 'git:remove') {
      if (!payload.repository || !payload.path) throw new Error('缺少隔离工作区信息。');
      const confirmation = await dialog.showMessageBox(win, {
        type: 'warning',
        message: '确定清理这个 Git 隔离工作区吗？',
        detail: '存在未提交修改时客户端会拒绝清理。分支会保留在原仓库中。',
        buttons: ['取消', '清理'], defaultId: 0, cancelId: 0,
      });
      if (confirmation.response !== 1) return null;
      const result = await git.remove(payload.repository, payload.path);
      updateDesktopContext(home, { worktree: null });
      return result;
    }
    throw new Error('Unsupported action');
  });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '文件', submenu: [
      { label: '快捷呼出 DSH Desktop', accelerator: readDesktopSettings(home).shortcut, click: showAndFocus },
      { label: '加入文件…', click: () => void chooseFiles() },
      { label: '打开内置浏览器', click: () => void openBrowser('') },
      { label: '打开默认工作目录', click: () => shell.openPath(workspace) },
      { type: 'separator' }, { role: 'quit', label: '退出' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '刷新桌面壳' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { label: '服务', submenu: [
      { label: '重启本地服务…', click: async () => { const result = await dialog.showMessageBox(win, { type: 'question', message: '重启会中断正在执行的任务。是否继续？', buttons: ['取消', '重启'], defaultId: 0, cancelId: 0 }); if (result.response === 1) void boot(); } },
      { label: '查看服务日志', click: () => shell.openPath(join(userData, 'logs')) },
      { label: '打开 DSH 数据目录', click: () => shell.openPath(home) },
      { label: '编辑全局指令', click: () => shell.openPath(join(home, 'DSH.md')) },
      { label: '编辑长期记忆', click: () => shell.openPath(join(home, 'memory.md')) },
    ] },
    { label: '帮助', submenu: [{ label: '关于 DSH Desktop', click: () => dialog.showMessageBox(win, { message: `DSH Desktop ${app.getVersion()}`, detail: '统一的本地智能工作台，内置 DeepSeek Harness。' }) }] },
  ]);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showAndFocus);
  app.whenReady().then(async () => {
    const runtime = join(app.isPackaged ? process.resourcesPath : root, 'runtime');
    userData = app.getPath('userData');
    ({ home } = prepareDshHome(app.getPath('home'), join(userData, 'harness-data')));
    const prepared = prepareDesktopState(home);
    state.mode = prepared.settings.mode;
    git = new GitIsolation(home);
    workspace = join(home, 'workspaces');
    mkdirSync(workspace, { recursive: true });
    const log = join(userData, 'logs', 'harness.log');
    if (existsSync(log) && statSync(log).size > 5 * 1024 * 1024) renameSync(log, `${log}.previous`);
    backend = new Backend({ node: join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(runtime, 'harness/lib/bin.js'), cwd: workspace, home, log });
    backend.on('crash', error => { if (!booting && !quitting) void failure(error); });
    backend.on('log-error', error => console.error('Log write failed:', error.message));
    createWindow();
    registerIpc();
    Menu.setApplicationMenu(buildMenu());
    try {
      if (!globalShortcut.register(prepared.settings.shortcut, showAndFocus)) console.warn(`Cannot register shortcut: ${prepared.settings.shortcut}`);
    } catch (error) { console.warn(`Cannot register shortcut: ${error.message}`); }
    await boot();
  }).catch(error => { dialog.showErrorBox('DSH Desktop 启动失败', error.message); app.quit(); });
  app.on('activate', () => {
    if (!win && backend && !quitting) { createWindow(); if (origin) void harnessView.webContents.loadURL(origin).then(() => update('ready', '本地服务已连接')); else void boot(); }
    else showAndFocus();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void (backend?.stop() ?? Promise.resolve()).finally(() => app.quit());
  });
}
