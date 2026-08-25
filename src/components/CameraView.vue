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

    <!-- Detection overlay: checkerboard corners (green) and ArUco markers
         (amber). Sized from the frames actually received — the server's
         coordinates are in the streamed frame's pixel space, which differs
         from the configured size whenever libcamera snaps the resolution or
         the stream is subsampled — so they map 1:1. Hidden alongside the main
         canvas in header-only mode. -->
    <canvas
      ref="overlayCanvas"
      class="canvas overlay"
      :class="{ hidden: isHeaderOnlyMode }"
      :width="frameWidth"
      :height="frameHeight"
    />

    <!-- Hover overlay (image mode) -->
    <div
      v-if="!isHeaderOnlyMode"
      class="hover-overlay"
      :class="{ visible: hovered }"
    >
      <div
        v-if="streaming"
        class="fps"
        :title="`Received (client): ${camera.clientFps} fps — frames decoded per second\nCaptured (server): ${camera.serverFps} fps — libcamera hardware cadence`"
      >
        <span class="fps-client">{{ camera.clientFps }}</span>
        <span class="fps-sep">/</span>
        <span class="fps-server">{{ camera.serverFps }}</span>
        <span class="fps-unit">fps</span>
      </div>
      <div class="cam-label">cam{{ paddedId }}</div>
      <div
        v-if="streaming"
        class="focus-info"
        :title="`Per-frame focus from the libcamera IPA (protocol v5).\nLens position in dioptres (0 = infinity); AF state from continuous/auto/manual focus.`"
      >
        <span class="focus-lens">{{ lensDisplay }}</span>
        <span class="focus-af" :class="afClass">{{ afDisplay }}</span>
      </div>
    </div>

    <!-- Saved-frame counter (checkerboard / aruco detector modes only).
         Always visible in image mode — calibration capture progress should be
         readable at a glance, not gated behind hover. -->
    <div
      v-if="!isHeaderOnlyMode && streaming && showSavedCount"
      class="saved-badge"
      :title="`Frames saved to disk on the server (${saveMode} mode)`"
    >
      <span class="saved-icon">●</span>
      <span class="saved-count">{{ framesSaved.toLocaleString() }}</span>
      <span class="saved-label">saved</span>
    </div>

    <!-- Header-only big display -->
    <div v-if="isHeaderOnlyMode && streaming" class="header-display">
      <div class="cam-label-big">cam{{ paddedId }}</div>
      <div
        class="big-fps-pair"
        :title="`Received (client): ${camera.clientFps} fps — frames decoded per second\nCaptured (server): ${camera.serverFps} fps — libcamera hardware cadence`"
      >
        <span class="big-fps-client">{{ camera.clientFps }}</span>
        <span class="big-fps-sep">/</span>
        <span class="big-fps-server">{{ camera.serverFps }}</span>
      </div>
      <div class="big-fps-unit">fps</div>
      <div class="frame-id">#{{ latestFrameId.toLocaleString() }}</div>
      <div
        v-if="showSavedCount"
        class="saved-frames-big"
        :title="`Frames saved to disk on the server (${saveMode} mode)`"
      >
        <span class="saved-frames-big-count">{{ framesSaved.toLocaleString() }}</span>
        <span class="saved-frames-big-label">saved</span>
      </div>
    </div>

    <!-- Observed camera whose server is not running: the subscription is
         parked until a commander starts the cameras (protocol §4.7). -->
    <div v-if="streaming && observerWaiting" class="no-signal waiting">
      <span>{{ waitingLabel }}</span>
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
const overlayCanvas = ref(null)
const hovered = ref(false)
const latestFrameId = ref(0)
const latestLensPosition = ref(NaN)
const latestAfState = ref(0xFF)

let debayer = null
let overlayCtx = null
let animationFrameId = null
let lastFrameTime = 0
const frameDropThreshold = 50
let blackFrameRendered = false
const frameQueue = []
let frameHandler = null

// Strictly per-frame overlay: only paint corners that came in this frame's
// header. If the next frame has no corners, the overlay is cleared.
const CORNER_COLOR = '#00FF80'
const CORNER_RADIUS_PX = 6

// ArUco marker overlay (protocol v6). Amber, deliberately distinct from the
// checkerboard green above, so both detector modes read differently on screen.
const ARUCO_COLOR = '#FF8C00'
const ARUCO_DOT_RADIUS_PX = 4

const ownServer = computed(() => store.servers.find(s => s.index === props.camera.serverIndex))
const canvasWidth = computed(() => ownServer.value?.width || 1456)
const canvasHeight = computed(() => ownServer.value?.height || 1088)
// Geometry of the frames actually arriving (the WebGL canvas follows it in
// Debayer.processFrame; the overlay canvas follows it here).
const frameWidth = ref(canvasWidth.value)
const frameHeight = ref(canvasHeight.value)
const streaming = computed(() => props.camera.streaming)
// An observed camera is "streaming" (subscribed) even while the watched
// server's cameras are stopped; say so instead of freezing the last frame.
const observerWaiting = computed(
  () => ownServer.value?.role === 'observer' && ownServer.value?.serverState !== 'running'
)
const waitingLabel = computed(() => {
  const srv = ownServer.value
  if (!srv?.connected) return 'RECONNECTING'
  if (srv.commanderConnected === false) return 'WAITING FOR COMMANDER'
  return 'CAMERAS STOPPED'
})
const isHeaderOnlyMode = computed(() => store.headerOnlyMode)
const paddedId = computed(() => String(props.camera.globalId).padStart(2, '0'))

// Saved-frame counter. The server reports a running per-camera frames_saved
// count in every frame header (stored as camera.framesSaved). Only surfaced in
// the detector save modes (checkerboard / checkerboard2x2 / aruco / aruco2x2),
// where it doubles as live calibration-capture progress.
const saveMode = computed(() => store.config?.processing?.mode)
const showSavedCount = computed(
  () => saveMode.value === 'checkerboard' || saveMode.value === 'checkerboard2x2'
    || saveMode.value === 'aruco' || saveMode.value === 'aruco2x2'
)
const framesSaved = computed(() => props.camera.framesSaved || 0)

// Per-frame focus metadata (protocol v5). lensPosition is in dioptres
// (0 = infinity); NaN means the server reported none for the frame. afState is
// the libcamera AfState enum; 0xFF means not reported.
const AF_STATES = {
  0: { label: 'idle', cls: 'af-idle' },
  1: { label: 'focusing', cls: 'af-focusing' },
  2: { label: 'focused', cls: 'af-focused' },
  3: { label: 'failed', cls: 'af-failed' },
}
const lensDisplay = computed(() =>
  Number.isNaN(latestLensPosition.value)
    ? '— D'
    : `${latestLensPosition.value.toFixed(2)} D`
)
const afDisplay = computed(() => (AF_STATES[latestAfState.value]?.label) ?? 'n/a')
const afClass = computed(() => (AF_STATES[latestAfState.value]?.cls) ?? 'af-na')

onMounted(() => {
  if (!canvas.value) return
  try {
    debayer = new Debayer(canvas.value)
    if (overlayCanvas.value) {
      overlayCtx = overlayCanvas.value.getContext('2d')
    }
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
    if (data.width > 0 && data.height > 0) {
      frameWidth.value = data.width
      frameHeight.value = data.height
    }
    if (typeof data.lensPosition === 'number') latestLensPosition.value = data.lensPosition
    if (typeof data.afState === 'number') latestAfState.value = data.afState

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
      cornerSets: data.cornerSets || [],
      arucoSets: data.arucoSets || [],
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
  clearOverlay()
}

function clearOverlay() {
  if (!overlayCtx || !overlayCanvas.value) return
  overlayCtx.clearRect(0, 0, overlayCanvas.value.width, overlayCanvas.value.height)
}

function drawCornerOverlay(cornerSets) {
  if (!overlayCtx || !overlayCanvas.value) return
  // Strict per-frame: wipe first so a frame with no detections leaves the
  // overlay blank.
  const w = overlayCanvas.value.width
  const h = overlayCanvas.value.height
  overlayCtx.clearRect(0, 0, w, h)
  if (!cornerSets || cornerSets.length === 0) return

  // The Debayer shader (src/webgl/Debayer.js) renders the frame in the raw
  // YUV buffer's native orientation (no flip), and the server's corner
  // coordinates live in that same full-frame Y-plane pixel space, so corner
  // (x, y) maps 1:1 onto canvas pixel (x, y).
  overlayCtx.fillStyle = CORNER_COLOR
  for (const set of cornerSets) {
    if (!set.corners) continue
    for (const c of set.corners) {
      overlayCtx.beginPath()
      overlayCtx.arc(c.x, c.y, CORNER_RADIUS_PX, 0, Math.PI * 2)
      overlayCtx.fill()
    }
  }
}

// Draw detected ArUco markers on the same overlay canvas as the checkerboard
// corners. Does NOT clear — drawCornerOverlay already wiped the canvas for this
// frame (a frame only ever carries one detection kind, but drawing both is
// harmless). Marker coordinates are in the same full-frame Y-plane space, so
// they map 1:1 to canvas pixels. Each marker: quad outline + corner dots +
// centered id label (dark shadow behind for legibility).
function drawArucoOverlay(arucoSets) {
  if (!overlayCtx || !overlayCanvas.value) return
  if (!arucoSets || arucoSets.length === 0) return

  for (const marker of arucoSets) {
    const c = marker.corners
    if (!c || c.length < 4) continue

    // Outline (clockwise from the marker's top-left, as sent by the server).
    overlayCtx.strokeStyle = ARUCO_COLOR
    overlayCtx.lineWidth = 2
    overlayCtx.beginPath()
    overlayCtx.moveTo(c[0].x, c[0].y)
    for (let i = 1; i < 4; i++) overlayCtx.lineTo(c[i].x, c[i].y)
    overlayCtx.closePath()
    overlayCtx.stroke()

    // Corner dots.
    overlayCtx.fillStyle = ARUCO_COLOR
    for (const p of c) {
      overlayCtx.beginPath()
      overlayCtx.arc(p.x, p.y, ARUCO_DOT_RADIUS_PX, 0, Math.PI * 2)
      overlayCtx.fill()
    }

    // Id label at the marker centroid.
    const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4
    const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4
    const label = String(marker.markerId)
    overlayCtx.font = '20px sans-serif'
    overlayCtx.textAlign = 'center'
    overlayCtx.textBaseline = 'middle'
    overlayCtx.fillStyle = '#000'
    overlayCtx.fillText(label, cx + 1, cy + 1)
    overlayCtx.fillStyle = ARUCO_COLOR
    overlayCtx.fillText(label, cx, cy)
  }
}

function renderLoop() {
  if (frameQueue.length > 0 && debayer) {
    const frame = frameQueue.shift()
    lastFrameTime = frame.timestamp
    try {
      debayer.processFrame(frame.data, frame.width, frame.height, frame.bytesPerLine)
      // drawCornerOverlay clears the overlay once; drawArucoOverlay draws on
      // top without clearing.
      drawCornerOverlay(frame.cornerSets)
      drawArucoOverlay(frame.arucoSets)
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

// When the watched server stops its cameras, blank the tile rather than
// leaving the last frame frozen behind the "CAMERAS STOPPED" label.
watch(observerWaiting, (waiting) => {
  if (waiting && streaming.value) {
    frameQueue.length = 0
    renderBlackFrame()
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
    latestLensPosition.value = NaN
    latestAfState.value = 0xFF
    clearOverlay()
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

/* Corner overlay sits on top of the WebGL canvas at the same intrinsic size,
   so corner coordinates emitted by the server (in full-frame Y-pixel space)
   map 1:1 to canvas pixels without further scaling. */
.canvas.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
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
  letter-spacing: 0.04em;
  white-space: nowrap;
  cursor: help;
}

.fps-client { color: var(--live); }
.fps-sep    { color: var(--text-sec); margin: 0 0.18em; font-weight: 300; opacity: 0.6; }
.fps-server { color: var(--hw-fps); }
.fps-unit   { color: var(--text-sec); font-size: 0.85em; margin-left: 0.3em; }

.hover-overlay .cam-label {
  position: absolute;
  bottom: 8px;
  left: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.04em;
}

/* Per-frame focus metadata (lens position + AF state), bottom-right opposite
   the cam label. Only present in image mode's hover overlay — never on the
   header-only big display. */
.hover-overlay .focus-info {
  position: absolute;
  bottom: 8px;
  right: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  cursor: help;
}

.focus-lens { color: rgba(255, 255, 255, 0.8); }
.focus-af {
  margin-left: 0.5em;
  text-transform: uppercase;
  font-size: 0.85em;
  letter-spacing: 0.06em;
}
.focus-af.af-focusing { color: var(--hw-fps); }
.focus-af.af-focused  { color: var(--live); }
.focus-af.af-failed   { color: #ff5c5c; }
.focus-af.af-idle     { color: var(--text-sec); }
.focus-af.af-na       { color: var(--text-sec); opacity: 0.6; }

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

.big-fps-pair {
  font-family: var(--font-mono);
  font-size: clamp(18px, 8cqw, 52px);
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1;
  white-space: nowrap;
  cursor: help;
}

.big-fps-client { color: var(--live); }
.big-fps-sep    { color: var(--text-sec); margin: 0 0.12em; font-weight: 300; opacity: 0.6; }
.big-fps-server { color: var(--hw-fps); }

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

/* Saved-frame count line in the header-only big display */
.saved-frames-big {
  font-family: var(--font-mono);
  font-size: clamp(9px, 2.5cqw, 13px);
  letter-spacing: 0.04em;
  cursor: help;
}

.saved-frames-big-count { color: var(--live); font-weight: 600; }
.saved-frames-big-label { color: var(--text-sec); margin-left: 0.4em; font-size: 0.85em; }

/* Always-visible saved-frame badge (image mode, detector modes). Sits
   top-left — the one corner the hover overlay leaves free (fps top-right,
   cam label bottom-left, focus bottom-right). The translucent pill keeps it
   legible over any frame content. */
.saved-badge {
  position: absolute;
  top: 8px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.45);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  pointer-events: none;
}

.saved-badge .saved-icon { color: var(--live); font-size: 0.7em; }
.saved-badge .saved-count { color: var(--live); font-weight: 600; }
.saved-badge .saved-label { color: var(--text-sec); font-size: 0.85em; }

/* No signal */
.no-signal {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.no-signal.waiting {
  color: var(--warn);
}

.no-signal span {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-sec);
  letter-spacing: 0.1em;
}
</style>
