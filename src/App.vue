<!-- src/App.vue -->
<template>
  <div class="app">
    <div class="app-layout">
      <ControlPanel />
      <CameraGrid />
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useCameraStore } from './stores/cameraStore'
import ControlPanel from './components/ControlPanel.vue'
import CameraGrid from './components/CameraGrid.vue'

const store = useCameraStore()

// Handle keyboard shortcuts
function handleKeyPress(event) {
  // Toggle control panel with 'P' key
  if (event.key === 'p' || event.key === 'P') {
    store.toggleControlPanel()
  }
  
  // Toggle debayer quality with 'Q' key
  if (event.key === 'q' || event.key === 'Q') {
    const qualities = ['fast', 'quality', 'high']
    const currentIndex = qualities.indexOf(store.debayerQuality)
    const nextIndex = (currentIndex + 1) % qualities.length
    store.setDebayerQuality(qualities[nextIndex])
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyPress)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyPress)
  
  // Clean up connections
  if (store.serverManager) {
    store.serverManager.disconnectAll()
  }
})
</script>

<style>
/* Global styles */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

#app {
  width: 100%;
  height: 100%;
}
</style>

<style scoped>
.app {
  width: 100%;
  height: 100vh;
  background: #0a0a0a;
  color: #ddd;
  display: flex;
  flex-direction: column;
}

.app-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}
</style>
