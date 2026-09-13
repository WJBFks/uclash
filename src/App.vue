<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from 'vue';
import { useStatus } from '@/composables/useStatus';
import HomeView from '@/views/HomeView.vue';
import NodesView from '@/views/NodesView.vue';
import SubscriptionView from '@/views/SubscriptionView.vue';
import SettingsView from '@/views/SettingsView.vue';
import ConnectionsPanel from '@/components/ConnectionsPanel.vue';
import RulesView from '@/views/RulesView.vue';
import ConfigView from '@/views/ConfigView.vue';
import LogsView from '@/views/LogsView.vue';
import { api } from '@/api/client';
import ToastHost from '@/components/ToastHost.vue';

const PAGES = [
  { key: 'home', label: '首页', icon: '🏠' },
  { key: 'nodes', label: '代理组', icon: '🌐' },
  { key: 'subs', label: '订阅', icon: '📡' },
  { key: 'connections', label: '连接排障', icon: '🔗' },
  { key: 'rules', label: '分流规则', icon: '↗' },
  { key: 'config', label: '网络与配置', icon: '🛠' },
  { key: 'logs', label: '日志与诊断', icon: '📋' },
  { key: 'settings', label: '设置', icon: '⚙️' },
] as const;
type PageKey = (typeof PAGES)[number]['key'];

const authRequired = ref(false), authToken = ref(''), authError = ref(''), signingIn = ref(false);
const onAuthRequired = () => { authRequired.value = true; };
async function signIn() {
  signingIn.value = true; authError.value = '';
  sessionStorage.setItem('cw-token', authToken.value);
  try { await api('/config-info'); authRequired.value = false; authToken.value = ''; refresh(); }
  catch (e) { sessionStorage.removeItem('cw-token'); authError.value = e instanceof Error ? e.message : String(e); }
  finally { signingIn.value = false; }
}
const { status, lastUpdated, statusError, refresh } = useStatus();
provide('refreshStatus', refresh);

const page = ref<PageKey>('home');

function pageFromHash(): PageKey {
  const h = location.hash.replace(/^#\/?/, '');
  return (PAGES.some((p) => p.key === h) ? h : 'home') as PageKey;
}

function onHashChange() {
  page.value = pageFromHash();
}

onMounted(() => {
  page.value = pageFromHash();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('cw-auth-required', onAuthRequired);
});
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('cw-auth-required', onAuthRequired);
});

const currentLabel = computed(() => PAGES.find((p) => p.key === page.value)?.label || '');
</script>

<template>
  <div v-if="authRequired" class="auth-screen"><form class="card" @submit.prevent="signIn"><h1>管理访问密钥</h1><p class="muted">密钥仅保存在当前标签页会话中。</p><input v-model="authToken" name="access-key" type="password" autocomplete="current-password" aria-label="管理访问密钥" autofocus required /><p v-if="authError" class="fail" role="alert">{{ authError }}</p><button class="primary" :disabled="signingIn">{{ signingIn ? '验证中…' : '进入面板' }}</button></form></div>
  <div v-else class="layout">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-name">UClash</div>
        <div class="brand-sub">通用代理管理面板</div>
      </div>
      <nav class="nav">
        <a
          v-for="p in PAGES"
          :key="p.key"
          :href="'#/' + p.key"
          :class="['nav-item', { active: p.key === page }]"
          :aria-current="p.key === page ? 'page' : undefined"
        >
          <span class="nav-icon" aria-hidden="true">{{ p.icon }}</span>
          {{ p.label }}
        </a>
      </nav>
      <div class="side-foot">
        <div class="side-node">
          <span class="dot" :class="status?.mihomoAlive ? 'on' : 'off'" aria-hidden="true"></span>
          {{ status?.node || '—' }}
        </div>
        <div class="side-ver muted">{{ status?.version || '…' }}</div>
      </div>
    </aside>

    <main id="main-content" class="main" tabindex="-1">
      <div class="wrap">
        <div class="page-title">
          <h1>{{ currentLabel }}</h1>
          <span class="ver muted">最后更新 {{ lastUpdated ? lastUpdated.toLocaleTimeString() : '—' }}</span>
        </div>
        <HomeView
          v-if="page === 'home'"
          :status="status"
          :status-error="statusError"
          :last-updated="lastUpdated"
        />
        <NodesView v-else-if="page === 'nodes'" />
        <SubscriptionView v-else-if="page === 'subs'" />
        <ConnectionsPanel v-else-if="page === 'connections'" />
        <RulesView v-else-if="page === 'rules'" />
        <ConfigView v-else-if="page === 'config'" />
        <LogsView v-else-if="page === 'logs'" />
        <SettingsView v-else :status="status" />
      </div>
    </main>
  </div>
  <ToastHost />
</template>
