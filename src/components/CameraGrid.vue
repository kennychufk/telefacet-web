<!-- src/components/CameraGrid.vue -->
<template>
  <div class="camera-grid-container">
    <div 
      class="camera-grid"
      :style="gridStyle"
      v-if="streamingCameras.length > 0"
    >
      <div 
        v-for="camera in streamingCameras" 
        :key="camera.globalId"
        class="grid-cell"
      >
        <CameraView :camera="camera" />
      </div>
    </div>
    
    <div v-else class="no-cameras">
      <div class="no-cameras-message">
        <h2>No Cameras Streaming</h2>
        <p v-if="store.totalCameras > 0">
          {{ store.totalCameras }} camera{{ store.totalCameras !== 1 ? 's' : '' }} discovered
        </p>
        <p v-else-if="store.configLoaded">
          Waiting for cameras to be discovered...
        </p>
        <p v-else>
          Please load a configuration file to get started
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCameraStore } from '../stores/cameraStore'
import CameraView from './CameraView.vue'

const store = useCameraStore()

// Get streaming cameras
const streamingCameras = computed(() => store.streamingCameras)

// Calculate grid dimensions
const gridDimensions = computed(() => store.getGridDimensions())

// Generate grid style
const gridStyle = computed(() => {
  const { cols, rows } = gridDimensions.value
  return {
    'grid-template-columns': `repeat(${cols}, 1fr)`,
    'grid-template-rows': `repeat(${rows}, 1fr)`
  }
})
</script>

<style scoped>
.camera-grid-container {
  flex: 1;
  width: 100%;
  height: 100%;
  background: #0a0a0a;
  position: relative;
  overflow: hidden;
}

.camera-grid {
  width: 100%;
  height: 100%;
  display: grid;
  gap: 4px;
  padding: 4px;
  box-sizing: border-box;
}

.grid-cell {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.no-cameras {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
}

.no-cameras-message {
  text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.no-cameras-message h2 {
  font-size: 24px;
  margin-bottom: 16px;
  color: #888;
}

.no-cameras-message p {
  font-size: 16px;
  margin: 8px 0;
  color: #555;
}
</style>
