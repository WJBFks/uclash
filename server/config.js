import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = {
  port: Number(process.env.PORT || 15924),
  host: process.env.CW_HOST || '127.0.0.1',
  token: process.env.CW_TOKEN || '',
  allowedOrigins: (process.env.CW_ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  mihomoApi: (process.env.MIHOMO_API || 'http://127.0.0.1:9090').replace(/\/$/, ''),
  mihomoSecret: process.env.MIHOMO_SECRET || '',
  serviceName: process.env.MIHOMO_SERVICE || 'mihomo',
  systemctlBin: process.env.CW_SYSTEMCTL_BIN || '/usr/bin/systemctl',
  journalctlBin: process.env.CW_JOURNALCTL_BIN || '/usr/bin/journalctl',
  stateDir: process.env.CW_STATE_DIR || fileURLToPath(new URL('../.pi/wj/clash-web/', import.meta.url)),
  backupLimit: Math.max(1, Math.min(100, Number(process.env.CW_BACKUP_LIMIT) || 20)),
  home: os.homedir(),
  mihomoBin: process.env.MIHOMO_BIN || '/usr/local/bin/mihomo',
  mihomoCfg: process.env.MIHOMO_CONFIG || path.join(os.homedir(), '.config/mihomo/config.yaml'),
  importScript: fileURLToPath(new URL('./lib/import-sub.py', import.meta.url)),
};
