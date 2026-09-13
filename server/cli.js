import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 15924;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数');
  return port;
}

export function parseCliArgs(args) {
  const values = [...args];
  let command = 'run';
  if (values[0] && !values[0].startsWith('-')) command = values.shift();
  if (!['run', 'start', 'stop', 'restart'].includes(command)) throw new Error(`未知命令：${command}`);
  if (['stop', 'restart'].includes(command) && values.length) throw new Error(`${command} 不接受端口参数`);
  if (['stop', 'restart'].includes(command)) return { command, port: null };

  let port = DEFAULT_PORT;
  let open = true;
  while (values.length) {
    const arg = values.shift();
    if (arg === '--port') {
      if (!values.length) throw new Error('--port 缺少端口值');
      port = portNumber(values.shift());
    } else if (arg.startsWith('--port=')) {
      port = portNumber(arg.slice('--port='.length));
    } else if (arg === '--no-open') {
      open = false;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { command, port, open };
}

export function browserCommand(platform, url) {
  if (platform === 'linux') return ['/usr/bin/xdg-open', [url]];
  if (platform === 'darwin') return ['/usr/bin/open', [url]];
  return null;
}

function waitForServer(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let finished = false;
      const finish = (ready) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        if (ready || Date.now() >= deadline) resolve(ready);
        else setTimeout(attempt, 100);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(500, () => finish(false));
    };
    attempt();
  });
}

function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`;
  const command = browserCommand(process.platform, url);
  if (!command || !fs.existsSync(command[0])) {
    console.warn(`无法自动打开浏览器，请手动访问 ${url}`);
    return;
  }
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.once('error', () => console.warn(`无法自动打开浏览器，请手动访问 ${url}`));
  child.unref();
}

function quoteUnit(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function escapeUnitPath(value) {
  return [...Buffer.from(String(value))]
    .map((byte) => (byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || [0x2f, 0x2e, 0x5f, 0x2d].includes(byte)
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, '0')}`)
    .join('');
}

export function renderServiceUnit({ rootDir, nodeBin, port }) {
  return `[Unit]\nDescription=UClash Web\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitPath(rootDir)}\nEnvironment=PORT=${port}\nExecStart=${quoteUnit(nodeBin)} ${quoteUnit(path.join(rootDir, 'server/index.js'))}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
}

function systemctl(args, stdio = 'inherit') {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/systemctl', ['--user', ...args], { stdio });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`systemctl ${args.join(' ')} 失败（退出码 ${code}）`)));
  });
}

function ensureDist() {
  if (!fs.existsSync(path.join(ROOT_DIR, 'dist/index.html'))) throw new Error('找不到 dist/index.html；请先运行 npm run build');
}

function servicePath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'systemd/user/uclash.service');
}

async function installService(port) {
  const file = servicePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = renderServiceUnit({ rootDir: ROOT_DIR, nodeBin: process.execPath, port });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o644 });
  fs.renameSync(temp, file);
  await systemctl(['daemon-reload']);
}

async function runForeground(port, shouldOpen) {
  ensureDist();
  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server/index.js')], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port), CW_DEV: '' },
    stdio: 'inherit',
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
  const ready = await Promise.race([
    waitForServer(port),
    exited.then(() => false),
  ]);
  if (ready && shouldOpen) openBrowser(port);
  return exited;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseCliArgs(args);
    if (options.command === 'run') return await runForeground(options.port, options.open);
    if (options.command === 'start') {
      ensureDist();
      await installService(options.port);
      await systemctl(['enable', '--now', 'uclash.service']);
      console.log(`UClash 已在 http://127.0.0.1:${options.port} 后台运行`);
      const ready = await waitForServer(options.port);
      if (ready && options.open) openBrowser(options.port);
      else if (!ready) console.warn('UClash 服务已启动，但端口尚未就绪');
      return 0;
    }
    if (options.command === 'stop') {
      await systemctl(['stop', 'uclash.service']);
      console.log('UClash 已停止');
      return 0;
    }
    if (!fs.existsSync(servicePath())) throw new Error('UClash 后台服务尚未安装，请先运行 uclash start');
    await systemctl(['restart', 'uclash.service']);
    console.log('UClash 已重启');
    return 0;
  } catch (error) {
    console.error(`uclash: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
