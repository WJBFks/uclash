<script setup lang="ts">
import { provide } from 'vue';
import { useStatus } from '@/composables/useStatus';
import StatusCard from '@/components/StatusCard.vue';
import ServicePanel from '@/components/ServicePanel.vue';
import TrafficChart from '@/components/TrafficChart.vue';
import NodePanel from '@/components/NodePanel.vue';
import ConnectionsPanel from '@/components/ConnectionsPanel.vue';
import SubscriptionPanel from '@/components/SubscriptionPanel.vue';
import ToastHost from '@/components/ToastHost.vue';

const { status, lastUpdated, statusError, refresh } = useStatus();
provide('refreshStatus', refresh);
</script>

<template>
  <div class="wrap">
    <header class="top">
      <h1>clash-web</h1>
      <span class="ver">{{ status?.version || 'mihomo 版本获取中…' }}</span>
    </header>

    <StatusCard :status="status" :status-error="statusError" :last-updated="lastUpdated" @refresh-ip="refresh" />
    <ServicePanel :status="status" />
    <TrafficChart />
    <NodePanel />
    <ConnectionsPanel />
    <SubscriptionPanel />
  </div>
  <ToastHost />
</template>
