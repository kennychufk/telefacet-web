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

    <button
      v-if="canAdvance"
      class="btn-advance"
      :disabled="busy"
      @click="$emit('advance')"
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor">
        <path d="M1.5 1.5l6 3-6 3V1.5z" />
      </svg>
      {{ nextAction }}
    </button>

    <div v-if="state === 'running' && streaming" class="live-pill">
      <LiveDot :on="true" color="var(--live)" />
      <span>Live</span>
    </div>

    <button
      v-if="canRetreat"
      class="btn-retreat"
      :disabled="busy"
      @click="$emit('retreat')"
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor">
        <path d="M7.5 1.5l-6 3 6 3V1.5z" />
      </svg>
      {{ retreatAction }}
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import LiveDot from './LiveDot.vue'

const props = defineProps({
  state:     { type: String,  required: true },
  busy:      { type: Boolean, default: false },
  streaming: { type: Boolean, default: false }
})
defineEmits(['advance', 'retreat'])

const stages = [
  { key: 'connected',  label: 'Discover',  sub: 'cameras found',     action: 'Configure' },
  { key: 'configured', label: 'Configure', sub: 'resolution & crop', action: 'Start' },
  { key: 'running',    label: 'Start',     sub: 'pipeline active',   action: null }
]

const idx          = computed(() => stages.findIndex(s => s.key === props.state))
const canAdvance   = computed(() => idx.value >= 0 && idx.value < stages.length - 1)
const canRetreat   = computed(() => idx.value > 0)
const nextAction   = computed(() => canAdvance.value ? stages[idx.value + 1].action : null)
const retreatAction = computed(() => {
  if (props.state === 'running')    return 'Stop'
  if (props.state === 'configured') return 'Unconfigure'
  return null
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

.btn-advance {
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 6px;
  background: color-mix(in oklch, var(--accent) 8%, transparent);
  border: 1px solid var(--accent);
  border-radius: 6px;
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background 0.15s;
}

.btn-advance:hover:not(:disabled) {
  background: color-mix(in oklch, var(--accent) 16%, transparent);
}

.btn-advance:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.live-pill {
  width: 100%;
  padding: 7px 10px;
  margin-bottom: 6px;
  background: color-mix(in oklch, var(--live) 5%, transparent);
  border: 1px solid color-mix(in oklch, var(--live) 25%, transparent);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--live);
  font-size: 11px;
  font-weight: 500;
}

.btn-retreat {
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text-sec);
  font-size: 11px;
  letter-spacing: 0.03em;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.15s;
}

.btn-retreat:hover:not(:disabled) {
  border-color: var(--line-hov);
  color: var(--text-mid);
}

.btn-retreat:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
