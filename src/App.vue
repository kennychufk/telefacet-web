<!-- src/App.vue -->
<template>
  <div class="app">
    <ControlPanel />

    <PanelToggle
      :open="store.showControlPanel"
      :panel-width="210"
      @toggle="store.toggleControlPanel"
    />

    <main class="main">
      <CameraGrid v-if="appState === 'streaming'" />
      <div v-else class="empty-state">
        <div class="status-line">{{ statusMessage }}</div>
        <div v-if="appState === 'connected'" class="discovery-line">
          {{ store.totalCameras }} {{ store.totalCameras === 1 ? 'camera' : 'cameras' }} discovered
        </div>
      </div>
    </main>

    <DebugPanel :showDebug="showDebugPanel" @close="showDebugPanel = false" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useCameraStore } from './stores/cameraStore'
import ControlPanel from './components/ControlPanel.vue'
import CameraGrid from './components/CameraGrid.vue'
import DebugPanel from './components/DebugPanel.vue'
import PanelToggle from './components/PanelToggle.vue'

const store = useCameraStore()
const showDebugPanel = ref(false)

const appState = computed(() => {
  if (!store.configLoaded || !store.hasConnectedServers) return null
  if (!store.camerasConfigured) return 'connected'
  if (!store.camerasRunning) return 'configured'
  if (store.streamingCameras.length === 0) return 'running'
  return 'streaming'
})

const statusMessage = computed(() => {
  switch (appState.value) {
    case 'connected':  return 'READY — CONFIGURE CAMERAS'
    case 'configured': return 'CONFIGURED — START CAMERAS'
    case 'running':    return 'RUNNING — PRESS STREAM'
    default:           return 'LOAD CONFIG TO BEGIN'
  }
})

async function handleKeyPress(event) {
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return

  const k = event.key.toLowerCase()
  if (k === 'p') {
    store.toggleControlPanel()
  } else if (k === 'h') {
    if (!store.hasConnectedServers) return
    const next = !store.headerOnlyMode
    store.headerOnlyMode = next
    await store.setHeaderOnlyMode(next)
  } else if (k === 'r') {
    if (store.hasConnectedServers) await store.resetFrameCounts()
  } else if (k === 'd') {
    showDebugPanel.value = !showDebugPanel.value
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyPress)
  console.log('telefacet — ready')
  console.log('Shortcuts:  P · panel   H · header only   R · reset counts   D · debug')
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyPress)
  if (store.serverManager) store.serverManager.disconnectAll()
})
</script>

<style scoped>
.app {
  width: 100vw;
  height: 100vh;
  display: flex;
  background: var(--bg);
  position: relative;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}

.main {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.status-line {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-sec);
  letter-spacing: 0.1em;
}

.discovery-line {
  font-size: 10px;
  color: var(--line);
  font-family: var(--font-mono);
}
</style>
