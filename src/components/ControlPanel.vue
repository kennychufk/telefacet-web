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
            :title="serverTitle(srv)"
          >
            <LiveDot :on="srv.connected" color="var(--live)" />
            <span class="server-addr">{{ srv.address.replace(/^wss?:\/\//, '') }}</span>
            <span
              v-if="srv.role === 'observer'"
              class="server-role"
              title="Read-only observer connection: this client only watches"
            >obs</span>
            <span v-if="srv.sensor" class="server-sensor">{{ srv.sensor }}</span>
            <span class="server-cams">{{ srv.cameras }}×</span>
          </div>
        </section>

        <!-- Observed servers: what we are waiting on, if anything. The
             cameras of an observer server are run by some other client (the
             commander); this panel can only watch. -->
        <section v-if="store.hasObserverServers" class="section">
          <div class="section-label">Observing</div>
          <div
            v-for="srv in store.observerServers"
            :key="srv.index"
            class="observe-row"
            :class="observeClass(srv)"
          >
            <span class="observe-state">{{ observeState(srv) }}</span>
            <span class="observe-detail">{{ observeDetail(srv) }}</span>
          </div>
        </section>

        <!-- Pipeline (only for servers this client commands) -->
        <section v-if="appState && store.hasCommanderServers" class="section">
          <div class="section-label">Pipeline</div>
          <Pipeline
            :state="appState"
            :busy="busy"
            :streaming="store.streamingCameras.length > 0"
            :all-streaming="store.allStreaming"
            @advance="advance"
            @retreat="retreat"
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
              :class="{ active: cam.streaming, observed: store.isObserverCamera(cam.globalId) }"
              :disabled="!store.camerasRunning && !store.isObserverCamera(cam.globalId)"
              :title="store.isObserverCamera(cam.globalId) ? 'Observed camera: subscription persists until a commander stops it for good' : undefined"
              @click="store.toggleCameraStream(cam.globalId)"
            >
              <span>cam{{ String(cam.globalId).padStart(2, '0') }}</span>
              <span
                v-if="cam.streaming"
                class="cam-fps"
                :title="`Received (client): ${cam.clientFps} fps — frames decoded per second\nCaptured (server): ${cam.serverFps} fps — libcamera hardware cadence`"
              >
                <span class="cam-fps-client">{{ cam.clientFps }}</span>
                <span class="cam-fps-sep">/</span>
                <span class="cam-fps-server">{{ cam.serverFps }}</span>
                <span class="cam-fps-unit">fps</span>
              </span>
            </button>
          </div>
        </section>

        <!-- Mode -->
        <section v-if="store.hasConnectedServers" class="section">
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

        <!-- Trigger (save-on-demand; only exists in the `trigger` mode) -->
        <section v-if="store.isTriggerMode && store.hasCommanderServers" class="section">
          <div class="section-label">Trigger</div>
          <button
            class="trigger-btn"
            :class="{ pending: store.triggerPending }"
            :disabled="!store.canTriggerCapture"
            :title="triggerHint"
            @click="fireTrigger"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5" />
              <circle cx="6" cy="6" r="2" fill="currentColor" />
            </svg>
            <span>{{ store.triggerPending ? 'Capturing…' : 'Capture' }}</span>
          </button>
          <div class="trigger-note">{{ triggerHint }}</div>
        </section>

        <!-- Exposure & frame rate (camera attributes: commander only) -->
        <section v-if="store.hasConnectedServers && store.hasCommanderServers" class="section">
          <div class="section-label">Exposure</div>
          <ExposureSection :disabled="!store.camerasConfigured" />
        </section>

        <!-- Focus (camera attributes: commander only) -->
        <section v-if="store.hasConnectedServers && store.hasCommanderServers" class="section last">
          <div class="section-label">Focus</div>
          <FocusSection :disabled="!store.camerasConfigured" />
        </section>

        <!-- Capture watchdog: a camera has stopped delivering frames and
             will not recover on its own (protocol §7.1). Distinct from a
             plain error because there is exactly one thing to do about it. -->
        <div v-if="store.captureTimeout" class="stall">
          <div class="stall-head">
            Camera {{ store.captureTimeout.globalId ?? store.captureTimeout.cameraId }}
            stopped delivering frames
          </div>
          <div class="stall-body">
            Silent for {{ stalledSeconds }}s. libcamera's frontend has timed out;
            capture will not resume by itself.
            <template v-if="store.captureTimeout.framesDroppedBacklog">
              {{ store.captureTimeout.framesDroppedBacklog }} frame(s) were dropped
              at the server's backlog budget, so its memory budget is the likely cause.
            </template>
          </div>
          <button
            v-if="store.hasCommanderServers"
            class="stall-action"
            :disabled="recovering"
            @click="onRecover"
          >
            {{ recovering ? 'Restarting…' : 'Restart capture' }}
          </button>
          <div v-else class="stall-body">
            Only the commander can restart capture; this client is an observer.
          </div>
        </div>

        <!-- Frames the server refused at its backlog budget: the recording
             from the last run has a gap. -->
        <div v-if="store.lastFramesDroppedBacklog > 0" class="dropped">
          <span>
            {{ store.lastFramesDroppedBacklog }} frame(s) dropped at the server's
            backlog budget — the last capture has a gap.
          </span>
          <button class="dropped-close" @click="store.clearDroppedNotice">×</button>
        </div>

        <!-- Error -->
        <div v-if="store.lastError" class="error">
          <span>{{ store.lastError }}</span>
          <button class="error-close" @click="store.clearError">×</button>
        </div>
      </div>

      <footer class="foot">
        <div class="kbd"><span class="key">P</span><span class="sep">·</span><span class="meaning">panel</span></div>
        <div class="kbd"><span class="key">H</span><span class="sep">·</span><span class="meaning">header only</span></div>
        <div v-if="store.hasCommanderServers" class="kbd"><span class="key">R</span><span class="sep">·</span><span class="meaning">reset counts</span></div>
        <div class="kbd"><span class="key">D</span><span class="sep">·</span><span class="meaning">debug</span></div>
        <div v-if="store.isTriggerMode" class="kbd"><span class="key">T</span><span class="sep">·</span><span class="meaning">trigger</span></div>
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
import FocusSection from './FocusSection.vue'
import ExposureSection from './ExposureSection.vue'

const store = useCameraStore()
const fileInput = ref(null)
const dragging = ref(false)
const configFileName = ref('config.yaml')
const busy = ref(false)

const appState = computed(() => {
  if (!store.configLoaded || !store.hasConnectedServers) return null
  if (!store.camerasConfigured) return 'connected'
  if (!store.camerasRunning) return 'configured'
  return 'running'
})

// Observer servers: what the watched server is doing, and whether anyone is
// there to change it.
function observeState(srv) {
  if (!srv.connected) return 'offline'
  if (srv.serverState === 'running') return 'live'
  return 'waiting'
}

function observeDetail(srv) {
  if (!srv.connected) return 'reconnecting…'
  if (srv.serverState === 'running') return 'commander is streaming'
  if (srv.commanderConnected === false) return 'no commander connected'
  if (srv.commanderConnected === true) {
    return srv.serverState === 'configured'
      ? 'commander has not started the cameras'
      : 'commander has not configured the cameras'
  }
  return 'cameras not running'
}

function observeClass(srv) {
  return { live: srv.connected && srv.serverState === 'running', offline: !srv.connected }
}

function serverTitle(srv) {
  const role = srv.role === 'observer' ? 'observer (read-only)' : 'commander'
  const state = srv.connected ? srv.serverState : 'disconnected'
  const others = srv.commanderConnected === null
    ? ''
    : `\ncommander ${srv.commanderConnected ? 'present' : 'absent'}, observer ${srv.observerConnected ? 'present' : 'absent'}`
  return `${role} · ${state}${others}`
}

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
        store.startAllStreams()
        break
    }
  } finally {
    busy.value = false
  }
}

async function retreat() {
  if (busy.value) return
  busy.value = true
  try {
    switch (appState.value) {
      case 'running':
        await store.stopAllCameras()
        break
      case 'configured':
        await store.unconfigureAllCameras()
        break
    }
  } finally {
    busy.value = false
  }
}

// In `trigger` mode nothing is written until this fires. The button stays
// disabled while a capture is outstanding — the server allows only one.
const triggerHint = computed(() => {
  if (!store.camerasRunning) return 'Start the cameras to capture'
  if (store.triggerPending) return 'Waiting for the triggered frame…'
  const last = store.lastTriggerResult
  if (last) {
    return last.cancelled
      ? `Trigger #${last.triggerId} cancelled`
      : `Trigger #${last.triggerId}: saved ${last.captures.length} frame(s)`
  }
  return 'Saves one frame per running camera'
})

async function fireTrigger() {
  if (!store.canTriggerCapture) return
  await store.triggerCapture()
}

// Capture watchdog banner: how long the camera has been silent, and the
// stop_cameras + start_cameras cycle that is the only way back.
const stalledSeconds = computed(() => {
  const us = store.captureTimeout?.stalledForUs
  return Number.isFinite(us) ? (us / 1e6).toFixed(1) : '?'
})

const recovering = ref(false)

async function onRecover() {
  recovering.value = true
  try {
    await store.recoverCapture()
  } finally {
    recovering.value = false
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

.server-sensor {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-sec);
  flex-shrink: 0;
}

.server-cams {
  font-size: 10px;
  color: var(--text-sec);
  flex-shrink: 0;
}

.server-role {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
  border: 1px solid color-mix(in oklch, var(--accent) 40%, transparent);
  border-radius: 3px;
  padding: 0 3px;
  flex-shrink: 0;
}

/* Observed servers */
.observe-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 16px;
  font-size: 10.5px;
}

.observe-state {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--warn);
  flex-shrink: 0;
  width: 46px;
}

.observe-row.live .observe-state { color: var(--live); }
.observe-row.offline .observe-state { color: var(--text-sec); }

.observe-detail {
  color: var(--text-mid);
  line-height: 1.3;
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

.cam-chip.observed.active {
  border-style: dashed;
}

.cam-chip:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.cam-fps {
  font-size: 9.5px;
  white-space: nowrap;
  cursor: help;
}

.cam-fps-client { color: var(--live); }
.cam-fps-sep    { color: var(--text-sec); margin: 0 0.15em; font-weight: 300; opacity: 0.6; }
.cam-fps-server { color: var(--hw-fps); }
.cam-fps-unit   { color: var(--text-sec); margin-left: 0.2em; opacity: 0.7; }

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

/* Trigger (save-on-demand shutter) */
.trigger-btn {
  width: calc(100% - 32px);
  margin: 0 16px;
  padding: 8px 10px;
  border: 1px solid color-mix(in oklch, var(--live) 38%, transparent);
  border-radius: 5px;
  background: var(--live-dim);
  color: var(--live);
  font-family: var(--font-mono);
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.15s;
}

.trigger-btn:hover:not(:disabled) {
  background: color-mix(in oklch, var(--live) 22%, transparent);
}

.trigger-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.trigger-btn.pending {
  border-color: color-mix(in oklch, var(--accent) 38%, transparent);
  color: var(--accent);
}

.trigger-note {
  padding: 5px 16px 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-mid);
}

/* Capture stall (capture_timeout) */
.stall {
  margin: 8px 12px 0;
  padding: 8px 10px;
  background: color-mix(in oklch, var(--danger) 14%, transparent);
  border: 1px solid color-mix(in oklch, var(--danger) 45%, transparent);
  border-radius: 5px;
  color: var(--danger);
  font-size: 10.5px;
  line-height: 1.4;
}

.stall-head {
  font-weight: 600;
  margin-bottom: 3px;
}

.stall-body {
  color: var(--text-mid);
  margin-bottom: 6px;
}

.stall-action {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid color-mix(in oklch, var(--danger) 55%, transparent);
  border-radius: 4px;
  background: color-mix(in oklch, var(--danger) 20%, transparent);
  color: var(--danger);
  font-size: 10.5px;
  font-weight: 600;
}

.stall-action:disabled {
  opacity: 0.6;
}

/* Frames refused at the server's backlog budget */
.dropped {
  margin: 8px 12px 0;
  padding: 8px 10px;
  background: color-mix(in oklch, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--warn) 38%, transparent);
  border-radius: 5px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--warn);
  font-size: 10.5px;
  line-height: 1.4;
}

.dropped span {
  flex: 1;
}

.dropped-close {
  color: var(--warn);
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
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
