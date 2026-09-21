import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EXTENSIONS = ['desktop-context.js', 'self-improvement.js'];

export function ensureRuntimeExtensions({ projectRoot, runtimeRoot, packaged }) {
  const destination = join(runtimeRoot, 'harness', 'desktop');
  if (packaged) {
    const missing = EXTENSIONS.filter(name => !existsSync(join(destination, name)));
    if (missing.length) throw new Error(`内置运行环境不完整，缺少 ${missing.join('、')}，请重新安装 DSH Desktop。`);
    return destination;
  }

  mkdirSync(destination, { recursive: true });
  const sources = {
    'desktop-context.js': join(projectRoot, 'src', 'runtime-desktop-context.js'),
    'self-improvement.js': join(projectRoot, 'src', 'runtime-self-improvement.js'),
  };
  for (const name of EXTENSIONS) {
    const source = sources[name];
    if (!existsSync(source)) throw new Error(`缺少桌面运行时扩展：${source}`);
    copyFileSync(source, join(destination, name));
  }
  return destination;
}
