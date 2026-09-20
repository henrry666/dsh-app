import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSelfImprovement } from './runtime-patches.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(process.env.DSH_SOURCE || process.argv.find(arg => !arg.startsWith('--') && process.argv.indexOf(arg) > 1) || join(root, '..', 'deepseek-harness'));
const runtime = resolve(process.env.DSH_RUNTIME || join(root, 'runtime'));
const targetPlatform = process.env.DSH_TARGET_PLATFORM || process.platform;
const targetArch = process.env.DSH_TARGET_ARCH || process.arch;
const stage = join(runtime, 'harness');
if (source === root || source.startsWith(runtime + sep)) throw new Error('Source must be outside the generated runtime directory');
if (!existsSync(join(source, 'apps/cli/lib/bin.js'))) throw new Error('Harness 尚未构建：请在源码目录运行 pnpm install 和 pnpm run build。');
if (+process.versions.node.split('.')[0] < 24) throw new Error('Runtime staging requires Node.js 24 or newer.');
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: source, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

function runCaptured(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}`)));
  });
}

function packageDirectory(name) {
  return join(stage, 'node_modules', ...name.split('/'));
}

async function installPackedPackage(name, version, temporary) {
  const stdout = await runCaptured('npm', [
    'pack', `${name}@${version}`, '--json', '--ignore-scripts',
    '--registry=https://registry.npmmirror.com', '--pack-destination', temporary,
  ]);
  const packed = JSON.parse(stdout);
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error(`npm pack did not return an archive for ${name}@${version}`);
  const destination = packageDirectory(name);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await runCaptured('tar', ['-xzf', join(temporary, filename), '-C', destination, '--strip-components=1']);
}

async function prepareTargetNativePackages() {
  if (targetPlatform === process.platform && targetArch === process.arch) return;
  if (targetPlatform !== 'win32' || targetArch !== 'x64') {
    throw new Error(`Cross-platform runtime is not implemented for ${targetPlatform}-${targetArch}`);
  }
  const families = [
    { owner: 'koffi', target: '@koromix/koffi-win32-x64' },
    { owner: '@napi-rs/canvas', target: '@napi-rs/canvas-win32-x64-msvc' },
    { owner: 'sharp', target: '@img/sharp-win32-x64' },
    { owner: '@vscode/ripgrep', target: '@vscode/ripgrep-win32-x64' },
    { owner: 'node-addon-require-builtin', target: 'node-addon-require-builtin-win32-x64-msvc' },
  ];
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-win-packages-'));
  try {
    for (const family of families) {
      const owner = JSON.parse(await readFile(join(packageDirectory(family.owner), 'package.json'), 'utf8'));
      const optional = owner.optionalDependencies || {};
      const version = optional[family.target];
      if (typeof version !== 'string') throw new Error(`${family.owner} does not declare ${family.target}`);
      for (const name of Object.keys(optional)) {
        if (name !== family.target && existsSync(packageDirectory(name))) {
          await rm(packageDirectory(name), { recursive: true, force: true });
        }
      }
      await installPackedPackage(family.target, version, temporary);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function download(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function prepareNodeRuntime() {
  await mkdir(join(runtime, 'node'), { recursive: true });
  if (targetPlatform === process.platform && targetArch === process.arch) {
    const node = join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    await copyFile(process.execPath, node);
    await chmod(node, 0o755);
    return;
  }
  if (targetPlatform !== 'win32' || targetArch !== 'x64') {
    throw new Error(`Bundled Node download is not implemented for ${targetPlatform}-${targetArch}`);
  }
  const release = process.version;
  const archiveName = `node-${release}-win-x64.zip`;
  const bases = [
    `https://npmmirror.com/mirrors/node/${release}`,
    `https://nodejs.org/dist/${release}`,
  ];
  let archive;
  let checksums;
  let lastError;
  for (const base of bases) {
    try {
      archive = await download(`${base}/${archiveName}`, AbortSignal.timeout(120_000));
      checksums = (await download(`${base}/SHASUMS256.txt`, AbortSignal.timeout(30_000))).toString('utf8');
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (archive === undefined || checksums === undefined) throw lastError ?? new Error('Cannot download Windows Node runtime');
  const expected = checksums.split(/\r?\n/).find(line => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(archive).digest('hex');
  if (expected === undefined || expected !== actual) throw new Error(`Checksum verification failed for ${archiveName}`);
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-win-node-'));
  try {
    const archivePath = join(temporary, archiveName);
    await writeFile(archivePath, archive);
    await runCaptured('unzip', ['-q', archivePath, '-d', temporary]);
    const extracted = join(temporary, `node-${release}-win-x64`);
    await copyFile(join(extracted, 'node.exe'), join(runtime, 'node', 'node.exe'));
    await copyFile(join(extracted, 'LICENSE'), join(runtime, 'NODE-LICENSE'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (!process.argv.includes('--finish')) {
  await rm(stage, { recursive: true, force: true });
  await run('pnpm', ['--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod', '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.link-workspace-packages=true', stage]);
}
// Legacy deployment may resolve direct dependencies from the source root.
const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
for (const name of Object.keys(manifest.dependencies || {})) {
  const destination = join(stage, 'node_modules', name);
  if (existsSync(destination)) continue;
  const original = await realpath(join(source, 'apps/cli/node_modules', name));
  await mkdir(dirname(destination), { recursive: true });
  await cp(original, destination, { recursive: true, dereference: true, filter: path => path !== join(original, 'node_modules') && !path.startsWith(join(original, 'node_modules') + sep) });
}
// Complete the plugin peer-dependency closure in the staged root.
const workspacePackages = new Map();
async function indexWorkspace(directory, depth = 0) {
  if (!existsSync(directory) || depth > 3) return;
  const packagePath = join(directory, 'package.json');
  if (depth > 0 && existsSync(packagePath)) {
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
    if (packageManifest.name) workspacePackages.set(packageManifest.name, directory);
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules') await indexWorkspace(join(directory, entry.name), depth + 1);
  }
}
for (const directory of ['vendor', 'packages', 'apps', 'native']) await indexWorkspace(join(source, directory));
const queue = [{ manifest, directory: join(source, 'apps/cli') }];
const inspected = new Set();
while (queue.length > 0) {
  const current = queue.shift();
  if (inspected.has(current.manifest.name)) continue;
  inspected.add(current.manifest.name);
  const dependencies = {
    ...current.manifest.dependencies,
    ...current.manifest.peerDependencies,
    ...current.manifest.optionalDependencies,
  };
  for (const name of Object.keys(dependencies)) {
    const destination = join(stage, 'node_modules', name);
    let original;
    for (const candidate of [join(current.directory, 'node_modules', name), join(source, 'node_modules', name), workspacePackages.get(name)]) {
      if (!candidate) continue;
      if (existsSync(candidate)) { original = await realpath(candidate); break; }
    }
    if (!original) {
      const optionalPeer = current.manifest.peerDependenciesMeta?.[name]?.optional === true;
      if (optionalPeer || current.manifest.optionalDependencies?.[name]) continue;
      // Workspace packages are copied without nested node_modules.
      if (!existsSync(destination) && current.manifest.name?.startsWith('@deepseek-ai/')) {
        throw new Error(`Cannot resolve runtime dependency ${name} required by ${current.manifest.name}`);
      }
      continue;
    }
    if (!existsSync(destination)) {
      await mkdir(dirname(destination), { recursive: true });
      await cp(original, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== join(original, 'node_modules') && !path.startsWith(join(original, 'node_modules') + sep),
      });
    }
    const dependencyManifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'));
    queue.push({ manifest: dependencyManifest, directory: original });
  }
}
async function materialize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === '.bin') { await rm(path, { recursive: true, force: true }); continue; }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const original = await realpath(path);
      await rm(path, { force: true, recursive: true });
      await cp(original, path, { recursive: true, dereference: true, filter: file => file !== join(original, 'node_modules') && !file.startsWith(join(original, 'node_modules') + sep) });
    } else if (metadata.isDirectory()) await materialize(path);
  }
}
await materialize(join(stage, 'node_modules'));
await prepareTargetNativePackages();
// Materialize workspace link overrides omitted by legacy deployment.
for (const name of ['cosmokit', 'schemastery']) {
  const original = join(source, 'vendor', name);
  const destination = join(stage, 'node_modules', '@deepseek-ai', name);
  if (!existsSync(destination)) await cp(original, destination, {
    recursive: true, dereference: true,
    filter: file => file !== join(original, 'node_modules') && !file.startsWith(join(original, 'node_modules') + sep),
  });
}
async function replaceDesktopBrand(relativePath) {
  const file = join(stage, relativePath);
  const content = await readFile(file, 'utf8');
  if (!content.includes('DSH Local Build')) {
    if (content.includes('DSH Desktop')) return;
    throw new Error(`Desktop brand marker is missing from ${relativePath}`);
  }
  await writeFile(file, content.replaceAll('DSH Local Build', 'DSH Desktop'));
}
for (const file of [
  'node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js',
  'node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
]) await replaceDesktopBrand(file);
await mkdir(join(stage, 'desktop'), { recursive: true });
await copyFile(join(root, 'src/runtime-self-improvement.js'), join(stage, 'desktop/self-improvement.js'));
await copyFile(join(root, 'src/runtime-desktop-context.js'), join(stage, 'desktop/desktop-context.js'));
await patchSelfImprovement(join(stage, 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'));
await prepareNodeRuntime();
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(source, name), join(runtime, name));
if (!existsSync(join(runtime, 'NODE-LICENSE'))) {
  const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!nodeLicense.ok) throw new Error('Cannot download the bundled Node.js license');
  await writeFile(join(runtime, 'NODE-LICENSE'), await nodeLicense.text());
}
await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ harness: manifest.version, node: process.version, platform: targetPlatform, arch: targetArch, builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log('Runtime ready:', runtime);
