// src/services/ConfigLoader.js
import yaml from 'js-yaml'

export class ConfigLoader {
  constructor() {
    this.config = null
  }

  // Load configuration from YAML file
  async loadFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()

      reader.onload = (e) => {
        try {
          const yamlText = e.target.result
          this.config = this.parseAndValidate(yamlText)
          resolve(this.config)
        } catch (error) {
          reject(new Error(`Failed to parse YAML: ${error.message}`))
        }
      }

      reader.onerror = () => {
        reject(new Error('Failed to read file'))
      }

      reader.readAsText(file)
    })
  }

  // Parse and validate YAML configuration
  parseAndValidate(yamlText) {
    const config = yaml.load(yamlText)

    // Validate required fields
    if (!config.servers || !Array.isArray(config.servers)) {
      throw new Error('Configuration must include a "servers" array')
    }

    if (config.servers.length === 0) {
      throw new Error('At least one server must be specified')
    }

    // Validate server addresses
    config.servers.forEach((server, index) => {
      if (!server.address) {
        throw new Error(`Server ${index} must have an address`)
      }

      // Validate WebSocket URL format
      try {
        const url = new URL(server.address)
        if (!['ws:', 'wss:'].includes(url.protocol)) {
          throw new Error(`Server ${index} address must use ws:// or wss:// protocol`)
        }
      } catch (e) {
        throw new Error(`Server ${index} has invalid address format: ${server.address}`)
      }
    })

    // Validate camera configuration
    if (!config.camera_config) {
      throw new Error('Configuration must include "camera_config"')
    }

    const requiredCameraFields = ['width', 'height', 'crop_width', 'crop_height', 'crop_left', 'crop_top']
    requiredCameraFields.forEach(field => {
      if (typeof config.camera_config[field] !== 'number') {
        throw new Error(`camera_config.${field} must be a number`)
      }
    })

    // Set default v4l2_buffers if not specified
    if (!config.camera_config.v4l2_buffers) {
      config.camera_config.v4l2_buffers = 4
    }

    // Validate frame saving configuration
    if (!config.frame_saving) {
      config.frame_saving = {
        mode: 'none',
        prefix: 'camera',
        batch_size: 10,
        writer_threads: 4
      }
    }

    const validModes = ['none', 'buffer', 'batch', 'checkerboard']
    if (!validModes.includes(config.frame_saving.mode)) {
      throw new Error(`frame_saving.mode must be one of: ${validModes.join(', ')}`)
    }

    // Set defaults for common parameters
    if (typeof config.frame_saving.prefix !== 'string') {
      config.frame_saving.prefix = 'camera'
    }
    if (typeof config.frame_saving.batch_size !== 'number') {
      config.frame_saving.batch_size = 10
    }
    if (typeof config.frame_saving.writer_threads !== 'number') {
      config.frame_saving.writer_threads = 4
    }

    // Validate checkerboard-specific parameters if mode is checkerboard
    if (config.frame_saving.mode === 'checkerboard') {
      // Set defaults for checkerboard parameters
      if (typeof config.frame_saving.checkerboard_rows !== 'number') {
        config.frame_saving.checkerboard_rows = 8
      }
      if (typeof config.frame_saving.checkerboard_cols !== 'number') {
        config.frame_saving.checkerboard_cols = 11
      }
      if (typeof config.frame_saving.checkerboard_full_res_detection !== 'boolean') {
        config.frame_saving.checkerboard_full_res_detection = false
      }
      if (typeof config.frame_saving.checkerboard_num_threads !== 'number') {
        config.frame_saving.checkerboard_num_threads = 4
      }

      // Validate checkerboard dimensions (must be positive integers)
      if (config.frame_saving.checkerboard_rows < 1 || !Number.isInteger(config.frame_saving.checkerboard_rows)) {
        throw new Error('frame_saving.checkerboard_rows must be a positive integer')
      }
      if (config.frame_saving.checkerboard_cols < 1 || !Number.isInteger(config.frame_saving.checkerboard_cols)) {
        throw new Error('frame_saving.checkerboard_cols must be a positive integer')
      }

      // Validate thread count
      if (config.frame_saving.checkerboard_num_threads < 1 || config.frame_saving.checkerboard_num_threads > 32) {
        throw new Error('frame_saving.checkerboard_num_threads must be between 1 and 32')
      }
    }

    // Validate AWB gains
    if (!config.awb_gains) {
      config.awb_gains = {}
    }

    // Validate each AWB gain entry
    Object.entries(config.awb_gains).forEach(([camId, gains]) => {
      if (!gains.r || !gains.g || !gains.b) {
        throw new Error(`AWB gains for ${camId} must include r, g, and b values`)
      }

      // Validate gain ranges (0.5 to 2.5)
      ['r', 'g', 'b'].forEach(channel => {
        const value = gains[channel]
        if (typeof value !== 'number' || value < 0.5 || value > 2.5) {
          throw new Error(`AWB gain ${camId}.${channel} must be between 0.5 and 2.5`)
        }
      })
    })

    return config
  }

  // Get AWB gains for a specific camera
  getAWBGains(globalCameraId) {
    const camKey = `cam${globalCameraId}`
    if (this.config && this.config.awb_gains && this.config.awb_gains[camKey]) {
      return this.config.awb_gains[camKey]
    }

    // Return default gains if not specified
    return { r: 1.0, g: 1.0, b: 1.0 }
  }

  // Get server addresses
  getServerAddresses() {
    if (!this.config) return []
    return this.config.servers.map(s => s.address)
  }

  // Get camera configuration
  getCameraConfig() {
    return this.config ? this.config.camera_config : null
  }

  // Get frame saving configuration
  getFrameSavingConfig() {
    return this.config ? this.config.frame_saving : null
  }

  // Export current configuration to YAML
  exportToYAML() {
    if (!this.config) return ''
    return yaml.dump(this.config, {
      indent: 2,
      lineWidth: -1, // Don't wrap lines
      noRefs: true
    })
  }

  // Create example configuration
  static createExampleConfig() {
    return {
      servers: [
        { address: 'ws://192.168.1.100:9001' },
        { address: 'ws://192.168.1.101:9001' }
      ],
      camera_config: {
        width: 1456,
        height: 1088,
        crop_width: 1456,
        crop_height: 1088,
        crop_left: 0,
        crop_top: 0,
        v4l2_buffers: 4
      },
      frame_saving: {
        mode: 'none',
        prefix: 'camera',
        batch_size: 10,
        writer_threads: 4,
        // Optional checkerboard parameters (only used when mode is 'checkerboard')
        checkerboard_rows: 8,
        checkerboard_cols: 11,
        checkerboard_full_res_detection: false,
        checkerboard_num_threads: 4
      },
      awb_gains: {
        cam0: { r: 1.5, g: 1.0, b: 1.8 },
        cam1: { r: 1.6, g: 1.0, b: 1.7 },
        cam2: { r: 1.5, g: 1.0, b: 1.8 },
        cam3: { r: 1.6, g: 1.0, b: 1.7 }
      }
    }
  }
}

// Create and export a singleton instance
export const configLoader = new ConfigLoader()
