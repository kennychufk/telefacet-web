<!-- src/components/DebugPanel.vue -->
<template>
  <div class="debug-panel" v-if="showDebug">
    <div class="debug-header">
      <h3>Debug Information</h3>
      <button @click="$emit('close')" class="close-button">×</button>
    </div>
    
    <div class="debug-content">
      <!-- Overall Statistics -->
      <section class="debug-section">
        <h4>Overall Statistics</h4>
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-label">Total Cameras:</span>
            <span class="stat-value">{{ store.totalCameras }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Streaming Cameras:</span>
            <span class="stat-value">{{ store.streamingCameras.length }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Connected Servers:</span>
            <span class="stat-value">{{ store.connectedServers.length }}/{{ store.servers.length }}</span>
          </div>
        </div>
      </section>
      
      <!-- Server Statistics -->
      <section class="debug-section" v-for="(stats, serverIndex) in serverStats" :key="serverIndex">
        <h4>Server {{ serverIndex }} Statistics</h4>
        <div class="server-info">
          <div class="connection-status" :class="stats.connectionState">
            <span class="status-dot"></span>
            <span>{{ stats.connectionState }}</span>
          </div>
        </div>
        
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-label">Messages:</span>
            <span class="stat-value">{{ stats.messagesReceived }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Frames:</span>
            <span class="stat-value">{{ stats.framesReceived }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Chunked Frames:</span>
            <span class="stat-value">{{ stats.chunkedFramesReceived }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Bytes Received:</span>
            <span class="stat-value">{{ formatBytes(stats.bytesReceived) }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Errors:</span>
            <span class="stat-value error">{{ stats.errors }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Reconnects:</span>
            <span class="stat-value">{{ stats.reconnects }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Active Chunks:</span>
            <span class="stat-value">{{ stats.chunkBuffersActive }}</span>
          </div>
        </div>
        
        <div v-if="stats.lastError" class="error-info">
          <strong>Last Error:</strong> {{ stats.lastError }}
        </div>
      </section>
      
      <!-- System Info -->
      <section class="debug-section">
        <h4>System Information</h4>
        <div class="info-list">
          <div class="info-item">
            <span class="info-label">Debayer Quality:</span>
            <span>{{ store.debayerQuality }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">Config Loaded:</span>
            <span>{{ store.configLoaded ? 'Yes' : 'No' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">Cameras Configured:</span>
            <span>{{ store.camerasConfigured ? 'Yes' : 'No' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">Cameras Running:</span>
            <span>{{ store.camerasRunning ? 'Yes' : 'No' }}</span>
          </div>
        </div>
      </section>
      
      <!-- Actions -->
      <section class="debug-section">
        <h4>Debug Actions</h4>
        <div class="action-buttons">
          <button @click="refreshStats" class="action-button">
            Refresh Stats
          </button>
          <button @click="clearErrors" class="action-button">
            Clear Errors
          </button>
          <button @click="exportLogs" class="action-button">
            Export Logs
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useCameraStore } from '../stores/cameraStore'

const props = defineProps({
  showDebug: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close'])

const store = useCameraStore()
const serverStats = ref({})
let updateInterval = null

// Get server statistics
const refreshStats = () => {
  if (store.serverManager) {
    serverStats.value = store.serverManager.getAllStats()
  }
}

// Format bytes to human readable
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// Clear all errors
const clearErrors = () => {
  store.clearError()
  refreshStats()
}

// Export debug logs
const exportLogs = () => {
  const logs = {
    timestamp: new Date().toISOString(),
    serverStats: serverStats.value,
    storeState: {
      servers: store.servers,
      cameras: store.cameras,
      configLoaded: store.configLoaded,
      camerasConfigured: store.camerasConfigured,
      camerasRunning: store.camerasRunning,
      lastError: store.lastError
    }
  }
  
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `camera-debug-${new Date().toISOString()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(() => {
  refreshStats()
  // Update stats every 2 seconds
  updateInterval = setInterval(refreshStats, 2000)
})

onUnmounted(() => {
  if (updateInterval) {
    clearInterval(updateInterval)
  }
})
</script>

<style scoped>
.debug-panel {
  position: fixed;
  top: 20px;
  right: 20px;
  width: 400px;
  max-height: 80vh;
  background: rgba(26, 26, 26, 0.95);
  border: 1px solid #444;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  z-index: 1000;
  overflow: hidden;
  backdrop-filter: blur(10px);
}

.debug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: #2a2a2a;
  border-bottom: 1px solid #444;
}

.debug-header h3 {
  margin: 0;
  color: #ddd;
  font-size: 16px;
}

.close-button {
  background: none;
  border: none;
  color: #888;
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-button:hover {
  background: #333;
  color: #ddd;
}

.debug-content {
  padding: 16px;
  overflow-y: auto;
  max-height: calc(80vh - 60px);
}

.debug-section {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid #333;
}

.debug-section:last-child {
  border-bottom: none;
  margin-bottom: 0;
}

.debug-section h4 {
  margin: 0 0 12px 0;
  color: #4a9eff;
  font-size: 14px;
  font-weight: 600;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
}

.stat-label {
  color: #888;
  font-size: 12px;
}

.stat-value {
  color: #ddd;
  font-size: 12px;
  font-weight: 500;
  font-family: monospace;
}

.stat-value.error {
  color: #dc2626;
}

.server-info {
  margin-bottom: 12px;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
}

.connection-status.connected .status-dot {
  background: #10b981;
  box-shadow: 0 0 4px #10b981;
}

.connection-status.connecting .status-dot {
  background: #f59e0b;
  animation: pulse 1s infinite;
}

.connection-status.error .status-dot {
  background: #dc2626;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.error-info {
  margin-top: 8px;
  padding: 8px;
  background: rgba(220, 38, 38, 0.1);
  border: 1px solid rgba(220, 38, 38, 0.3);
  border-radius: 4px;
  font-size: 12px;
  color: #fca5a5;
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-item {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.info-label {
  color: #888;
}

.action-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-button {
  background: #333;
  color: #ddd;
  border: 1px solid #444;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.action-button:hover {
  background: #444;
  border-color: #555;
}
</style>
