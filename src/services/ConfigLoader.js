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

    // Validate server addresses and per-server camera settings. Sensor type
    // and resolution are per-server (a client may talk to servers running
    // different sensors), but identical across every camera on one server.
    // Both are optional — an omitted field falls back to the connected
    // server's own default (currently "imx519" / 2328x1748).
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

      if (server.sensor !== undefined && typeof server.sensor !== 'string') {
        throw new Error(`Server ${index} sensor must be a string`)
      }

      ;['width', 'height'].forEach(field => {
        if (server[field] !== undefined && typeof server[field] !== 'number') {
          throw new Error(`Server ${index} ${field} must be a number`)
        }
      })
    })

    // Validate frame-processing configuration
    if (!config.processing) {
      config.processing = {
        mode: 'none',
        save_frames: true,
        output_dir: 'camera_frames',
        prepend_timestamp_to_dir: false,
        batch_size: 10,
        writer_threads: 4
      }
    }

    const validModes = ['none', 'buffer', 'batch', 'trigger', 'checkerboard', 'checkerboard2x2', 'aruco', 'aruco2x2']
    if (!validModes.includes(config.processing.mode)) {
      throw new Error(`processing.mode must be one of: ${validModes.join(', ')}`)
    }

    // save_frames decouples detection from disk writing: false ⇒ detector modes
    // still run and stream corners/markers, but no frames are saved. Defaults to
    // true (preserves prior save-on-detect behaviour).
    if (typeof config.processing.save_frames !== 'boolean') {
      config.processing.save_frames = true
    }

    // Set defaults for common parameters
    if (typeof config.processing.output_dir !== 'string') {
      config.processing.output_dir = 'camera_frames'
    }

    // Basic validation for output_dir
    const outputDir = config.processing.output_dir.trim()
    if (outputDir === '') {
      throw new Error('processing.output_dir cannot be empty')
    }

    // Check for invalid characters (basic validation)
    const invalidChars = /[<>:"|?*\x00-\x1f]/
    if (invalidChars.test(outputDir)) {
      throw new Error('processing.output_dir contains invalid characters')
    }

    // Update the config with trimmed value
    config.processing.output_dir = outputDir

    // Validate prepend_timestamp_to_dir
    if (typeof config.processing.prepend_timestamp_to_dir !== 'boolean') {
      config.processing.prepend_timestamp_to_dir = false
    }

    if (typeof config.processing.batch_size !== 'number') {
      config.processing.batch_size = 10
    }
    if (typeof config.processing.writer_threads !== 'number') {
      config.processing.writer_threads = 4
    }

    // Validate checkerboard-specific parameters if mode uses checkerboard detection
    if (config.processing.mode === 'checkerboard' ||
        config.processing.mode === 'checkerboard2x2') {
      // Set defaults for checkerboard parameters
      if (typeof config.processing.checkerboard_rows !== 'number') {
        config.processing.checkerboard_rows = 8
      }
      if (typeof config.processing.checkerboard_cols !== 'number') {
        config.processing.checkerboard_cols = 11
      }
      if (typeof config.processing.checkerboard_full_res_detection !== 'boolean') {
        config.processing.checkerboard_full_res_detection = false
      }
      if (typeof config.processing.checkerboard_num_threads !== 'number') {
        config.processing.checkerboard_num_threads = 4
      }

      // Validate checkerboard dimensions (must be positive integers)
      if (config.processing.checkerboard_rows < 1 || !Number.isInteger(config.processing.checkerboard_rows)) {
        throw new Error('processing.checkerboard_rows must be a positive integer')
      }
      if (config.processing.checkerboard_cols < 1 || !Number.isInteger(config.processing.checkerboard_cols)) {
        throw new Error('processing.checkerboard_cols must be a positive integer')
      }

      // Validate thread count
      if (config.processing.checkerboard_num_threads < 1 || config.processing.checkerboard_num_threads > 32) {
        throw new Error('processing.checkerboard_num_threads must be between 1 and 32')
      }
    }

    // Validate trigger-specific parameters. `trigger` writes nothing until the
    // client sends trigger_capture; trigger_skip_frames is the default number
    // of settling frames discarded per camera before the one that is kept.
    if (config.processing.mode === 'trigger') {
      if (typeof config.processing.trigger_skip_frames !== 'number') {
        config.processing.trigger_skip_frames = 0
      }
      if (config.processing.trigger_skip_frames < 0 ||
          !Number.isInteger(config.processing.trigger_skip_frames)) {
        throw new Error('processing.trigger_skip_frames must be a non-negative integer')
      }
    }

    // Validate aruco-specific parameters if mode uses ArUco marker detection.
    // aruco_num_threads applies only to aruco2x2 quadrant parallelism (clamped
    // [1,4] by the server); it's harmless for `aruco`.
    if (config.processing.mode === 'aruco' ||
        config.processing.mode === 'aruco2x2') {
      // Set defaults for aruco parameters
      if (typeof config.processing.aruco_full_res_detection !== 'boolean') {
        config.processing.aruco_full_res_detection = false
      }
      if (typeof config.processing.aruco_num_threads !== 'number') {
        config.processing.aruco_num_threads = 4
      }
      if (typeof config.processing.aruco_corner_refine !== 'boolean') {
        config.processing.aruco_corner_refine = false
      }

      // Validate thread count (server clamps to [1,4] for quadrant parallelism)
      if (config.processing.aruco_num_threads < 1 || config.processing.aruco_num_threads > 4) {
        throw new Error('processing.aruco_num_threads must be between 1 and 4')
      }
    }

    return config
  }

  // Get server addresses
  getServerAddresses() {
    if (!this.config) return []
    return this.config.servers.map(s => s.address)
  }

  // Get frame saving configuration
  getFrameSavingConfig() {
    return this.config ? this.config.processing : null
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
        { address: 'ws://192.168.1.100:9001', sensor: 'imx519', width: 1456, height: 1088 },
        { address: 'ws://192.168.1.101:9001', sensor: 'imx708', width: 1536, height: 864 }
      ],
      processing: {
        mode: 'none',
        output_dir: 'camera_frames',
        prepend_timestamp_to_dir: false,
        batch_size: 10,
        writer_threads: 4,
        // Optional checkerboard parameters (used when mode is 'checkerboard' or 'checkerboard2x2')
        checkerboard_rows: 8,
        checkerboard_cols: 11,
        checkerboard_full_res_detection: false,
        checkerboard_num_threads: 4,
        // Optional aruco parameters (used when mode is 'aruco' or 'aruco2x2')
        aruco_full_res_detection: false,
        aruco_num_threads: 4,
        aruco_corner_refine: false
      }
    }
  }
}

// Create and export a singleton instance
export const configLoader = new ConfigLoader()
