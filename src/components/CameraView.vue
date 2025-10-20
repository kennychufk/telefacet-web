<!-- src/components/CameraView.vue -->
<template>
  <div class="camera-view" :class="{ 'no-signal': !streaming, 'header-only': isHeaderOnlyMode }">
    <canvas 
      ref="canvas" 
      class="camera-canvas"
      :class="{ 'hidden': isHeaderOnlyMode }"
      :width="canvasWidth"
      :height="canvasHeight"
    />
    
    <!-- Normal overlay for image mode -->
    <div class="camera-overlay" v-if="!isHeaderOnlyMode">
      <div class="camera-info">
        <span class="camera-name">cam{{ camera.globalId }}</span>
        <div class="camera-stats" v-if="streaming">
          <span class="camera-fps">{{ camera.fps }} FPS</span>
          <span class="camera-frame-id">Frame {{ latestFrameId }}</span>
          <span class="camera-frames-saved">Saved {{ camera.framesSaved }}</span>
        </div>
        <span class="camera-status" v-else>No Signal</span>
      </div>
    </div>
    
    <!-- Maximized overlay for header-only mode -->
    <div class="camera-overlay-maximized" v-if="isHeaderOnlyMode">
      <div class="camera-info-maximized">
        <div class="camera-stats-grid" v-if="streaming">
          <div class="stat-large camera-name-large">cam{{ camera.globalId }}</div>
          <div class="stat-large fps-large">{{ camera.fps }} FPS</div>
          <div class="stat-large frame-id-large">{{ latestFrameId }}</div>
          <div class="stat-large frames-saved-large">{{ camera.framesSaved }}</div>
        </div>
        <div class="camera-status-large" v-else>No Signal</div>
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
const latestFrameId = ref(0)
let debayer = null
let animationFrameId = null
let lastFrameTime = 0
const frameDropThreshold = 50
let blackFrameRendered = false

// Canvas dimensions from config
const canvasWidth = computed(() => store.config?.camera_config?.width || 1456)
const canvasHeight = computed(() => store.config?.camera_config?.height || 1088)

// Check if this camera is streaming
const streaming = computed(() => props.camera.streaming)

// Check if we're in header-only mode
const isHeaderOnlyMode = computed(() => store.headerOnlyMode)

// Initialize WebGL debayer
onMounted(() => {
  if (canvas.value) {
    try {
      debayer = new Debayer(canvas.value, store.debayerQuality)
      debayer.setAWBGains(props.camera.awbGains)
      
      // Set up frame listener
      setupFrameListener()
      
      console.log(`✅ WebGL initialized for camera ${props.camera.globalId}`)
    } catch (error) {
      console.error(`❌ Failed to initialize WebGL for camera ${props.camera.globalId}:`, error)
      store.lastError = `Camera ${props.camera.globalId}: Failed to initialize WebGL - ${error.message}`
    }
  }
})

// Clean up on unmount
onUnmounted(() => {
  console.log(`🧹 Cleaning up camera ${props.camera.globalId}`)
  
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
  }
  
  if (frameHandler) {
    store.serverManager.off('frame', frameHandler)
  }
  
  if (debayer) {
    debayer.destroy()
  }
  
  // Clear frame queue
  frameQueue.length = 0
})

// Frame queue for this camera
const frameQueue = []
let frameHandler = null

// Set up frame event listener
function setupFrameListener() {
  frameHandler = (data) => {
    // Only process frames for this camera
    if (data.globalCameraId === props.camera.globalId) {
      // Update the latest frame ID regardless of header-only mode
      latestFrameId.value = data.frameId
      
      // Check if this is a header-only frame
      if (data.isHeaderOnly || data.data.length === 0) {
        // For header-only frames, render black canvas but still update FPS and frame ID
        if (!blackFrameRendered || !store.headerOnlyMode) {
          renderBlackFrame()
          blackFrameRendered = true
        }
        return
      }
      
      // Reset black frame flag when we get real data
      blackFrameRendered = false
      
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
        frameId: data.frameId,
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

// Render a black frame for header-only mode
function renderBlackFrame() {
  if (!canvas.value) return
  
  const ctx = canvas.value.getContext('2d')
  if (ctx) {
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, canvas.value.width, canvas.value.height)
  }
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

// Watch for header-only mode changes
watch(() => store.headerOnlyMode, (isHeaderOnly) => {
  if (isHeaderOnly && streaming.value) {
    // When switching to header-only mode, clear the canvas
    renderBlackFrame()
    blackFrameRendered = true
  } else {
    // Reset the flag when switching back to normal mode
    blackFrameRendered = false
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
    // Reset frame ID when stopping
    latestFrameId.value = 0
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
  container-type: inline-size;
}

.camera-view.no-signal {
  opacity: 0.5;
}

.camera-view.header-only {
  background: #0f1419; /* Darker background for header-only mode */
}

.camera-canvas {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  transition: opacity 0.3s ease;
}

.camera-canvas.hidden {
  opacity: 0;
  pointer-events: none;
}

/* Normal overlay for image mode */
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
  align-items: flex-start;
  color: white;
  font-size: 14px;
  font-family: monospace;
  text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
}

.camera-name {
  font-weight: bold;
}

.camera-stats {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.camera-fps {
  color: #00ff00;
}

.camera-frame-id {
  color: #4a9eff;
  font-size: 12px;
}

.camera-frames-saved {
  color: #ff9500;
  font-size: 12px;
}

.camera-status {
  color: #ff6666;
}

/* Maximized overlay for header-only mode */
.camera-overlay-maximized {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(15, 20, 25, 0.9), rgba(26, 26, 26, 0.9));
  pointer-events: none;
}

.camera-info-maximized {
  width: 100%;
  height: 100%;
  padding: clamp(0.5rem, 2cqw, 2rem);
  color: white;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
  text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.3s ease-in-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.camera-stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: clamp(0.3rem, calc(1cqw + 1cqh), 2rem);
  width: 90%;
  height: 90%;
}

.camera-name-large {
  font-size: clamp(0.8rem, calc(3cqw + 3cqh), 4rem);
  font-weight: bold;
  color: #4a9eff;
  letter-spacing: 0.05em;
  background: rgba(74, 158, 255, 0.15);
  border-color: rgba(74, 158, 255, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}

.stat-large {
  font-size: clamp(0.6rem, calc(2cqw + 2cqh), 3rem);
  font-weight: 600;
  padding: clamp(0.5rem, calc(1cqw + 1cqh), 2rem);
  border-radius: clamp(6px, calc(0.75cqw + 0.75cqh), 16px);
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border: 2px solid rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  transition: all 0.2s ease;
}

.fps-large {
  color: #00ff88;
  background: rgba(0, 255, 136, 0.15);
  border-color: rgba(0, 255, 136, 0.4);
}

.frame-id-large {
  color: #4a9eff;
  background: rgba(74, 158, 255, 0.15);
  border-color: rgba(74, 158, 255, 0.4);
  font-size: clamp(1rem, calc(3cqw + 3cqh), 4.5rem);
}

.frames-saved-large {
  color: #ff9500;
  background: rgba(255, 149, 0, 0.15);
  border-color: rgba(255, 149, 0, 0.4);
  font-size: clamp(1rem, calc(3cqw + 3cqh), 4.5rem);
}

.camera-status-large {
  font-size: clamp(0.7rem, 5cqw, 3rem);
  font-weight: bold;
  color: #ff6666;
  background: rgba(255, 102, 102, 0.15);
  padding: clamp(0.4rem, 2cqw, 1rem) clamp(0.6rem, 4cqw, 2rem);
  border-radius: clamp(6px, 2cqw, 12px);
  border: 2px solid rgba(255, 102, 102, 0.4);
}

/* Container queries for responsive design based on camera view size */
@container (max-width: 400px) {
  .camera-stats-grid {
    gap: clamp(0.2rem, calc(0.8cqw + 0.8cqh), 1rem);
  }

  .camera-name-large {
    font-size: clamp(0.5rem, calc(2cqw + 2cqh), 2rem);
  }

  .stat-large {
    font-size: clamp(0.4rem, calc(1.5cqw + 1.5cqh), 1.5rem);
    padding: clamp(0.3rem, calc(0.8cqw + 0.8cqh), 1rem);
  }

  .frame-id-large,
  .frames-saved-large {
    font-size: clamp(0.6rem, calc(2cqw + 2cqh), 2.5rem);
  }
}

@container (max-width: 250px) {
  .camera-stats-grid {
    gap: clamp(0.15rem, calc(0.5cqw + 0.5cqh), 0.6rem);
  }

  .camera-name-large {
    font-size: clamp(0.4rem, calc(2.5cqw + 2.5cqh), 4rem);
  }

  .stat-large {
    font-size: clamp(0.35rem, calc(2cqw + 2cqh), 3rem);
    padding: clamp(0.2rem, calc(0.5cqw + 0.5cqh), 0.6rem);
  }

  .frame-id-large,
  .frames-saved-large {
    font-size: clamp(0.5rem, calc(2.5cqw + 2.5cqh), 4rem);
  }
}

/* Fallback media queries for browsers without container query support */
@media (max-width: 768px) {
  .camera-info-maximized {
    padding: clamp(0.3rem, 2vw, 1rem);
  }

  .camera-stats-grid {
    gap: clamp(0.4rem, 1.5vw, 1rem);
  }

  .stat-large {
    font-size: clamp(0.5rem, 3vw, 1.5rem);
    padding: clamp(0.3rem, 1.5vw, 0.8rem);
  }
}

@media (max-height: 600px) {
  .camera-stats-grid {
    gap: clamp(0.3rem, 1.5vh, 0.8rem);
  }

  .stat-large {
    font-size: clamp(0.5rem, 2.5vh, 1.2rem);
  }
}
</style>
