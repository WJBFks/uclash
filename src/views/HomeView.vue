<script setup lang="ts">
import { inject } from 'vue';
import type { StatusData } from '@/api/types';
import StatusCard from '@/components/StatusCard.vue';
import ServicePanel from '@/components/ServicePanel.vue';
import TrafficChart from '@/components/TrafficChart.vue';
import ConnectionsPanel from '@/components/ConnectionsPanel.vue';

defineProps<{
  status: StatusData | null;
  statusError: boolean;
  lastUpdated: Date | null;
}>();

const refreshStatus = inject<() => void>('refreshStatus', () => {});
</script>

<template>
  <StatusCard :status="status" :status-error="statusError" :last-updated="lastUpdated" @refresh-ip="refreshStatus" />
  <ServicePanel :status="status" />
  <TrafficChart />
  <ConnectionsPanel compact />
</template>
