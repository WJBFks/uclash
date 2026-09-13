import { parse } from 'yaml';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chmodSync, writeFileSync } from 'node:fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-web-test-'));
const state = path.join(root, 'state');
const cfg = path.join(root, 'config.yaml');
const bin = path.join(root, 'mihomo');
fs.mkdirSync(state);
writeFileSync(cfg, 'mode: rule\nrules:\n  - MATCH,DIRECT\nproxy-groups:\n  - name: Auto\n    type: select\n    proxies: [DIRECT]\n');
writeFileSync(bin, '#!/bin/sh\n[ "$1" = "-t" ] && exit 0\nexit 0\n'); chmodSync(bin, 0o755);

let api, port, security, connections, store, management, bearerSeen;
let httpJson;
let failPut = 0, failConfigGet = 0, putPaths = [];
let failAfterReload = false;
let runtimeConfig = { mode: 'rule' }, ignoreReload = false, removedSelector = false;
before(async () => {
  api = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const p = req.url.split('?')[0];
      if (p === '/auth') { bearerSeen = req.headers.authorization; return res.end('{}'); }
      if (p === '/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const timer = setInterval(() => res.write('x'), 10);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (p === '/proxies') return res.end(JSON.stringify({ proxies: { Auto: { type: 'Selector', now: 'DIRECT' } } }));
      if (p === '/configs' && req.method === 'GET') { if (failConfigGet-- > 0) { res.statusCode = 503; return res.end('{}'); } return res.end(JSON.stringify(runtimeConfig)); }
      if (p === '/configs' && req.method === 'PUT') { putPaths.push(p); if (failPut-- > 0) { res.statusCode = 503; return res.end('{}'); } if (!ignoreReload) runtimeConfig = parse(fs.readFileSync(cfg, 'utf8')); if (failAfterReload) { failConfigGet = 1; failAfterReload = false; } return res.end('{}'); }
      if (p === '/configs' && req.method === 'PATCH') { runtimeConfig = { ...runtimeConfig, ...JSON.parse(body) }; return res.end('{}'); }
      if (p === '/proxies/Auto' && removedSelector && putPaths.length) { res.statusCode = 404; return res.end('{}'); }
      if (p.startsWith('/proxies/')) return res.end('{}');
      if (p === '/rules') return res.end(JSON.stringify({ rules: [] }));
      if (p === '/providers/rules') return res.end(JSON.stringify({ providers: {} }));
      return res.end('{}');
    });
  }).listen(0, '127.0.0.1');
  await once(api, 'listening'); port = api.address().port;
  process.env.MIHOMO_API = `http://127.0.0.1:${port}`;
  process.env.MIHOMO_CONFIG = cfg; process.env.MIHOMO_BIN = bin; process.env.CW_STATE_DIR = state;
  process.env.CW_HOST = '127.0.0.1'; process.env.CW_TOKEN = 'secret'; process.env.MIHOMO_SECRET = 'mock-secret';
  security = await import('../server/lib/security.js');
  connections = await import('../server/lib/connections.js');
  store = await import('../server/lib/config-store.js');
  management = await import('../server/management.js');
  ({ httpJson } = await import('../server/mihomo.js'));
});
after(() => { api.close(); fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f), { recursive: true, force: true }); fs.writeFileSync(cfg, 'mode: rule\nrules:\n  - MATCH,DIRECT\n'); writeFileSync(bin, '#!/bin/sh\n[ "$1" = "-t" ] && exit 0\nexit 0\n'); chmodSync(bin, 0o755); failPut = 0; failConfigGet = 0; putPaths = []; runtimeConfig = { mode: 'rule' }; ignoreReload = false; removedSelector = false; });

test('authorize rejects missing token, bad origin, and DNS rebinding', () => {
  assert.equal(security.authorize({ headers: { host: '127.0.0.1:15924' }, method: 'GET' }, { host: '127.0.0.1', token: 'secret', allowedOrigins: [] }).status, 401);
  assert.equal(security.authorize({ headers: { host: '127.0.0.1:15924', authorization: 'Bearer secret', origin: 'http://evil.test' }, method: 'GET' }, { host: '127.0.0.1', token: 'secret', allowedOrigins: [] }).status, 403);
  assert.equal(security.authorize({ headers: { host: 'evil.test' }, method: 'GET' }, { host: '127.0.0.1', token: '', allowedOrigins: [] }).status, 403);
});

test('connection tracker computes rates and records closed snapshots', () => {
  const track = connections.createConnectionTracker(5);
  track([{ id: 'a', upload: 10, download: 20, metadata: { sourceIP: '1.2.3.4', sourcePort: 1 } }], 1000);
  const next = track([{ id: 'a', upload: 30, download: 60, metadata: {} }], 2000);
  assert.equal(next.connections[0].uploadSpeed, 20); assert.equal(next.connections[0].downloadSpeed, 40);
  const closed = track([], 3000).closed; assert.equal(closed[0].id, 'a'); assert.equal(closed[0].uploadSpeed, 0);
});

test('overlay markers are idempotent and preserve unrelated comments', () => {
  const text = '# keep\nmode: rule\nrules:\n  - MATCH,DIRECT\n';
  const overlay = { rules: [{ id: 'r', type: 'DOMAIN', payload: 'example.com', target: 'DIRECT', enabled: true }], network: {} };
  const onceText = store.applyOverlay(text, overlay); const twiceText = store.applyOverlay(onceText, overlay);
  assert.equal(twiceText, onceText); assert.match(twiceText, /# keep/);
});

test('network and rule validation reject unsafe values', () => {
  assert.throws(() => management.validNetwork({ port: 70000 }));
  assert.throws(() => management.validNetwork({ tun: { enable: 'yes' } }));
  assert.throws(() => management.validRules([{ type: 'DOMAIN', payload: 'a,b', target: 'DIRECT', enabled: true }]));
  assert.throws(() => management.validRules([{ type: 'IP-CIDR', payload: '10.0.0.1/99', target: 'DIRECT', enabled: true }]));
});

test('draft saves without calling mihomo and stale revisions are rejected', async () => {
  const rev = management.currentRevision();
  const result = await management.managementHandlers['POST /api/rules/draft']({ revision: rev, rules: [{ type: 'DOMAIN', payload: 'example.com', target: 'DIRECT', enabled: true }] });
  assert.equal(result.ok, true); assert.ok(fs.existsSync(path.join(state, 'draft.json')));
  await assert.rejects(() => management.managementHandlers['POST /api/network/draft']({ revision: 'stale', network: { mode: 'global' } }), /配置已变更/);
});

test('apply failure rolls configuration and overlay files back', async () => {
  const before = fs.readFileSync(cfg, 'utf8'); const rev = management.currentRevision();
  await management.managementHandlers['POST /api/rules/draft']({ revision: rev, rules: [{ type: 'DOMAIN', payload: 'example.com', target: 'DIRECT', enabled: true }] });
  writeFileSync(bin, '#!/bin/sh\nexit 1\n'); chmodSync(bin, 0o755);
  await assert.rejects(() => management.managementHandlers['POST /api/config/apply']({ revision: management.currentRevision(), confirm: true }), /内核配置校验失败/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
});

test('transaction restores config and state after runtime reload failure', async () => {
  const original = fs.readFileSync(cfg, 'utf8');
  fs.mkdirSync(path.join(state, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(state, 'selected.json'), '{"Auto":"DIRECT"}\n');
  fs.writeFileSync(path.join(state, 'overrides.json'), '{"rules":[],"network":{}}\n');
  fs.writeFileSync(path.join(state, 'draft.json'), '{"overlay":{"rules":[],"network":{}}}\n');
  failPut = 1;
  const result = await store.transaction('测试事务', () => management.managementHandlers['POST /api/config/apply']({ revision: management.currentRevision(), confirm: true }));
  assert.equal(result.ok, false); assert.equal(result.rolledBack, true);
  assert.equal(fs.readFileSync(cfg, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(state, 'selected.json'), 'utf8'), '{"Auto":"DIRECT"}\n');
  assert.equal(fs.readFileSync(path.join(state, 'overrides.json'), 'utf8'), '{"rules":[],"network":{}}\n');
  assert.equal(fs.readFileSync(path.join(state, 'draft.json'), 'utf8'), '{"overlay":{"rules":[],"network":{}}}\n');
  assert.ok(putPaths.length >= 2);
});

test('serial runs concurrent operations in queue order', async () => {
  const order = [];
  await Promise.all([
    store.serial(async () => { order.push('a:start'); await new Promise(r => setTimeout(r, 15)); order.push('a:end'); }),
    store.serial(async () => { order.push('b:start'); order.push('b:end'); }),
  ]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('successful apply persists overlay, clears draft, and exposes effective config', async () => {
  const rev = management.currentRevision();
  await management.managementHandlers['POST /api/rules/draft']({ revision: rev, rules: [{ type: 'DOMAIN', payload: 'example.com', target: 'DIRECT', enabled: true }] });
  const rev2 = management.currentRevision();
  await management.managementHandlers['POST /api/network/draft']({ revision: rev2, network: { mode: 'global', 'mixed-port': 17890 } });
  const applied = await store.transaction('应用配置', () => management.managementHandlers['POST /api/config/apply']({ revision: management.currentRevision(), confirm: true }));
  assert.equal(applied.ok, true); assert.equal(fs.existsSync(path.join(state, 'draft.json')), false);
  const overlay = JSON.parse(fs.readFileSync(path.join(state, 'overrides.json'), 'utf8'));
  assert.equal(overlay.rules[0].payload, 'example.com'); assert.equal(overlay.network.mode, 'global');
  const network = await management.managementHandlers['GET /api/network']();
  assert.equal(network.network.mode, 'global'); assert.equal(network.network['mixed-port'], 17890);
  assert.equal(putPaths.some(p => p.includes('restart')), false);
});

test('apply validates runtime GET failure and transaction rolls back', async () => {
  const original = fs.readFileSync(cfg, 'utf8');
  const rev = management.currentRevision();
  await management.managementHandlers['POST /api/rules/draft']({ revision: rev, rules: [{ type: 'DOMAIN', payload: 'bad.example', target: 'DIRECT', enabled: true }] });
  failAfterReload = true;
  const result = await store.transaction('GET失败事务', () => management.managementHandlers['POST /api/config/apply']({ revision: management.currentRevision(), confirm: true }));
  assert.equal(result.ok, false); assert.equal(fs.readFileSync(cfg, 'utf8'), original);
});

test('applyOverlay rejects flow rules and incomplete markers; backup import validates format', async () => {
  const flowText = store.applyOverlay('rules:\n  - MATCH,DIRECT\n', { rules: [{ id: 'x', type: 'DOMAIN', payload: 'x.test', target: 'DIRECT', enabled: true }], network: {} });
  assert.match(flowText, /# >>> clash-web user rules >>>/);
  assert.throws(() => store.applyOverlay('# >>> clash-web user rules >>>\nmode: rule\n', { rules: [], network: {} }), /标记不完整/);
  await assert.rejects(() => management.managementHandlers['POST /api/backups/import']({ bundle: { format: 'wrong', config: 'mode: rule' } }), /备份/);
  await assert.rejects(() => management.managementHandlers['POST /api/backups/import']({ bundle: { format: 'clash-web-backup-v1', config: 'mode: rule', overlay: { rules: [{ type: 'DOMAIN', payload: 'a', target: 'DIRECT', enabled: true }], network: { unknown: true } } } }), /网络/);
});

test('applyOverlay handles flow string rules and strips/replaces indented markers', () => {
  const base = 'rules: ["MATCH,DIRECT"]\n  # >>> clash-web user rules >>>\n  - "DOMAIN,old.example,DIRECT"\n  # <<< clash-web user rules <<<\n';
  const overlay = { rules: [{ id: 'new', type: 'DOMAIN', payload: 'new.example', target: 'DIRECT', enabled: true }], network: {} };
  const result = store.applyOverlay(base, overlay);
  assert.doesNotMatch(result, /old\.example/); assert.match(result, /new\.example/);
});

test('subscription edit rejects newline and traversal URL values', async () => {
  fs.writeFileSync(cfg, 'proxy-providers:\n  mysub:\n    url: https://old.example/sub\n    path: ./providers/mysub.yaml\n');
  for (const url of ['file:///etc/passwd', 'https://example.test/a\nX', 'https://user:pass@example.test/sub']) {
    await assert.rejects(() => management.managementHandlers['POST /api/subscriptions/edit']({ name: 'mysub', displayName: 'My', url, interval: 60, confirm: true }), /URL/);
  }
  const subs = await import('../server/lib/subscriptions.js');
  assert.throws(() => subs.providerName('../x'), /名称|无效|provider/i);
});

test('httpJson enforces an absolute timeout during a continuously streaming response', async () => {
  const started = Date.now();
  const result = await httpJson(`http://127.0.0.1:${port}/slow`, 'GET', null, 50);
  assert.equal(result.ok, false); assert.equal(result.error, 'timeout');
  assert.ok(Date.now() - started < 500);
});

test('httpJson sends mihomo bearer secret', async () => {
  bearerSeen = null; await httpJson(`http://127.0.0.1:${port}/auth`); assert.equal(bearerSeen, 'Bearer mock-secret');
});

test('transaction removes newly created provider files on failure', async () => {
  const provider = path.join(path.dirname(cfg), 'providers', 'ghost.yaml');
  const result = await store.transaction('provider', async () => { fs.mkdirSync(path.dirname(provider), { recursive: true }); fs.writeFileSync(provider, 'ghost'); throw new Error('boom'); });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(provider), false);
});

test('restore of imported backup materializes overlay into restored config', async () => {
  const imported = await management.managementHandlers['POST /api/backups/import']({ bundle: {
    format: 'clash-web-backup-v1', config: 'mode: rule\nrules:\n  - MATCH,DIRECT\n',
    overlay: { rules: [{ type: 'DOMAIN', payload: 'imported.example', target: 'DIRECT', enabled: true }], network: { mode: 'global' } },
  } });
  const backups = await management.managementHandlers['GET /api/backups']();
  const id = backups.backups.find(x => x.label?.includes('导入'))?.id;
  assert.ok(id);
  const result = await store.transaction('restore', () => management.managementHandlers['POST /api/backups/restore']({ id, revision: management.currentRevision(), confirm: true }));
  assert.equal(result.ok, true);
  const restored = fs.readFileSync(cfg, 'utf8');
  assert.match(restored, /imported\.example/);
});


test('removed selector groups do not cause a successful reload to roll back', async () => {
  removedSelector = true;
  const result = await store.reloadValidatedConfig();
  assert.equal(result.ok, true);
});

test('HTTP success without applying the requested mode is rejected and rolled back', async () => {
  await management.managementHandlers['POST /api/network/draft']({ revision: management.currentRevision(), network: { mode: 'global' } });
  ignoreReload = true;
  const original = fs.readFileSync(cfg, 'utf8');
  const result = await store.transaction('ignored reload', () => management.managementHandlers['POST /api/config/apply']({ revision: management.currentRevision(), confirm: true }));
  assert.equal(result.ok, false);
  assert.match(result.error, /未生效/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), original);
});

test('malformed subscription markers cannot be imported as a restorable backup', async () => {
  await assert.rejects(() => management.managementHandlers['POST /api/backups/import']({ bundle: {
    format: 'clash-web-backup-v1', config: 'mode: rule\n# >>> 订阅分组（clash-web 自动生成，刷新订阅时重建，请勿手改）>>>\n', overlay: { rules: [], network: {} },
  } }), /标记/);
});

test('provider writer updates only mysub URL and preserves unrelated healthcheck URL', async () => {
  const { editProvider } = await import('../server/lib/subscriptions.js');
  fs.writeFileSync(cfg, 'url: https://health.example/\nproxy-providers:\n  mysub: {type: http, url: https://old.example/, path: ./providers/mysub.yaml}\nrules: ["MATCH,DIRECT"]\n');
  editProvider({ name: 'mysub', url: 'https://new.example/sub' });
  const value = parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(value.url, 'https://health.example/');
  assert.equal(value['proxy-providers'].mysub.url, 'https://new.example/sub');
});
