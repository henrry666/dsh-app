import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const release = new URL('../release/', import.meta.url);
const files = (await readdir(release)).filter(name => /^DSH Desktop-.*-mac-arm64\.(?:dmg|zip)$/.test(name));
const checksums = [];
for (const name of files) {
  const data = await readFile(new URL(name, release));
  checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
}
await writeFile(new URL('macOS-内部测试包安装说明.txt', release), `DSH Desktop macOS 内部测试包\n\n当前文件适用于 Apple Silicon（M1/M2/M3/M4/M5）Mac。\n此测试包没有 Apple Developer ID 公证，请只安装来自可信来源且校验和一致的文件。\n\n安装步骤：\n1. 从 DMG 或 ZIP 中把“DSH Desktop.app”拖入“应用程序”。\n2. 首次打开若被系统阻止，请进入“系统设置 → 隐私与安全性”，点击“仍要打开”。\n3. 若仍显示“已损坏”，在终端执行：\n\n   xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"\n   open "/Applications/DSH Desktop.app"\n\nSHA-256：\n${checksums.join('\n')}\n`);
