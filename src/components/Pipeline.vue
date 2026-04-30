<template>
  <div class="pipeline">
    <div class="stage-track">
      <div
        v-for="(stage, i) in stages"
        :key="stage.key"
        class="stage-row"
      >
        <div class="rail">
          <div
            class="node"
            :class="{
              done: i < idx,
              active: i === idx
            }"
          />
          <div
            v-if="i < stages.length - 1"
            class="connector"
            :class="{ done: i < idx }"
          />
        </div>
        <div class="label-wrap" :class="{ last: i === stages.length - 1 }">
          <div
            class="label"
            :class="{
              done: i < idx,
              active: i === idx
            }"
          >
            {{ stage.label }}
          </div>
          <div v-if="i === idx" class="sub">{{ stage.sub }}</div>
        </div>
      </div>
    </div>

    <!-- Fixed-height live slot — sits between track and buttons so the
         button row never shifts when streaming starts/stops. -->
    <div class="live-slot">
      <div v-if="state === 'running' && streaming" class="live-pill">
        <LiveDot :on="true" color="var(--live)" />
        <span>LIVE</span>
      </div>
    </div>

    <!-- Fixed two-button row — both buttons always rendered, dimmed when
         inapplicable so click targets stay still during rapid clicks. -->
    <div class="btn-row">
      <button
        class="btn-retreat"
        :disabled="!canRetreat || busy"
        :title="retreatTitle"
        @click="$emit('retreat')"
      >
        <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor">
          <path d="M7.5 1.5l-6 3 6 3V1.5z" />
        </svg>
        {{ retreatLabel }}
      </button>

      <button
        class="btn-advance"
        :disabled="!canAdvance || busy"
        :title="advanceTitle"
        @click="$emit('advance')"
      >
        {{ advanceLabel }}
        <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor">
          <path d="M1.5 1.5l6 3-6 3V1.5z" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import LiveDot from './LiveDot.vue'

const props = defineProps({
  state:        { type: String,  required: true },
  busy:         { type: Boolean, default: false },
  streaming:    { type: Boolean, default: false },
  allStreaming: { type: Boolean, default: false }
})
defineEmits(['advance', 'retreat'])

// Stream is not a formal state — it's an action available while in `running`
// that starts streams for any cameras that aren't already streaming.
const stages = [
  { key: 'connected',  label: 'Discover',  sub: 'cameras found',     action: 'Configure' },
  { key: 'configured', label: 'Configure', sub: 'resolution & crop', action: 'Start' },
  { key: 'running',    label: 'Start',     sub: 'pipeline active',   action: 'Stream' }
]

const idx        = computed(() => stages.findIndex(s => s.key === props.state))
const canRetreat = computed(() => idx.value > 0)
const canAdvance = computed(() => {
  if (idx.value < 0) return false
  if (idx.value < stages.length - 1) return true
  // Terminal stage (`running`): advance acts as Stream — enabled only if at
  // least one camera isn't already streaming.
  return props.state === 'running' && !props.allStreaming
})

const advanceLabel = computed(() => idx.value >= 0 ? stages[idx.value].action ?? 'Done' : 'Done')
const advanceTitle = computed(() => advanceLabel.value)

const retreatLabel = computed(() => {
  if (props.state === 'running')    return 'Stop'
  if (props.state === 'configured') return 'Reset'
  return 'Back'
})
const retreatTitle = computed(() => {
  if (props.state === 'running')    return 'Stop cameras'
  if (props.state === 'configured') return 'Unconfigure'
  return undefined
})
</script>

<style scoped>
.pipeline {
  padding: 0 12px;
}

.stage-track {
  display: flex;
  flex-direction: column;
  margin-bottom: 14px;
}

.stage-row {
  display: flex;
  align-items: stretch;
  gap: 10px;
}

.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 14px;
  flex-shrink: 0;
}

.node {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 6px;
  background: transparent;
  border: 1.5px solid var(--line);
  transition: all 0.2s;
}

.node.done {
  background: var(--live);
  border-color: var(--live);
  box-shadow: 0 0 5px color-mix(in oklch, var(--live) 33%, transparent);
}

.node.active {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 7px color-mix(in oklch, var(--accent) 53%, transparent);
}

.connector {
  width: 1px;
  flex: 1;
  min-height: 10px;
  background: var(--line);
  transition: background 0.3s;
}

.connector.done {
  background: color-mix(in oklch, var(--live) 38%, transparent);
}

.label-wrap {
  padding-bottom: 10px;
  padding-top: 2px;
}

.label-wrap.last {
  padding-bottom: 0;
}

.label {
  font-size: 11px;
  color: var(--text-sec);
  line-height: 1.2;
  transition: color 0.2s;
}

.label.active {
  color: var(--text-pri);
  font-weight: 500;
}

.label.done {
  color: var(--live);
}

.sub {
  font-size: 9.5px;
  color: var(--text-sec);
  margin-top: 1px;
  font-family: var(--font-mono);
}

.live-slot {
  height: 28px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.live-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: color-mix(in oklch, var(--live) 5%, transparent);
  border: 1px solid color-mix(in oklch, var(--live) 25%, transparent);
  border-radius: 20px;
  color: var(--live);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
}

.btn-row {
  display: flex;
  gap: 6px;
}

.btn-retreat,
.btn-advance {
  flex: 1;
  height: 34px;
  border-radius: 6px;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.btn-retreat {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--text-sec);
}

.btn-retreat:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: var(--line-hov);
  color: var(--text-mid);
}

.btn-advance {
  background: color-mix(in oklch, var(--accent) 8%, transparent);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-weight: 500;
}

.btn-advance:not(:disabled):hover {
  background: color-mix(in oklch, var(--accent) 16%, transparent);
}

.btn-retreat:disabled,
.btn-advance:disabled {
  opacity: 0.28;
  cursor: default;
}

.btn-advance:disabled {
  background: transparent;
  border-color: var(--line);
  color: var(--line);
}
</style>
