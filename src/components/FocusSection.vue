<template>
  <div class="focus">
    <!-- Auto / Manual segmented control -->
    <div class="seg-control" :class="{ disabled }">
      <button
        v-for="seg in ['auto', 'manual']"
        :key="seg"
        :disabled="disabled"
        :class="['seg-btn', { active: mode === seg }]"
        @click="switchMode(seg)"
      >{{ seg === 'auto' ? 'Auto' : 'Manual' }}</button>
    </div>

    <!-- Manual controls — always in DOM for smooth height transition -->
    <div class="manual-wrap" :class="{ visible: mode === 'manual', disabled }">
      <div class="lens-row">
        <span class="lens-label">Lens position</span>
        <div class="input-wrap">
          <input
            type="text"
            class="lens-input"
            :value="inputVal"
            :disabled="disabled || mode !== 'manual'"
            title="Lens position in diopters (0 = ∞). Use ↑/↓ or type a value."
            @input="onInputChange"
            @blur="onInputBlur"
            @keydown="onInputKey"
          />
          <span class="unit">dpt</span>
        </div>
      </div>

      <div class="slider-wrap">
        <div class="track-fill" :style="{ width: pct + '%' }" />
        <input
          type="range"
          class="slider"
          :min="MIN"
          :max="MAX"
          :step="STEP"
          :value="lensPos"
          :disabled="disabled || mode !== 'manual'"
          @input="onSliderChange"
        />
      </div>

      <div class="range-labels">
        <span>∞</span>
        <span>{{ maxLabel }} dpt</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useCameraStore } from '../stores/cameraStore'

defineProps({
  disabled: { type: Boolean, default: false }
})

const store = useCameraStore()

const STEP = 0.05
// Decimal places matching STEP's precision (0.05 → 2), used for rounding and
// display so typed/stepped values snap cleanly onto the slider grid.
const DECIMALS = 2
// Range (dioptres) used until the server reports the hardware LensPosition
// range via get_lens_position_limits, or when a field is null (fixed-focus
// module / not yet fetched).
const FALLBACK_MIN = 0
const FALLBACK_MAX = 10

// Real hardware limits, with safe fallbacks for null/non-finite fields.
const MIN = computed(() => {
  const v = store.lensPositionLimits?.min
  return Number.isFinite(v) ? v : FALLBACK_MIN
})
const MAX = computed(() => {
  const v = store.lensPositionLimits?.max
  return Number.isFinite(v) ? v : FALLBACK_MAX
})
// Trim a trailing ".0" so a whole-number max reads "10 dpt", not "10.0 dpt".
const maxLabel = computed(() => MAX.value.toFixed(1).replace(/\.0$/, ''))

const mode = ref(store.focusMode)
const lensPos = ref(store.lensPosition)
const inputVal = ref(store.lensPosition.toFixed(DECIMALS))

const pct = computed(() => {
  const span = MAX.value - MIN.value
  return span > 0 ? ((lensPos.value - MIN.value) / span) * 100 : 0
})

function clamp(v) {
  return Math.max(MIN.value, Math.min(MAX.value, v))
}

// Snap to the nearest STEP and clean up float error (0.05 * 3 → 0.15).
function quantize(v) {
  return Number((Math.round(v / STEP) * STEP).toFixed(DECIMALS))
}

// When real limits arrive (or shrink) and the current position falls outside
// the new range, pull it back in. Only push to the server if we're actually
// in manual mode — clamping the display shouldn't trigger a focus command.
watch([MIN, MAX], () => {
  const clamped = quantize(clamp(lensPos.value))
  if (clamped !== lensPos.value) {
    lensPos.value = clamped
    inputVal.value = clamped.toFixed(DECIMALS)
    if (mode.value === 'manual') store.setLensPosition(clamped)
  }
})

function applyLens(raw) {
  const rounded = quantize(clamp(parseFloat(raw) || 0))
  lensPos.value = rounded
  inputVal.value = rounded.toFixed(DECIMALS)
  store.setLensPosition(rounded)
}

function onSliderChange(e) {
  applyLens(e.target.value)
}

function onInputChange(e) {
  inputVal.value = e.target.value
}

function onInputBlur() {
  applyLens(inputVal.value)
}

function onInputKey(e) {
  if (e.key === 'Enter') { applyLens(inputVal.value); e.target.blur() }
  if (e.key === 'ArrowUp')   { e.preventDefault(); applyLens(lensPos.value + STEP) }
  if (e.key === 'ArrowDown') { e.preventDefault(); applyLens(lensPos.value - STEP) }
}

function switchMode(seg) {
  mode.value = seg
  store.setLensPosition(seg === 'auto' ? -1 : lensPos.value)
}
</script>

<style scoped>
.focus {
  padding: 0 12px;
}

/* Segmented control */
.seg-control {
  display: flex;
  gap: 3px;
  padding: 3px;
  background: var(--bg);
  border-radius: 6px;
  border: 1px solid var(--line);
  margin-bottom: 10px;
  transition: opacity 0.15s;
}

.seg-control.disabled {
  opacity: 0.4;
}

.seg-btn {
  flex: 1;
  height: 24px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0.04em;
  color: var(--text-sec);
  background: transparent;
  transition: all 0.15s;
}

.seg-btn:hover:not(:disabled):not(.active) {
  color: var(--text-mid);
}

.seg-btn.active {
  background: color-mix(in oklch, var(--accent) 13%, transparent);
  color: var(--accent);
  font-weight: 500;
  outline: 1px solid color-mix(in oklch, var(--accent) 33%, transparent);
}

.seg-btn:disabled {
  cursor: not-allowed;
}

/* Manual controls */
.manual-wrap {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transition: max-height 0.2s ease, opacity 0.15s ease;
}

.manual-wrap.visible {
  max-height: 72px;
  opacity: 1;
}

.manual-wrap.disabled {
  opacity: 0.4;
}

.manual-wrap.visible.disabled {
  opacity: 0.4;
}

.lens-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.lens-label {
  font-size: 10px;
  color: var(--text-sec);
  letter-spacing: 0.04em;
}

.input-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

.lens-input {
  width: 40px;
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

.lens-input:focus {
  border-color: var(--accent);
}

.unit {
  font-size: 9.5px;
  color: var(--text-sec);
}

/* Slider */
.slider-wrap {
  position: relative;
  height: 20px;
  display: flex;
  align-items: center;
}

.track-fill {
  position: absolute;
  left: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
  transition: width 0.05s;
}

.slider {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  height: 3px;
  background: var(--line);
  border-radius: 2px;
  accent-color: var(--accent);
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  border: none;
  cursor: pointer;
}

.slider:disabled {
  cursor: not-allowed;
}

.slider:disabled::-webkit-slider-thumb {
  cursor: not-allowed;
}

/* Range labels */
.range-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
}

.range-labels span {
  font-size: 9px;
  color: var(--text-sec);
  font-family: var(--font-mono);
}
</style>
