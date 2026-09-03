<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from 'vue';
import { useStatus } from '@/composables/useStatus';
import HomeView from '@/views/HomeView.vue';
import NodesView from '@/views/NodesView.vue';
import SubscriptionView from '@/views/SubscriptionView.vue';
import SettingsView from '@/views/SettingsView.vue';
import ToastHost from '@/components/ToastHost.vue';

const PAGES = [
  { key: 'home', label: '首页', icon: '🏠' },
  { key: 'nodes', label: '代理组', icon: '🌐' },
  { key: 'subs', label: '订阅', icon: '📡' },
  { key: 'settings', label: '设置', icon: '⚙️' },
] as const;
type PageKey = (typeof PAGES)[number]['key'];

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
});
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
});

const currentLabel = computed(() => PAGES.find((p) => p.key === page.value)?.label || '');
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-name">clash-web</div>
        <div class="brand-sub">mihomo 管理面板</div>
      </div>
      <nav class="nav">
        <a
          v-for="p in PAGES"
          :key="p.key"
          :href="'#/' + p.key"
          :class="['nav-item', { active: p.key === page }]"
        >
          <span class="nav-icon">{{ p.icon }}</span>
          {{ p.label }}
        </a>
      </nav>
      <div class="side-foot">
        <div class="side-node">
          <span class="dot" :class="status?.mihomoAlive ? 'on' : 'off'"></span>
          {{ status?.node || '—' }}
        </div>
        <div class="side-ver muted">{{ status?.version || '…' }}</div>
      </div>
    </aside>

    <main class="main">
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
        <SettingsView v-else :status="status" />
      </div>
    </main>
  </div>
  <ToastHost />
</template>
