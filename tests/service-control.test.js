import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { parse } from 'yaml';

test('starting the global service enables TUN in config and runtime', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uclash-service-'));
  const cfg = path.join(root, 'config.yaml');
  const systemctl = path.join(root, 'systemctl');
  const mihomo = path.join(root, 'mihomo');
  fs.writeFileSync(cfg, 'mode: rule\ntun:\n  enable: false\nrules: ["MATCH,DIRECT"]\n');
  fs.writeFileSync(systemctl, '#!/bin/sh\nif [ "$2" = "is-active" ]; then echo active; fi\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(mihomo, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let runtime = { mode: 'rule', tun: { enable: false } };
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/configs' && req.method === 'PUT') {
        runtime = parse(fs.readFileSync(cfg, 'utf8'));
        return res.end('{}');
      }
      if (req.url === '/configs') return res.end(JSON.stringify(runtime));
      if (req.url === '/proxies') return res.end(JSON.stringify({ proxies: {} }));
      res.end('{}');
    });
  }).listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.MIHOMO_API = `http://127.0.0.1:${api.address().port}`;
  process.env.MIHOMO_CONFIG = cfg;
  process.env.MIHOMO_BIN = mihomo;
  process.env.CW_SYSTEMCTL_BIN = systemctl;
  process.env.CW_STATE_DIR = path.join(root, 'state');
  process.env.MIHOMO_SERVICE = 'mihomo-test';

  const { handlers } = await import('../server/routes.js');
  const result = await handlers['POST /api/service']({ action: 'start' });

  assert.equal(result.ok, true);
  assert.equal(parse(fs.readFileSync(cfg, 'utf8')).tun.enable, true);
  assert.equal(runtime.tun.enable, true);
});
