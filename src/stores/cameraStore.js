// src/stores/cameraStore.js
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
    servers: [], // Array of { index, address, connected, cameras }
    
    // Camera management
    cameras: [], // Array of { globalId, serverIndex, localId, streaming, fps, awbGains }
    totalCameras: 0,
    
    // System state
    camerasConfigured: false,
    camerasRunning: false,
    saveModeConfigured: false,
    
    // UI state
    debayerQuality: 'quality', // 'quality'
    showControlPanel: true,
    
    // Error handling
    lastError: null
  }),
  
  getters: {
    streamingCameras: (state) => {
      return state.cameras.filter(cam => cam.streaming)
    },
    
    connectedServers: (state) => {
      return state.servers.filter(server => server.connected)
    },
    
    allServersConnected: (state) => {
      return state.servers.length > 0 && 
             state.servers.every(server => server.connected)
    },
    
    canConfigure: (state) => {
      return state.configLoaded && 
             state.allServersConnected && 
             !state.camerasConfigured
    },
    
    canStartCameras: (state) => {
      return state.camerasConfigured && !state.camerasRunning
    },
    
    canStopCameras: (state) => {
      return state.camerasRunning
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
        connected: false,
        cameras: 0
      }))
      
      // Add servers to manager
      this.servers.forEach(server => {
        this.serverManager.addServer(server.address, server.index)
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
        }
      })
      
      manager.on('server-disconnected', (serverIndex) => {
        const server = this.servers.find(s => s.index === serverIndex)
        if (server) {
          server.connected = false
        }
      })
      
      manager.on('cameras-discovered', (data) => {
        const server = this.servers.find(s => s.index === data.serverIndex)
        if (server) {
          server.cameras = data.cameras.length
        }
        this.updateCameraList()
      })
      
      manager.on('camera-map-updated', (cameraMap) => {
        this.updateCameraList()
      })
      
      manager.on('fps-update', (data) => {
        const camera = this.cameras.find(cam => cam.globalId === data.globalCameraId)
        if (camera) {
          camera.fps = data.fps
        }
      })
      
      manager.on('status', (data) => {
        console.log(`Server ${data.serverIndex} status:`, data.message)
      })
      
      manager.on('server-error', (data) => {
        console.error(`Server ${data.serverIndex} error:`, data.message)
        this.lastError = `Server ${data.serverIndex}: ${data.message}`
      })
    },
    
    updateCameraList() {
      const cameraMap = this.serverManager.globalCameraMap
      
      this.cameras = Array.from(cameraMap.entries()).map(([globalId, info]) => {
        const awbGains = configLoader.getAWBGains(globalId)
        
        return {
          globalId,
          serverIndex: info.serverIndex,
          localId: info.localCameraId,
          streaming: false,
          fps: 0,
          awbGains
        }
      })
      
      this.totalCameras = this.cameras.length
    },
    
    async configureAllCameras() {
      if (!this.canConfigure) return false
      
      try {
        const cameraConfig = this.config.camera_config
        this.serverManager.configureAll(cameraConfig)
        
        // Set save mode as part of configuration (only if not already set)
        if (!this.saveModeConfigured) {
          await this.setSaveMode()
          this.saveModeConfigured = true
        }
        
        // Wait a bit for configuration to complete
        await new Promise(resolve => setTimeout(resolve, 1000))
        
        this.camerasConfigured = true
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
        const saveConfig = this.config.frame_saving
        this.serverManager.setSaveModeAll(saveConfig.mode, {
          prefix: saveConfig.prefix,
          batch_size: saveConfig.batch_size,
          writer_threads: saveConfig.writer_threads
        })
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
        // Start cameras
        this.serverManager.startAllCameras()
        
        // Wait a bit for cameras to start
        await new Promise(resolve => setTimeout(resolve, 500))
        
        this.camerasRunning = true
        return true
      } catch (error) {
        this.lastError = 'Failed to start cameras'
        console.error(error)
        return false
      }
    },
    
    async stopAllCameras() {
      if (!this.canStopCameras) return false
      
      try {
        // Stop all streaming first
        this.cameras.forEach(camera => {
          if (camera.streaming) {
            this.toggleCameraStream(camera.globalId)
          }
        })
        
        // Stop cameras
        this.serverManager.stopAllCameras()
        
        this.camerasRunning = false
        this.camerasConfigured = false
        this.saveModeConfigured = false
        return true
      } catch (error) {
        this.lastError = 'Failed to stop cameras'
        console.error(error)
        return false
      }
    },
    
    toggleCameraStream(globalId) {
      const camera = this.cameras.find(cam => cam.globalId === globalId)
      if (!camera) return false
      
      if (!this.camerasRunning) {
        this.lastError = 'Cameras must be running to stream'
        return false
      }
      
      if (camera.streaming) {
        if (this.serverManager.stopStream(globalId)) {
          camera.streaming = false
          camera.fps = 0
          return true
        }
      } else {
        if (this.serverManager.startStream(globalId)) {
          camera.streaming = true
          return true
        }
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
