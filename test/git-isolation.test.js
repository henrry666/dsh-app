import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitIsolation, parseWorktreeList, taskSlug } from '../src/git-isolation.js';

const execFile = promisify(execFileCallback);

test('normalizes task names and parses porcelain worktrees', () => {
  assert.equal(taskSlug('Fix Login Page'), 'fix-login-page');
  assert.equal(taskSlug('登录页面'), 'task');
  assert.deepEqual(parseWorktreeList('worktree /tmp/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/task\nHEAD def\nbranch refs/heads/dsh/task\n'), [
    { path: '/tmp/main', head: 'abc', branch: 'main', bare: false },
    { path: '/tmp/task', head: 'def', branch: 'dsh/task', bare: false },
  ]);
});

test('creates and safely removes a real isolated Git worktree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-isolation-'));
  const repository = join(root, 'repo');
  const home = join(root, 'home');
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile('git', ['init', repository]);
  await execFile('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
  await execFile('git', ['-C', repository, 'config', 'user.name', 'DSH Test']);
  await writeFile(join(repository, 'README.md'), '# test\n');
  await execFile('git', ['-C', repository, 'add', 'README.md']);
  await execFile('git', ['-C', repository, 'commit', '-m', 'initial']);
  const isolation = new GitIsolation(home);
  const created = await isolation.create(repository, 'Fix Login');
  assert.match(created.branch, /^dsh\/fix-login-/);
  assert.match(await readFile(join(created.path, 'DSH.md'), 'utf8'), /Git 隔离工作区/);
  assert.ok((await isolation.list(repository)).some(item => item.path === created.path));
  await isolation.remove(repository, created.path);
  assert.ok(!(await isolation.list(repository)).some(item => item.path === created.path));
});
