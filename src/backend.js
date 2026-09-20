import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function parseReadyUrl(line) {
  const match = line.match(/^dsh web: (http:\/\/127\.0\.0\.1:(\d+))(?:\s|$)/m);
  return match && +match[2] > 0 && +match[2] <= 65535 ? match[1] : null;
}

export function isInternalUrl(candidate, origin) {
  try { return Boolean(origin) && new URL(candidate).origin === origin; }
  catch { return false; }
}

export class Backend extends EventEmitter {
  constructor({ node, entry, cwd, home, log, timeout = 90000 }) {
    super();
    Object.assign(this, { node, entry, cwd, home, log, timeout });
  }
  async start() {
    if (this.child) throw new Error('服务仍在运行，请先停止。');
    if (!existsSync(this.node) || !existsSync(this.entry)) throw new Error('缺少内置运行环境，请先运行 npm run runtime:prepare。');
    mkdirSync(this.home, { recursive: true });
    mkdirSync(dirname(this.log), { recursive: true });
    this.stopping = false;
    this.url = null;
    const env = { ...process.env, DSH_HOME: this.home, NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    env.PATH = dirname(this.node) + (process.platform === 'win32' ? ';' : ':') + (env.PATH ?? '');
    const child = spawn(this.node, [this.entry, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32',
    });
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', resolve));
    return new Promise((resolve, reject) => {
      let buffer = '', settled = false;
      const finish = (error, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else { this.url = url; resolve(url); }
      };
      const timer = setTimeout(() => finish(new Error('服务启动超时，请查看日志后重试。')), this.timeout);
      const record = chunk => {
        try { appendFileSync(this.log, chunk); } catch (error) { this.emit('log-error', error); }
      };
      child.stdout.on('data', chunk => {
        record(chunk);
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop().slice(-8192);
        for (const line of lines) {
          const url = parseReadyUrl(line);
          if (url) finish(null, url);
        }
      });
      child.stderr.on('data', record);
      child.once('error', error => finish(error));
      child.once('close', (code, signal) => {
        this.child = null;
        this.url = null;
        const error = new Error(`本地服务已退出（${code ?? signal ?? 'unknown'}），请查看日志。`);
        finish(error);
        if (!this.stopping) this.emit('crash', error);
      });
    });
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    if (child.pid) {
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          killer.once('error', resolve); killer.once('close', resolve);
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    let timer;
    await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await this.exited;
  }
}
