import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRuntimeExtensions } from '../src/runtime-support.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-support-'));
  const projectRoot = join(root, 'project');
  const runtimeRoot = join(root, 'runtime');
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, 'src', 'runtime-desktop-context.js'), 'context');
  await writeFile(join(projectRoot, 'src', 'runtime-self-improvement.js'), 'learning');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { projectRoot, runtimeRoot };
}

test('source startup restores desktop runtime extensions', async t => {
  const paths = await fixture(t);
  const destination = ensureRuntimeExtensions({ ...paths, packaged: false });
  assert.equal(await readFile(join(destination, 'desktop-context.js'), 'utf8'), 'context');
  assert.equal(await readFile(join(destination, 'self-improvement.js'), 'utf8'), 'learning');
});

test('packaged startup reports an incomplete runtime', async t => {
  const paths = await fixture(t);
  assert.throws(
    () => ensureRuntimeExtensions({ ...paths, packaged: true }),
    /内置运行环境不完整/,
  );
});
