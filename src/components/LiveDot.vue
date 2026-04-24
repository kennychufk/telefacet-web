<template>
  <span
    class="live-dot"
    :class="{ on }"
    :style="dotStyle"
  />
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  on: { type: Boolean, default: false },
  color: { type: String, default: 'var(--live)' }
})

const dotStyle = computed(() => ({
  background: props.on ? props.color : 'var(--text-sec)',
  boxShadow: props.on ? `0 0 6px ${props.color}` : 'none'
}))
</script>

<style scoped>
.live-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.live-dot.on {
  animation: pulse-dot 2s ease-in-out infinite;
}
</style>
