import { readFile, writeFile } from 'node:fs/promises';

const OLD_PATCH_MARKER = 'dsh-desktop:user-memory';
const PATCH_MARKER = 'dsh-desktop:self-improvement-v2';
const CONTEXT_PATCH_MARKER = 'dsh-desktop:active-context-v1';

function removeOldMemoryPatch(source) {
  if (!source.includes(OLD_PATCH_MARKER)) return source;
  return source
    .replace('\nimport { readFile as readDshMemoryFile } from "node:fs/promises";', '')
    .replace('\nimport { join as joinDshMemoryPath } from "node:path";', '')
    .replace('\nimport { resolveDshHome as resolveDshMemoryHome } from "@deepseek-ai/dsh-home-paths";', '')
    .replace(/\n\t\t\/\/ dsh-desktop:user-memory[\s\S]*?\n\t\t\}, \{ prepend: true \}\);/, '');
}

export function addSelfImprovementSupport(input) {
  if (input.includes(PATCH_MARKER) || input.includes('dsh:native-self-improvement') || input.includes('name: "dsh_record_lesson"')) return input;
  const source = removeOldMemoryPatch(input);
  const importAnchor = 'import { Service } from "@deepseek-ai/cordis";';
  const constructorAnchor = '\t\tthis.respond = api.respond.bind(api);';
  if (!source.includes(importAnchor) || !source.includes(constructorAnchor)) {
    throw new Error('Harness API proxy layout changed; cannot install the desktop learning extension.');
  }
  const imports = `${importAnchor}\nimport { defineTool as defineDshLearningTool } from "@deepseek-ai/dsh-tools";\nimport { installDshSelfImprovement } from "../../../../desktop/self-improvement.js";`;
  const hook = `${constructorAnchor}\n\t\t// ${PATCH_MARKER}\n\t\tconst dshSelfImprovement = installDshSelfImprovement(ctx, { createUserMessage, defineTool: defineDshLearningTool, resolveDshHome });\n\t\tctx.on("agent/pre-step", dshSelfImprovement.preStep, { prepend: true });`;
  return source.replace(importAnchor, imports).replace(constructorAnchor, hook);
}

export function addDesktopContextSupport(input) {
  if (input.includes(CONTEXT_PATCH_MARKER)) return input;
  const importAnchor = 'import { Service } from "@deepseek-ai/cordis";';
  const constructorAnchor = '\t\tthis.respond = api.respond.bind(api);';
  if (!input.includes(importAnchor) || !input.includes(constructorAnchor)) {
    throw new Error('Harness API proxy layout changed; cannot install desktop context support.');
  }
  const imports = `${importAnchor}\nimport { installDshDesktopContext } from "../../../../desktop/desktop-context.js";`;
  const hook = `${constructorAnchor}\n\t\t// ${CONTEXT_PATCH_MARKER}\n\t\tconst dshDesktopContext = installDshDesktopContext(ctx, { createUserMessage, resolveDshHome });\n\t\tctx.on("agent/pre-step", dshDesktopContext.preStep, { prepend: true });`;
  return input.replace(importAnchor, imports).replace(constructorAnchor, hook);
}

export async function patchSelfImprovement(file) {
  const source = await readFile(file, 'utf8');
  const patched = addDesktopContextSupport(addSelfImprovementSupport(source));
  if (patched !== source) await writeFile(file, patched);
}
