// src/services/WebSocketManager.js
import { EventEmitter } from 'events'

export class WebSocketManager extends EventEmitter {
  constructor(serverAddress, serverIndex) {
    super()
    this.address = serverAddress
    this.serverIndex = serverIndex
    this.ws = null
    this.connected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
    this.reconnectDelay = 1000 // Start with 1 second
    this.cameras = []
    this.streamingCameras = new Set()

    // Frame statistics
    this.frameStats = new Map() // cameraId -> { count, lastTime }
  }

  connect() {
    try {
      this.ws = new WebSocket(this.address)
      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        console.log(`Connected to server ${this.serverIndex} at ${this.address}`)
        this.connected = true
        this.reconnectAttempts = 0
        this.reconnectDelay = 1000
        this.emit('connected', this.serverIndex)

        // Discover cameras immediately after connection
        this.discoverCameras()
      }

      this.ws.onclose = () => {
        this.connected = false
        this.emit('disconnected', this.serverIndex)
        this.handleReconnect()
      }

      this.ws.onerror = (error) => {
        console.error(`WebSocket error on server ${this.serverIndex}:`, error)
        this.emit('error', { serverIndex: this.serverIndex, error })
      }

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryMessage(event.data)
        } else {
          this.handleTextMessage(event.data)
        }
      }
    } catch (error) {
      console.error(`Failed to create WebSocket for server ${this.serverIndex}:`, error)
      this.handleReconnect()
    }
  }

  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Max reconnection attempts reached for server ${this.serverIndex}`)
      this.emit('reconnect-failed', this.serverIndex)
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000)

    console.log(`Reconnecting to server ${this.serverIndex} in ${delay}ms (attempt ${this.reconnectAttempts})`)

    setTimeout(() => {
      this.connect()
    }, delay)
  }

  handleTextMessage(data) {
    try {
      const message = JSON.parse(data)

      switch (message.type) {
        case 'discovery':
          this.cameras = message.cameras
          this.emit('cameras-discovered', {
            serverIndex: this.serverIndex,
            cameras: this.cameras
          })
          break

        case 'status':
          this.emit('status', {
            serverIndex: this.serverIndex,
            message: message.message,
            data: message
          })
          break

        case 'error':
          this.emit('server-error', {
            serverIndex: this.serverIndex,
            message: message.message
          })
          break
      }
    } catch (error) {
      console.error('Failed to parse message:', error)
    }
  }

  handleBinaryMessage(data) {
    // Parse frame header (20 bytes)
    const headerView = new DataView(data, 0, 20)
    const frameId = headerView.getUint32(0, true)
    const cameraId = headerView.getUint32(4, true)
    const bytesPerLine = headerView.getUint32(8, true)
    const width = headerView.getUint32(12, true)
    const height = headerView.getUint32(16, true)

    // Frame data starts at byte 20
    const frameData = new Uint8Array(data, 20)

    // Update frame statistics
    const now = performance.now()
    const stats = this.frameStats.get(cameraId) || { count: 0, lastTime: now }
    stats.count++
    const elapsed = now - stats.lastTime

    if (elapsed > 1000) { // Update FPS every second
      const fps = (stats.count / elapsed) * 1000
      this.emit('fps-update', {
        serverIndex: this.serverIndex,
        cameraId,
        fps: Math.round(fps * 10) / 10
      })
      stats.count = 0
      stats.lastTime = now
    }

    this.frameStats.set(cameraId, stats)

    // Emit frame for processing
    this.emit('frame', {
      serverIndex: this.serverIndex,
      cameraId,
      frameId,
      width,
      height,
      bytesPerLine,
      data: frameData
    })
  }

  // Command methods
  send(command) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`Cannot send command to disconnected server ${this.serverIndex}`)
      return false
    }

    this.ws.send(JSON.stringify(command))
    return true
  }

  discoverCameras() {
    return this.send({ cmd: 'discover' })
  }

  configureCameras(config) {
    return this.send({
      cmd: 'configure',
      params: {
        width: config.width,
        height: config.height,
        crop_width: config.crop_width,
        crop_height: config.crop_height,
        crop_left: config.crop_left,
        crop_top: config.crop_top
      }
    })
  }

  setSaveMode(mode, params = {}) {
    return this.send({
      cmd: 'set_save_mode',
      mode: mode,
      params: params
    })
  }

  startCameras() {
    return this.send({ cmd: 'start_cameras' })
  }

  startStream(cameraId) {
    if (this.send({ cmd: 'start_stream', camera_id: cameraId })) {
      this.streamingCameras.add(cameraId)
      return true
    }
    return false
  }

  stopStream(cameraId) {
    if (this.send({ cmd: 'stop_stream', camera_id: cameraId })) {
      this.streamingCameras.delete(cameraId)
      return true
    }
    return false
  }

  stopCameras() {
    this.streamingCameras.clear()
    return this.send({ cmd: 'stop_cameras' })
  }

  disconnect() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.cameras = []
    this.streamingCameras.clear()
  }

  // Restore streaming state after reconnection
  restoreStreamingState() {
    for (const cameraId of this.streamingCameras) {
      this.startStream(cameraId)
    }
  }
}

// Manager for all server connections
export class MultiServerManager extends EventEmitter {
  constructor() {
    super()
    this.servers = new Map() // serverIndex -> WebSocketManager
    this.globalCameraMap = new Map() // globalCameraId -> { serverIndex, localCameraId }
  }

  addServer(address, index) {
    const manager = new WebSocketManager(address, index)

    // Forward events with global camera IDs
    manager.on('cameras-discovered', (data) => {
      this.updateGlobalCameraMap()
      this.emit('cameras-discovered', data)
    })

    manager.on('frame', (data) => {
      // Convert to global camera ID
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

    // Forward other events
    manager.on('connected', (...args) => this.emit('server-connected', ...args))
    manager.on('disconnected', (...args) => this.emit('server-disconnected', ...args))
    manager.on('status', (...args) => this.emit('status', ...args))
    manager.on('server-error', (...args) => this.emit('server-error', ...args))

    this.servers.set(index, manager)
    return manager
  }

  updateGlobalCameraMap() {
    this.globalCameraMap.clear()
    let globalId = 0

    // Iterate through servers in order
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
    for (const server of this.servers.values()) {
      server.connect()
    }
  }

  configureAll(config) {
    const promises = []
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.configureCameras(config)
      }
    }
  }

  setSaveModeAll(mode, params) {
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.setSaveMode(mode, params)
      }
    }
  }

  startAllCameras() {
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.startCameras()
      }
    }
  }

  stopAllCameras() {
    for (const server of this.servers.values()) {
      if (server.connected) {
        server.stopCameras()
      }
    }
  }

  startStream(globalCameraId) {
    const info = this.getCameraInfo(globalCameraId)
    if (info) {
      const server = this.servers.get(info.serverIndex)
      if (server && server.connected) {
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
    for (const server of this.servers.values()) {
      server.disconnect()
    }
  }
}
