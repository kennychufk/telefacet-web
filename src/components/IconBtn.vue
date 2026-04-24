<template>
  <button
    class="icon-btn"
    :class="{ active, danger, disabled }"
    :title="title"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>

<script setup>
defineProps({
  active: { type: Boolean, default: false },
  danger: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' }
})
defineEmits(['click'])
</script>

<style scoped>
.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 5px;
  border: 1px solid transparent;
  color: var(--text-sec);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.icon-btn:hover:not(.active):not(:disabled) {
  background: var(--panel-hov);
  border-color: var(--line-hov);
  color: var(--text-mid);
}

.icon-btn.active {
  background: color-mix(in oklch, var(--accent) 13%, transparent);
  border-color: var(--accent);
  color: var(--accent);
}

.icon-btn.active.danger {
  background: color-mix(in oklch, var(--danger) 13%, transparent);
  border-color: var(--danger);
  color: var(--danger);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
