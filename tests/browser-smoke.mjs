import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CW_PLAYWRIGHT_MODULE || 'playwright');

const dist = process.env.CW_TEST_DIST || '/tmp/cw-ui-test-dist';
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(dist, pathname === '/' ? 'index.html' : pathname);
    const body = await readFile((await stat(file)).isFile() ? file : path.join(dist, 'index.html'));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CW_CHROMIUM_EXECUTABLE } : {}) });
const errors = [], requests = [];
const network = { tun: { enable: false, stack: 'system', 'auto-route': true, 'route-exclude-address': [] }, dns: { enable: false, 'enhanced-mode': 'fake-ip', nameserver: [] }, 'mixed-port': 7890, 'allow-lan': false, ipv6: false };
const rules = { custom: [{ id: 'existing-rule', type: 'DOMAIN', payload: 'existing.example.com', target: 'DIRECT', enabled: true, noResolve: false }], revision: 'rules-1', pending: false };
const preview = { original: 'mixed-port: 7890\n', candidate: 'mixed-port: 7890\n', changed: false, pending: false, revision: 'preview-1' };
let connectionMode = 'active';
let markImportPreviewStarted;
const importPreviewStarted = new Promise((resolve) => { markImportPreviewStarted = resolve; });
let pendingImportPreview;
function createImportPreviewDeferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}
function dataFor(url) {
  const p = url.pathname;
  if (p === '/api/status') return { service: 'active', tun: 'off', node: 'Mock Node', exitIp: '127.0.0.1', version: 'mock', mihomoAlive: true };
  if (p === '/api/rules') return { rules: [], custom: rules.custom, providers: [], targets: ['DIRECT', 'PROXY'], runtimeError: '', revision: rules.revision, pending: rules.pending };
  if (p === '/api/traffic') return { history: [{ t: 1000, up: 1024, down: 2048 }, { t: 3000, up: 3072, down: 4096 }], live: { up: 8192, down: 16384 }, intervalMs: 2000, maxPoints: 120, sampling: true };
  if (p === '/api/connections') {
    const connection = { id: 'conn-1', metadata: { host: 'seed.example.com', sourceIP: '192.0.2.10', sourcePort: 51234, destinationIP: '198.51.100.20', destinationPort: 443, network: 'tcp', type: 'mixed' }, rule: 'MATCH', rulePayload: '', chains: ['PROXY', 'Mock Node'], upload: 1, download: 2, uploadSpeed: 1, downloadSpeed: 2, processAvailable: false, processLabel: '进程信息不可用' };
    return connectionMode === 'active' ? { connections: [connection], closed: [] } : { connections: [], closed: [{ ...connection, closedAt: 2000 }] };
  }
  if (p === '/api/network') return { network, runtime: network, pending: false, revision: 'network-1', runtimeError: '' };
  if (p === '/api/config/preview') return preview;
  if (p === '/api/backups') return { backups: [], limit: 20 };
  if (p === '/api/logs') return { lines: ['INFO mock log'] };
  if (p === '/api/config-info') return { webPort: 15924, mihomoApi: 'mock', mihomoBin: 'mock', mihomoCfg: 'mock', providersDir: 'mock' };
  return { ok: true, message: 'mock ok', revision: 'network-2' };
}
async function newPage(auth401 = false) {
  const page = await browser.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); requests.push({ path: url.pathname, method: route.request().method(), body: route.request().postData() });
    if (auth401 && url.pathname === '/api/status') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unauthorized' }) });
    if (url.pathname === '/api/rules/draft' && route.request().method() === 'POST') {
      rules.custom = JSON.parse(route.request().postData() || '{}').rules; rules.revision = 'rules-2'; rules.pending = true;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { message: '规则草稿已保存', revision: rules.revision } }) });
    }
    if (url.pathname === '/api/network/draft' && route.request().method() === 'POST') {
      const patch = JSON.parse(route.request().postData() || '{}').network || {}; Object.assign(network, patch); if (patch.tun) Object.assign(network.tun, patch.tun);
      preview.pending = true; preview.changed = true; preview.candidate = 'tun:\n  enable: true\n'; preview.revision = 'preview-2';
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ok: true, message: '草稿已保存', revision: 'network-2' } }) });
    }
    if (url.pathname === '/api/import/preview') {
      markImportPreviewStarted();
      pendingImportPreview = createImportPreviewDeferred();
      await pendingImportPreview.promise;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { name: 'late-preview', nodes: 1 } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: dataFor(url) }) });
  });
  return page;
}
async function nav(page, hash, text) { await page.goto(`${base}/#/${hash}`); await page.getByText(text, { exact: false }).first().waitFor(); }
const page = await newPage();
for (const [hash, text] of [['rules', '自定义分流规则'], ['connections', 'seed.example.com'], ['config', '网络设置'], ['logs', '运行日志']]) await nav(page, hash, text);
await page.goto(`${base}/#/`);
await page.getByText('实时流量（2s 采样 · 最近 4 分钟）').waitFor();
await page.locator('polyline').nth(1).waitFor();
if (await page.locator('polyline').count() !== 2) throw new Error('流量图曲线未渲染');
if (!(await page.getByText('3 KB/s').count()) || !(await page.getByText('4 KB/s').count())) throw new Error('流量速率未显示');
if (!(await page.getByText('8 KB').count()) || !(await page.getByText('16 KB').count())) throw new Error('流量累计未显示');
await nav(page, 'connections', 'seed.example.com');
await page.evaluate(() => { document.body.style.overflow = 'scroll'; });
await page.getByRole('button', { name: '详情' }).click();
for (const text of ['192.0.2.10:51234', '198.51.100.20:443', '进程信息不可用']) await page.getByText(text, { exact: true }).waitFor();
connectionMode = 'closed';
await page.waitForTimeout(2200);
if (await page.getByRole('button', { name: '断开此连接' }).count()) throw new Error('关闭快照仍显示断开操作');
await page.getByRole('button', { name: '关闭详情' }).click();
if (await page.evaluate(() => document.body.style.overflow) !== 'scroll') throw new Error('详情替换后关闭未恢复原始滚动状态');
if (await page.evaluate(() => document.activeElement?.id) !== 'main-content') throw new Error('详情关闭后未回退焦点至主面板');
connectionMode = 'active';
await page.getByRole('button', { name: '添加规则' }).first().waitFor();
await page.getByRole('button', { name: '添加规则' }).first().click();
await page.getByLabel('新规则内容').waitFor();
await page.waitForFunction(() => document.querySelector('[aria-label="新规则内容"]')?.value === 'seed.example.com');
if (await page.getByLabel('新规则内容').inputValue() !== 'seed.example.com') throw new Error('连接添加规则未注入种子域名');
await page.getByLabel('规则内容', { exact: true }).first().waitFor();
if (await page.getByLabel('规则内容', { exact: true }).count() !== 1 || await page.getByLabel('规则内容', { exact: true }).inputValue() !== 'existing.example.com') throw new Error('已有自定义规则未显示');
await page.getByRole('button', { name: '添加' }).click();
if (await page.getByLabel('规则内容', { exact: true }).count() !== 2) throw new Error('新增规则丢失已有自定义规则');
await page.getByRole('button', { name: '保存草稿' }).click();
await page.waitForTimeout(100);
if (!requests.some((r) => r.path === '/api/rules/draft' && r.method === 'POST') || requests.some((r) => r.path === '/api/config/apply')) throw new Error('规则保存请求不符合仅草稿约束');
if (!(await page.getByRole('button', { name: '保存草稿' }).isDisabled())) throw new Error('规则草稿保存后按钮仍可用');
await nav(page, 'config', '网络设置');
await page.getByLabel('启用 TUN').check();
await page.getByRole('button', { name: '保存为草稿' }).click(); await page.waitForTimeout(100);
const draft = requests.filter((r) => r.path === '/api/network/draft').at(-1);
const body = JSON.parse(draft?.body || '{}');
if (Object.keys(body.network || {}).join(',') !== 'tun' || body.network.tun.enable !== true) throw new Error('TUN 草稿未提交最小 network patch');
if (!(await page.getByRole('button', { name: '保存为草稿' }).isDisabled())) throw new Error('网络草稿保存后按钮仍可用');
await nav(page, 'subs', '添加订阅');
const importUrl = page.getByLabel('订阅链接');
await importUrl.fill('https://example.test/subscription');
const importButton = page.getByRole('button', { name: '导入' });
await importButton.click();
await importPreviewStarted;
await page.keyboard.press('Escape');
await page.locator('[role="dialog"]').waitFor({ state: 'hidden' });
if (await importButton.isDisabled()) throw new Error('取消预览后导入按钮仍处于忙碌状态');
await importButton.click();
const importPreviewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/import/preview');
pendingImportPreview.release();
await importPreviewResponse;
await page.waitForTimeout(100);
if (await page.locator('[role="dialog"]').count()) throw new Error('迟到的订阅预览响应重新打开了对话框');
if (await page.locator('.toast-item.err').count()) throw new Error(`出现错误 toast: ${await page.locator('.toast-item.err').allTextContents()}`);
if (errors.length) throw new Error(`pageerror: ${errors.join('; ')}`);
await page.screenshot({ path: '/tmp/cw-browser/smoke.png', fullPage: true });
await page.close();
const unmountPage = await newPage();
await nav(unmountPage, 'subs', '添加订阅');
await unmountPage.getByLabel('订阅链接').fill('https://example.test/unmount');
await unmountPage.getByRole('button', { name: '导入' }).evaluate((button) => button.click());
await unmountPage.evaluate(() => { location.hash = '#/nodes'; });
await unmountPage.waitForFunction(() => location.hash === '#/nodes');
await unmountPage.waitForTimeout(50);
if (await unmountPage.evaluate(() => document.body.style.overflow)) throw new Error('订阅页卸载后遗留了滚动锁定');
await unmountPage.keyboard.press('Escape');
if (await unmountPage.locator('[role="dialog"]').count()) throw new Error('订阅页卸载后遗留了 Escape 对话框处理');
await unmountPage.close();
const authPage = await newPage(true); await authPage.goto(`${base}/#/config`); await authPage.getByText('管理访问密钥').waitFor(); await authPage.close();
await browser.close(); await new Promise((resolve) => server.close(resolve));
console.log('PASS: #/rules #/connections #/config #/logs load without pageerror');
console.log('PASS: connection rule seed; rules save only POST /api/rules/draft');
console.log('PASS: TUN save only POST /api/network/draft with { tun: { enable: true } }');
console.log('PASS: mocked 401 renders management-key login');
