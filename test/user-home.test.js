import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DSH_INSTRUCTIONS_TEMPLATE, MEMORY_TEMPLATE, prepareDshHome } from '../src/user-home.js';

test('creates ~/.dsh with DSH instructions and memory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = prepareDshHome(root);
  assert.equal(result.home, join(root, '.dsh'));
  assert.equal(await readFile(result.memory, 'utf8'), MEMORY_TEMPLATE);
  assert.equal(await readFile(result.instructions, 'utf8'), DSH_INSTRUCTIONS_TEMPLATE);
});

test('merges legacy data without overwriting current ~/.dsh files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, 'legacy');
  const current = join(root, '.dsh');
  await mkdir(join(legacy, 'skills'), { recursive: true });
  await mkdir(current, { recursive: true });
  await writeFile(join(legacy, 'config.json'), 'legacy');
  await writeFile(join(legacy, 'skills', 'one.md'), 'skill');
  await writeFile(join(current, 'config.json'), 'current');
  await writeFile(join(current, 'memory.md'), 'keep me');
  await writeFile(join(current, 'DSH.md'), 'keep instructions');
  prepareDshHome(root, legacy);
  assert.equal(await readFile(join(current, 'config.json'), 'utf8'), 'current');
  assert.equal(await readFile(join(current, 'skills', 'one.md'), 'utf8'), 'skill');
  assert.equal(await readFile(join(current, 'memory.md'), 'utf8'), 'keep me');
  assert.equal(await readFile(join(current, 'DSH.md'), 'utf8'), 'keep instructions');
});
