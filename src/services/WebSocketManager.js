// src/services/WebSocketManager.js - Updated to handle frames_saved in chunk headers
import { EventEmitter } from 'events'

// Enhanced logging utility
const createLogger = (prefix) => {
  const log = (level, ...args) => {
    const timestamp = new Date().toISOString()
    console[level](`[${timestamp}] [${prefix}]`, ...args)
  }

  return {
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args)
  }
}

export class WebSocketManager extends EventEmitter {
  constructor(serverAddress, serverIndex) {
    super()
    this.address = serverAddress
    this.serverIndex = serverIndex
    this.ws = null
    this.connected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
    this.reconnectDelay = 1000
    this.cameras = []
    this.streamingCameras = new Set()
    this.headerOnlyMode = false // Track header only mode state

    // Frame statistics
    this.frameStats = new Map()
    this.serverFpsStats = new Map()

    // Chunked transfer state - key by frame_uuid
    this.chunkBuffers = new Map()
    this.CHUNK_START_MAGIC = 0x4348554E // 'CHUN' in hex
    this.CHUNK_DATA_MAGIC = 0x43484E4B  // 'CHNK' in hex

    // Enhanced logging
    this.logger = createLogger(`Server${serverIndex}`)

    // Connection state tracking
    this.connectionState = 'disconnected'
    this.lastError = null

    // Statistics
    this.stats = {
      messagesReceived: 0,
      framesReceived: 0,
      chunkedFramesReceived: 0,
      bytesReceived: 0,
      errors: 0,
      reconnects: 0
    }

    // Cleanup timer for old chunks
    this.chunkCleanupInterval = setInterval(() => this.cleanupOldChunks(), 5000)
  }

  connect() {
    try {
      this.connectionState = 'connecting'
      this.logger.info(`Connecting to ${this.address}...`)

      this.ws = new WebSocket(this.address)
      this.ws.binaryType = 'arraybuffer'

      const connectionTimeout = setTimeout(() => {
        if (this.connectionState === 'connecting') {
          this.logger.error('Connection timeout after 10 seconds')
          this.ws.close()
        }
      }, 10000)

      this.ws.onopen = () => {
        clearTimeout(connectionTimeout)
        this.connectionState = 'connected'
        this.connected = true
        this.reconnectAttempts = 0
        this.reconnectDelay = 1000
        this.lastError = null

        this.logger.info(`Successfully connected to ${this.address}`)
        this.emit('connected', this.serverIndex)

        // Discover cameras and query server state immediately after connection
        this.discoverCameras()
        this.getState()
      }

      this.ws.onclose = (event) => {
        clearTimeout(connectionTimeout)
        const wasConnected = this.connected
        this.connected = false
        this.connectionState = 'disconnected'

        this.logger.warn(`Connection closed. Code: ${event.code}, Reason: ${event.reason || 'No reason provided'}, Clean: ${event.wasClean}`)

        if (event.code === 1006) {
          this.logger.error('Abnormal closure - possible network error or server crash')
        }

        this.emit('disconnected', this.serverIndex)
        this.chunkBuffers.clear()

        if (wasConnected) {
          this.handleReconnect()
        }
      }

      this.ws.onerror = (error) => {
        this.connectionState = 'error'
        this.stats.errors++
        this.lastError = error

        this.logger.error('WebSocket error occurred:', {
          readyState: this.ws ? this.ws.readyState : 'N/A',
          url: this.address,
          error: error.message || 'Unknown error'
        })

        this.emit('error', {
          serverIndex: this.serverIndex,
          error: error.message || 'WebSocket error',
          type: 'websocket_error'
        })
      }

      this.ws.onmessage = (event) => {
        try {
          this.stats.messagesReceived++
          this.stats.bytesReceived += event.data.byteLength || event.data.length || 0

          if (event.data instanceof ArrayBuffer) {
            this.handleBinaryMessage(event.data)
          } else {
            this.handleTextMessage(event.data)
          }
        } catch (error) {
          this.logger.error('Error handling message:', error)
          this.stats.errors++
        }
      }
    } catch (error) {
      this.connectionState = 'error'
      this.logger.error(`Failed to create WebSocket connection:`, error)
      this.handleReconnect()
    }
  }

  handleBinaryMessage(data) {
    try {
      // Check minimum size for any valid message
      if (data.byteLength < 8) {
        this.logger.warn(`Binary message too small: ${data.byteLength} bytes`)
        return
      }

      const view = new DataView(data)
      const magic = view.getUint32(0, true)

      // Check if this is a chunk start message
      if (magic === this.CHUNK_START_MAGIC) {
        this.handleChunkStart(data)
      }
      // Check if this is chunk data
      else if (magic === this.CHUNK_DATA_MAGIC) {
        this.handleChunkData(data)
      }
      // Unknown message type
      else {
        this.logger.warn(`Unknown binary message magic: 0x${magic.toString(16)}`)
      }
    } catch (error) {
      this.logger.error('Error handling binary message:', error)
      this.stats.errors++
    }
  }

  handleChunkStart(data) {
    // Protocol v5: ChunkStartMarker (8) + ChunkHeader (68) = 76 bytes minimum,
    // plus an optional variable-size CornerBlock appended in the same message
    // when the server's save mode is `checkerboard` or `checkerboard2x2`.
    const MIN_SIZE = 76
    if (data.byteLength < MIN_SIZE) {
      this.logger.error(`Invalid chunk start size: ${data.byteLength} bytes, expected at least ${MIN_SIZE}`)
      return
    }

    const view = new DataView(data)
    const version = view.getUint32(4, true)

    if (version !== 5) {
      this.logger.error(`Unsupported chunk version: ${version} (expected 5)`)
      return
    }

    const frameUuid      = view.getUint32(8,  true)
    const frameId        = view.getUint32(12, true)
    const cameraId       = view.getUint32(16, true)
    const totalChunks    = view.getUint32(20, true)
    const totalSize      = view.getUint32(24, true)
    const bytesPerLine   = view.getUint32(28, true)
    const width          = view.getUint32(32, true)
    const height         = view.getUint32(36, true)
    const pixelFormat    = view.getUint32(40, true)
    const framesSaved    = view.getUint32(44, true)
    // uint64 read as two uint32s (JS safe-integer range covers camera uptime)
    const tsLow          = view.getUint32(48, true)
    const tsHigh         = view.getUint32(52, true)
    const timestampUs    = tsHigh * 0x100000000 + tsLow
    const frameDurationUs = view.getUint32(56, true)
    // v4 additions
    const cornerBlockSize = view.getUint32(60, true)
    const numCornerSets   = view.getUint16(64, true)
    // reserved at offset 66 (uint16), unused
    // v5 additions: per-frame focus metadata reported by the libcamera IPA.
    // lensPosition is in dioptres (0 = infinity); NaN means the server had no
    // LensPosition for the frame. afState is the libcamera AfState enum
    // (0=Idle, 1=Scanning, 2=Focused, 3=Failed); 0xFF means not reported.
    const lensPosition = view.getFloat32(68, true)
    const afState      = view.getUint8(72)

    if (data.byteLength !== MIN_SIZE + cornerBlockSize) {
      this.logger.error(
        `Chunk start length mismatch: got ${data.byteLength}, expected ${MIN_SIZE + cornerBlockSize}`
      )
      return
    }

    const cornerSets = this.parseCornerBlock(view, MIN_SIZE, cornerBlockSize, numCornerSets)

    // Check if this is header only mode (totalChunks = 0, totalSize = 0)
    if (totalChunks === 0 && totalSize === 0) {
      this.logger.debug(`Header only frame ${frameId} from camera ${cameraId}`)
      this.updateFrameStats(cameraId)
      this.updateServerFpsStats(cameraId, timestampUs, frameDurationUs, frameId)
      this.emitFrame(cameraId, frameId, width, height, bytesPerLine,
                     new Uint8Array(0), pixelFormat, framesSaved, cornerSets,
                     lensPosition, afState)
      return
    }

    this.logger.debug(`Starting chunked frame ${frameId} from camera ${cameraId}: ${totalChunks} chunks, ${totalSize} bytes`)

    this.chunkBuffers.set(frameUuid, {
      header: { frameId, cameraId, totalChunks, totalSize, bytesPerLine, width, height, pixelFormat, framesSaved, timestampUs, frameDurationUs, cornerSets, lensPosition, afState },
      chunks: new Array(totalChunks),
      receivedChunks: 0,
      startTime: performance.now()
    })
  }

  // Parse the v4 CornerBlock that follows ChunkHeader. Returns an array of
  // { setId, flags, corners: [{x, y}, ...] } sets. Coordinates are in
  // full-frame Y-plane pixel space, so the renderer can draw them directly
  // on a canvas sized to the frame's width × height.
  parseCornerBlock(view, offset, blockSize, expectedSets) {
    const sets = []
    if (blockSize === 0 || expectedSets === 0) return sets

    const end = offset + blockSize
    while (offset + 4 <= end && sets.length < expectedSets) {
      const setId = view.getUint8(offset)
      const flags = view.getUint8(offset + 1)
      const numCorners = view.getUint16(offset + 2, true)
      offset += 4

      const cornerBytes = numCorners * 8
      if (offset + cornerBytes > end) {
        this.logger.error(`CornerBlock overrun: set ${sets.length} claims ${numCorners} corners but only ${end - offset} bytes left`)
        return sets
      }

      const corners = new Array(numCorners)
      for (let i = 0; i < numCorners; i++) {
        const x = view.getFloat32(offset, true)
        const y = view.getFloat32(offset + 4, true)
        corners[i] = { x, y }
        offset += 8
      }

      sets.push({ setId, flags, corners })
    }

    if (sets.length !== expectedSets) {
      this.logger.warn(`Parsed ${sets.length} corner sets, expected ${expectedSets}`)
    }
    return sets
  }

  handleChunkData(data) {
    if (data.byteLength < 16) { // Minimum ChunkData header size
      this.logger.error(`Chunk data too small: ${data.byteLength} bytes`)
      return
    }

    const view = new DataView(data)
    const frameUuid = view.getUint32(4, true)
    const chunkIndex = view.getUint32(8, true)
    const chunkSize = view.getUint32(12, true)

    // Validate chunk data size
    if (data.byteLength !== 16 + chunkSize) {
      this.logger.error(`Invalid chunk data: expected ${16 + chunkSize} bytes, got ${data.byteLength}`)
      return
    }

    // Find the corresponding chunk buffer
    const buffer = this.chunkBuffers.get(frameUuid)
    if (!buffer) {
      this.logger.warn(`Received chunk for unknown frame UUID: ${frameUuid}`)
      return
    }

    // Validate chunk index
    if (chunkIndex >= buffer.header.totalChunks) {
      this.logger.error(`Invalid chunk index ${chunkIndex} for frame with ${buffer.header.totalChunks} chunks`)
      return
    }

    // Check for duplicate chunk
    if (buffer.chunks[chunkIndex]) {
      this.logger.warn(`Duplicate chunk ${chunkIndex} for frame ${buffer.header.frameId}`)
      return
    }

    // Store chunk data
    buffer.chunks[chunkIndex] = new Uint8Array(data, 16, chunkSize)
    buffer.receivedChunks++

    // Check if all chunks received
    if (buffer.receivedChunks === buffer.header.totalChunks) {
      this.assembleFrame(frameUuid, buffer)
    }
  }

  assembleFrame(frameUuid, buffer) {
    try {
      // Validate all chunks are present
      for (let i = 0; i < buffer.header.totalChunks; i++) {
        if (!buffer.chunks[i]) {
          this.logger.error(`Missing chunk ${i} when assembling frame ${buffer.header.frameId}`)
          this.chunkBuffers.delete(frameUuid)
          return
        }
      }

      // Reassemble frame
      const frameData = new Uint8Array(buffer.header.totalSize)
      let offset = 0

      for (let i = 0; i < buffer.header.totalChunks; i++) {
        frameData.set(buffer.chunks[i], offset)
        offset += buffer.chunks[i].length
      }

      const assemblyTime = performance.now() - buffer.startTime
      this.logger.debug(`Assembled frame ${buffer.header.frameId} from camera ${buffer.header.cameraId} in ${assemblyTime.toFixed(2)}ms`)

      this.stats.chunkedFramesReceived++
      this.updateFrameStats(buffer.header.cameraId)
      this.updateServerFpsStats(buffer.header.cameraId, buffer.header.timestampUs, buffer.header.frameDurationUs, buffer.header.frameId)
      this.emitFrame(
        buffer.header.cameraId,
        buffer.header.frameId,
        buffer.header.width,
        buffer.header.height,
        buffer.header.bytesPerLine,
        frameData,
        buffer.header.pixelFormat,
        buffer.header.framesSaved,
        buffer.header.cornerSets,
        buffer.header.lensPosition,
        buffer.header.afState
      )

      // Clean up
      this.chunkBuffers.delete(frameUuid)
    } catch (error) {
      this.logger.error(`Error assembling frame:`, error)
      this.chunkBuffers.delete(frameUuid)
    }
  }

  cleanupOldChunks() {
    const now = performance.now()
    const timeout = 5000 // 5 seconds

    for (const [frameUuid, buffer] of this.chunkBuffers) {
      if (now - buffer.startTime > timeout) {
        this.logger.warn(`Dropping incomplete frame after ${timeout}ms: UUID ${frameUuid} (received ${buffer.receivedChunks}/${buffer.header.totalChunks} chunks)`)
        this.chunkBuffers.delete(frameUuid)
      }
    }
  }

  handleTextMessage(data) {
    try {
      const message = JSON.parse(data)
      this.logger.debug('Received text message:', message.type)

      switch (message.type) {
        case 'discovery':
          this.cameras = message.cameras
          this.logger.info(`Discovered ${message.cameras.length} cameras`)
          this.emit('cameras-discovered', {
            serverIndex: this.serverIndex,
            cameras: this.cameras
          })
          break

        case 'state':
          this.logger.info('Server state:', message.state)
          this.emit('server-state', {
            serverIndex: this.serverIndex,
            state: message.state
          })
          break

        case 'status':
          this.logger.info('Status:', message.message)
          this.emit('status', {
            serverIndex: this.serverIndex,
            message: message.message,
            data: message
          })
          break

        case 'error':
          this.logger.error('Server error:', message.message)
          this.emit('server-error', {
            serverIndex: this.serverIndex,
            message: message.message
          })
          break

        case 'frame_duration_limits':
          this.emit('frame-duration-limits', {
            serverIndex: this.serverIndex,
            min: message.min,
            max: message.max,
            current: message.current
          })
          break

        case 'lens_position_limits':
          // min/max/default are in dioptres, or null when the module has no
          // focuser (server reports NaN → JSON null).
          this.emit('lens-position-limits', {
            serverIndex: this.serverIndex,
            min: message.min,
            max: message.max,
            default: message.default
          })
          break

        default:
          this.logger.warn('Unknown message type:', message.type)
      }
    } catch (error) {
      this.logger.error('Failed to parse text message:', error, 'Raw data:', data)
    }
  }

  updateFrameStats(cameraId) {
    const now = performance.now()
    const stats = this.frameStats.get(cameraId) || { count: 0, lastTime: now }
    stats.count++
    const elapsed = now - stats.lastTime

    if (elapsed > 1000) { // Update FPS every second
      const clientFps = (stats.count / elapsed) * 1000
      this.emit('fps-update', {
        serverIndex: this.serverIndex,
        cameraId,
        clientFps: Math.round(clientFps * 10) / 10
      })
      stats.count = 0
      stats.lastTime = now
    }

    this.frameStats.set(cameraId, stats)
  }

  updateServerFpsStats(cameraId, timestampUs, frameDurationUs, frameId) {
    const now = performance.now()
    const stats = this.serverFpsStats.get(cameraId) || {
      durations: [],
      lastTimestamp: 0,
      lastFrameId: -1,
      lastWallTime: now
    }

    // Primary: diff consecutive hardware timestamps, normalized by frame ID gap to
    // recover the true per-frame duration even when frames are dropped due to backpressure.
    // Fallback to frame_duration_us only when timestamp is unavailable.
    let durationUs = 0
    if (timestampUs > 0 && stats.lastTimestamp > 0 && stats.lastFrameId >= 0) {
      const frameIdGap = frameId - stats.lastFrameId
      if (frameIdGap > 0) {
        durationUs = (timestampUs - stats.lastTimestamp) / frameIdGap
      }
    } else if (timestampUs === 0 && frameDurationUs > 0) {
      durationUs = frameDurationUs
    }

    if (durationUs > 0) {
      stats.durations.push(durationUs)
      if (stats.durations.length > 10) stats.durations.shift()
    }

    if (timestampUs > 0) stats.lastTimestamp = timestampUs
    stats.lastFrameId = frameId

    const wallElapsed = now - stats.lastWallTime
    if (wallElapsed >= 1000 && stats.durations.length > 0) {
      const avgDuration = stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length
      const serverFps = Math.round((1000000 / avgDuration) * 10) / 10
      this.emit('server-fps-update', { serverIndex: this.serverIndex, cameraId, serverFps })
      stats.lastWallTime = now
    }

    this.serverFpsStats.set(cameraId, stats)
  }

  emitFrame(cameraId, frameId, width, height, bytesPerLine, data,
            pixelFormat = 0, framesSaved = 0, cornerSets = [],
            lensPosition = NaN, afState = 0xFF) {
    this.emit('frame', {
      serverIndex: this.serverIndex,
      cameraId,
      frameId,
      width,
      height,
      bytesPerLine,
      data,
      pixelFormat,
      framesSaved,
      cornerSets,
      lensPosition,
      afState,
      isHeaderOnly: data.length === 0
    })
  }

  // Command methods
  send(command) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`Cannot send command to disconnected server: ${JSON.stringify(command)}`)
      return false
    }

    try {
      this.logger.debug('Sending command:', command.cmd)
      this.ws.send(JSON.stringify(command))
      return true
    } catch (error) {
      this.logger.error('Error sending command:', error)
      return false
    }
  }

  setHeaderOnlyMode(enabled) {
    this.headerOnlyMode = enabled
    this.logger.info(`Setting header only mode to ${enabled}`)
    return this.send({ cmd: 'set_header_only', enabled: enabled })
  }

  // lens_position < 0 → continuous AF; >= 0 → manual at that dioptre value
  setLensPosition(lensPosition) {
    this.logger.info(`Setting lens position to ${lensPosition}`)
    return this.send({ cmd: 'set_lens_position', lens_position: lensPosition })
  }

  // exposure_time < 0 → auto AE; > 0 → manual shutter at that value (µs, max 1_000_000)
  setExposureTime(exposureTime) {
    this.logger.info(`Setting exposure time to ${exposureTime}`)
    return this.send({ cmd: 'set_exposure_time', exposure_time: exposureTime })
  }

  // frame_duration <= 0 → unset (libcamera default); > 0 → lock to that value (µs)
  setFrameDuration(frameDuration) {
    this.logger.info(`Setting frame duration to ${frameDuration}`)
    return this.send({ cmd: 'set_frame_duration', frame_duration: frameDuration })
  }

  // Returns asynchronously via 'frame-duration-limits' event
  getFrameDurationLimits() {
    return this.send({ cmd: 'get_frame_duration_limits' })
  }

  // Returns asynchronously via 'lens-position-limits' event
  getLensPositionLimits() {
    return this.send({ cmd: 'get_lens_position_limits' })
  }

  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`)
      this.emit('reconnect-failed', this.serverIndex)
      return
    }

    this.reconnectAttempts++
    this.stats.reconnects++
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000)

    this.logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`)

    setTimeout(() => {
      if (this.connectionState !== 'connected') {
        this.connect()
      }
    }, delay)
  }

  discoverCameras() {
    return this.send({ cmd: 'discover' })
  }

  getState() {
    return this.send({ cmd: 'get_state' })
  }

  configureCameras(config) {
    this.logger.info('Configuring cameras with:', config)
    return this.send({
      cmd: 'configure',
      params: {
        width: config.width,
        height: config.height
      }
    })
  }

  unconfigure() {
    this.logger.info('Unconfiguring cameras (CONFIGURED → IDLE)')
    return this.send({ cmd: 'unconfigure' })
  }

  setSaveMode(mode, params = {}) {
    this.logger.info(`Setting save mode to ${mode}`)
    return this.send({
      cmd: 'set_save_mode',
      mode: mode,
      params: params
    })
  }

  startCameras() {
    this.logger.info('Starting cameras')
    return this.send({ cmd: 'start_cameras' })
  }

  startStream(cameraId) {
    this.logger.info(`Starting stream for camera ${cameraId}`)
    if (this.send({ cmd: 'start_stream', camera_id: cameraId })) {
      this.streamingCameras.add(cameraId)
      return true
    }
    return false
  }

  stopStream(cameraId) {
    this.logger.info(`Stopping stream for camera ${cameraId}`)
    if (this.send({ cmd: 'stop_stream', camera_id: cameraId })) {
      this.streamingCameras.delete(cameraId)
      return true
    }
    return false
  }

  stopCameras() {
    this.logger.info('Stopping all cameras')
    this.streamingCameras.clear()
    return this.send({ cmd: 'stop_cameras' })
  }

  resetFrameCounts() {
    this.logger.info('Resetting frame counts')
    return this.send({ cmd: 'reset_frame_counts' })
  }

  disconnect() {
    this.logger.info('Disconnecting...')

    // Clear cleanup interval
    if (this.chunkCleanupInterval) {
      clearInterval(this.chunkCleanupInterval)
      this.chunkCleanupInterval = null
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
    this.connected = false
    this.connectionState = 'disconnected'
    this.cameras = []
    this.streamingCameras.clear()
    this.chunkBuffers.clear()
  }

  getStats() {
    return {
      ...this.stats,
      connectionState: this.connectionState,
      connected: this.connected,
      reconnectAttempts: this.reconnectAttempts,
      chunkBuffersActive: this.chunkBuffers.size,
      lastError: this.lastError,
      headerOnlyMode: this.headerOnlyMode
    }
  }

  restoreStreamingState() {
    this.logger.info(`Restoring streaming state for ${this.streamingCameras.size} cameras`)
    for (const cameraId of this.streamingCameras) {
      this.startStream(cameraId)
    }
  }
}

// MultiServerManager for managing multiple server connections
export class MultiServerManager extends EventEmitter {
  constructor() {
    super()
    this.servers = new Map()
    this.globalCameraMap = new Map()
    this.logger = createLogger('MultiServerManager')
  }

  addServer(address, index) {
    this.logger.info(`Adding server ${index} at ${address}`)
    const manager = new WebSocketManager(address, index)

    // Forward events with global camera IDs
    manager.on('cameras-discovered', (data) => {
      this.updateGlobalCameraMap()
      this.emit('cameras-discovered', data)
    })

    manager.on('frame', (data) => {
      const globalId = this.getGlobalCameraId(data.serverIndex, data.cameraId)
      if (globalId !== null) {
        this.emit('frame', {
          ...data,
          globalCameraId: globalId
        })
      }
    })

    manager.on('fps-update', (data) => {
      const globalId = this.getGlobalCameraId(data.serverIndex, data.cameraId)
      if (globalId !== null) {
        this.emit('fps-update', {
          ...data,
          globalCameraId: globalId
        })
      }
    })

    manager.on('server-fps-update', (data) => {
      const globalId = this.getGlobalCameraId(data.serverIndex, data.cameraId)
      if (globalId !== null) {
        this.emit('server-fps-update', {
          ...data,
          globalCameraId: globalId
        })
      }
    })

    // Forward other events
    manager.on('connected', (...args) => this.emit('server-connected', ...args))
    manager.on('disconnected', (...args) => this.emit('server-disconnected', ...args))
    manager.on('server-state', (...args) => this.emit('server-state', ...args))
    manager.on('status', (...args) => this.emit('status', ...args))
    manager.on('server-error', (...args) => this.emit('server-error', ...args))
    manager.on('error', (...args) => this.emit('error', ...args))
    manager.on('reconnect-failed', (...args) => this.emit('reconnect-failed', ...args))
    manager.on('frame-duration-limits', (...args) => this.emit('frame-duration-limits', ...args))
    manager.on('lens-position-limits', (...args) => this.emit('lens-position-limits', ...args))

    this.servers.set(index, manager)
    return manager
  }

  updateGlobalCameraMap() {
    this.globalCameraMap.clear()
    let globalId = 0

    const sortedIndices = Array.from(this.servers.keys()).sort((a, b) => a - b)

    for (const serverIndex of sortedIndices) {
      const server = this.servers.get(serverIndex)
      if (server.cameras) {
        for (let localId = 0; localId < server.cameras.length; localId++) {
          this.globalCameraMap.set(globalId, {
            serverIndex,
            localCameraId: localId
          })
          globalId++
        }
      }
    }

    this.logger.info(`Updated global camera map: ${globalId} total cameras`)
    this.emit('camera-map-updated', this.globalCameraMap)
  }

  getGlobalCameraId(serverIndex, localCameraId) {
    for (const [globalId, info] of this.globalCameraMap) {
      if (info.serverIndex === serverIndex && info.localCameraId === localCameraId) {
        return globalId
      }
    }
    return null
  }

  getCameraInfo(globalCameraId) {
    return this.globalCameraMap.get(globalCameraId)
  }

  connectAll() {
    this.logger.info('Connecting to all servers...')
    for (const server of this.servers.values()) {
      server.connect()
    }
  }

  configureAll(config) {
    this.logger.info('Configuring all servers')
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.configureCameras(config)
      }
    }
  }

  unconfigureAll() {
    this.logger.info('Unconfiguring all servers')
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.unconfigure()
      }
    }
  }

  setSaveModeAll(mode, params) {
    this.logger.info(`Setting save mode ${mode} on all servers`)
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.setSaveMode(mode, params)
      }
    }
  }

  setHeaderOnlyModeAll(enabled) {
    this.logger.info(`Setting header only mode to ${enabled} on all servers`)
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.setHeaderOnlyMode(enabled)
      }
    }
  }

  setLensPositionAll(lensPosition) {
    this.logger.info(`Setting lens position to ${lensPosition} on all servers`)
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.setLensPosition(lensPosition)
      }
    }
  }

  setExposureTimeAll(exposureTime) {
    this.logger.info(`Setting exposure time to ${exposureTime} on all servers`)
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.setExposureTime(exposureTime)
      }
    }
  }

  setFrameDurationAll(frameDuration) {
    this.logger.info(`Setting frame duration to ${frameDuration} on all servers`)
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.setFrameDuration(frameDuration)
      }
    }
  }

  // All cameras share the same sensor → ask the first connected server.
  getFrameDurationLimits() {
    for (const server of this.servers.values()) {
      if (server.connected) {
        return server.getFrameDurationLimits()
      }
    }
    return false
  }

  // All cameras share the same sensor → ask the first connected server.
  getLensPositionLimits() {
    for (const server of this.servers.values()) {
      if (server.connected) {
        return server.getLensPositionLimits()
      }
    }
    return false
  }

  startAllCameras() {
    this.logger.info('Starting cameras on all servers')
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.startCameras()
      }
    }
  }

  stopAllCameras() {
    this.logger.info('Stopping cameras on all servers')
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.stopCameras()
      }
    }
  }

  resetFrameCountsAll() {
    this.logger.info('Resetting frame counts on all servers')
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.resetFrameCounts()
      }
    }
  }

  startStream(globalCameraId) {
    const info = this.getCameraInfo(globalCameraId)
    if (info) {
      const server = this.servers.get(info.serverIndex)
      if (server && server.connected) {
        this.logger.info(`Starting stream for global camera ${globalCameraId}`)
        return server.startStream(info.localCameraId)
      }
    }
    return false
  }

  stopStream(globalCameraId) {
    const info = this.getCameraInfo(globalCameraId)
    if (info) {
      const server = this.servers.get(info.serverIndex)
      if (server && server.connected) {
        return server.stopStream(info.localCameraId)
      }
    }
    return false
  }

  disconnectAll() {
    this.logger.info('Disconnecting all servers')
    for (const server of this.servers.values()) {
      server.disconnect()
    }
  }

  getAllStats() {
    const stats = {}
    for (const [index, server] of this.servers) {
      stats[index] = server.getStats()
    }
    return stats
  }
}
