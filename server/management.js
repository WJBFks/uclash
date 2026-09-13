import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { probeHttpsThroughProxy } from './lib/proxy-probe.js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { httpJson, run } from './mihomo.js';
import { applyOverlay, readOverlay, readDraft, readConfig, yamlObject, setSection, revision, stateFile, readJson, writeJson, atomicWrite, validateConfig, reloadValidatedConfig, backup, listBackups, readBackup, pruneBackups } from './lib/config-store.js';

import { stripSubscriptionBlocks } from './lib/group-sync.js';
import { providerName, subscriptionUrl } from './lib/subscriptions.js';

const api = (p, method = 'GET', body = null) => httpJson(config.mihomoApi + p, method, body);
const requireOk = (r) => { if (!r.ok) throw new Error(r.error || `内核请求失败 HTTP ${r.status}`); return r.json; };
export const currentRevision = () => revision(readConfig() + JSON.stringify(readOverlay()) + JSON.stringify(readDraft()));
function expectRevision(value) { if (value !== currentRevision()) throw new Error('配置已变更，请重新读取并预览后再操作'); }
function confirmApply(value) { if (value !== true) throw new Error('需要明确确认应用配置，操作可能影响现有连接'); }
export function validRules(rules) {
  if (!Array.isArray(rules) || rules.length > 2000) throw new Error('自定义规则最多 2000 条');
  const types = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'PROCESS-NAME', 'PROCESS-PATH'];
  const ids = new Set();
  return rules.map((r) => {
    if (!r || !types.includes(r.type) || typeof r.enabled !== 'boolean') throw new Error('规则类型或启用状态无效');
    for (const key of ['payload', 'target']) if (typeof r[key] !== 'string' || !r[key].trim() || /[,\r\n\x00]/.test(r[key]) || r[key].length > 1024) throw new Error('规则内容与策略不能为空，且不能含逗号或换行');
    if (r.type.startsWith('IP-CIDR') && !validCidr(r.payload)) throw new Error('请输入有效 CIDR 网段');
    const id = typeof r.id === 'string' && /^[\w-]{1,80}$/.test(r.id) ? r.id : randomUUID();
    if (ids.has(id)) throw new Error('规则 ID 重复');
    ids.add(id);
    return { id, type: r.type, payload: r.payload.trim(), target: r.target, enabled: r.enabled, noResolve: r.type.startsWith('IP-CIDR') && r.noResolve === true };
  });
}
function validCidr(value) {
  const [ip, prefix, extra] = String(value).split('/');
  const version = net.isIP(ip);
  return !extra && !!version && /^\d+$/.test(prefix || '') && Number(prefix) <= (version === 4 ? 32 : 128);
}
export function validNetwork(network) {
  if (!network || typeof network !== 'object' || Array.isArray(network)) throw new Error('网络设置无效');
  const keys = ['tun', 'dns', 'mixed-port', 'port', 'socks-port', 'allow-lan', 'ipv6', 'mode'];
  for (const [key, value] of Object.entries(network)) {
    if (!keys.includes(key)) throw new Error('不允许修改网络字段：' + key);
    if (key.endsWith('port') && (!Number.isInteger(value) || value < 0 || value > 65535)) throw new Error('端口必须是 0–65535 的整数');
    if (['allow-lan', 'ipv6'].includes(key) && typeof value !== 'boolean') throw new Error('开关必须是布尔值');
    if (key === 'mode' && !['rule', 'global', 'direct'].includes(value)) throw new Error('模式无效');
    if (key === 'tun' || key === 'dns') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(key + ' 必须是对象');
      const allowed = key === 'tun' ? ['enable', 'stack', 'auto-route', 'strict-route', 'auto-detect-interface', 'route-exclude-address', 'dns-hijack', 'mtu'] : ['enable', 'enhanced-mode', 'nameserver', 'fallback', 'fake-ip-filter', 'ipv6'];
      for (const [k, v] of Object.entries(value)) {
        if (!allowed.includes(k)) throw new Error('不支持的字段：' + key + '.' + k);
        if (['enable', 'auto-route', 'strict-route', 'auto-detect-interface', 'ipv6'].includes(k) && typeof v !== 'boolean') throw new Error(k + ' 必须是布尔值');
        if (['route-exclude-address', 'dns-hijack', 'nameserver', 'fallback', 'fake-ip-filter'].includes(k) && (!Array.isArray(v) || v.length > 500 || v.some((x) => typeof x !== 'string' || /[\r\n\x00]/.test(x)))) throw new Error(k + ' 必须是字符串列表');
        if (k === 'route-exclude-address' && v.some((x) => !validCidr(x))) throw new Error('排除地址必须是 CIDR 网段');
        if (k === 'stack' && !['system', 'gvisor', 'mixed'].includes(v)) throw new Error('TUN 堆栈无效');
        if (k === 'enhanced-mode' && !['fake-ip', 'redir-host'].includes(v)) throw new Error('DNS 模式无效');
        if (k === 'mtu' && (!Number.isInteger(v) || v < 576 || v > 65535)) throw new Error('MTU 无效');
      }
    }
  }
  return network;
}
function draftOverlay() { return readDraft()?.overlay || readOverlay(); }
function saveDraft(overlay, baseRevision) {
  expectRevision(baseRevision);
  writeJson(stateFile('draft.json'), { overlay, at: new Date().toISOString() });
  return { ok: true, message: '草稿已保存，尚未应用到 mihomo', revision: currentRevision() };
}
export function redact(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL 已隐藏]')
    .replace(/((?:password|passwd|secret|token|authorization|uuid)\s*[:=]\s*)[^\s,]+/gi, '$1[已隐藏]')
    .replaceAll(config.home, '~');
}
export const managementHandlers = {
  async 'GET /api/rules'() {
    const [r, p, groups] = await Promise.all([api('/rules'), api('/providers/rules'), api('/proxies')]);
    return { ok: true, rules: r.json?.rules || [], runtimeError: r.ok ? '' : '无法读取运行规则',
      providers: Object.entries(p.json?.providers || {}).map(([name, data]) => ({ name, ...data })),
      targets: [...new Set(['DIRECT', 'REJECT', ...Object.keys(groups.json?.proxies || {})])],
      custom: draftOverlay().rules, pending: !!readDraft(), revision: currentRevision() };
  },
  async 'POST /api/rules/draft'({ rules, revision: rev }) {
    return saveDraft({ ...draftOverlay(), rules: validRules(rules) }, rev);
  },
  async 'POST /api/rule-providers/refresh'({ name }) {
    const r = requireOk(await api('/providers/rules'));
    if (typeof name !== 'string' || !Object.hasOwn(r.providers || {}, name)) throw new Error('规则集合不存在');
    requireOk(await api('/providers/rules/' + encodeURIComponent(name), 'PUT'));
    return { ok: true, message: '规则集合已更新' };
  },
  async 'GET /api/network'() {
    const runtime = await api('/configs');
    const effective = yamlObject(applyOverlay(readConfig(), draftOverlay()));
    const fields = ['tun', 'dns', 'mixed-port', 'port', 'socks-port', 'allow-lan', 'ipv6', 'mode'];
    const pick = (obj) => Object.fromEntries(fields.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
    return { ok: true, network: pick(effective), runtime: pick(runtime.json), runtimeError: runtime.ok ? '' : '无法读取内核运行状态', pending: !!readDraft(), revision: currentRevision() };
  },
  async 'POST /api/network/draft'({ network, revision: rev }) {
    const overlay = draftOverlay();
    const patch = validNetwork(network);
    const merged = { ...overlay.network, ...patch };
    for (const key of ['tun', 'dns']) if (patch[key]) merged[key] = { ...overlay.network[key], ...patch[key] };
    return saveDraft({ ...overlay, network: merged }, rev);
  },
  async 'GET /api/config/preview'() {
    const original = readConfig(), candidate = applyOverlay(original, draftOverlay());
    return { ok: true, original, candidate, changed: original !== candidate, pending: !!readDraft(), revision: currentRevision() };
  },
  async 'POST /api/config/validate'({ revision: rev }) {
    expectRevision(rev);
    await validateConfig(applyOverlay(readConfig(), draftOverlay()));
    return { ok: true, message: 'YAML 与内核配置校验通过，尚未应用' };
  },
  async 'POST /api/config/apply'({ revision: rev, confirm }) {
    confirmApply(confirm); expectRevision(rev);
    const overlay = draftOverlay();
    const candidate = applyOverlay(readConfig(), overlay);
    stripSubscriptionBlocks(candidate);
    await validateConfig(candidate);
    const id = backup('应用规则 / 网络设置前');
    atomicWrite(config.mihomoCfg, candidate);
    requireOk(await reloadValidatedConfig());
    writeJson(stateFile('overrides.json'), overlay);
    fs.rmSync(stateFile('draft.json'), { force: true });
    return { ok: true, message: '配置已应用，已保留变更前备份', backup: id };
  },
  async 'POST /api/config/discard'({ revision: rev }) {
    expectRevision(rev);
    fs.rmSync(stateFile('draft.json'), { force: true });
    return { ok: true, message: '草稿已丢弃' };
  },
  async 'GET /api/backups'() { return { ok: true, backups: listBackups(), limit: config.backupLimit }; },
  async 'POST /api/backups/create'() { return { ok: true, id: backup('手动备份'), message: '本地备份已创建' }; },
  async 'GET /api/backups/export'({ id }) { return { ok: true, bundle: readBackup(id) }; },
  async 'POST /api/backups/import'({ bundle }) {
    if (!bundle || bundle.format !== 'clash-web-backup-v1' || typeof bundle.config !== 'string' || bundle.config.length > 4e6) throw new Error('不支持的备份文件');
    stripSubscriptionBlocks(bundle.config);
    const configData = yamlObject(bundle.config);
    let selected = null;
    if (bundle.selected?.selected === 'default') selected = { selected: 'default' };
    else if (bundle.selected?.selected) {
      const name = providerName(bundle.selected.selected);
      if (!Object.hasOwn(configData['proxy-providers'] || {}, name)) throw new Error('备份选中源不在配置中');
      selected = { selected: name };
    }
    const overlay = { rules: validRules(bundle.overlay?.rules || []), network: validNetwork(bundle.overlay?.network || {}) };
    const id = Date.now() + '-' + randomUUID() + '.json';
    writeJson(stateFile('backups/' + id), { format: bundle.format, config: bundle.config, overlay, selected, at: new Date().toISOString(), label: '导入的备份（尚未恢复）' });
    pruneBackups();
    return { ok: true, message: '备份已导入，尚未恢复' };
  },
  async 'POST /api/backups/restore'({ id, revision: rev, confirm }) {
    confirmApply(confirm); expectRevision(rev);
    const b = readBackup(id);
    const overlay = { rules: validRules(b.overlay?.rules || []), network: validNetwork(b.overlay?.network || {}) };
    const candidate = applyOverlay(b.config, overlay);
    stripSubscriptionBlocks(candidate);
    await validateConfig(candidate);
    backup('恢复备份前');
    atomicWrite(config.mihomoCfg, candidate);
    requireOk(await reloadValidatedConfig());
    writeJson(stateFile('overrides.json'), overlay);
    if (b.selected) writeJson(stateFile('selected.json'), b.selected);
    else fs.rmSync(stateFile('selected.json'), { force: true });
    fs.rmSync(stateFile('draft.json'), { force: true });
    return { ok: true, message: '备份已恢复' };
  },
  async 'DELETE /api/backups'({ id }) {
    readBackup(id); fs.rmSync(stateFile('backups/' + id));
    return { ok: true, message: '备份已删除' };
  },
  async 'POST /api/subscriptions/edit'({ name, displayName, url, interval, confirm }) {
    confirmApply(confirm);
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100) throw new Error('显示名称无效');
    providerName(name); subscriptionUrl(url);
    const obj = yamlObject(readConfig());
    const provider = Object.hasOwn(obj['proxy-providers'] || {}, name) ? obj['proxy-providers'][name] : null;
    if (!provider) throw new Error('订阅源未声明');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('订阅 URL 无效');
    if (!Number.isInteger(interval) || interval < 60 || interval > 2592000) throw new Error('更新间隔需为 60–2592000 秒');
    obj['proxy-providers'][name] = { ...provider, url, interval };
    const text = setSection(readConfig(), 'proxy-providers', obj['proxy-providers']);
    await validateConfig(text); backup('编辑订阅前');
    atomicWrite(config.mihomoCfg, text); requireOk(await reloadValidatedConfig());
    const labels = readJson(stateFile('subscription-labels.json'), {});
    labels[name] = displayName.trim(); writeJson(stateFile('subscription-labels.json'), labels);
    return { ok: true, message: '订阅设置已保存，显示名称不改变策略组引用' };
  },
  async 'GET /api/diagnostics'({ name = 'example.com' }) {
    if (typeof name !== 'string' || !/^[a-z\d.-]{1,253}$/i.test(name)) throw new Error('请输入域名，不含协议或路径');
    const [version, runtime, dns, logs] = await Promise.all([
      api('/version'), api('/configs'), api('/dns/query?name=' + encodeURIComponent(name) + '&type=A'),
      run(config.journalctlBin, ['--user', '-u', config.serviceName, '-n', '200', '--no-pager'], 15000),
    ]);
    const port = runtime.json?.['mixed-port'] || runtime.json?.port;
    const portReachable = port ? await new Promise((resolve) => {
      const socket = net.createConnection({ host: new URL(config.mihomoApi).hostname, port });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(2000, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    }) : false;
    const target = portReachable ? await probeHttpsThroughProxy({ proxyHost: new URL(config.mihomoApi).hostname, proxyPort: port, hostname: name }) : null;
    return { ok: true, report: { target: target ? { ok: target.ok, result: target.ok ? `${target.status} ${target.elapsed}` : '', error: target.ok ? null : redact(target.error) } : { ok: false, error: '代理端口不可达，跳过网站测试' }, at: new Date().toISOString(), coreReachable: version.ok, version: version.json?.version || null,
      configReadable: fs.existsSync(config.mihomoCfg), binaryExists: fs.existsSync(config.mihomoBin),
      mode: runtime.json?.mode, tun: runtime.json?.tun?.enable, proxyPort: port || null, portReachable,
      dns: dns.ok ? { status: dns.json?.Status, answers: (dns.json?.Answer || []).map((a) => a.data) } : { error: 'DNS 查询失败' },
      logs: redact(logs.stdout).split('\n') } };
  },
};
