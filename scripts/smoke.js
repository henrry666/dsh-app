import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Backend } from '../src/backend.js';
const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-smoke-'));
const runtime = resolve(process.env.DSH_RUNTIME || 'runtime');
const backend = new Backend({ node: join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(runtime, 'harness/lib/bin.js'), cwd: directory, home: join(directory, 'data'), log: join(directory, 'harness.log') });
try {
  const url = await backend.start();
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html/);
  const asset = html.match(/src="([^"\s]+\.js)"/);
  assert.ok(asset, 'Frontend JavaScript asset present');
  assert.equal((await fetch(new URL(asset[1], url))).status, 200);
  console.log('PASS: Harness boots with bundled Node, serves HTML and JavaScript:', url);
  await backend.stop();
  await assert.rejects(fetch(url));
  console.log('PASS: Quit releases the local service port');
} catch (error) {
  console.error('Smoke logs:', directory);
  throw error;
} finally { await backend.stop(); }
await rm(directory, { recursive: true, force: true });
