<template>
  <div class="exposure" :class="{ disabled }">
    <!-- Effective readout -->
    <div class="effective">
      <span class="effective-label">Effective</span>
      <span class="effective-value" :class="{ unknown: effFps === null }">
        {{ effFps === null ? '— fps' : `${effFps} fps` }}
      </span>
    </div>

    <!-- Mode pills -->
    <div class="pills">
      <button
        class="pill pill-exp"
        :class="{ on: autoAE }"
        :disabled="disabled"
        title="Auto AE — server picks exposure (sends exposure_time = -1)"
        @click="toggleAutoAE"
      >Auto AE</button>
      <button
        class="pill pill-fd"
        :class="{ on: fdLocked }"
        :disabled="disabled"
        title="Lock frame duration — when off, libcamera picks (sends frame_duration = -1)"
        @click="toggleFdLock"
      >Lock fps</button>
    </div>

    <!-- Dual-thumb log slider -->
    <div class="slider-area">
      <div v-if="toast" :key="toast.key" class="toast">
        {{ toast.msg }}
        <div class="toast-tail" />
      </div>

      <div
        ref="trackRef"
        class="track"
        :class="{ disabled }"
        @pointerdown="onTrackPointerDown"
      >
        <!-- Exposure-fill segment (amber) -->
        <div
          v-if="!autoAE"
          class="seg-exp"
          :style="{ width: expPct + '%' }"
        />
        <!-- Gap segment (striped blue) -->
        <div
          v-if="!autoAE && fdLocked && fdPct > expPct"
          class="seg-gap"
          :style="{ left: expPct + '%', width: (fdPct - expPct) + '%' }"
        />
        <!-- Auto-AE wash -->
        <div
          v-if="autoAE"
          class="seg-auto"
          :style="{ width: (fdLocked ? fdPct : 100) + '%' }"
        />
      </div>

      <!-- Tick marks -->
      <div
        v-for="t in TICKS"
        :key="`tick-${t.us}`"
        class="tick"
        :style="{ left: usToPct(t.us) + '%' }"
      />

      <!-- Exposure thumb -->
      <div
        v-if="!autoAE"
        class="thumb-exp"
        :class="{ dragging: dragging === 'exp' }"
        :style="{ left: expPct + '%' }"
        :tabindex="disabled ? -1 : 0"
        :title="`Exposure: ${formatUs(exposureUs)} (≈1/${usToFps(exposureUs)} s)`"
        @pointerdown.stop="startDrag('exp', $event)"
        @keydown="onExpKeydown"
      />

      <!-- Frame-duration thumb -->
      <div
        v-if="fdLocked"
        class="thumb-fd"
        :class="{ dragging: dragging === 'fd' }"
        :style="{ left: fdPct + '%' }"
        :tabindex="disabled ? -1 : 0"
        :title="`Frame duration: ${formatUs(fdUs)} (${usToFps(fdUs)} fps)`"
        @pointerdown.stop="startDrag('fd', $event)"
        @keydown="onFdKeydown"
      />
    </div>

    <!-- Tick labels -->
    <div class="tick-labels">
      <span
        v-for="t in LABELED_TICKS"
        :key="`label-${t.us}`"
        :style="{ left: usToPct(t.us) + '%' }"
      >{{ t.label }}</span>
    </div>

    <!-- Exposure numeric row -->
    <div class="num-row" :class="{ inactive: autoAE }">
      <div class="num-label">
        <span class="dot dot-exp" />
        <span class="label-text label-exp">Shutter</span>
      </div>
      <div class="num-input-wrap">
        <input
          type="text"
          class="num-input"
          :disabled="disabled || autoAE"
          :value="expInput"
          @input="expInput = $event.target.value"
          @blur="commitExposure(expInput)"
          @keydown="onExpInputKey"
        />
        <span class="unit">ms</span>
      </div>
    </div>

    <!-- Frame-rate numeric row -->
    <div class="num-row" :class="{ inactive: !fdLocked }">
      <div class="num-label">
        <span class="dot dot-fd" />
        <span class="label-text label-fd">Frame rate</span>
      </div>
      <div class="num-input-wrap">
        <input
          type="text"
          class="num-input"
          :disabled="disabled || !fdLocked"
          :value="fpsInput"
          @input="fpsInput = $event.target.value"
          @blur="commitFps(fpsInput)"
          @keydown="onFpsInputKey"
        />
        <span class="unit">fps</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { useCameraStore } from '../stores/cameraStore'

const props = defineProps({
  disabled: { type: Boolean, default: false }
})

const store = useCameraStore()

// ── Log-scale range (100 µs → 1 s) ───────────────────────────────────────
const MIN_US = 100
const MAX_US = 1_000_000
const LOG_MIN = Math.log10(MIN_US)
const LOG_MAX = Math.log10(MAX_US)

function usToPct(us) {
  const c = Math.max(MIN_US, Math.min(MAX_US, us))
  return ((Math.log10(c) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100
}
function pctToUs(p) {
  const c = Math.max(0, Math.min(100, p))
  return Math.round(Math.pow(10, LOG_MIN + (c / 100) * (LOG_MAX - LOG_MIN)))
}
function formatUs(us) {
  if (us < 1000) return `${us} µs`
  if (us < 10_000) return `${(us / 1000).toFixed(2)} ms`
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`
  return `${(us / 1_000_000).toFixed(2)} s`
}
function usToFps(us) {
  const fps = 1_000_000 / us
  if (fps >= 100) return fps.toFixed(0)
  if (fps >= 10) return fps.toFixed(1)
  return fps.toFixed(2)
}
function fpsToUs(fps) { return Math.round(1_000_000 / fps) }

const TICKS = [
  { us: 100,     label: '10kfps' },
  { us: 1000,    label: '1kfps' },
  { us: 4167,    label: '240' },
  { us: 16667,   label: '60' },
  { us: 33333,   label: '30' },
  { us: 100000,  label: '10' },
  { us: 1000000, label: '1fps' }
]
const LABELED_TICKS = [TICKS[0], TICKS[3], TICKS[4], TICKS[6]]

// ── Local UI state — seeded from store, but the slider remembers its own
//   "last manual" values even while auto/unset modes are engaged. ────────
const initExp = store.exposureTimeUs > 0 ? store.exposureTimeUs : 10_000
const initFd  = store.frameDurationUs > 0 ? store.frameDurationUs : 33_333

const autoAE = ref(store.exposureTimeUs <= 0)
const exposureUs = ref(initExp)
const fdLocked = ref(store.frameDurationUs > 0)
const fdUs = ref(initFd)

const expInput = ref(formatExpInput(initExp))
const fpsInput = ref(usToFps(initFd))

function formatExpInput(us) {
  return (us / 1000).toFixed(us < 10_000 ? 2 : 1)
}

watch(exposureUs, (us) => { expInput.value = formatExpInput(us) })
watch(fdUs, (us) => { fpsInput.value = usToFps(us) })

// ── Toast ────────────────────────────────────────────────────────────────
const toast = ref(null)
let toastTimer = null
function flashToast(msg) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { msg, key: Date.now() }
  toastTimer = setTimeout(() => { toast.value = null }, 2400)
}
onUnmounted(() => { if (toastTimer) clearTimeout(toastTimer) })

// ── Effective fps readout (per design) ───────────────────────────────────
const effFps = computed(() => {
  if (fdLocked.value && autoAE.value)  return usToFps(fdUs.value)
  if (!fdLocked.value && !autoAE.value) return usToFps(exposureUs.value)
  if (fdLocked.value && !autoAE.value) return usToFps(Math.max(exposureUs.value, fdUs.value))
  return null
})

const expPct = computed(() => usToPct(exposureUs.value))
const fdPct  = computed(() => usToPct(fdUs.value))

// ── Pointer drag on track / thumbs ───────────────────────────────────────
const trackRef = ref(null)
const dragging = ref(null)  // 'exp' | 'fd' | null

function pointerToUs(clientX) {
  const rect = trackRef.value.getBoundingClientRect()
  const pct = ((clientX - rect.left) / rect.width) * 100
  return pctToUs(pct)
}

function startDrag(thumb, e) {
  if (props.disabled) return
  if (thumb === 'exp' && autoAE.value) return
  if (thumb === 'fd' && !fdLocked.value) return
  dragging.value = thumb
  e.preventDefault()
}

function onTrackPointerDown(e) {
  if (props.disabled) return
  const us = pointerToUs(e.clientX)
  // Snap nearest active thumb to click position.
  const distExp = autoAE.value ? Infinity : Math.abs(usToPct(exposureUs.value) - usToPct(us))
  const distFd  = fdLocked.value ? Math.abs(usToPct(fdUs.value) - usToPct(us)) : Infinity
  if (distExp <= distFd && !autoAE.value) {
    const max = fdLocked.value ? fdUs.value : MAX_US
    exposureUs.value = Math.min(max, Math.max(MIN_US, us))
    pushExposure()
    startDrag('exp', e)
  } else if (fdLocked.value) {
    const min = autoAE.value ? MIN_US : exposureUs.value
    fdUs.value = Math.max(min, Math.min(MAX_US, us))
    pushFd()
    startDrag('fd', e)
  }
}

function onPointerMove(e) {
  if (!dragging.value) return
  const us = pointerToUs(e.clientX)
  if (dragging.value === 'exp') {
    const max = fdLocked.value ? fdUs.value : MAX_US
    const clamped = Math.min(max, Math.max(MIN_US, us))
    if (fdLocked.value && us > fdUs.value) flashToast('Shutter pinned to frame duration')
    exposureUs.value = clamped
  } else if (dragging.value === 'fd') {
    const min = autoAE.value ? MIN_US : exposureUs.value
    const clamped = Math.max(min, Math.min(MAX_US, us))
    if (!autoAE.value && us < exposureUs.value) flashToast('Frame rate capped by exposure')
    fdUs.value = clamped
  }
}

function onPointerUp() {
  if (dragging.value === 'exp') pushExposure()
  else if (dragging.value === 'fd') pushFd()
  dragging.value = null
}

watch(dragging, (val) => {
  if (val) {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  } else {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }
})

onUnmounted(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})

// ── Numeric commits ──────────────────────────────────────────────────────
function commitExposure(raw) {
  const ms = parseFloat(raw)
  if (!isFinite(ms) || ms <= 0) { expInput.value = formatExpInput(exposureUs.value); return }
  let us = Math.round(ms * 1000)
  const wanted = us
  us = Math.max(MIN_US, Math.min(MAX_US, us))
  if (fdLocked.value && wanted > fdUs.value) flashToast('Shutter pinned to frame duration')
  if (fdLocked.value) us = Math.min(us, fdUs.value)
  exposureUs.value = us
  pushExposure()
}

function commitFps(raw) {
  const fps = parseFloat(raw)
  if (!isFinite(fps) || fps <= 0) { fpsInput.value = usToFps(fdUs.value); return }
  let us = fpsToUs(fps)
  us = Math.max(MIN_US, Math.min(MAX_US, us))
  if (!autoAE.value && us < exposureUs.value) flashToast('Frame rate capped by exposure')
  if (!autoAE.value) us = Math.max(us, exposureUs.value)
  fdUs.value = us
  pushFd()
}

function nudgeExposure(factor) {
  const next = Math.round(exposureUs.value * factor)
  const max = fdLocked.value ? fdUs.value : MAX_US
  exposureUs.value = Math.max(MIN_US, Math.min(max, next))
  pushExposure()
}

function nudgeFps(factor) {
  const next = Math.round(fdUs.value * factor)
  const min = autoAE.value ? MIN_US : exposureUs.value
  fdUs.value = Math.max(min, Math.min(MAX_US, next))
  pushFd()
}

// ── Server pushes ────────────────────────────────────────────────────────
function pushExposure() {
  if (props.disabled || autoAE.value) return
  store.setExposureTime(exposureUs.value)
}
function pushFd() {
  if (props.disabled || !fdLocked.value) return
  store.setFrameDuration(fdUs.value)
}

function toggleAutoAE() {
  if (props.disabled) return
  autoAE.value = !autoAE.value
  if (autoAE.value) {
    store.setExposureTime(-1)
  } else {
    // If fd is locked, clamp last manual value to ≤ fd before pushing.
    if (fdLocked.value && exposureUs.value > fdUs.value) {
      exposureUs.value = fdUs.value
    }
    store.setExposureTime(exposureUs.value)
  }
}

function toggleFdLock() {
  if (props.disabled) return
  fdLocked.value = !fdLocked.value
  if (fdLocked.value) {
    // Ensure fd ≥ exposure if manual.
    if (!autoAE.value && fdUs.value < exposureUs.value) {
      fdUs.value = exposureUs.value
    }
    store.setFrameDuration(fdUs.value)
  } else {
    store.setFrameDuration(-1)
  }
}

// ── Keyboard ─────────────────────────────────────────────────────────────
function onExpKeydown(e) {
  if (props.disabled) return
  if (e.key === 'ArrowRight') { e.preventDefault(); nudgeExposure(1.1) }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); nudgeExposure(1 / 1.1) }
}
function onFdKeydown(e) {
  if (props.disabled) return
  if (e.key === 'ArrowRight') { e.preventDefault(); nudgeFps(1.1) }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); nudgeFps(1 / 1.1) }
}
function onExpInputKey(e) {
  if (e.key === 'Enter') { commitExposure(expInput.value); e.target.blur() }
  if (e.key === 'ArrowUp')   { e.preventDefault(); nudgeExposure(1.1) }
  if (e.key === 'ArrowDown') { e.preventDefault(); nudgeExposure(1 / 1.1) }
}
function onFpsInputKey(e) {
  if (e.key === 'Enter') { commitFps(fpsInput.value); e.target.blur() }
  // ↑ = faster fps = smaller fd
  if (e.key === 'ArrowUp')   { e.preventDefault(); nudgeFps(1 / 1.1) }
  if (e.key === 'ArrowDown') { e.preventDefault(); nudgeFps(1.1) }
}
</script>

<style scoped>
.exposure {
  padding: 0 12px;
  transition: opacity 0.15s;

  --exp: oklch(76% 0.14 75);   /* amber — shutter */
  --fd:  oklch(70% 0.12 215);  /* cool blue — frame rate */
}

.exposure.disabled {
  opacity: 0.45;
}

/* Effective readout */
.effective {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 5px;
}

.effective-label {
  font-size: 9.5px;
  color: var(--text-sec);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.effective-value {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--live);
  font-weight: 500;
}

.effective-value.unknown {
  color: var(--text-sec);
}

/* Pills */
.pills {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}

.pill {
  flex: 1;
  height: 22px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text-sec);
  font-size: 10px;
  letter-spacing: 0.04em;
  transition: all 0.15s;
}

.pill:disabled {
  cursor: not-allowed;
}

.pill-exp.on {
  background: color-mix(in oklch, var(--exp) 13%, transparent);
  border-color: color-mix(in oklch, var(--exp) 50%, transparent);
  color: var(--exp);
}

.pill-fd.on {
  background: color-mix(in oklch, var(--fd) 13%, transparent);
  border-color: color-mix(in oklch, var(--fd) 50%, transparent);
  color: var(--fd);
}

/* Slider */
.slider-area {
  position: relative;
  height: 28px;
  margin-bottom: 4px;
}

.track {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 4px;
  transform: translateY(-50%);
  background: var(--line);
  border-radius: 2px;
  cursor: pointer;
}

.track.disabled {
  cursor: not-allowed;
}

.seg-exp {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: var(--exp);
  border-radius: 2px;
  pointer-events: none;
}

.seg-gap {
  position: absolute;
  top: 0;
  height: 100%;
  background: repeating-linear-gradient(
    90deg,
    color-mix(in oklch, var(--fd) 25%, transparent) 0 3px,
    transparent 3px 6px
  );
  pointer-events: none;
}

.seg-auto {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: color-mix(in oklch, var(--exp) 10%, transparent);
  border-radius: 2px;
  pointer-events: none;
}

.tick {
  position: absolute;
  top: 50%;
  width: 1px;
  height: 6px;
  background: var(--line);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* Thumbs */
.thumb-exp {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--exp);
  border: 2px solid var(--bg);
  transform: translate(-50%, -50%);
  cursor: grab;
  outline: none;
  z-index: 2;
  transition: box-shadow 0.15s;
}

.thumb-exp.dragging {
  box-shadow: 0 0 0 4px color-mix(in oklch, var(--exp) 27%, transparent);
  cursor: grabbing;
}

.thumb-fd {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--bg);
  border: 2px solid var(--fd);
  transform: translate(-50%, -50%) rotate(45deg);
  cursor: grab;
  outline: none;
  z-index: 3;
  transition: box-shadow 0.15s;
}

.thumb-fd.dragging {
  box-shadow: 0 0 0 4px color-mix(in oklch, var(--fd) 27%, transparent);
  cursor: grabbing;
}

.exposure.disabled .thumb-exp,
.exposure.disabled .thumb-fd {
  cursor: not-allowed;
}

/* Tick labels */
.tick-labels {
  position: relative;
  height: 10px;
  margin-bottom: 12px;
}

.tick-labels span {
  position: absolute;
  transform: translateX(-50%);
  font-size: 8.5px;
  color: var(--text-sec);
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* Toast */
.toast {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 4px);
  transform: translateX(-50%);
  padding: 4px 8px;
  background: #1a1620;
  border: 1px solid color-mix(in oklch, var(--warn) 50%, transparent);
  border-radius: 4px;
  font-size: 9.5px;
  color: var(--warn);
  font-family: var(--font-ui);
  letter-spacing: 0.02em;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  animation: toast-pop 2.4s ease forwards;
}

.toast-tail {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%) rotate(45deg);
  width: 6px;
  height: 6px;
  margin-top: -3px;
  background: #1a1620;
  border-right: 1px solid color-mix(in oklch, var(--warn) 50%, transparent);
  border-bottom: 1px solid color-mix(in oklch, var(--warn) 50%, transparent);
}

@keyframes toast-pop {
  0%   { opacity: 0; transform: translateX(-50%) translateY(4px); }
  8%   { opacity: 1; transform: translateX(-50%) translateY(0); }
  85%  { opacity: 1; transform: translateX(-50%) translateY(0); }
  100% { opacity: 0; transform: translateX(-50%) translateY(-2px); }
}

/* Numeric rows */
.num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.num-row:last-child {
  margin-bottom: 0;
}

.num-row.inactive {
  opacity: 0.4;
}

.num-label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
}

.dot-exp {
  background: var(--exp);
  border-radius: 50%;
}

.dot-fd {
  background: transparent;
  border: 1.5px solid var(--fd);
  border-radius: 2px;
  transform: rotate(45deg);
}

.label-text {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-sec);
}

.num-row:not(.inactive) .label-exp {
  color: var(--exp);
}

.num-row:not(.inactive) .label-fd {
  color: var(--fd);
}

.num-input-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

.num-input {
  width: 48px;
  height: 20px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text-pri);
  font-size: 10.5px;
  font-family: var(--font-mono);
  text-align: right;
  padding: 0 5px;
}

.num-input:focus {
  border-color: var(--text-mid);
}

.num-input:disabled {
  cursor: not-allowed;
}

.unit {
  font-size: 9.5px;
  color: var(--text-sec);
  font-family: var(--font-mono);
}
</style>
