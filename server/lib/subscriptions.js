import { readConfig, yamlObject, setSection, atomicWrite } from './config-store.js';
import { stripSubscriptionBlocks } from './group-sync.js';
import { config } from '../config.js';

export function providerName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[/\\\x00-\x1f\x7f]/.test(value) || ['.', '..', 'default', '__proto__', 'prototype', 'constructor'].includes(value)) {
    throw new Error('订阅名称无效（不能含路径分隔符或控制字符）');
  }
  return value.trim();
}
export function subscriptionUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value) || value.length > 8192) throw new Error('订阅 URL 无效');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('订阅 URL 需为 HTTP(S) 地址');
  return value;
}
// All YAML writes target a structural key. In particular updating "mysub"
// must never edit the first unrelated health-check URL in the document.
export function editProvider({ name, url, remove = false, switchTo = false }) {
  name = providerName(name);
  let text = stripSubscriptionBlocks(readConfig());
  const obj = yamlObject(text);
  const providers = { ...(obj['proxy-providers'] || {}) };
  if (remove) {
    if (!Object.hasOwn(providers, name)) throw new Error('订阅未声明');
    delete providers[name];
  } else {
    subscriptionUrl(url);
    providers[name] = { ...(Object.hasOwn(providers, name) ? providers[name] : { type: 'http', path: `./providers/${name}.yaml`, interval: 86400 }), url };
  }
  text = setSection(text, 'proxy-providers', providers);
  if (switchTo) {
    const groups = obj['proxy-groups'] || [];
    let count = 0;
    for (const group of groups) {
      if (Array.isArray(group.use) && group.use.length) { group.use = [name]; count++; }
    }
    if (!count) throw new Error('没有引用订阅的基础代理组，无法激活');
    text = setSection(text, 'proxy-groups', groups);
  }
  yamlObject(text);
  atomicWrite(config.mihomoCfg, text);
}
