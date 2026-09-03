import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = {
  port: Number(process.env.PORT || 15924),
  host: '0.0.0.0',
  mihomoApi: 'http://127.0.0.1:9090',
  home: os.homedir(),
  /** 终端代理标记文件（内容写入后，新开的终端 shell 自动加载代理环境变量，与 zshrc 机制一致） */
  proxyOnFile: path.join(os.homedir(), '.clash_proxy_on'),
  mihomoBin: '/usr/local/bin/mihomo',
  mihomoCfg: path.join(os.homedir(), '.config/mihomo/config.yaml'),
  importScript: fileURLToPath(new URL('./lib/import-sub.py', import.meta.url)),
};

/** ~/.clash_proxy_on 内容（与 zshrc 完全一致） */
export const PROXY_ON_CONTENT =
  'export http_proxy="http://127.0.0.1:7890"\n' +
  'export https_proxy="http://127.0.0.1:7890"\n' +
  'export all_proxy="socks5://127.0.0.1:7890"\n' +
  'export no_proxy="localhost,127.0.0.1,::1"\n';
