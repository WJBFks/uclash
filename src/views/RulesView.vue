<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type { CustomRule, RulesData } from '@/api/types';
const toast = useToast();
const data = ref<RulesData | null>(null), error = ref(''), busy = ref(false), dirty = ref(false);
const custom = ref<CustomRule[]>([]), query = ref(''), page = ref(1);
const type = ref('DOMAIN-SUFFIX'), payload = ref(''), target = ref('DIRECT');
const types = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'PROCESS-NAME', 'PROCESS-PATH'];
const filtered = computed(() => (data.value?.rules || []).filter((r) => [r.type, r.payload, r.proxy].join(' ').toLowerCase().includes(query.value.toLowerCase())));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 100)));
const rows = computed(() => filtered.value.slice((page.value - 1) * 100, page.value * 100));
watch(query, () => { page.value = 1; });
watch(pages, (n) => { if (page.value > n) page.value = n; });
async function load() {
  try { data.value = await api<RulesData>('/rules'); custom.value = JSON.parse(JSON.stringify(data.value.custom)); error.value = ''; dirty.value = false; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
function add() {
  if (!payload.value.trim()) return toast('请填写规则内容', true);
  custom.value.push({ id: `r-${Date.now()}-${Math.random().toString(36).slice(2)}`, type: type.value, payload: payload.value.trim(), target: target.value, enabled: true, noResolve: false });
  payload.value = ''; dirty.value = true;
}
function move(i: number, step: number) {
  const other = i + step;
  if (other < 0 || other >= custom.value.length) return;
  const row = custom.value.splice(i, 1)[0]!; custom.value.splice(other, 0, row); dirty.value = true;
}
async function save() {
  if (!data.value) return;
  busy.value = true;
  try { const r = await api<{ message: string; revision: string }>('/rules/draft', { method: 'POST', body: { rules: custom.value, revision: data.value.revision } });
    data.value.revision = r.revision; data.value.pending = true; dirty.value = false; toast(r.message);
  } catch (e) { toast(String(e), true); } finally { busy.value = false; }
}
async function updateProvider(name: string) {
  if (!confirm(`更新规则集合「${name}」？规则内容会立即生效。`)) return;
  busy.value = true;
  try { const r = await api<{ message: string }>('/rule-providers/refresh', { method: 'POST', body: { name }, timeout: 30000 }); toast(r.message);
    const fresh = await api<RulesData>('/rules'); if (data.value) { data.value.rules = fresh.rules; data.value.providers = fresh.providers; }
  } catch (e) { toast(String(e), true); } finally { busy.value = false; }
}
onMounted(async () => {
  await load();
  const seed = sessionStorage.getItem('cw-rule-seed');
  if (seed) { try { const v = JSON.parse(seed); type.value = v.type || 'DOMAIN'; payload.value = v.payload || ''; } catch {} sessionStorage.removeItem('cw-rule-seed'); }
});
</script>
<template>
  <div v-if="error" class="card"><p class="fail" role="alert">{{ error }}</p><button @click="load">重新读取</button></div>
  <div class="card">
    <h2>自定义分流规则 <span v-if="dirty" class="draft-badge">未保存</span><span v-else-if="data?.pending" class="draft-badge">有待应用草稿</span></h2>
    <p class="muted">按从上到下的顺序优先匹配，位于订阅规则之前。保存草稿不会改变连接；到「网络与配置」预览后手动应用。</p>
    <form class="toolbar" @submit.prevent="add">
      <select v-model="type" aria-label="新规则类型"><option v-for="t in types" :key="t">{{ t }}</option></select>
      <input v-model="payload" aria-label="新规则内容" placeholder="example.com、192.168.0.0/16 或进程名" />
      <select v-model="target" aria-label="新规则目标"><option v-for="t in data?.targets || ['DIRECT', 'REJECT']" :key="t">{{ t }}</option></select>
      <button type="submit" :disabled="!data">添加</button>
    </form>
    <div class="table-scroll"><table class="data-table rule-editor"><thead><tr><th>启用</th><th>类型</th><th>内容</th><th>策略</th><th>跳过 DNS</th><th>顺序 / 删除</th></tr></thead><tbody>
      <tr v-for="(r, i) in custom" :key="r.id">
        <td><input v-model="r.enabled" type="checkbox" :aria-label="'启用规则 ' + (i + 1)" @change="dirty = true" /></td>
        <td><select v-model="r.type" aria-label="规则类型" @change="dirty = true"><option v-for="t in types" :key="t">{{ t }}</option></select></td>
        <td><input v-model="r.payload" aria-label="规则内容" @input="dirty = true" /></td>
        <td><select v-model="r.target" aria-label="规则策略" @change="dirty = true"><option v-for="t in [...new Set([r.target, ...(data?.targets || [])])]" :key="t">{{ t }}</option></select></td>
        <td><input v-model="r.noResolve" type="checkbox" aria-label="跳过 DNS 解析" :disabled="!r.type.startsWith('IP-CIDR')" @change="dirty = true" /></td>
        <td class="nowrap"><button class="small" :disabled="i === 0" @click="move(i, -1)">↑</button> <button class="small" :disabled="i === custom.length - 1" @click="move(i, 1)">↓</button> <button class="small danger" @click="custom.splice(i, 1); dirty = true">删除</button></td>
      </tr>
    </tbody></table></div>
    <p v-if="!custom.length" class="muted">还没有自定义规则。可从连接详情为指定网站添加规则。</p>
    <div class="toolbar"><button class="primary" :disabled="busy || !data || !dirty" @click="save">保存草稿</button><a href="#/config">预览与应用配置 →</a></div>
  </div>
  <div class="card"><h2>当前运行规则</h2><p v-if="data?.runtimeError" class="fail">{{ data.runtimeError }}</p>
    <input v-model="query" class="search-wide" aria-label="搜索规则" placeholder="搜索域名、规则类型、代理策略…" />
    <div class="table-scroll"><table class="data-table"><thead><tr><th>顺序</th><th>类型</th><th>内容</th><th>策略</th></tr></thead><tbody><tr v-for="(r, i) in rows" :key="i"><td>{{ (page - 1) * 100 + i + 1 }}</td><td>{{ r.type }}</td><td>{{ r.payload || '—' }}</td><td>{{ r.proxy }}</td></tr></tbody></table></div>
    <div class="toolbar"><button :disabled="page <= 1" @click="page--">上一页</button><span>{{ page }} / {{ pages }} 页 · {{ filtered.length }} 条</span><button :disabled="page >= pages" @click="page++">下一页</button></div>
  </div>
  <div class="card"><h2>规则集合</h2><p v-if="!data?.providers.length" class="muted">没有可读取的规则集合。</p><div v-for="p in data?.providers" :key="p.name" class="toolbar"><strong>{{ p.name }}</strong><span>{{ p.ruleCount ?? '—' }} 条</span><span class="muted">{{ p.updatedAt || '更新时间未知' }}</span><button :disabled="busy" @click="updateProvider(p.name)">更新此集合</button></div></div>
</template>
<style scoped>
.rule-editor input:not([type="checkbox"]) { min-width: 150px; width: 100%; }
.rule-editor select { max-width: 220px; }
.nowrap { white-space: nowrap; }
</style>
