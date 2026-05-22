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

**Binary Messages (protocol v4)**:
- `ChunkStartMarker` (8 bytes): `magic = 'CHUN'`, `version = 4`.
- `ChunkHeader` (60 bytes) follows the marker in the same WS message: frame_uuid, frame_id, camera_id, total_chunks, total_size, bytes_per_line, width, height, pixel_format, frames_saved, timestamp_us, frame_duration_us, **corner_block_size (u32), num_corner_sets (u16), reserved (u16)**.
- Optional `CornerBlock` (variable, present when `num_corner_sets > 0`) appended to that same message: `num_corner_sets × (CornerSetHeader{set_id u8, flags u8, num_corners u16} + num_corners × {float x, float y})`. Coordinates are in full-frame Y-plane pixel space; the renderer overlays them 1:1 on the canvas. The server emits a corner block only when the save mode is `checkerboard` or `checkerboard2x2` and at least one board was detected on that exact frame.
- `ChunkData` packets carry the frame payload (YUV420 main stream).

### Configuration Format

YAML files define:
- Server addresses (WebSocket URLs)
- Camera configuration (resolution, cropping, v4l2 buffers)
- Frame saving options (none/buffer/batch/checkerboard/checkerboard2x2 modes)
- Per-camera AWB gains for color correction

#### Frame Saving Modes

1. **none**: No frame saving
2. **buffer**: Buffer frames in memory, write all at once when stopping
3. **batch**: Write frames in batches during capture
4. **checkerboard**: Detect and save only frames containing checkerboard patterns
5. **checkerboard2x2**: Split each frame into 4 equal quadrants and save the whole frame if **any** quadrant contains a checkerboard pattern. Uses the same `checkerboard_*` parameters as `checkerboard`.

#### Checkerboard Mode Configuration

When using `mode: checkerboard` or `mode: checkerboard2x2`, additional parameters are available:

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

The shader in `src/webgl/Debayer.js` rotates the rendered frame 180° relative to the raw buffer by setting `v_texCoord = vec2(1.0 - a_texCoord.x, 1.0 - a_texCoord.y)`. Any 2D overlay drawn on top in buffer coordinates (e.g. the checkerboard corner overlay in `CameraView.vue`) must apply the same flip — `(w - x, h - y)` — or it will land 180° off from the displayed image.
