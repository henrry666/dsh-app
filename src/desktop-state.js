import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+D';
export const DEFAULT_SETTINGS = Object.freeze({ mode: 'chat', shortcut: DEFAULT_SHORTCUT });
export const MODES = Object.freeze({
  chat: '当前是对话模式。优先理解、解释和整理信息；只有完成用户请求确有需要时才调用工具。',
  work: '当前是工作模式。主动使用可用工具把任务执行到可验证的结果，完成必要检查，并清楚报告交付物。',
});

const SETTINGS_FILE = 'desktop-settings.json';
const CONTEXT_FILE = 'desktop-context.json';
const MAX_FILES = 8;
const MAX_BROWSER_TEXT = 12_000;

function safeJson(path, fallback) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function normalizeMode(mode) {
  return Object.hasOwn(MODES, mode) ? mode : DEFAULT_SETTINGS.mode;
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter(item => item && typeof item.path === 'string' && item.path.trim() !== '')
    .map(item => ({ path: item.path, addedAt: typeof item.addedAt === 'string' ? item.addedAt : new Date().toISOString() }))
    .slice(-MAX_FILES);
}

function normalizeBrowser(browser) {
  if (!browser || typeof browser.url !== 'string') return null;
  return {
    url: browser.url,
    title: typeof browser.title === 'string' ? browser.title.slice(0, 300) : '',
    text: typeof browser.text === 'string' ? browser.text.slice(0, MAX_BROWSER_TEXT) : '',
    capturedAt: typeof browser.capturedAt === 'string' ? browser.capturedAt : new Date().toISOString(),
  };
}

function normalizeWorktree(worktree) {
  if (!worktree || typeof worktree.path !== 'string') return null;
  return {
    path: worktree.path,
    branch: typeof worktree.branch === 'string' ? worktree.branch : '',
    repository: typeof worktree.repository === 'string' ? worktree.repository : '',
    createdAt: typeof worktree.createdAt === 'string' ? worktree.createdAt : new Date().toISOString(),
  };
}

export function readDesktopSettings(home) {
  const input = safeJson(join(home, SETTINGS_FILE), DEFAULT_SETTINGS);
  return {
    mode: normalizeMode(input.mode),
    shortcut: typeof input.shortcut === 'string' && input.shortcut.trim() ? input.shortcut : DEFAULT_SHORTCUT,
  };
}

export function writeDesktopSettings(home, patch) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const current = readDesktopSettings(home);
  const next = {
    mode: normalizeMode(patch.mode ?? current.mode),
    shortcut: typeof patch.shortcut === 'string' && patch.shortcut.trim() ? patch.shortcut : current.shortcut,
  };
  atomicJson(join(home, SETTINGS_FILE), next);
  updateDesktopContext(home, { mode: next.mode });
  return next;
}

export function readDesktopContext(home) {
  const input = safeJson(join(home, CONTEXT_FILE), {});
  return {
    mode: normalizeMode(input.mode),
    files: normalizeFiles(input.files),
    browser: normalizeBrowser(input.browser),
    worktree: normalizeWorktree(input.worktree),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  };
}

export function updateDesktopContext(home, patch) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const current = readDesktopContext(home);
  const next = {
    mode: normalizeMode(patch.mode ?? current.mode),
    files: normalizeFiles(patch.files ?? current.files),
    browser: patch.browser === undefined ? current.browser : normalizeBrowser(patch.browser),
    worktree: patch.worktree === undefined ? current.worktree : normalizeWorktree(patch.worktree),
    updatedAt: new Date().toISOString(),
  };
  atomicJson(join(home, CONTEXT_FILE), next);
  return next;
}

export function addContextFiles(home, paths) {
  const current = readDesktopContext(home);
  const addedAt = new Date().toISOString();
  const byPath = new Map(current.files.map(item => [item.path, item]));
  for (const path of paths) {
    if (typeof path !== 'string' || path.trim() === '') continue;
    byPath.delete(path);
    byPath.set(path, { path, addedAt });
  }
  return updateDesktopContext(home, { files: [...byPath.values()].slice(-MAX_FILES) });
}

export function prepareDesktopState(home) {
  if (!existsSync(join(home, SETTINGS_FILE))) writeDesktopSettings(home, DEFAULT_SETTINGS);
  if (!existsSync(join(home, CONTEXT_FILE))) updateDesktopContext(home, { mode: readDesktopSettings(home).mode });
  return { settings: readDesktopSettings(home), context: readDesktopContext(home) };
}

function fileSource(path) {
  if (!existsSync(path)) return { available: false, bytes: 0 };
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() ? { available: true, bytes: metadata.size } : { available: false, bytes: 0 };
  } catch { return { available: false, bytes: 0 }; }
}

function count(directory, predicate) {
  try { return readdirSync(directory, { withFileTypes: true }).filter(predicate).length; }
  catch { return 0; }
}

export function inspectContextSources(home) {
  const settings = readDesktopSettings(home);
  const context = readDesktopContext(home);
  return {
    mode: settings.mode,
    shortcut: settings.shortcut,
    instructions: fileSource(join(home, 'DSH.md')),
    memory: fileSource(join(home, 'memory.md')),
    topics: count(join(home, 'topics'), entry => entry.isFile() && entry.name.endsWith('.md')),
    skills: count(join(home, 'skills'), entry => entry.isDirectory()),
    knowledgeBases: count(join(home, 'knowledge-bases'), entry => entry.isDirectory()),
    files: context.files,
    browser: context.browser,
    worktree: context.worktree,
  };
}

export function modeInstruction(mode) {
  return MODES[normalizeMode(mode)];
}
