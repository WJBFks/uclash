import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('an unreachable preview does not block first subscription import', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uclash-preview-'));
  const configFile = path.join(root, 'config.yaml');
  fs.writeFileSync(configFile, 'mode: direct\nrules: ["MATCH,DIRECT"]\n');
  process.env.MIHOMO_CONFIG = configFile;
  process.env.CW_STATE_DIR = path.join(root, 'state');
  const server = http.createServer((req) => req.socket.destroy()).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { handlers } = await import('../server/routes.js');
  const result = await handlers['POST /api/import/preview']({
    url: `http://127.0.0.1:${server.address().port}/subscription`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.name, null);
  assert.equal(result.nodes, null);
  assert.match(result.warning, /无法预览|网络/);
});
