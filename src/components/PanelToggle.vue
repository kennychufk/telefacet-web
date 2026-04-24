<template>
  <div
    class="panel-toggle"
    :style="{ left: open ? `${panelWidth}px` : '0px' }"
    :title="open ? 'Hide panel  P' : 'Show panel  P'"
    @click="$emit('toggle')"
  >
    <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
      <path
        :d="open ? 'M5 1L1 6l4 5' : 'M2 1l4 5-4 5'"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </div>
</template>

<script setup>
defineProps({
  open: { type: Boolean, default: true },
  panelWidth: { type: Number, default: 210 }
})
defineEmits(['toggle'])
</script>

<style scoped>
.panel-toggle {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 48px;
  z-index: 100;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: none;
  border-radius: 0 5px 5px 0;
  color: var(--text-sec);
  transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.15s, color 0.15s;
}

.panel-toggle:hover {
  background: var(--panel-hov);
  color: var(--text-mid);
}
</style>
