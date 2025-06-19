<!-- src/components/ServerStatus.vue -->
<template>
  <div class="server-status" :class="{ connected: server.connected }">
    <div class="status-indicator" :class="statusClass"></div>
    <div class="server-info">
      <p class="server-address">{{ server.address }}</p>
      <p class="server-details">
        <span v-if="server.connected">
          {{ server.cameras }} camera{{ server.cameras !== 1 ? 's' : '' }}
        </span>
        <span v-else>Disconnected</span>
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  server: {
    type: Object,
    required: true
  }
})

const statusClass = computed(() => ({
  'status-connected': props.server.connected,
  'status-disconnected': !props.server.connected
}))
</script>

<style scoped>
.server-status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: #2a2a2a;
  border: 1px solid #333;
  border-radius: 4px;
  margin-bottom: 8px;
  transition: all 0.2s;
}

.server-status.connected {
  border-color: #10b981;
}

.status-indicator {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: all 0.2s;
}

.status-connected {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
}

.status-disconnected {
  background: #ef4444;
}

.server-info {
  flex: 1;
  min-width: 0;
}

.server-address {
  margin: 0;
  color: #ddd;
  font-size: 13px;
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-details {
  margin: 2px 0 0 0;
  color: #888;
  font-size: 12px;
}
</style>
