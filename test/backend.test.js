import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend, parseReadyUrl, isInternalUrl } from '../src/backend.js';

test('Only trusts a Harness readiness announcement on loopback', () => {
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:43210'), 'http://127.0.0.1:43210');
  for (const line of ['request http://127.0.0.1:12', 'dsh web: http://evil.com:12', 'dsh web: http://127.0.0.1:0', 'dsh web: http://127.0.0.1:99999', 'dsh web: http://127.0.0.1:123.evil.com']) assert.equal(parseReadyUrl(line), null);
});
test('Navigation stays on the exact server origin', () => {
  assert.ok(isInternalUrl('http://127.0.0.1:32/session/1', 'http://127.0.0.1:32'));
  for (const url of ['http://127.0.0.1:33', 'https://evil.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1:32@evil.com']) assert.equal(isInternalUrl(url, 'http://127.0.0.1:32'), false);
});
async function fixture(t, source, timeout = 2000) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-'));
  const entry = join(root, 'server.cjs');
  await writeFile(entry, source);
  const backend = new Backend({ node: process.execPath, entry, cwd: root, home: join(root, 'data'), log: join(root, 'server.log'), timeout });
  t.after(async () => { await backend.stop(); await rm(root, { recursive: true, force: true }); });
  return backend;
}
test('Reassembles split readiness output and shuts down its server', async t => {
  const backend = await fixture(t, `const http=require('http'); const server=http.createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',()=>{process.stdout.write('dsh web: http://127.'); setTimeout(()=>console.log('0.0.1:'+server.address().port),20)});`);
  const url = await backend.start();
  assert.equal(await (await fetch(url)).text(), 'ok');
  await assert.rejects(backend.start(), /仍在运行/);
  await backend.stop();
  await assert.rejects(fetch(url));
  await backend.stop();
});
test('An early exit fails startup instead of leaving a loading screen', async t => {
  const backend = await fixture(t, 'process.exit(7)');
  await assert.rejects(backend.start(), /7/);
});
test('A startup timeout can be stopped and retried', async t => {
  const backend = await fixture(t, 'setInterval(()=>{},1000)', 100);
  await assert.rejects(backend.start(), /超时/);
  await backend.stop();
  assert.equal(backend.child, null);
  await assert.rejects(backend.start(), /超时/);
});
