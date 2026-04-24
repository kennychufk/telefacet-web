<template>
  <div
    class="grid"
    :style="gridStyle"
  >
    <div
      v-for="cam in cameras"
      :key="cam.globalId"
      class="cell"
    >
      <CameraView :camera="cam" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCameraStore } from '../stores/cameraStore'
import CameraView from './CameraView.vue'

const store = useCameraStore()
const cameras = computed(() => store.cameras)

const gridStyle = computed(() => {
  const n = cameras.value.length
  const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : 4
  const rows = Math.ceil(n / cols)
  return {
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`
  }
})
</script>

<style scoped>
.grid {
  flex: 1;
  display: grid;
  gap: 2px;
  padding: 2px;
  background: #050508;
  overflow: hidden;
  width: 100%;
  height: 100%;
}

.cell {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
