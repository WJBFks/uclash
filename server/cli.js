import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  while (values.length) {
    const arg = values.shift();
    if (arg === '--port') {
      if (!values.length) throw new Error('--port 缺少端口值');
      port = portNumber(values.shift());
    } else if (arg.startsWith('--port=')) {
      port = portNumber(arg.slice('--port='.length));
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { command, port };
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

async function runForeground(port) {
  ensureDist();
  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server/index.js')], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port), CW_DEV: '' },
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseCliArgs(args);
    if (options.command === 'run') return await runForeground(options.port);
    if (options.command === 'start') {
      ensureDist();
      await installService(options.port);
      await systemctl(['enable', '--now', 'uclash.service']);
      console.log(`UClash 已在 http://127.0.0.1:${options.port} 后台运行`);
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
