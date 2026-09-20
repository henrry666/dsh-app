import test from 'node:test';
import assert from 'node:assert/strict';
import { addDesktopContextSupport, addSelfImprovementSupport } from '../scripts/runtime-patches.js';

const BASE = 'import { Service } from "@deepseek-ai/cordis";\nclass Api {\n\t\tthis.respond = api.respond.bind(api);\n}';

test('installs the self-improvement extension exactly once', () => {
  const once = addSelfImprovementSupport(BASE);
  assert.match(once, /dsh-desktop:self-improvement-v2/);
  assert.match(once, /installDshSelfImprovement/);
  assert.match(once, /defineDshLearningTool/);
  assert.equal(addSelfImprovementSupport(once), once);
});

test('upgrades the first memory-only patch', () => {
  const old = BASE.replace(
    '\t\tthis.respond = api.respond.bind(api);',
    '\t\tthis.respond = api.respond.bind(api);\n\t\t// dsh-desktop:user-memory\n\t\tconst memorySessions = new WeakSet();\n\t\tctx.on("agent/pre-step", async () => {\n\t\t\treturn;\n\t\t}, { prepend: true });',
  );
  const upgraded = addSelfImprovementSupport(old);
  assert.doesNotMatch(upgraded, /dsh-desktop:user-memory/);
  assert.match(upgraded, /dsh-desktop:self-improvement-v2/);
});

test('fails clearly when the upstream bundle layout changes', () => {
  assert.throws(() => addSelfImprovementSupport('changed bundle'), /layout changed/);
});

test('does not duplicate native Harness support', () => {
  const native = `${BASE}\n// dsh:native-self-improvement\nname: "dsh_record_lesson"`;
  assert.equal(addSelfImprovementSupport(native), native);
});

test('installs desktop context support alongside native Harness learning', () => {
  const native = `${BASE}\n// dsh:native-self-improvement\nname: "dsh_record_lesson"`;
  const once = addDesktopContextSupport(addSelfImprovementSupport(native));
  assert.match(once, /dsh-desktop:active-context-v1/);
  assert.match(once, /installDshDesktopContext/);
  assert.equal(addDesktopContextSupport(once), once);
});
