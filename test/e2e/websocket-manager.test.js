// End-to-end tests for the production WebSocketManager against a live
// camera_ws_server. Requires:
//   - A running camera_ws_server reachable at $TELEFACET_WS_URL (default
//     ws://localhost:9001).
//   - Real IMX519 hardware behind the server.
//
// These tests import the exact module shipped with the Vue app, so a passing
// run proves wire-level compatibility without ever booting the browser.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WebSocketManager, MultiServerManager } from '../../src/services/WebSocketManager.js'
import { collectFrames, disableReconnect, waitForEvent, waitForEventMatching } from './setup.js'

const WS_URL = process.env.TELEFACET_WS_URL || 'ws://localhost:9001'
const FOURCC_YU12 = 0x32315559

const TEST_CONFIG = {
  width: 1456,
  height: 1088,
  crop_width: 4656,
  crop_height: 3496,
  crop_left: 8,
  crop_top: 48,
}

describe('WebSocketManager against live server', () => {
  /** @type {WebSocketManager} */
  let mgr

  beforeEach(() => {
    mgr = new WebSocketManager(WS_URL, 0)
  })

  afterEach(async () => {
    if (!mgr) return
    disableReconnect(mgr)
    try {
      if (mgr.connected) {
        // Best-effort walk back to IDLE. Server keeps state across client
        // disconnects, so stopping here isn't enough — we also need
        // `unconfigure` to release libcamera resources. Mirror the Python
        // conftest's teardown order:
        //   set_header_only(false) → stop_cameras → unconfigure → set_save_mode(none)
        // Each may legitimately error (e.g. stop_cameras in IDLE); TCP
        // ordering ensures the server processes them in sequence.
        mgr.setHeaderOnlyMode(false)
        mgr.stopCameras()
        mgr.unconfigure()
        mgr.setSaveMode('none')
        // Give libcamera time to release the sensor pipeline before the
        // next test re-acquires it (matches the Python conftest).
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (_) {
      // ignore
    }
    mgr.disconnect()
  })

  it('connects and auto-discovers cameras', async () => {
    const connectedP = waitForEvent(mgr, 'connected', 5000)
    const discoveredP = waitForEvent(mgr, 'cameras-discovered', 5000)

    mgr.connect()

    await connectedP
    const payload = await discoveredP

    expect(payload.serverIndex).toBe(0)
    expect(Array.isArray(payload.cameras)).toBe(true)
    expect(payload.cameras.length).toBeGreaterThan(0)
    for (const cam of payload.cameras) {
      expect(cam).toHaveProperty('id')
      expect(cam).toHaveProperty('type')
    }
  }, 10000)

  it('runs configure → start → stream and receives a frame', async () => {
    await waitForEvent(mgr, 'cameras-discovered', 5000).then(() => {}).catch(() => {})
    // `connect` + auto-discover
    mgr.connect()
    const discovered = await waitForEvent(mgr, 'cameras-discovered', 5000)
    const cameraId = discovered.cameras[0].id

    // configure → status
    const configStatusP = waitForEvent(mgr, 'status', 5000)
    mgr.configureCameras(TEST_CONFIG)
    const configStatus = await configStatusP
    expect(configStatus.message).toMatch(/YUV420/)

    // start_cameras → status
    const startStatusP = waitForEvent(mgr, 'status', 5000)
    mgr.startCameras()
    await startStatusP

    // start_stream → status, then frames
    const streamStatusP = waitForEvent(mgr, 'status', 5000)
    mgr.startStream(cameraId)
    await streamStatusP

    const [frame] = await collectFrames(mgr, 1, 5000)
    expect(frame.cameraId).toBe(cameraId)
    // libcamera snaps requested dimensions to the nearest supported sensor
    // mode (e.g. 1456x1088 → 2328x1748 on IMX519), so assert structural
    // invariants rather than exact equality.
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.height).toBeGreaterThan(0)
    expect(frame.bytesPerLine).toBeGreaterThanOrEqual(frame.width)
    expect(frame.pixelFormat).toBe(FOURCC_YU12)
    expect(frame.isHeaderOnly).toBe(false)
    // YUV420 plane layout (Y stride × H + 2 × UV at half stride, half height)
    expect(frame.data.length).toBe(frame.bytesPerLine * frame.height * 3 / 2)
  }, 20000)

  it('header-only mode delivers zero-length payload frames', async () => {
    mgr.connect()
    const discovered = await waitForEvent(mgr, 'cameras-discovered', 5000)
    const cameraId = discovered.cameras[0].id

    mgr.configureCameras(TEST_CONFIG)
    await waitForEvent(mgr, 'status', 5000)

    mgr.setHeaderOnlyMode(true)
    await waitForEvent(mgr, 'status', 5000)

    mgr.startCameras()
    await waitForEvent(mgr, 'status', 5000)

    mgr.startStream(cameraId)
    await waitForEvent(mgr, 'status', 5000)

    // Drop the first frame (race with mode toggle) and validate the next few.
    const frames = await collectFrames(mgr, 4, 8000)
    const post = frames.slice(1)
    for (const f of post) {
      expect(f.isHeaderOnly).toBe(true)
      expect(f.data.length).toBe(0)
      // libcamera may snap dimensions to the nearest sensor mode.
      expect(f.width).toBeGreaterThan(0)
      expect(f.height).toBeGreaterThan(0)
    }
  }, 20000)

  it('reports framesSaved via header counter and stop_cameras payload', async () => {
    mgr.connect()
    const discovered = await waitForEvent(mgr, 'cameras-discovered', 5000)
    const cameraId = discovered.cameras[0].id

    mgr.configureCameras(TEST_CONFIG)
    await waitForEvent(mgr, 'status', 5000)

    // BATCH mode flushes every `batch_size` frames during streaming, so the
    // per-frame `framesSaved` counter increments live. (BUFFER mode only
    // increments it at stop_cameras time, so it would stay 0 mid-stream.)
    // Use a build-tree scratch dir: /tmp is tmpfs on the Pi and BATCH writes
    // with O_DIRECT, which tmpfs doesn't support.
    const outDir = `${process.cwd()}/.vitest-e2e-save`
    mgr.setSaveMode('batch', {
      output_dir: outDir,
      batch_size: 5,
      writer_threads: 2,
    })
    await waitForEvent(mgr, 'status', 5000)

    mgr.startCameras()
    await waitForEvent(mgr, 'status', 5000)

    mgr.startStream(cameraId)
    await waitForEvent(mgr, 'status', 5000)

    const frames = await collectFrames(mgr, 15, 15000)
    const savedCounts = frames.map((f) => f.framesSaved)
    // Monotonic non-decreasing — same invariant as the Python suite.
    for (let i = 1; i < savedCounts.length; i++) {
      expect(savedCounts[i]).toBeGreaterThanOrEqual(savedCounts[i - 1])
    }

    // `stop_cameras` carries a cumulative `frames_saved` / `bytes_written`;
    // this mirrors the Python save-mode test which checks the stop response.
    const stopP = waitForEventMatching(
      mgr,
      'status',
      (p) => typeof p.data?.frames_saved === 'number',
      10000,
    )
    mgr.stopCameras()
    const stop = await stopP
    expect(stop.data.frames_saved).toBeGreaterThan(0)
    expect(stop.data.bytes_written).toBeGreaterThan(0)
  }, 30000)
})

describe('MultiServerManager', () => {
  /** @type {MultiServerManager} */
  let multi

  afterEach(async () => {
    if (!multi) return
    for (const server of multi.servers.values()) {
      disableReconnect(server)
    }
    try {
      multi.stopAllCameras()
      multi.unconfigureAll()
      await new Promise((r) => setTimeout(r, 500))
    } catch (_) { /* ignore */ }
    multi.disconnectAll()
  })

  it('discovers cameras and builds a global camera map', async () => {
    multi = new MultiServerManager()
    const server = multi.addServer(WS_URL, 0)

    const discoveredP = waitForEvent(multi, 'cameras-discovered', 5000)
    server.connect()
    const payload = await discoveredP

    expect(payload.cameras.length).toBeGreaterThan(0)
    // Global map should have been updated with one slot per camera.
    expect(multi.globalCameraMap.size).toBe(payload.cameras.length)
    // First global id maps back to local camera 0 on server 0.
    expect(multi.getCameraInfo(0)).toEqual({
      serverIndex: 0,
      localCameraId: payload.cameras[0].id,
    })
  }, 10000)
})
