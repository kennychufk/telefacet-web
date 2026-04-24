<template>
  <aside class="panel" :class="{ closed: !store.showControlPanel }">
    <div class="inner">
      <header class="head">
        <span class="wordmark">telefacet</span>
        <div class="head-actions">
          <IconBtn
            :active="store.headerOnlyMode"
            :title="store.headerOnlyMode ? 'Header only: on' : 'Header only: off'"
            :disabled="!store.hasConnectedServers"
            @click="toggleHeaderOnly"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="2" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              <line x1="10" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </IconBtn>
        </div>
      </header>

      <div class="scroll">
        <!-- Config -->
        <section class="section">
          <div class="section-label">Config</div>
          <input
            ref="fileInput"
            type="file"
            accept=".yaml,.yml"
            hidden
            @change="onFileSelect"
          />
          <div
            v-if="!store.configLoaded"
            class="drop-zone"
            :class="{ dragging }"
            @click="fileInput?.click()"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <div class="drop-text">
              Drop <code>.yaml</code> config<br />
              or click to browse
            </div>
          </div>
          <div
            v-else
            class="config-pill"
            :title="`Click to load a different config (${configFileName})`"
            @click="fileInput?.click()"
          >
            <LiveDot :on="true" color="var(--live)" />
            <span class="config-name">{{ configFileName }}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="check">
              <path d="M1 5.5L3.5 8l5.5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </section>

        <!-- Servers -->
        <section v-if="store.servers.length > 0" class="section">
          <div class="section-label">Servers</div>
          <div
            v-for="srv in store.servers"
            :key="srv.index"
            class="server-row"
          >
            <LiveDot :on="srv.connected" color="var(--live)" />
            <span class="server-addr">{{ srv.address.replace(/^wss?:\/\//, '') }}</span>
            <span class="server-cams">{{ srv.cameras }}×</span>
          </div>
        </section>

        <!-- Pipeline -->
        <section v-if="appState" class="section">
          <div class="section-label">Pipeline</div>
          <Pipeline
            :state="appState"
            :busy="busy"
            @advance="advance"
            @halt="halt"
          />
        </section>

        <!-- Cameras -->
        <section v-if="store.cameras.length > 0" class="section">
          <div class="section-label">Cameras</div>
          <div class="cam-grid">
            <button
              v-for="cam in store.cameras"
              :key="cam.globalId"
              class="cam-chip"
              :class="{ active: cam.streaming }"
              :disabled="!store.camerasRunning"
              @click="store.toggleCameraStream(cam.globalId)"
            >
              <span>cam{{ String(cam.globalId).padStart(2, '0') }}</span>
              <span v-if="cam.streaming" class="cam-fps">{{ cam.fps }} fps</span>
            </button>
          </div>
        </section>

        <!-- Mode -->
        <section v-if="store.hasConnectedServers" class="section last">
          <div class="section-label">Mode</div>
          <div class="toggle-row">
            <span class="toggle-label">Header only</span>
            <button
              class="toggle"
              :class="{ on: store.headerOnlyMode }"
              @click="toggleHeaderOnly"
            >
              <span class="thumb" :class="{ on: store.headerOnlyMode }" />
            </button>
          </div>
        </section>

        <!-- Error -->
        <div v-if="store.lastError" class="error">
          <span>{{ store.lastError }}</span>
          <button class="error-close" @click="store.clearError">×</button>
        </div>
      </div>

      <footer class="foot">
        <div class="kbd"><span class="key">P</span><span class="sep">·</span><span class="meaning">panel</span></div>
        <div class="kbd"><span class="key">H</span><span class="sep">·</span><span class="meaning">header only</span></div>
        <div class="kbd"><span class="key">R</span><span class="sep">·</span><span class="meaning">reset counts</span></div>
        <div class="kbd"><span class="key">D</span><span class="sep">·</span><span class="meaning">debug</span></div>
      </footer>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useCameraStore } from '../stores/cameraStore'
import IconBtn from './IconBtn.vue'
import LiveDot from './LiveDot.vue'
import Pipeline from './Pipeline.vue'

const store = useCameraStore()
const fileInput = ref(null)
const dragging = ref(false)
const configFileName = ref('config.yaml')
const busy = ref(false)

const appState = computed(() => {
  if (!store.configLoaded || !store.hasConnectedServers) return null
  if (!store.camerasConfigured) return 'connected'
  if (!store.camerasRunning) return 'configured'
  if (store.streamingCameras.length === 0) return 'running'
  return 'streaming'
})

async function loadFile(file) {
  if (!file) return
  if (!/\.ya?ml$/i.test(file.name)) return
  configFileName.value = file.name
  await store.loadConfig(file)
}

async function onDrop(event) {
  dragging.value = false
  await loadFile(event.dataTransfer.files[0])
}

async function onFileSelect(event) {
  await loadFile(event.target.files[0])
  event.target.value = ''
}

async function advance() {
  if (busy.value) return
  busy.value = true
  try {
    switch (appState.value) {
      case 'connected':
        await store.configureAllCameras()
        break
      case 'configured':
        await store.startAllCameras()
        break
      case 'running':
        for (const cam of store.cameras) {
          if (!cam.streaming) store.toggleCameraStream(cam.globalId)
        }
        break
    }
  } finally {
    busy.value = false
  }
}

async function halt() {
  busy.value = true
  try {
    await store.stopAllCameras()
  } finally {
    busy.value = false
  }
}

async function toggleHeaderOnly() {
  if (!store.hasConnectedServers) return
  const next = !store.headerOnlyMode
  store.headerOnlyMode = next
  await store.setHeaderOnlyMode(next)
}
</script>

<style scoped>
.panel {
  width: 210px;
  height: 100%;
  background: var(--panel);
  border-right: 1px solid var(--line);
  overflow: hidden;
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}

.panel.closed {
  width: 0;
}

.inner {
  width: 210px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.head {
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.wordmark {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.12em;
  color: var(--text-pri);
  text-transform: lowercase;
}

.head-actions {
  display: flex;
  gap: 4px;
}

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 0 12px;
}

.section {
  margin-bottom: 20px;
}

.section.last {
  margin-bottom: 0;
}

.section-label {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-sec);
  padding: 0 16px;
  margin-bottom: 8px;
}

/* Drop zone */
.drop-zone {
  margin: 0 12px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: 14px 10px;
  text-align: center;
  cursor: pointer;
  background: transparent;
  transition: all 0.15s;
}

.drop-zone.dragging {
  border-color: var(--accent);
  background: color-mix(in oklch, var(--accent) 5%, transparent);
}

.drop-text {
  font-size: 11px;
  color: var(--text-sec);
  line-height: 1.5;
}

.drop-text code {
  font-family: var(--font-mono);
  font-size: 10px;
}

.config-pill {
  margin: 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  background: color-mix(in oklch, var(--live) 4%, transparent);
  border: 1px solid color-mix(in oklch, var(--live) 19%, transparent);
  cursor: pointer;
  transition: background 0.15s;
}

.config-pill:hover {
  background: color-mix(in oklch, var(--live) 8%, transparent);
}

.config-name {
  font-size: 11px;
  color: var(--live);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.check {
  color: var(--text-sec);
  flex-shrink: 0;
}

/* Servers */
.server-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
}

.server-addr {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.server-cams {
  font-size: 10px;
  color: var(--text-sec);
  flex-shrink: 0;
}

/* Cameras */
.cam-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 0 12px;
}

.cam-chip {
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 7px 6px;
  background: transparent;
  color: var(--text-sec);
  font-family: var(--font-mono);
  font-size: 10.5px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  transition: all 0.15s;
}

.cam-chip:hover:not(:disabled):not(.active) {
  border-color: var(--line-hov);
  color: var(--text-mid);
}

.cam-chip.active {
  border-color: color-mix(in oklch, var(--live) 38%, transparent);
  background: var(--live-dim);
  color: var(--live);
}

.cam-chip:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.cam-fps {
  font-size: 9.5px;
  opacity: 0.8;
}

/* Toggle */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 16px;
}

.toggle-label {
  font-size: 11px;
  color: var(--text-mid);
}

.toggle {
  width: 28px;
  height: 16px;
  border-radius: 8px;
  background: var(--line);
  position: relative;
  flex-shrink: 0;
  transition: background 0.2s;
}

.toggle.on {
  background: var(--accent);
}

.thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.2s;
}

.thumb.on {
  left: 14px;
}

/* Error */
.error {
  margin: 8px 12px 0;
  padding: 8px 10px;
  background: color-mix(in oklch, var(--danger) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--danger) 38%, transparent);
  border-radius: 5px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--danger);
  font-size: 10.5px;
  line-height: 1.4;
}

.error span {
  flex: 1;
}

.error-close {
  color: var(--danger);
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}

/* Footer */
.foot {
  border-top: 1px solid var(--line);
  padding: 10px 16px;
}

.kbd {
  font-size: 9.5px;
  line-height: 1.9;
  font-family: var(--font-mono);
}

.kbd .key {
  color: var(--text-sec);
}

.kbd .sep {
  color: var(--line);
  margin: 0 5px;
}

.kbd .meaning {
  color: var(--text-sec);
  opacity: 0.7;
}
</style>
