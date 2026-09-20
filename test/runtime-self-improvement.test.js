import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDshSelfImprovement } from '../src/runtime-self-improvement.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-learning-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let tool;
  const ctx = { tools: { register(value) { tool = value; } }, logger: { warn() {} } };
  const extension = installDshSelfImprovement(ctx, {
    createUserMessage: value => ({ role: 'user', ...value }),
    defineTool: value => value,
    resolveDshHome: () => home,
  });
  return { home, tool, extension };
}

test('records and deduplicates one-line memory', async t => {
  const { home, tool } = await fixture(t);
  const args = { kind: 'memory', summary: '打包 Windows Electron 时若官方源无响应，应切换已验证的镜像。' };
  assert.equal((await tool.execute(args)).operation, 'created');
  assert.equal((await tool.execute(args)).operation, 'unchanged');
  const memory = await readFile(join(home, 'memory.md'), 'utf8');
  assert.equal(memory.match(/打包 Windows/g)?.length, 1);
});

test('creates a discoverable multi-step skill and redacts secrets', async t => {
  const { home, tool } = await fixture(t);
  const result = await tool.execute({
    kind: 'skill', summary: 'Windows 跨平台打包需要准备目标运行时。', skill_name: 'windows-cross-package',
    when_to_use: '在 macOS 上生成 Windows 安装包时。',
    procedure: '1. 下载目标平台 Node。\n2. API_KEY=secret-value 安装目标平台原生依赖。\n3. 运行安装包构建。',
  });
  assert.equal(result.operation, 'created');
  const skill = await readFile(join(home, 'skills/windows-cross-package/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: windows-cross-package/m);
  assert.match(skill, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(skill, /secret-value/);
});

test('injects policy and memory once per opened session', async t => {
  const { home, extension } = await fixture(t);
  await writeFile(join(home, 'DSH.md'), '# 用户全局规则\n\n优先读取此文件。\n');
  await writeFile(join(home, 'memory.md'), '<!-- help -->\n- 使用镜像前验证校验和。\n');
  const session = {};
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '开始' }], source: { kind: 'user' } }] };
  const first = await extension.preStep({ agent: { session }, step: 1, signal: new AbortController().signal }, async () => decision);
  assert.equal(first.messages.length, 2);
  assert.match(first.messages[0].content[0].text, /<dsh_instructions>[\s\S]*优先读取此文件/);
  assert.match(first.messages[0].content[0].text, /dsh_record_lesson/);
  assert.match(first.messages[0].content[0].text, /使用镜像前验证校验和/);
  const second = await extension.preStep({ agent: { session }, step: 1, signal: new AbortController().signal }, async () => decision);
  assert.equal(second, decision);
});

test('persists an explicit remember directive before answering', async t => {
  const { home, extension } = await fixture(t);
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '请记住：默认使用中文回答。' }], source: { kind: 'user' } }] };
  await extension.preStep({ agent: { session: {} }, step: 1, signal: new AbortController().signal }, async () => decision);
  assert.match(await readFile(join(home, 'memory.md'), 'utf8'), /默认使用中文回答/);
});

test('moves memory over 8 KiB into topics and recalls only a matching topic', async t => {
  const { home, tool, extension } = await fixture(t);
  for (let index = 0; index < 20; index += 1) {
    await tool.execute({
      kind: 'memory', topic: 'Windows-Electron',
      summary: `Windows 打包经验 ${index}：${'校验运行时后再生成安装包。'.repeat(22)}`,
    });
  }
  const memory = await readFile(join(home, 'memory.md'), 'utf8');
  assert.ok(Buffer.byteLength(memory, 'utf8') <= 8 * 1024);
  assert.match(await readFile(join(home, 'topics/Windows-Electron.md'), 'utf8'), /Windows 打包经验 0/);
  const session = {};
  const ask = text => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] });
  await extension.preStep({ agent: { session }, step: 1, signal: new AbortController().signal }, async () => ask('开始'));
  const related = await extension.preStep({ agent: { session }, step: 1, signal: new AbortController().signal }, async () => ask('继续检查 Windows 安装包'));
  assert.match(related.messages[0].content[0].text, /Windows 打包经验 0/);
  const unrelated = await extension.preStep({ agent: { session }, step: 1, signal: new AbortController().signal }, async () => ask('整理软件著作权材料'));
  assert.equal(unrelated.messages.length, 1);
});
