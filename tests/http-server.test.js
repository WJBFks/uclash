import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function waitFor(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for condition');
}

test('HTTP entry requires authentication and rejects cross-origin writes; drafts never mutate the core', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-http-test-'));
  const cfg = path.join(dir, 'config.yaml');
  fs.writeFileSync(cfg, 'mode: rule\nrules:\n  - MATCH,DIRECT\n');
  const requests = [];
  const mock = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ connections: [], uploadTotal: 1234, downloadTotal: 5678 }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const token = 'isolated-test-token-01234567890';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', CW_HOST: '127.0.0.1', CW_TOKEN: token, CW_ALLOWED_ORIGINS: '',
      MIHOMO_API: `http://127.0.0.1:${mock.address().port}`, MIHOMO_CONFIG: cfg, MIHOMO_BIN: path.join(dir, 'nonexistent-mock-binary'),
      MIHOMO_SERVICE: 'isolated-do-not-call', CW_STATE_DIR: path.join(dir, 'state'), CW_DEV: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Test backend did not start')), 5000);
      child.stdout.on('data', (buf) => {
        output += buf.toString();
        const match = output.match(/listening on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Test backend exited: ${code}`)); });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await waitFor(() => requests.some(({ method, path: requestPath }) => method === 'GET' && requestPath === '/connections'));
    let traffic;
    await waitFor(async () => {
      traffic = await (await fetch(base + '/api/traffic', { headers })).json();
      return traffic.data.live.up === 1234 && traffic.data.live.down === 5678 && traffic.data.history.length === 1;
    });
    assert.deepEqual(traffic.data.live, { up: 1234, down: 5678 });
    assert.deepEqual(traffic.data.history, [{ t: traffic.data.history[0].t, up: 0, down: 0 }]);
    assert.equal(requests.some(({ path: requestPath }) => requestPath === '/traffic'), false);
    assert.equal((await fetch(base + '/api/config-info')).status, 401);
    assert.equal((await fetch(base + '/api/config-info', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/network/draft', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    const preview = await (await fetch(base + '/api/config/preview', { headers })).json();
    const saved = await (await fetch(base + '/api/network/draft', { method: 'POST', headers,
      body: JSON.stringify({ revision: preview.data.revision, network: { tun: { enable: true } } }) })).json();
    assert.equal(saved.ok, true);
    assert.equal(fs.readFileSync(cfg, 'utf8'), 'mode: rule\nrules:\n  - MATCH,DIRECT\n');
    assert.ok(fs.existsSync(path.join(dir, 'state/draft.json')));
    assert.equal(requests.filter((r) => r.method !== 'GET').length, 0);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
