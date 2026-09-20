import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addContextFiles, inspectContextSources, prepareDesktopState, readDesktopContext, writeDesktopSettings } from '../src/desktop-state.js';

test('persists desktop mode and bounded active context', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-state-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prepared = prepareDesktopState(home);
  assert.equal(prepared.settings.mode, 'chat');
  assert.equal(writeDesktopSettings(home, { mode: 'work' }).mode, 'work');
  addContextFiles(home, Array.from({ length: 10 }, (_, index) => `/tmp/file-${index}.txt`));
  const context = readDesktopContext(home);
  assert.equal(context.mode, 'work');
  assert.equal(context.files.length, 8);
  assert.equal(context.files[0].path, '/tmp/file-2.txt');
  assert.equal(JSON.parse(await readFile(join(home, 'desktop-settings.json'), 'utf8')).mode, 'work');
});

test('reports user-visible context source counts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-sources-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  prepareDesktopState(home);
  await writeFile(join(home, 'DSH.md'), '# DSH');
  await writeFile(join(home, 'memory.md'), '- memory');
  await mkdir(join(home, 'topics'), { recursive: true });
  await mkdir(join(home, 'skills', 'one'), { recursive: true });
  await mkdir(join(home, 'knowledge-bases', 'kb-one'), { recursive: true });
  await writeFile(join(home, 'topics', 'one.md'), '# one');
  const sources = inspectContextSources(home);
  assert.equal(sources.instructions.available, true);
  assert.equal(sources.memory.bytes, 8);
  assert.equal(sources.topics, 1);
  assert.equal(sources.skills, 1);
  assert.equal(sources.knowledgeBases, 1);
});
