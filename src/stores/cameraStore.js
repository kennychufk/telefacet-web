// src/stores/cameraStore.js - Updated to track frames_saved per camera
import { defineStore } from 'pinia'
import { MultiServerManager } from '../services/WebSocketManager'
import { configLoader } from '../services/ConfigLoader'

export const useCameraStore = defineStore('camera', {
  state: () => ({
    // Configuration
    config: null,
    configLoaded: false,

    // Server management
    serverManager: null,
    // Array of { index, address, role, connected, cameras, serverState,
    //            commanderConnected, observerConnected, ... }
    servers: [],

    // Camera management
    cameras: [], // Array of { globalId, serverIndex, localId, streaming, fps, framesSaved }
    totalCameras: 0,

    // System state
    camerasConfigured: false,
    camerasRunning: false,
    saveModeConfigured: false,

    // UI state
    debayerQuality: 'quality', // 'quality'
    showControlPanel: true,
    headerOnlyMode: false,
    focusMode: 'auto',      // 'auto' | 'manual'
    lensPosition: 0.0,

    // Exposure & frame duration (µs). -1 = auto AE / unset fd (matches server defaults).
    exposureTimeUs: -1,
    frameDurationUs: -1,
    // Sensor limits populated by get_frame_duration_limits: { min, max, current }
    frameDurationLimits: null,
    // Hardware lens range (dioptres) populated by get_lens_position_limits:
    // { min, max, default }. null until fetched; fields null on a fixed-focus
    // module. The Focus UI falls back to a default range when this is null.
    lensPositionLimits: null,

    // Trigger mode (save-on-demand). triggerPendingServers counts servers that
    // have been armed but not yet acked; lastTriggerResult holds the most
    // recent ack: { triggerId, cancelled, captures, at }.
    triggerPendingServers: 0,
    lastTriggerResult: null,

    // Capture watchdog (protocol §7.1). Set when a server pushes an
    // unsolicited `capture_timeout`, meaning one of its cameras has stopped
    // delivering frames and will not resume on its own. Holds
    // { serverIndex, cameraId, globalId, stalledForUs, message, at,
    //   backlogBytes, backlogBudgetBytes, framesDroppedBacklog }.
    // Cleared by recoverCapture(), by stopping the cameras, or as soon as the
    // affected camera delivers a frame again.
    captureTimeout: null,
    // frames_dropped_backlog from the last stop_cameras reply. Non-zero means
    // capture outran its sink and the recording has a gap.
    lastFramesDroppedBacklog: 0,

    // Error handling
    lastError: null
  }),

  getters: {
    streamingCameras: (state) => {
      return state.cameras.filter(cam => cam.streaming)
    },

    // A camera has died and needs stop_cameras + start_cameras to come back.
    hasCaptureTimeout: (state) => state.captureTimeout !== null,

    // Client roles (protocol §1.1). Commander servers are the ones this client
    // drives; observer servers are watched read-only and wait for someone else
    // to run their cameras.
    commanderServers: (state) => state.servers.filter(s => s.role !== 'observer'),
    observerServers: (state) => state.servers.filter(s => s.role === 'observer'),
    hasCommanderServers: (state) => state.servers.some(s => s.role !== 'observer'),
    hasObserverServers: (state) => state.servers.some(s => s.role === 'observer'),
    // Pure telemetry session: nothing to configure or start from here.
    observerOnly: (state) =>
      state.servers.length > 0 && state.servers.every(s => s.role === 'observer'),

    allCommanderServersConnected: (state) => {
      const commanders = state.servers.filter(s => s.role !== 'observer')
      return commanders.length > 0 && commanders.every(s => s.connected)
    },

    // Observer servers whose cameras are not running — the CCTV view is
    // waiting on a commander (absent, or present but not started).
    waitingObserverServers: (state) =>
      state.servers.filter(
        s => s.role === 'observer' && s.connected && s.serverState !== 'running'
      ),

    connectedServers: (state) => {
      return state.servers.filter(server => server.connected)
    },

    allServersConnected: (state) => {
      return state.servers.length > 0 &&
        state.servers.every(server => server.connected)
    },

    hasConnectedServers: (state) => {
      return state.servers.some(server => server.connected)
    },

    canConfigure(state) {
      return state.configLoaded &&
        this.allCommanderServersConnected &&
        !state.camerasConfigured
    },

    canStartCameras(state) {
      return this.hasCommanderServers && state.camerasConfigured && !state.camerasRunning
    },

    canStopCameras(state) {
      return this.hasCommanderServers && state.camerasRunning
    },

    allStreaming: (state) => {
      return state.cameras.length > 0 &&
        state.cameras.every(cam => cam.streaming)
    },

    // The `trigger` process mode writes nothing until trigger_capture asks for
    // a frame, so the shutter button only exists in that mode.
    isTriggerMode: (state) => {
      return state.config?.processing?.mode === 'trigger'
    },

    triggerPending: (state) => state.triggerPendingServers > 0,

    canTriggerCapture: (state) => {
      return state.config?.processing?.mode === 'trigger' &&
        state.camerasRunning &&
        state.triggerPendingServers === 0 &&
        state.servers.some(server => server.connected && server.role !== 'observer')
    }
  },

  actions: {
    async loadConfig(file) {
      try {
        const config = await configLoader.loadFromFile(file)
        this.config = config
        this.configLoaded = true

        // Initialize servers
        this.initializeServers()

        return true
      } catch (error) {
        this.lastError = error.message
        console.error('Failed to load config:', error)
        return false
      }
    },

    initializeServers() {
      if (!this.config) return

      // Create server manager
      this.serverManager = new MultiServerManager()

      // Set up event listeners
      this.setupEventListeners()

      // Initialize server list
      this.servers = this.config.servers.map((server, index) => ({
        index,
        address: server.address,
        role: server.role === 'observer' ? 'observer' : 'commander',
        sensor: server.sensor,
        width: server.width,
        height: server.height,
        subsample: server.subsample || 1,
        maxFps: server.max_fps || 0,
        connected: false,
        cameras: 0,
        serverState: 'unknown',
        // Who else is on the server, from the `state` reply/pushes (§3.1).
        // null until the first `state` arrives.
        commanderConnected: null,
        observerConnected: null
      }))

      // Add servers to manager
      this.servers.forEach(server => {
        this.serverManager.addServer(server.address, server.index, {
          role: server.role,
          sensor: server.sensor,
          cameraConfig: { width: server.width, height: server.height },
          subsample: server.subsample,
          maxFps: server.maxFps
        })
      })

      // Connect to all servers
      this.serverManager.connectAll()
    },

    setupEventListeners() {
      const manager = this.serverManager

      manager.on('server-connected', (serverIndex) => {
        const server = this.servers.find(s => s.index === serverIndex)
        if (server) {
          server.connected = true
          console.log(`✅ Server ${serverIndex} connected successfully`)
        }
      })

      manager.on('server-disconnected', (serverIndex) => {
        const server = this.servers.find(s => s.index === serverIndex)
        if (server) {
          server.connected = false
          server.serverState = 'unknown'
          server.commanderConnected = null
          server.observerConnected = null
          console.warn(`⚠️ Server ${serverIndex} disconnected`)
          // The server dropped this connection's subscriptions.
          this._markServerStreams(serverIndex, false)
        }
        this._syncStateFromServers()
      })

      manager.on('server-state', ({ serverIndex, state, cause, commanderConnected, observerConnected }) => {
        const server = this.servers.find(s => s.index === serverIndex)
        if (server) {
          const wasRunning = server.serverState === 'running'
          server.serverState = state
          if (typeof commanderConnected === 'boolean') server.commanderConnected = commanderConnected
          if (typeof observerConnected === 'boolean') server.observerConnected = observerConnected
          console.log(`Server ${serverIndex} reported state: ${state} (${cause || 'query'})`)
          // An observer's subscriptions survive the commander stopping the
          // cameras (§4.7); only the frames pause. Zero the rates so the UI
          // does not show a stale fps over a frozen picture.
          if (wasRunning && state !== 'running' && server.role === 'observer') {
            this._zeroServerFps(serverIndex)
          }
        }
        this._syncStateFromServers()
      })

      manager.on('cameras-discovered', (data) => {
        const server = this.servers.find(s => s.index === data.serverIndex)
        if (server) {
          server.cameras = data.cameras.length
        }
        this.updateCameraList()
      })

      manager.on('camera-map-updated', () => {
        this.updateCameraList()
      })

      manager.on('fps-update', (data) => {
        const camera = this.cameras.find(cam => cam.globalId === data.globalCameraId)
        if (camera) {
          camera.clientFps = data.clientFps
        }
      })

      manager.on('server-fps-update', (data) => {
        const camera = this.cameras.find(cam => cam.globalId === data.globalCameraId)
        if (camera) {
          camera.serverFps = data.serverFps
        }
      })

      // Handle frame events to update frames_saved counter
      manager.on('frame', (data) => {
        const camera = this.cameras.find(cam => cam.globalId === data.globalCameraId)
        if (camera && typeof data.framesSaved === 'number') {
          camera.framesSaved = data.framesSaved
        }
        // Frames are flowing again for the camera we flagged, so the stall is
        // over (the server latches per episode and does the same).
        if (this.captureTimeout &&
            this.captureTimeout.globalId === data.globalCameraId) {
          this.captureTimeout = null
        }
      })

      manager.on('status', (data) => {
        console.log(`Server ${data.serverIndex} status:`, data.message)
        // stop_cameras reports how many frames the server refused at its
        // backlog budget (§4.9). Non-zero ⇒ the recording has a gap, which the
        // operator needs to know before trusting the capture.
        if (Number.isFinite(data.data?.frames_dropped_backlog)) {
          this.lastFramesDroppedBacklog = data.data.frames_dropped_backlog
        }
      })

      manager.on('server-error', (data) => {
        console.error(`Server ${data.serverIndex} error:`, data.message)
        this.lastError = `Server ${data.serverIndex}: ${data.message}`

        // capture_timeout is not a reply to anything we sent — a camera has
        // stopped delivering frames and libcamera's frontend will not recover
        // on its own. Record it so the UI can say so and offer the restart,
        // instead of leaving the operator staring at a frozen preview.
        if (data.code === 'capture_timeout') {
          const globalId = this.cameras.find(
            cam => cam.serverIndex === data.serverIndex && cam.localId === data.cameraId
          )?.globalId ?? null
          this.captureTimeout = {
            serverIndex: data.serverIndex,
            cameraId: data.cameraId,
            globalId,
            stalledForUs: data.stalledForUs,
            message: data.message,
            backlogBytes: data.backlogBytes,
            backlogBudgetBytes: data.backlogBudgetBytes,
            framesDroppedBacklog: data.framesDroppedBacklog,
            at: Date.now()
          }
          // It is not streaming any more, whatever the toggle says.
          const camera = this.cameras.find(cam => cam.globalId === globalId)
          if (camera) {
            camera.clientFps = 0
            camera.serverFps = 0
          }
        }
      })

      manager.on('error', (data) => {
        // Handle WebSocket errors without throwing unhandled exceptions
        console.error(`WebSocket error on server ${data.serverIndex}:`, data.error)
        if (data.type === 'websocket_error') {
          // Don't show transient WebSocket errors to user unless they persist
          console.log('WebSocket error handled - will attempt reconnection')
        }
      })

      manager.on('reconnect-failed', (serverIndex) => {
        this.lastError = `Server ${serverIndex}: Failed to reconnect after multiple attempts`
        console.error(`❌ Server ${serverIndex} reconnection failed permanently`)
      })

      manager.on('frame-duration-limits', (data) => {
        this.frameDurationLimits = {
          min: data.min,
          max: data.max,
          current: data.current
        }
      })

      manager.on('lens-position-limits', (data) => {
        this.lensPositionLimits = {
          min: data.min,
          max: data.max,
          default: data.default
        }
      })

      manager.on('trigger-result', (data) => {
        // One ack per server; the pending count clears as they report.
        this.triggerPendingServers = Math.max(0, this.triggerPendingServers - 1)
        this.lastTriggerResult = {
          triggerId: data.triggerId,
          cancelled: data.cancelled,
          captures: data.captures,
          at: Date.now()
        }
        if (data.cancelled) {
          this.lastError = `Trigger ${data.triggerId} was cancelled before every camera delivered`
        }
      })
    },

    updateCameraList() {
      const cameraMap = this.serverManager.globalCameraMap

      this.cameras = Array.from(cameraMap.entries()).map(([globalId, info]) => ({
        globalId,
        serverIndex: info.serverIndex,
        localId: info.localCameraId,
        streaming: false,
        clientFps: 0,
        serverFps: 0,
        framesSaved: 0
      }))

      this.totalCameras = this.cameras.length
      this.autoSubscribeObservers()
    },

    // An observer is a CCTV view: subscribe to every camera of every observer
    // server as soon as it is discovered. The subscription is persistent on
    // the server (§4.7) — it waits for the cameras to run and survives the
    // commander's stop/start cycles — so this is a one-off per connection.
    // Idempotent: a camera already subscribed on its current connection is
    // skipped (discovery fires the camera-map rebuild twice).
    autoSubscribeObservers() {
      if (!this.serverManager) return
      for (const camera of this.cameras) {
        if (!this.serverManager.isObserverCamera(camera.globalId)) continue
        if (this.serverManager.isStreaming(camera.globalId) ||
            this.serverManager.startStream(camera.globalId)) {
          camera.streaming = true
        }
      }
    },

    _markServerStreams(serverIndex, streaming) {
      for (const camera of this.cameras) {
        if (camera.serverIndex !== serverIndex) continue
        camera.streaming = streaming
        camera.clientFps = 0
        camera.serverFps = 0
      }
    },

    _zeroServerFps(serverIndex) {
      for (const camera of this.cameras) {
        if (camera.serverIndex !== serverIndex) continue
        camera.clientFps = 0
        camera.serverFps = 0
      }
    },

    isObserverCamera(globalId) {
      return !!this.serverManager?.isObserverCamera(globalId)
    },

    async configureAllCameras() {
      if (!this.canConfigure) return false

      try {
        this.serverManager.configureAll()

        // Set save mode as part of configuration (only if not already set)
        if (!this.saveModeConfigured) {
          await this.setSaveMode()
          this.saveModeConfigured = true
        }

        // Ask whether it actually happened rather than sleeping and hoping.
        // _syncStateFromServers() drives camerasConfigured off what the
        // servers report, so polling get_state is what makes the flag true.
        const ok = await this._awaitServerState(() => this.camerasConfigured)
        if (!ok) {
          if (!this.lastError) this.lastError = 'Cameras did not reach the configured state'
          return false
        }

        // Limits come from ControlInfoMap, only valid once configured.
        this.serverManager.getFrameDurationLimits()
        this.serverManager.getLensPositionLimits()
        return true
      } catch (error) {
        this.lastError = 'Failed to configure cameras'
        console.error(error)
        return false
      }
    },

    async setSaveMode() {
      if (!this.config) return false

      try {
        const saveConfig = this.config.processing
        const params = {
          save_frames: saveConfig.save_frames,
          output_dir: saveConfig.output_dir,
          prepend_timestamp_to_dir: saveConfig.prepend_timestamp_to_dir,
          batch_size: saveConfig.batch_size,
          writer_threads: saveConfig.writer_threads,
          // Resource guards (§4.5.1). Mode-independent: 0/0/false means "server
          // decides", which is the default every config gets.
          backlog_max_bytes: saveConfig.backlog_max_bytes,
          disk_write_bytes_per_sec: saveConfig.disk_write_bytes_per_sec,
          allow_overcommit: saveConfig.allow_overcommit
        }

        // Add checkerboard parameters if mode uses checkerboard detection
        if (saveConfig.mode === 'checkerboard' || saveConfig.mode === 'checkerboard2x2') {
          params.checkerboard_rows = saveConfig.checkerboard_rows
          params.checkerboard_cols = saveConfig.checkerboard_cols
          params.checkerboard_full_res_detection = saveConfig.checkerboard_full_res_detection
          params.checkerboard_num_threads = saveConfig.checkerboard_num_threads
        }

        // Trigger mode: default settling frames discarded per capture
        if (saveConfig.mode === 'trigger') {
          params.trigger_skip_frames = saveConfig.trigger_skip_frames
        }

        // Add aruco parameters if mode uses ArUco marker detection
        if (saveConfig.mode === 'aruco' || saveConfig.mode === 'aruco2x2') {
          params.aruco_full_res_detection = saveConfig.aruco_full_res_detection
          params.aruco_num_threads = saveConfig.aruco_num_threads
          params.aruco_corner_refine = saveConfig.aruco_corner_refine
        }

        this.serverManager.setSaveModeAll(saveConfig.mode, params)
        return true
      } catch (error) {
        this.lastError = 'Failed to set save mode'
        console.error(error)
        return false
      }
    },

    async startAllCameras() {
      if (!this.canStartCameras) return false

      try {
        this.captureTimeout = null
        this.serverManager.startAllCameras()

        // start_cameras is not guaranteed to succeed: the server refuses a
        // process mode it judges unable to keep up with the camera (§4.6) and
        // stays CONFIGURED. Assuming success here would light up the UI as
        // Running, open streams that never deliver a frame, and hand the
        // operator a hang with no explanation — so confirm via get_state.
        const ok = await this._awaitServerState(() => this.camerasRunning)
        if (!ok) {
          // A refusal already arrived as an `error` and is in lastError with
          // the server's own reasoning; don't overwrite it with something
          // vaguer.
          if (!this.lastError) this.lastError = 'Cameras did not reach the running state'
          return false
        }
        return true
      } catch (error) {
        this.lastError = 'Failed to start cameras'
        console.error(error)
        return false
      }
    },

    // Poll get_state until `predicate` holds or the timeout expires. The
    // server pushes `state` on every transition (§3.1), but polling is what
    // makes a *refused* transition observable within a bounded time; each
    // reply feeds _syncStateFromServers(), which is what moves
    // camerasConfigured / camerasRunning.
    async _awaitServerState(predicate, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        this.serverManager.getStateAll()
        await new Promise(resolve => setTimeout(resolve, 150))
        if (predicate()) return true
      }
      return predicate()
    },

    // The documented recovery for a capture_timeout (§7.1): rebuild the
    // pipeline with stop_cameras + start_cameras, then reopen the streams that
    // were running. Reconfiguring is not needed.
    async recoverCapture() {
      if (!this.hasConnectedServers) {
        this.lastError = 'No connected servers to recover'
        return false
      }
      const wasStreaming = this.cameras.filter(cam => cam.streaming).map(cam => cam.globalId)

      this.serverManager.stopAllCameras()
      const stopped = await this._awaitServerState(() => !this.camerasRunning)
      if (!stopped) {
        this.lastError = 'Recovery failed: cameras did not stop'
        return false
      }

      this.serverManager.startAllCameras()
      const started = await this._awaitServerState(() => this.camerasRunning)
      if (!started) {
        if (!this.lastError) this.lastError = 'Recovery failed: cameras did not restart'
        return false
      }

      this.captureTimeout = null
      this.lastError = null
      for (const globalId of wasStreaming) {
        if (this.serverManager.startStream(globalId)) {
          const camera = this.cameras.find(cam => cam.globalId === globalId)
          if (camera) camera.streaming = true
        }
      }
      return true
    },

    async stopAllCameras() {
      if (!this.canStopCameras) return false

      try {
        // Clear client-side streaming state for the cameras we command (the
        // server's stop_cameras drops the commander's streams). Observer
        // subscriptions are persistent and stay put.
        this.cameras.forEach(camera => {
          if (this.isObserverCamera(camera.globalId)) return
          camera.streaming = false
          camera.clientFps = 0
          camera.serverFps = 0
        })

        // stop_cameras moves server from RUNNING → CONFIGURED
        this.serverManager.stopAllCameras()

        // Whatever stalled is moot once capture is torn down; a fresh start
        // gets a fresh watchdog.
        this.captureTimeout = null
        this.camerasRunning = false
        // camerasConfigured stays true — server is now in CONFIGURED state
        return true
      } catch (error) {
        this.lastError = 'Failed to stop cameras'
        console.error(error)
        return false
      }
    },

    async unconfigureAllCameras() {
      if (!this.camerasConfigured || this.camerasRunning) return false

      try {
        // unconfigure moves server from CONFIGURED → IDLE
        this.serverManager.unconfigureAll()

        this.camerasConfigured = false
        this.saveModeConfigured = false
        return true
      } catch (error) {
        this.lastError = 'Failed to unconfigure cameras'
        console.error(error)
        return false
      }
    },

    _syncStateFromServers() {
      // The aggregate flags describe the servers this client commands. In a
      // pure observer session there is nothing to command, so they describe
      // the watched servers instead (a "running" observer session is one whose
      // commanders have started the cameras).
      const commanders = this.servers.filter(s => s.connected && s.role !== 'observer')
      const connected = commanders.length > 0
        ? commanders
        : this.servers.filter(s => s.connected)
      if (connected.length === 0) {
        this.camerasConfigured = false
        this.camerasRunning = false
        return
      }
      const withKnownState = connected.filter(s => s.serverState && s.serverState !== 'unknown')
      if (withKnownState.length === 0) return

      // Use minimum state: all known-state servers must be at least configured/running
      this.camerasConfigured = withKnownState.every(
        s => s.serverState === 'configured' || s.serverState === 'running'
      )
      this.camerasRunning = withKnownState.every(s => s.serverState === 'running')
    },

    async resetFrameCounts() {
      if (!this.hasConnectedServers) {
        this.lastError = 'No connected servers to reset frame counts'
        return false
      }

      try {
        this.serverManager.resetFrameCountsAll()
        
        // Also reset local frames_saved counters
        this.cameras.forEach(camera => {
          camera.framesSaved = 0
        })
        
        console.log('✅ Frame counts reset on all connected servers')
        return true
      } catch (error) {
        this.lastError = 'Failed to reset frame counts'
        console.error(error)
        return false
      }
    },

    /**
     * Save one frame per running camera, right now (`trigger` mode only).
     * Resolves once every armed server has acked — meaning the frames really
     * were captured — or when `timeoutMs` elapses.
     * @param {{skipFrames?: number, timeoutMs?: number}} [options]
     * @returns {Promise<boolean>} true if every armed server acked in time.
     */
    async triggerCapture({ skipFrames, timeoutMs = 10000 } = {}) {
      if (!this.canTriggerCapture) {
        this.lastError = this.isTriggerMode
          ? 'Cameras must be running (and no trigger pending) to capture'
          : 'trigger_capture requires the "trigger" process mode'
        return false
      }

      const armed = this.serverManager.triggerCaptureAll({ skipFrames })
      if (armed === 0) {
        this.lastError = 'No connected servers to trigger'
        return false
      }
      this.triggerPendingServers = armed

      // Wait for the `trigger-result` handler to drain the pending count. The
      // server sends no ack at all if it rejects the request, hence the cap.
      const deadline = Date.now() + timeoutMs
      while (this.triggerPendingServers > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (this.triggerPendingServers > 0) {
        this.triggerPendingServers = 0
        this.lastError = 'Trigger capture timed out waiting for the frame'
        return false
      }
      return !this.lastTriggerResult?.cancelled
    },

    async setHeaderOnlyMode(enabled) {
      if (!this.hasConnectedServers) {
        this.lastError = 'No connected servers'
        return false
      }

      try {
        this.serverManager.setHeaderOnlyModeAll(enabled)
        console.log(`✅ Header only mode ${enabled ? 'enabled' : 'disabled'}`)
        return true
      } catch (error) {
        this.lastError = 'Failed to set header only mode'
        console.error(error)
        return false
      }
    },

    // exposureTimeUs < 0 → auto AE; > 0 → manual shutter (µs)
    async setExposureTime(exposureTimeUs) {
      if (!this.hasConnectedServers) {
        this.lastError = 'No connected servers'
        return false
      }
      try {
        this.serverManager.setExposureTimeAll(exposureTimeUs)
        this.exposureTimeUs = exposureTimeUs
        return true
      } catch (error) {
        this.lastError = 'Failed to set exposure time'
        console.error(error)
        return false
      }
    },

    // frameDurationUs <= 0 → unset (libcamera default); > 0 → locked (µs)
    async setFrameDuration(frameDurationUs) {
      if (!this.hasConnectedServers) {
        this.lastError = 'No connected servers'
        return false
      }
      try {
        this.serverManager.setFrameDurationAll(frameDurationUs)
        this.frameDurationUs = frameDurationUs
        return true
      } catch (error) {
        this.lastError = 'Failed to set frame duration'
        console.error(error)
        return false
      }
    },

    async fetchFrameDurationLimits() {
      if (!this.hasConnectedServers) return false
      return this.serverManager.getFrameDurationLimits()
    },

    // Result arrives asynchronously and populates this.lensPositionLimits.
    async fetchLensPositionLimits() {
      if (!this.hasConnectedServers) return false
      return this.serverManager.getLensPositionLimits()
    },

    // lensPosition < 0 engages continuous AF; >= 0 sets manual focus at that dioptre value
    async setLensPosition(lensPosition) {
      if (!this.hasConnectedServers) {
        this.lastError = 'No connected servers'
        return false
      }

      try {
        this.serverManager.setLensPositionAll(lensPosition)
        if (lensPosition < 0) {
          this.focusMode = 'auto'
        } else {
          this.focusMode = 'manual'
          this.lensPosition = lensPosition
        }
        return true
      } catch (error) {
        this.lastError = 'Failed to set lens position'
        console.error(error)
        return false
      }
    },

    startAllStreams() {
      const pending = this.cameras.filter(cam => !cam.streaming)
      if (pending.length === 0) return true

      // Observer subscriptions may be made in any state; commander streams
      // need the cameras running.
      const needsRunning = pending.some(cam => !this.isObserverCamera(cam.globalId))
      if (needsRunning && !this.camerasRunning) {
        this.lastError = 'Cameras must be running to stream'
        return false
      }

      pending.forEach(camera => {
        if (this.serverManager.startStream(camera.globalId)) {
          camera.streaming = true
        }
      })
      return true
    },

    toggleCameraStream(globalId) {
      const camera = this.cameras.find(cam => cam.globalId === globalId)
      if (!camera) return false

      if (!this.camerasRunning && !this.isObserverCamera(globalId)) {
        this.lastError = 'Cameras must be running to stream'
        return false
      }

      if (camera.streaming) {
        if (this.serverManager.stopStream(globalId)) {
          camera.streaming = false
          camera.clientFps = 0
          camera.serverFps = 0
          return true
        }
      } else {
        // Add a small delay before starting stream to ensure WebSocket is ready
        setTimeout(() => {
          if (this.serverManager.startStream(globalId)) {
            camera.streaming = true
          }
        }, 100)
        return true
      }

      return false
    },

    setDebayerQuality(quality) {
      this.debayerQuality = quality
    },

    toggleControlPanel() {
      this.showControlPanel = !this.showControlPanel
    },

    clearError() {
      this.lastError = null
    },

    // Dismiss the "frames were dropped" notice from the last capture.
    clearDroppedNotice() {
      this.lastFramesDroppedBacklog = 0
    },

    // Get optimal grid dimensions based on number of streaming cameras
    getGridDimensions() {
      const count = this.streamingCameras.length

      if (count === 0) return { cols: 0, rows: 0 }
      if (count === 1) return { cols: 1, rows: 1 }
      if (count === 2) return { cols: 2, rows: 1 }
      if (count <= 4) return { cols: 2, rows: 2 }
      if (count <= 6) return { cols: 3, rows: 2 }
      if (count <= 9) return { cols: 3, rows: 3 }
      if (count <= 12) return { cols: 4, rows: 3 }
      if (count <= 16) return { cols: 4, rows: 4 }

      // For more than 16, calculate dynamically
      const cols = Math.ceil(Math.sqrt(count * 1.5)) // Prefer landscape
      const rows = Math.ceil(count / cols)
      return { cols, rows }
    }
  }
})
