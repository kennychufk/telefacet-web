# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Vue 3 + Vite multi-camera WebSocket client application that connects to Raspberry Pi 5 devices running camera servers. The client receives raw 10-bit SRGGB Bayer frames via WebSocket and performs real-time WebGL debayering for display.

## Project Connections

- `/home/kennychufk/workspace/cppWs/cherupi-v4l2` contains the WebSocket server code that runs on Raspberry Pi 5. The current working directory is an HTML/WebSocket client. The server sends raw frames to the client and receives control commands from the client. Please reference the WebSocket server code to understand the communication protocol and the camera lifecycle.

## Development Commands

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Architecture

### Core Components

- **WebSocketManager.js**: Handles WebSocket connections to individual servers, manages frame parsing, and provides camera control commands
- **MultiServerManager**: Coordinates multiple WebSocket servers and provides global camera ID mapping
- **ConfigLoader.js**: Parses and validates YAML configuration files with server addresses, camera settings, and AWB gains
- **cameraStore.js**: Pinia store managing application state, server connections, and camera lifecycle
- **Debayer.js**: WebGL-based Bayer demosaicing

### Data Flow

1. Configuration loaded from YAML file (drag & drop)
2. WebSocket connections established to multiple servers
3. Camera discovery and global ID mapping
4. Frame streaming with binary protocol (20-byte header + frame data)
5. Real-time WebGL debayering and display

### WebSocket Protocol

**Text Messages (JSON)**:
- `discover`: Request camera discovery
- `configure`: Set camera parameters (width, height, crop settings)
- `start_cameras`/`stop_cameras`: Control camera lifecycle
- `start_stream`/`stop_stream`: Control per-camera streaming
- `set_save_mode`: Configure frame saving behavior

**Binary Messages**:
- Header (20 bytes): frameId, cameraId, bytesPerLine, width, height
- Frame data: 10-bit SRGGB Bayer data in packed format (SRGGB10P)

### Configuration Format

YAML files define:
- Server addresses (WebSocket URLs)
- Camera configuration (resolution, cropping, v4l2 buffers)
- Frame saving options (none/buffer/batch/checkerboard modes)
- Per-camera AWB gains for color correction

#### Frame Saving Modes

1. **none**: No frame saving
2. **buffer**: Buffer frames in memory, write all at once when stopping
3. **batch**: Write frames in batches during capture
4. **checkerboard**: Detect and save only frames containing checkerboard patterns

#### Checkerboard Mode Configuration

When using `mode: checkerboard`, additional parameters are available:

```yaml
frame_saving:
  mode: checkerboard
  output_dir: calibration
  batch_size: 10
  writer_threads: 4
  checkerboard_rows: 8        # Inner corners vertically
  checkerboard_cols: 11       # Inner corners horizontally  
  checkerboard_full_res_detection: false  # false=half-res (faster), true=full-res
  checkerboard_num_threads: 4 # Threads for debayering
```

The checkerboard mode:
- Debayers each frame using NEON-optimized processing
- Detects checkerboard patterns using OpenCV
- Saves only the original raw Bayer data of frames containing checkerboards
- Preserves frame IDs in filenames (non-sequential if some frames don't contain patterns)

### WebGL Debayering

One quality mode available for now (will be extended in the future):
- **Quality**: Bilinear interpolation

The debayer handles 10-bit SRGGB10P packed format where 4 pixels are packed into 5 bytes.
