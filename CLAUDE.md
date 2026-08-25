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
- **ConfigLoader.js**: Parses and validates YAML configuration files with server addresses and camera settings
- **cameraStore.js**: Pinia store managing application state, server connections, and camera lifecycle
- **Debayer.js**: WebGL-based Bayer demosaicing

### Data Flow

1. Configuration loaded from YAML file (drag & drop)
2. WebSocket connections established to multiple servers
3. Camera discovery and global ID mapping
4. Frame streaming with binary protocol (20-byte header + frame data)
5. Real-time WebGL debayering and display

### Client Roles (protocol §1.1)

The server holds one read-write **commander** and one read-only **observer**
connection at a time. Each `servers[]` entry has a `role:` (`commander` by
default; `observer` for a CCTV-style telemetry view of a server some *other*
client commands). Observers connect to the server's `/observer` path
(`WebSocketManager.roleUrl`), may only `discover` / `get_state` /
`get_*_limits` / `start_stream` / `stop_stream` / `set_header_only`, and get
an `error` with `code: "forbidden"` for anything else — so
`MultiServerManager`'s write broadcasts (`configureAll`, `startAllCameras`,
`setLensPositionAll`, …) iterate `connectedCommanders()` only, while
`setHeaderOnlyModeAll` / `getStateAll` reach every server.

Observer behaviour in this client:

- `cameraStore.autoSubscribeObservers()` sends `start_stream` for every camera
  of an observer server as soon as it is discovered. The subscription is
  **persistent** on the server — allowed in any state, kept across the
  commander's `stop_cameras` / `start_cameras` — so the tile just shows
  **WAITING FOR COMMANDER** / **CAMERAS STOPPED** (`CameraView.vue`) until
  frames flow. `stopAllCameras()` leaves observer cameras subscribed.
- The server **pushes `state`** to both clients on every transition and when
  the other role connects/disconnects (`cause`, `role`, `commander_connected`,
  `observer_connected`); `WebSocketManager` folds pushes and the `get_state`
  reply into the same `server-state` event, and the store keeps
  `servers[].commanderConnected` for the **Observing** panel.
- Observers retry the initial connection forever (`retryInitialConnect`,
  `maxReconnectAttempts = Infinity`): they exist to wait. Commanders keep the
  original bounded reconnect-after-connect behaviour.
- Per-server stream options `subsample` (1/2/4/8; decimates the payload —
  2 ⇒ a quarter of the bytes) and `max_fps` (0 = uncapped) go out with every
  `start_stream` as `subsample` / `max_fps` (only when non-default). On a
  subsampled stream the frame header's `width`/`height`/`bytes_per_line` and
  the detection coordinates describe the decimated frame, which is why
  `CameraView.vue` sizes its overlay canvas from the received frame.
- The aggregate `camerasConfigured` / `camerasRunning` flags describe the
  commander servers; in an observer-only config they describe the watched
  servers instead. Lifecycle/attribute/trigger UI is hidden when the config has
  no commander servers.
- **Streaming priority** is server-side: the observer's stream yields to the
  commander's whenever the commander's socket is congested (protocol §5.8).

### WebSocket Protocol

**Text Messages (JSON)**:
- `discover`: Request camera discovery; optional `params.sensor` selects which sensor model to enumerate (substring match against the sensor's libcamera model name, e.g. "imx519", "imx708"). The first `discover` call that matches at least one camera locks in that sensor for the rest of the server's process lifetime; a call that matches zero cameras doesn't lock anything and can be retried with a different `sensor`.
- `configure`: Set camera parameters (width, height)
- `start_cameras`/`stop_cameras`: Control camera lifecycle. **`start_cameras` can be refused**: the server rejects a process mode it judges unable to keep up with the camera on its hardware (e.g. `batch` at a resolution/fps the disk cannot sustain) and stays CONFIGURED, with the arithmetic in the error message. Never assume it succeeded — `cameraStore` polls `get_state` until every server reports `running`. `stop_cameras`'s status adds `frames_dropped_backlog`, the number of frames the server refused at its backlog budget (non-zero ⇒ the recording has a gap).
- `start_stream`/`stop_stream`: Control per-camera streaming. `start_stream` takes optional `max_fps` and `subsample` (see **Client Roles**).
- `state`: reply to `get_state` (`cause: "query"`) **and an unsolicited push** on every transition / on the other role's connect or disconnect; carries `cause`, `role`, `commander_connected`, `observer_connected`.
- `set_process_mode`: Configure per-frame processing (detection and/or saving). `params.save_frames` (default `true`) toggles disk writing independently of the mode — `false` runs the detector and streams its corners/markers but writes nothing. (Formerly `set_save_mode`.)
- Server-pushed `error` messages carry `message` and, for coded errors, structured fields. **`code: "capture_timeout"` is unsolicited** — a camera has stopped delivering frames and libcamera's frontend will not recover on its own. It carries `camera_id`, `stalled_for_us` and the server's backlog figures. `WebSocketManager` forwards the whole payload on the `server-error` event (`code`, `cameraId`, `stalledForUs`, `backlogBytes`, `backlogBudgetBytes`, `framesDroppedBacklog`, plus the raw `data`); `cameraStore` records it as `captureTimeout` and the control panel offers `recoverCapture()` — `stop_cameras` then `start_cameras`, which is the only way back.
- `trigger_capture`: Save one frame per running camera, on demand (`trigger` mode only — rejected with an `error` in every other mode). Optional `camera_id` narrows it to one camera; optional `skip_frames` overrides the configured `trigger_skip_frames`. Answered **asynchronously** with a `trigger_result` message (`trigger_id`, `cancelled`, `captures[] = {camera_id, frame_id, filename}`) once every armed camera has actually delivered its frame — not with a plain `status`. `WebSocketManager.triggerCapture()` sends it; the ack surfaces as the `trigger-result` event, re-forwarded by `MultiServerManager` and consumed by `cameraStore.triggerCapture()`.

**Binary Messages (protocol v6)**:
- `ChunkStartMarker` (8 bytes): `magic = 'CHUN'`, `version = 6`.
- `ChunkHeader` (68 bytes) follows the marker in the same WS message: frame_uuid, frame_id, camera_id, total_chunks, total_size, bytes_per_line, width, height, pixel_format, frames_saved, timestamp_us, frame_duration_us, corner_block_size (u32), num_corner_sets (u16), reserved (u16), lens_position (f32, dioptres, NaN if unavailable), af_state (u8: 0=Idle/1=Scanning/2=Focused/3=Failed, 0xFF if unavailable), **detection_kind (u8: 0=none/1=checkerboard/2=aruco — offset 65, carved out of the old reserved2), reserved2 (u8[2])**. The per-frame focus metadata is shown on `CameraView.vue`'s image-mode hover overlay (not the header-only big display).
- Optional **detection block** (variable, present when `num_corner_sets > 0`) appended to that same message. `detection_kind` selects its per-record layout — the block's total byte size is always `corner_block_size`:
  - `detection_kind == 1` (checkerboard): `num_corner_sets × (CornerSetHeader{set_id u8, flags u8, num_corners u16} + num_corners × {float x, float y})`. Emitted only in `checkerboard` / `checkerboard2x2` process modes.
  - `detection_kind == 2` (aruco): `num_corner_sets × (MarkerSetHeader{marker_id **i32 signed**, quadrant u8 (0 for `aruco`; row*2+col 0..3 for `aruco2x2`), flags u8, num_corners u16 (=4)} + 4 × {float x, float y})` → 40 bytes per marker. Dictionary is `DICT_APRILTAG_16h5` (ids 0..29); corners are clockwise from the marker's top-left. Emitted only in `aruco` / `aruco2x2` process modes.
  - Coordinates in both are in full-frame Y-plane pixel space; the renderer overlays them 1:1 on the canvas (checkerboard corners in green, aruco markers in amber). A block is emitted only when at least one pattern/marker was detected on that exact frame.
- `ChunkData` packets carry the frame payload (YUV420 main stream).

### Configuration Format

YAML files define:
- Servers: one entry per server, each with a WebSocket URL (`address`), its own optional `sensor` (model substring, e.g. "imx519", "imx708") and resolution (`width`/`height`), an optional `role` (`commander` default, or `observer` — see **Client Roles**), and optional stream options `subsample` (1/2/4/8) and `max_fps` (0 = uncapped). A client can talk to servers running different sensor types at different resolutions; within one server, every camera shares the same sensor and resolution. Omitted fields fall back to that server's own defaults.
- Frame-processing options under the `processing:` key (formerly `frame_saving:`): the `mode` (none/buffer/batch/trigger/checkerboard/checkerboard2x2/aruco/aruco2x2) plus `save_frames` (default `true`), shared across all servers
- Resource guards under the same `processing:` key, all optional and mode-independent (see **Resource Guards** below): `backlog_max_bytes`, `disk_write_bytes_per_sec`, `allow_overcommit`

#### Process Modes

The `mode` names what happens to each frame; `save_frames` (default `true`) is an orthogonal toggle for disk writing. When `save_frames: false`, detector modes still run and stream corners/markers but write nothing (writer pool never starts). For `buffer`/`batch` (no side-product) `false` just means no output.

1. **none**: No processing
2. **buffer**: Buffer frames in memory, write all at once when stopping
3. **batch**: Write frames in batches during capture
4. **trigger**: Save-on-demand. Frames stream live but nothing is written until the client sends `trigger_capture`, which saves one frame per armed camera. Built for automated calibration: move the camera (robot arm), wait for it to stop, then trigger — so no saved frame carries motion blur. `trigger_skip_frames` (default `0`) discards that many settling frames per camera first. The control panel shows a **Capture** button (shortcut **T**) in this mode only, wired to `cameraStore.triggerCapture()`, which resolves when every server acks.
5. **checkerboard**: Detect checkerboard patterns and stream their corners; when `save_frames`, also save the frames containing them
6. **checkerboard2x2**: Split each frame into 4 equal quadrants and detect in each; stream every detecting quadrant's corners; when `save_frames`, save the whole frame if **any** quadrant detects. Uses the same `checkerboard_*` parameters as `checkerboard`.
7. **aruco**: Detect `DICT_APRILTAG_16h5` markers and stream their ids + corners; when `save_frames`, also save the frames containing them. Uses the `aruco_*` parameters.
8. **aruco2x2**: Split each frame into 4 equal quadrants and detect in each; when `save_frames`, save the whole frame if **any** quadrant detects. Uses the same `aruco_*` parameters as `aruco`.

#### Resource Guards

Full-resolution frames are large — 17.9 MB at 4608x2592 YUV420 — so a mode that
keeps every frame (`buffer`) or writes every frame (`batch`) can outrun its
sink. Left unbounded on the server that does not merely waste memory: the box
swap-thrashes, libcamera's completion thread misses the RPi dequeue watchdog,
the camera frontend times out permanently, and the process is OOM-killed. From
here that looked like an open WebSocket that simply stopped delivering frames.

The server now bounds its own backlog and refuses modes that cannot work. Three
optional `processing:` keys drive it, passed through by `ConfigLoader` and
`cameraStore.setSaveMode()`:

| Key | Default | Meaning |
|---|---|---|
| `backlog_max_bytes` | `0` | RAM ceiling for captured-but-unwritten frames. `0` ⇒ the server derives half of `MemAvailable`. On reaching it the frames already accepted are kept and new ones are dropped and counted. |
| `disk_write_bytes_per_sec` | `0` | Declared sustained write rate of the server's `output_dir`. `0` ⇒ the server measures it once with a 32 MiB `O_DIRECT` probe (adds ~1.5 s to the first `start_cameras` in `batch` mode). |
| `allow_overcommit` | `false` | Start even when the server judges the mode unable to keep up. The check still runs and still logs; it just stops refusing. |

Client-side consequences, all already handled:

- `cameraStore.startAllCameras()` and `configureAllCameras()` confirm the
  transition by polling `get_state` (`_awaitServerState`) instead of sleeping
  and assuming. A refusal leaves `camerasRunning` false and the server's own
  explanation in `lastError`.
- `cameraStore.captureTimeout` holds the last `capture_timeout`;
  `recoverCapture()` runs the documented `stop_cameras` → `start_cameras` cycle
  and reopens the streams that were running.
- `cameraStore.lastFramesDroppedBacklog` carries the count from the last
  `stop_cameras`, surfaced as a warning strip in the control panel.

#### Trigger Mode Configuration

```yaml
processing:
  mode: trigger
  save_frames: true           # trigger mode is pointless with this off
  output_dir: calibration
  writer_threads: 4
  trigger_skip_frames: 0      # settling frames discarded per camera per trigger
```

Only one trigger may be outstanding at a time — the server rejects an overlapping
`trigger_capture` with an `error`, and the store's `canTriggerCapture` getter
keeps the button disabled while `triggerPendingServers > 0`.

#### Checkerboard Mode Configuration

When using `mode: checkerboard` or `mode: checkerboard2x2`, additional parameters are available:

```yaml
processing:
  mode: checkerboard
  save_frames: true           # false ⇒ detect + stream corners only, write nothing
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

#### ArUco Mode Configuration

When using `mode: aruco` or `mode: aruco2x2`, the server runs `cv::aruco::detectMarkers`
(dictionary `DICT_APRILTAG_16h5`) and saves only frames with at least one detected marker.
Additional parameters:

```yaml
processing:
  mode: aruco
  save_frames: true                # false ⇒ detect + stream markers only, write nothing
  output_dir: calibration
  batch_size: 10
  writer_threads: 4
  aruco_full_res_detection: false  # false=2×-subsampled Y (faster), true=full-res
  aruco_num_threads: 4             # aruco2x2 quadrant parallelism, clamped [1,4]
  aruco_corner_refine: false       # false=CORNER_REFINE_NONE (fast), true=CORNER_REFINE_SUBPIX
```

Detected markers are drawn on `CameraView.vue`'s overlay (amber quad outline + corner dots +
centered marker-id label) — distinct from the checkerboard corner overlay (green). The per-camera
`frames_saved` badge is surfaced in the aruco modes too.

### WebGL Debayering

One quality mode available for now (will be extended in the future):
- **Quality**: Bilinear interpolation

The debayer handles 10-bit SRGGB10P packed format where 4 pixels are packed into 5 bytes.

The shader in `src/webgl/Debayer.js` renders the frame in the raw buffer's native orientation (`v_texCoord = a_texCoord`, no rotation). 2D overlays drawn on top in buffer coordinates (e.g. the checkerboard corner overlay in `CameraView.vue`) map 1:1 — corner `(x, y)` is drawn at canvas `(x, y)`.
