import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const WORKTREE_DSH_TEMPLATE = `# DSH 工作区说明

## 项目定位

- 本目录是由 DSH Desktop 创建的 Git 隔离工作区。
- 当前分支用于一项独立任务，完成后通过 Git 审核和合并。

## 工作流程

- 开始前阅读仓库已有说明和相关源文件。
- 只修改当前任务需要的内容。
- 完成后运行与改动相关的检查，并报告结果。
- 保留清晰的提交记录，避免把构建产物和密钥加入版本库。
`;

async function runGit(args, cwd) {
  try {
    const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const message = typeof error.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : error.message;
    throw new Error(`Git 操作失败：${message}`);
  }
}

export function taskSlug(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'task';
}

export function parseWorktreeList(output) {
  return output.split(/\n\n+/).flatMap(block => {
    const fields = Object.fromEntries(block.split('\n').filter(Boolean).map(line => {
      const index = line.indexOf(' ');
      return index < 0 ? [line, true] : [line.slice(0, index), line.slice(index + 1)];
    }));
    return typeof fields.worktree === 'string' ? [{
      path: fields.worktree,
      branch: typeof fields.branch === 'string' ? fields.branch.replace(/^refs\/heads\//, '') : '',
      head: typeof fields.HEAD === 'string' ? fields.HEAD : '',
      bare: fields.bare === true,
    }] : [];
  });
}

export class GitIsolation {
  constructor(home) {
    this.home = home;
    this.root = join(home, 'worktrees');
  }

  async repositoryRoot(directory) {
    return runGit(['-C', directory, 'rev-parse', '--show-toplevel'], directory);
  }

  async create(directory, taskName) {
    const repository = await this.repositoryRoot(directory);
    const slug = taskSlug(taskName);
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const token = Math.random().toString(36).slice(2, 6);
    const name = `${slug}-${stamp}-${token}`;
    const branch = `dsh/${name}`;
    const parent = join(this.root, taskSlug(basename(repository)));
    const path = join(parent, name);
    await mkdir(parent, { recursive: true });
    await runGit(['-C', repository, 'worktree', 'add', '-b', branch, path, 'HEAD'], repository);
    const canonicalPath = await realpath(path);
    const instructions = join(canonicalPath, 'DSH.md');
    if (!existsSync(instructions)) await writeFile(instructions, WORKTREE_DSH_TEMPLATE, 'utf8');
    return { path: canonicalPath, branch, repository: await realpath(repository), createdAt: new Date().toISOString() };
  }

  async list(directory) {
    const repository = await this.repositoryRoot(directory);
    return parseWorktreeList(await runGit(['-C', repository, 'worktree', 'list', '--porcelain'], repository));
  }

  async remove(directory, path) {
    const repository = await this.repositoryRoot(directory);
    const resolved = await realpath(resolve(path));
    const allowed = `${await realpath(this.root)}${sep}`;
    if (!resolved.startsWith(allowed)) throw new Error('只能清理由 DSH Desktop 创建的隔离工作区。');
    let changes = await runGit(['-C', resolved, 'status', '--porcelain'], resolved);
    if (changes === '?? DSH.md') {
      const instructions = join(resolved, 'DSH.md');
      if (await readFile(instructions, 'utf8') === WORKTREE_DSH_TEMPLATE) {
        await unlink(instructions);
        changes = '';
      }
    }
    if (changes !== '') throw new Error('隔离工作区仍有未提交修改，请先提交或手动处理。');
    await runGit(['-C', repository, 'worktree', 'remove', resolved], repository);
    await runGit(['-C', repository, 'worktree', 'prune'], repository);
    return { removed: resolved };
  }
}
