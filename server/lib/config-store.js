import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseDocument, stringify, isMap } from 'yaml';
import { config } from '../config.js';
import { httpJson, run } from '../mihomo.js';

export const stateFile = (name) => path.join(config.stateDir, name);
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, value, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export const writeJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
export const readConfig = () => fs.readFileSync(config.mihomoCfg, 'utf8');
export const revision = (text) => createHash('sha256').update(text).digest('hex');
export function yamlDocument(text) {
  const doc = parseDocument(text, { merge: true });
  if (doc.errors.length) throw new Error('YAML 无效：' + doc.errors[0].message);
  if (!isMap(doc.contents)) throw new Error('配置必须是 YAML 对象');
  doc.toJS({ maxAliasCount: 100 });
  return doc;
}
export const yamlObject = (text) => yamlDocument(text).toJS({ maxAliasCount: 100 });
// Replace only the requested top-level section. Subscription marker comments in
// other sections must remain byte-for-byte intact for the legacy group merger.
export function setSection(text, key, value) {
  const doc = yamlDocument(text);
  const pair = doc.contents.items.find((p) => String(p.key.value) === key);
  const replacement = stringify({ [key]: value }, { indent: 2, lineWidth: 0 });
  if (!pair) return text.replace(/\s*$/, '\n') + replacement;
  const start = pair.key.range[0];
  const end = pair.value?.range?.[2] ?? pair.key.range[2];
  return text.slice(0, start) + replacement + text.slice(end);
}

export const emptyOverlay = () => ({ rules: [], network: {} });
export const readOverlay = () => readJson(stateFile('overrides.json'), emptyOverlay());
export const readDraft = () => readJson(stateFile('draft.json'), null);
const RULE_START = '# >>> clash-web user rules >>>';
const RULE_END = '# <<< clash-web user rules <<<';
export function applyOverlay(text, overlay = readOverlay()) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const markers = lines.map((line) => line.trim());
  const start = markers.indexOf(RULE_START), end = markers.indexOf(RULE_END);
  if (markers.filter((l) => l === RULE_START).length > 1 || markers.filter((l) => l === RULE_END).length > 1) throw new Error('自定义规则标记重复');
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end <= start)) throw new Error('自定义规则标记不完整');
  if (start >= 0) lines.splice(start, end - start + 1);
  text = lines.join('\n');
  for (const [key, value] of Object.entries(overlay.network || {})) {
    const original = yamlObject(text)[key];
    const merged = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(original || {}), ...value } : value;
    text = setSection(text, key, merged);
  }
  const enabled = (overlay.rules || []).filter((r) => r.enabled);
  if (enabled.length) {
    let doc = yamlDocument(text);
    const rules = doc.get('rules', true);
    if (!rules || !Array.isArray(rules.items) || !rules.items.length || rules.flow) {
      text = setSection(text, 'rules', yamlObject(text).rules || []);
      // Empty sequences must be expanded before inserting a marked block.
      text = text.replace(/^rules: \[\]\s*$/m, 'rules:\n');
      doc = yamlDocument(text);
    }
    const ruleLines = enabled.map((r) => '  - ' + JSON.stringify(`${r.type},${r.payload},${r.target}${r.noResolve ? ',no-resolve' : ''}`));
    const pair = doc.contents.items.find((p) => p.key.value === 'rules');
    const at = text.indexOf('\n', pair.key.range[0]) + 1;
    text = text.slice(0, at) + [RULE_START, ...ruleLines, RULE_END, ''].join('\n') + text.slice(at);
  }
  yamlDocument(text);
  return text;
}

export async function validateConfig(text) {
  yamlDocument(text);
  // Separate validation process, isolated working directory and cache copies;
  // never passes start/restart arguments or touches the running core's files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-check-'));
  const candidate = path.join(dir, 'config.yaml');
  try {
    const cfgDir = path.dirname(config.mihomoCfg);
    const value = yamlObject(text);
    for (const section of ['proxy-providers', 'rule-providers']) {
      for (const [name, provider] of Object.entries(value[section] || {})) {
        if (!provider || typeof provider !== 'object') throw new Error('provider 配置无效：' + name);
        const resource = path.join(dir, section, randomUUID() + '.yaml');
        fs.mkdirSync(path.dirname(resource), { recursive: true });
        if (provider.path) {
          const source = path.resolve(cfgDir, provider.path);
          if (fs.existsSync(source)) fs.copyFileSync(source, resource);
        }
        provider.path = resource;
      }
    }
    for (const name of ['Country.mmdb', 'GeoIP.dat', 'GeoSite.dat', 'geoip.metadb', 'geosite.dat', 'geoip.dat']) {
      const src = path.join(cfgDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    }
    fs.writeFileSync(candidate, stringify(value, { lineWidth: 0 }), { mode: 0o600 });
    const r = await run(config.mihomoBin, ['-t', '-d', dir, '-f', candidate], 30000);
    if (r.code !== 0) throw new Error('内核配置校验失败：' + (r.stderr || r.stdout || `exit ${r.code}`).slice(-1800));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const context = new AsyncLocalStorage();
let queue = Promise.resolve();
export function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
export function markRuntimeTouched(selections, runtimeConfig) {
  const ctx = context.getStore();
  if (ctx) { ctx.runtimeTouched = true; if (selections && !ctx.selections) ctx.selections = selections; if (runtimeConfig && !ctx.runtimeConfig) ctx.runtimeConfig = runtimeConfig; }
}
export async function reloadValidatedConfig() {
  const text = readConfig();
  await validateConfig(text);
  const [before, runtime] = await Promise.all([httpJson(config.mihomoApi + '/proxies'), httpJson(config.mihomoApi + '/configs')]);
  if (!runtime.ok || !runtime.json) throw new Error('无法读取当前运行配置，已取消重载');
  if (!before.ok || !before.json?.proxies) throw new Error('无法读取当前节点选择，已取消重载');
  const ctx = context.getStore();
  if (ctx && !ctx.selections) ctx.selections = before.json?.proxies;
  if (ctx && !ctx.runtimeConfig) ctx.runtimeConfig = runtime.json;
  if (ctx) ctx.runtimeTouched = true; // timeout may still have applied the change
  const result = await httpJson(config.mihomoApi + '/configs', 'PUT', { path: config.mihomoCfg }, 30000);
  if (!result.ok) return result;
  const check = await httpJson(config.mihomoApi + '/configs');
  if (!check.ok || !check.json) return { ok: false, error: '重载后无法确认内核运行状态' };
  const expected = yamlObject(text);
  for (const key of ['mode', 'port', 'mixed-port', 'socks-port', 'allow-lan', 'ipv6']) {
    if (expected[key] !== undefined && check.json[key] !== expected[key]) throw new Error('配置应用未生效：' + key);
  }
  if (expected.tun?.enable !== undefined && check.json.tun?.enable !== expected.tun.enable) throw new Error('TUN 设置未生效');
  for (const [name, proxy] of Object.entries(before.json?.proxies || {})) {
    if (proxy.type === 'Selector' && proxy.now) {
      const result = await httpJson(config.mihomoApi + '/proxies/' + encodeURIComponent(name), 'PUT', { name: proxy.now });
      if (!result.ok) {
        const available = await httpJson(config.mihomoApi + '/proxies/' + encodeURIComponent(name));
        if ((!available.ok && available.status !== 404) || (available.ok && available.json?.all?.includes(proxy.now))) throw new Error('恢复节点选择失败：' + name);
      }
    }
  }
  return result;
}

function snapshot() {
  const files = new Set([config.mihomoCfg, config.mihomoCfg + '.wjbase', ...['selected.json', 'overrides.json', 'draft.json', 'subscription-labels.json'].map(stateFile)]);
  const providers = path.join(path.dirname(config.mihomoCfg), 'providers');
  if (fs.existsSync(providers)) for (const name of fs.readdirSync(providers)) {
    if (/\.ya?ml$/.test(name)) files.add(path.join(providers, name));
  }
  for (const p of Object.values(yamlObject(readConfig())['proxy-providers'] || {})) {
    if (p.path) files.add(path.resolve(path.dirname(config.mihomoCfg), p.path));
  }
  return new Map([...files].map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
}
export async function transaction(label, fn) {
  const snap = snapshot();
  const ctx = { runtimeTouched: false, selections: null, runtimeConfig: null, pendingBackups: [] };
  return context.run(ctx, async () => {
    try {
      const result = await fn();
      if (result?.ok === false) throw new Error(result.error || result.message || '操作失败');
      try { pruneBackups(); } catch { /* Retention failure must not undo an applied configuration. */ }
      return result;
    } catch (e) {
      const failures = [];
      // Remove provider caches created by a failed import. Without this step a
      // rolled-back declaration would remain visible as an orphan subscription.
      const providerDir = path.join(path.dirname(config.mihomoCfg), 'providers');
      if (fs.existsSync(providerDir)) for (const name of fs.readdirSync(providerDir)) {
        const file = path.join(providerDir, name);
        if (/\.ya?ml$/.test(name) && !snap.has(file)) {
          try { fs.rmSync(file); } catch (error) { failures.push(error.message); }
        }
      }
      for (const [file, value] of snap) {
        try { value === null ? fs.rmSync(file, { force: true }) : atomicWrite(file, value); }
        catch (error) { failures.push(error.message); }
      }
      if (ctx.runtimeTouched) {
        const r = await httpJson(config.mihomoApi + '/configs', 'PUT', { path: config.mihomoCfg }, 30000);
        if (r.ok && ctx.runtimeConfig?.mode) {
          const restoredMode = await httpJson(config.mihomoApi + '/configs', 'PATCH', { mode: ctx.runtimeConfig.mode });
          if (!restoredMode.ok) failures.push('运行模式回滚失败');
        }
        const check = r.ok ? await httpJson(config.mihomoApi + '/configs') : null;
        if (!r.ok || !check?.ok || (ctx.runtimeConfig?.mode && check.json?.mode !== ctx.runtimeConfig.mode)) failures.push('内核回滚未确认，请检查服务状态');
        for (const [name, proxy] of Object.entries(ctx.selections || {})) {
          if (proxy.type === 'Selector' && proxy.now) {
            const result = await httpJson(config.mihomoApi + '/proxies/' + encodeURIComponent(name), 'PUT', { name: proxy.now });
            if (!result.ok) failures.push('节点选择回滚失败：' + name);
          }
        }
      }
      if (!failures.length) for (const id of ctx.pendingBackups) { try { fs.rmSync(stateFile('backups/' + id), { force: true }); } catch {} }
      return { ok: false, rolledBack: !failures.length, backup: failures.length ? ctx.pendingBackups[0] : undefined, error: `${label}失败：${e.message}；${failures.length ? failures.join('；') : '配置与选中状态已回滚'}` };
    }
  });
}

export function backup(label) {
  const id = Date.now() + '-' + randomUUID() + '.json';
  const bundle = { format: 'clash-web-backup-v1', at: new Date().toISOString(), label,
    config: readConfig(), overlay: readOverlay(), selected: readJson(stateFile('selected.json'), null) };
  writeJson(stateFile('backups/' + id), bundle);
  const ctx = context.getStore();
  if (ctx) ctx.pendingBackups.push(id);
  else pruneBackups();
  return id;
}
export function pruneBackups() {
  for (const old of listBackups().slice(config.backupLimit)) fs.rmSync(stateFile('backups/' + old.id));
}
export function listBackups() {
  const dir = stateFile('backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^\d+-[\da-f-]+\.json$/.test(n)).sort().reverse().map((id) => {
    const b = readJson(path.join(dir, id), {});
    return { id, at: b.at, label: b.label, bytes: fs.statSync(path.join(dir, id)).size };
  });
}
export function readBackup(id) {
  if (!listBackups().some((b) => b.id === id)) throw new Error('备份不存在');
  return readJson(stateFile('backups/' + id), null);
}
