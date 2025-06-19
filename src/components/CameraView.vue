<!-- src/components/CameraView.vue -->
<template>
  <div class="camera-view" :class="{ 'no-signal': !streaming }">
    <canvas 
      ref="canvas" 
      class="camera-canvas"
      :width="canvasWidth"
      :height="canvasHeight"
    />
    
    <div class="camera-overlay">
      <div class="camera-info">
        <span class="camera-name">cam{{ camera.globalId }}</span>
        <span class="camera-fps" v-if="streaming">{{ camera.fps }} FPS</span>
        <span class="camera-status" v-else>No Signal</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useCameraStore } from '../stores/cameraStore'
import { Debayer } from '../webgl/Debayer'

const props = defineProps({
  camera: {
    type: Object,
    required: true
  }
})

const store = useCameraStore()
const canvas = ref(null)
let debayer = null
let animationFrameId = null
let lastFrameTime = 0
const frameDropThreshold = 50 // Drop frames if more than 50ms behind

// Canvas dimensions from config
const canvasWidth = computed(() => store.config?.camera_config?.width || 1456)
const canvasHeight = computed(() => store.config?.camera_config?.height || 1088)

// Check if this camera is streaming
const streaming = computed(() => props.camera.streaming)

// Initialize WebGL debayer
onMounted(() => {
  if (canvas.value) {
    try {
      debayer = new Debayer(canvas.value, store.debayerQuality)
      debayer.setAWBGains(props.camera.awbGains)
      
      // Set up frame listener
      setupFrameListener()
    } catch (error) {
      console.error(`Failed to initialize WebGL for camera ${props.camera.globalId}:`, error)
    }
  }
})

// Clean up on unmount
onUnmounted(() => {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
  }
  
  if (frameHandler) {
    store.serverManager.off('frame', frameHandler)
  }
  
  if (debayer) {
    debayer.destroy()
  }
})

// Frame queue for this camera
const frameQueue = []
let frameHandler = null

// Set up frame event listener
function setupFrameListener() {
  frameHandler = (data) => {
    // Only process frames for this camera
    if (data.globalCameraId === props.camera.globalId) {
      // Drop old frames if queue is building up
      const now = performance.now()
      if (frameQueue.length > 0 && now - lastFrameTime > frameDropThreshold) {
        frameQueue.length = 0 // Clear queue
      }
      
      // Add frame to queue
      frameQueue.push({
        data: data.data,
        width: data.width,
        height: data.height,
        bytesPerLine: data.bytesPerLine,
        timestamp: now
      })
      
      // Start render loop if not already running
      if (!animationFrameId) {
        renderLoop()
      }
    }
  }
  
  store.serverManager.on('frame', frameHandler)
}

// Render loop using requestAnimationFrame
function renderLoop() {
  if (frameQueue.length > 0 && debayer) {
    const frame = frameQueue.shift()
    lastFrameTime = frame.timestamp
    
    try {
      debayer.processFrame(
        frame.data,
        frame.width,
        frame.height,
        frame.bytesPerLine
      )
    } catch (error) {
      console.error(`Error processing frame for camera ${props.camera.globalId}:`, error)
    }
  }
  
  // Continue render loop if streaming
  if (streaming.value) {
    animationFrameId = requestAnimationFrame(renderLoop)
  } else {
    animationFrameId = null
  }
}

// Watch for quality changes
watch(() => store.debayerQuality, (newQuality) => {
  if (debayer) {
    debayer.setQuality(newQuality)
  }
})

// Watch for streaming state changes
watch(streaming, (isStreaming) => {
  if (isStreaming && !animationFrameId) {
    renderLoop()
  } else if (!isStreaming) {
    frameQueue.length = 0 // Clear any pending frames
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }
})
</script>

<style scoped>
.camera-view {
  position: relative;
  width: 100%;
  height: 100%;
  background: #1a1a1a;
  border: 1px solid #333;
  overflow: hidden;
}

.camera-view.no-signal {
  opacity: 0.5;
}

.camera-canvas {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.camera-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 8px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.7), transparent);
  pointer-events: none;
}

.camera-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: white;
  font-size: 14px;
  font-family: monospace;
  text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
}

.camera-name {
  font-weight: bold;
}

.camera-fps {
  color: #00ff00;
}

.camera-status {
  color: #ff6666;
}
</style>
