<template>
  <div
    class="cell"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <canvas
      ref="canvas"
      class="canvas"
      :class="{ hidden: isHeaderOnlyMode }"
      :width="canvasWidth"
      :height="canvasHeight"
    />

    <!-- Hover overlay (image mode) -->
    <div
      v-if="!isHeaderOnlyMode"
      class="hover-overlay"
      :class="{ visible: hovered }"
    >
      <div class="fps">{{ streaming ? `${camera.fps} fps` : '' }}</div>
      <div class="cam-label">cam{{ paddedId }}</div>
    </div>

    <!-- Header-only big display -->
    <div v-if="isHeaderOnlyMode && streaming" class="header-display">
      <div class="cam-label-big">cam{{ paddedId }}</div>
      <div class="big-fps">{{ camera.fps }}</div>
      <div class="big-fps-unit">fps</div>
      <div class="frame-id">#{{ latestFrameId.toLocaleString() }}</div>
    </div>

    <!-- No signal -->
    <div v-if="!streaming" class="no-signal">
      <span>NO SIGNAL</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useCameraStore } from '../stores/cameraStore'
import { Debayer } from '../webgl/Debayer'

const props = defineProps({
  camera: { type: Object, required: true }
})

const store = useCameraStore()
const canvas = ref(null)
const hovered = ref(false)
const latestFrameId = ref(0)

let debayer = null
let animationFrameId = null
let lastFrameTime = 0
const frameDropThreshold = 50
let blackFrameRendered = false
const frameQueue = []
let frameHandler = null

const canvasWidth = computed(() => store.config?.camera_config?.width || 1456)
const canvasHeight = computed(() => store.config?.camera_config?.height || 1088)
const streaming = computed(() => props.camera.streaming)
const isHeaderOnlyMode = computed(() => store.headerOnlyMode)
const paddedId = computed(() => String(props.camera.globalId).padStart(2, '0'))

onMounted(() => {
  if (!canvas.value) return
  try {
    debayer = new Debayer(canvas.value)
    setupFrameListener()
    console.log(`✅ WebGL initialized for camera ${props.camera.globalId}`)
  } catch (error) {
    console.error(`❌ Failed to initialize WebGL for camera ${props.camera.globalId}:`, error)
    store.lastError = `Camera ${props.camera.globalId}: ${error.message}`
  }
})

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
  if (frameHandler) store.serverManager.off('frame', frameHandler)
  if (debayer) debayer.destroy()
  frameQueue.length = 0
})

function setupFrameListener() {
  frameHandler = (data) => {
    if (data.globalCameraId !== props.camera.globalId) return
    latestFrameId.value = data.frameId

    if (data.isHeaderOnly || data.data.length === 0) {
      if (!blackFrameRendered || !store.headerOnlyMode) {
        renderBlackFrame()
        blackFrameRendered = true
      }
      return
    }

    blackFrameRendered = false

    const now = performance.now()
    if (frameQueue.length > 0 && now - lastFrameTime > frameDropThreshold) {
      frameQueue.length = 0
    }

    frameQueue.push({
      data: data.data,
      width: data.width,
      height: data.height,
      bytesPerLine: data.bytesPerLine,
      frameId: data.frameId,
      timestamp: now
    })

    if (!animationFrameId) renderLoop()
  }

  store.serverManager.on('frame', frameHandler)
}

function renderBlackFrame() {
  if (!canvas.value) return
  const ctx = canvas.value.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#08080c'
    ctx.fillRect(0, 0, canvas.value.width, canvas.value.height)
  }
}

function renderLoop() {
  if (frameQueue.length > 0 && debayer) {
    const frame = frameQueue.shift()
    lastFrameTime = frame.timestamp
    try {
      debayer.processFrame(frame.data, frame.width, frame.height, frame.bytesPerLine)
    } catch (error) {
      console.error(`Error processing frame for camera ${props.camera.globalId}:`, error)
    }
  }

  if (streaming.value) {
    animationFrameId = requestAnimationFrame(renderLoop)
  } else {
    animationFrameId = null
  }
}

watch(() => store.debayerQuality, (q) => debayer?.setQuality(q))

watch(() => store.headerOnlyMode, (on) => {
  if (on && streaming.value) {
    renderBlackFrame()
    blackFrameRendered = true
  } else {
    blackFrameRendered = false
  }
})

watch(streaming, (on) => {
  if (on && !animationFrameId) {
    renderLoop()
  } else if (!on) {
    frameQueue.length = 0
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    latestFrameId.value = 0
  }
})
</script>

<style scoped>
.cell {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
  container-type: size;
}

.canvas {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  transition: opacity 0.2s ease;
}

.canvas.hidden {
  opacity: 0;
}

/* Hover overlay (image mode) */
.hover-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s ease;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.55) 0%,
    transparent 40%,
    transparent 60%,
    rgba(0, 0, 0, 0.4) 100%
  );
}

.hover-overlay.visible {
  opacity: 1;
}

.hover-overlay .fps {
  position: absolute;
  top: 8px;
  right: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--live);
  letter-spacing: 0.04em;
}

.hover-overlay .cam-label {
  position: absolute;
  bottom: 8px;
  left: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.04em;
}

/* Header-only big display */
.header-display {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  animation: fade-in 0.2s ease;
}

.cam-label-big {
  font-family: var(--font-mono);
  font-size: clamp(11px, 3cqw, 16px);
  color: var(--accent-dim);
  letter-spacing: 0.1em;
}

.big-fps {
  font-family: var(--font-mono);
  font-size: clamp(18px, 8cqw, 52px);
  font-weight: 500;
  color: var(--live);
  letter-spacing: -0.02em;
  line-height: 1;
}

.big-fps-unit {
  font-family: var(--font-mono);
  font-size: clamp(10px, 3cqw, 14px);
  color: var(--text-sec);
  margin-top: 2px;
}

.frame-id {
  font-family: var(--font-mono);
  font-size: clamp(9px, 2.5cqw, 13px);
  color: var(--text-sec);
}

/* No signal */
.no-signal {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.no-signal span {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-sec);
  letter-spacing: 0.1em;
}
</style>
