import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-web-group-sync-'));
const cfg = path.join(root, 'config.yaml');
process.env.MIHOMO_CONFIG = cfg;
process.env.CW_STATE_DIR = path.join(root, 'state');
const sync = await import(`../server/lib/group-sync.js?test=${Date.now()}`);

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('stripSubscriptionBlocks only removes complete, non-crossing marker pairs', () => {
  const groups = '# >>> 订阅分组（clash-web 自动生成，刷新订阅时重建，请勿手改）>>>';
  const groupsEnd = '# <<< 订阅分组（clash-web 自动生成）<<<';
  const rules = '# >>> 订阅规则（clash-web 自动生成，切换/刷新订阅时重建，请勿手改）>>>';
  const rulesEnd = '# <<< 订阅规则（clash-web 自动生成）<<<';
  assert.equal(sync.stripSubscriptionBlocks(`a\n${groups}\nx\n${groupsEnd}\nb\n${rules}\ny\n${rulesEnd}\n`), 'a\nb\n');
  assert.throws(() => sync.stripSubscriptionBlocks(`a\n${groups}\nx`), /标记/);
  assert.throws(() => sync.stripSubscriptionBlocks(`${groups}\n${rules}\n${rulesEnd}\n${groupsEnd}`), /嵌套|交叉/);
  assert.throws(() => sync.stripSubscriptionBlocks(`${groupsEnd}\na`), /标记/);
});

test('provider declarations use YAML keys and their declared paths', () => {
  const cache = path.join(root, 'custom-cache.yml');
  fs.writeFileSync(cache, 'proxies:\n  - name: Node A\nproxy-groups:\n  - name: Custom\n    type: select\n    proxies: [Node A]\nrules:\n  - DOMAIN,example.test,DIRECT\n');
  fs.writeFileSync(cfg, `'provider with space': { url: https://example.test/sub, path: ${JSON.stringify(cache)}, interval: 3600 }\nproxy-providers:\n  'provider with space': { url: https://example.test/sub, path: ${JSON.stringify(cache)}, interval: 3600 }\nproxy-groups:\n  - { name: Base, type: select, use: ['provider with space'] }\n`);
  assert.deepEqual(sync.readConfigProviders(), [{ name: 'provider with space', url: 'https://example.test/sub', path: cache, interval: 3600 }]);
  assert.deepEqual(sync.activeProviderNames(), ['provider with space']);
  assert.deepEqual(sync.findProviderRefs('provider with space'), ['Base']);
  assert.equal(sync.readProviderRules(['provider with space'])[0].payload, 'example.test');
  assert.equal(sync.readProviderGroups(['provider with space'])[0].name, 'Custom');
});
