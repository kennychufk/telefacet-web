// State-machine edge cases beyond the happy-path lifecycle in
// websocket-manager.test.js. Each test starts from a fresh, IDLE server (the
// afterEach walks back to IDLE), so rejected-state assertions don't depend
// on test ordering.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WebSocketManager } from '../../src/services/WebSocketManager.js'
import {
  collectFrames,
  disableReconnect,
  waitForEvent,
  waitForEventMatching,
} from './setup.js'

const WS_URL = process.env.TELEFACET_WS_URL || 'ws://localhost:9001'

const TEST_CONFIG = {
  width: 1456,
  height: 1088,
  crop_width: 4656,
  crop_height: 3496,
  crop_left: 8,
  crop_top: 48,
}

/**
 * Pull frames from the manager until one satisfies `predicate`, or fail.
 * Used right after a mode-switch — frames already in flight may still
 * reflect the old mode, so we skip them.
 *
 * Defaults are very generous (60s / 500 frames) because over a real
 * LAN the server can land in a backpressure-recovery cycle after a
 * mid-stream mode switch — the chunked-transfer rate controller caps at
 * ~1000 chunks/sec (≈5 fps for 6 MB IMX519 frames) and the in-flight
 * data frame may need to drain before the new mode takes effect. On
 * loopback this all happens in milliseconds.
 */
async function nextFrameMatching(mgr, predicate, { timeoutMs = 60000, maxFrames = 500 } = {}) {
  return new Promise((resolve, reject) => {
    let seen = 0
    const t = setTimeout(() => {
      mgr.off('frame', onFrame)
      reject(new Error(`No frame matched predicate within ${timeoutMs}ms / ${maxFrames} frames`))
    }, timeoutMs)
    const onFrame = (frame) => {
      seen++
      if (predicate(frame)) {
        clearTimeout(t)
        mgr.off('frame', onFrame)
        resolve(frame)
      } else if (seen >= maxFrames) {
        clearTimeout(t)
        mgr.off('frame', onFrame)
        reject(new Error(`Exhausted ${maxFrames} frames without a match`))
      }
    }
    mgr.on('frame', onFrame)
  })
}

describe('State-machine edges', () => {
  /** @type {WebSocketManager} */
  let mgr

  beforeEach(async () => {
    mgr = new WebSocketManager(WS_URL, 0)
    disableReconnect(mgr)
    // Swallow WebSocket error events: WebSocketManager extends EventEmitter,
    // and Node throws ERR_UNHANDLED_ERROR if an 'error' event has no
    // listener. On a flaky LAN the WS may emit 'error' during teardown
    // after a timeout, which would otherwise crash the whole test file
    // and cascade-fail every subsequent test.
    mgr.on('error', () => {})
    // Generous connect timeout: if the previous test left the server
    // draining a backed-up send queue, the single-client slot may take a
    // few seconds to free up.
    const connected = waitForEvent(mgr, 'connected', 15000)
    mgr.connect()
    await connected
    await waitForEvent(mgr, 'cameras-discovered', 10000)
  })

  afterEach(async () => {
    if (!mgr) return
    try {
      mgr.setHeaderOnlyMode(false)
      mgr.stopCameras()
      mgr.unconfigure()
      mgr.setSaveMode('none')
      // Give the server a moment to process the teardown commands and
      // drain any in-flight binary chunks before we close the socket.
      await new Promise((r) => setTimeout(r, 1500))
    } catch (_) { /* ignore */ }
    mgr.disconnect()
  })

  // --- stop_stream gating --------------------------------------------------

  it('rejects stop_stream from IDLE', async () => {
    const errP = waitForEvent(mgr, 'server-error', 3000)
    mgr.stopStream(0)
    await errP
  }, 10000)

  it('rejects stop_stream from CONFIGURED', async () => {
    const cfgP = waitForEvent(mgr, 'status', 5000)
    mgr.configureCameras(TEST_CONFIG)
    await cfgP

    const errP = waitForEvent(mgr, 'server-error', 3000)
    mgr.stopStream(0)
    await errP
  }, 10000)

  it('rejects stop_stream of a camera that was never streaming', async () => {
    const disc = await new Promise((resolve) => {
      // cameras-discovered already fired in beforeEach; ask again to capture.
      mgr.once('cameras-discovered', resolve)
      mgr.discoverCameras()
    })
    const cameraId = disc.cameras[0].id

    const cfgP = waitForEvent(mgr, 'status', 5000)
    mgr.configureCameras(TEST_CONFIG)
    await cfgP

    const startP = waitForEvent(mgr, 'status', 5000)
    mgr.startCameras()
    await startP

    // No start_stream yet → stop_stream must error.
    const errP = waitForEvent(mgr, 'server-error', 3000)
    mgr.stopStream(cameraId)
    await errP

    const stopP = waitForEvent(mgr, 'status', 10000)
    mgr.stopCameras()
    await stopP
  }, 20000)

  // --- start_stream idempotency -------------------------------------------

  it('treats a second start_stream for the same camera as a no-op', async () => {
    const disc = await new Promise((resolve) => {
      mgr.once('cameras-discovered', resolve)
      mgr.discoverCameras()
    })
    const cameraId = disc.cameras[0].id

    mgr.configureCameras(TEST_CONFIG)
    await waitForEvent(mgr, 'status', 5000)
    mgr.startCameras()
    await waitForEvent(mgr, 'status', 5000)

    // First start_stream — status.
    const ss1 = waitForEvent(mgr, 'status', 5000)
    mgr.startStream(cameraId)
    await ss1

    // Wait for at least one frame so the streaming thread is settled before
    // we issue the second start_stream. Without this delay, two start_stream
    // commands can land while the streaming thread is mid-send and trip a
    // uWS cork race on the server (observed under Node — Python's tests have
    // enough per-call latency that they don't hit it). The contract under
    // test (silent re-success) is unchanged either way. Generous frame
    // timeout: first frame can take >5s over a real LAN as libcamera warms
    // up and the chunked transfer drains.
    await waitForEvent(mgr, 'frame', 15000)

    // Second start_stream — must also be status (no error). Very generous
    // timeout: while RUNNING, status text responses can queue behind tens
    // of MB of in-flight binary chunks on a real LAN.
    const ss2 = waitForEvent(mgr, 'status', 60000)
    mgr.startStream(cameraId)
    await ss2

    // Frames still flow.
    const frame = await waitForEvent(mgr, 'frame', 15000)
    expect(frame.cameraId).toBe(cameraId)

    // Single stop_stream halts the (single) logical stream; second stop_stream errors.
    const stop1 = waitForEvent(mgr, 'status', 60000)
    mgr.stopStream(cameraId)
    await stop1

    // Generous timeout: error response queues behind buffered binary
    // chunks that were in-flight when the first stop_stream landed.
    const stop2err = waitForEvent(mgr, 'server-error', 30000)
    mgr.stopStream(cameraId)
    await stop2err

    const stopAll = waitForEvent(mgr, 'status', 30000)
    mgr.stopCameras()
    await stopAll
  }, 240000)

  // --- mid-stream control commands ----------------------------------------

  it('toggles header-only mode mid-stream', async () => {
    const disc = await new Promise((resolve) => {
      mgr.once('cameras-discovered', resolve)
      mgr.discoverCameras()
    })
    const cameraId = disc.cameras[0].id

    mgr.configureCameras(TEST_CONFIG)
    await waitForEvent(mgr, 'status', 5000)
    mgr.startCameras()
    await waitForEvent(mgr, 'status', 5000)
    mgr.startStream(cameraId)
    await waitForEvent(mgr, 'status', 5000)

    // Baseline: full data frames.
    const first = await nextFrameMatching(
      mgr,
      (f) => f.cameraId === cameraId && !f.isHeaderOnly,
    )
    expect(first.data.length).toBeGreaterThan(0)

    // Switch to header-only. Very generous timeout: mid-stream the WS is
    // saturated with frame data and the status text response can queue
    // behind tens of MB of in-flight binary chunks on a real LAN.
    mgr.setHeaderOnlyMode(true)
    await waitForEvent(mgr, 'status', 60000)
    const ho = await nextFrameMatching(mgr, (f) => f.isHeaderOnly)
    expect(ho.data.length).toBe(0)

    // Switch back.
    mgr.setHeaderOnlyMode(false)
    await waitForEvent(mgr, 'status', 60000)
    const back = await nextFrameMatching(mgr, (f) => !f.isHeaderOnly)
    expect(back.data.length).toBeGreaterThan(0)

    const stopAll = waitForEvent(mgr, 'status', 30000)
    mgr.stopCameras()
    await stopAll
  }, 180000)

  it('reset_frame_counts mid-stream rolls frame_id back without disrupting flow', async () => {
    const disc = await new Promise((resolve) => {
      mgr.once('cameras-discovered', resolve)
      mgr.discoverCameras()
    })
    const cameraId = disc.cameras[0].id

    mgr.configureCameras(TEST_CONFIG)
    await waitForEvent(mgr, 'status', 5000)
    mgr.startCameras()
    await waitForEvent(mgr, 'status', 5000)
    mgr.startStream(cameraId)
    await waitForEvent(mgr, 'status', 5000)

    // Advance the counter. Generous timeout: the chunked-transfer rate
    // controller caps at ~5 fps for 6 MB IMX519 frames over a real LAN.
    const before = await collectFrames(mgr, 8, 30000)
    const preResetId = before[before.length - 1].frameId
    expect(preResetId).toBeGreaterThanOrEqual(1)

    mgr.resetFrameCounts()
    // Very generous timeout: under heavy chunked-binary streaming the
    // status text reply can sit behind several seconds of queued binary
    // (uWS buffers up to ~8 MB plus our deferred-send cap).
    await waitForEvent(mgr, 'status', 60000)

    // Next freshly-captured frame should have a much smaller frameId.
    // Generous bounds: on a real LAN the server's TCP send buffer holds
    // many old-counter frames captured before the reset took effect.
    const post = await nextFrameMatching(
      mgr,
      (f) => f.cameraId === cameraId && f.frameId < preResetId,
    )
    expect(post.frameId).toBeLessThan(preResetId)

    const stopAll = waitForEvent(mgr, 'status', 30000)
    mgr.stopCameras()
    await stopAll
  }, 180000)

  it('allows discover during RUNNING', async () => {
    const initialDisc = await new Promise((resolve) => {
      mgr.once('cameras-discovered', resolve)
      mgr.discoverCameras()
    })

    mgr.configureCameras(TEST_CONFIG)
    await waitForEvent(mgr, 'status', 5000)
    mgr.startCameras()
    await waitForEvent(mgr, 'status', 5000)

    // Discover while RUNNING — must succeed. Generous timeout: the text
    // response queues behind active binary frame chunks on a real LAN.
    // Very generous timeout: same reasoning as resetFrameCounts above.
    const discP = waitForEvent(mgr, 'cameras-discovered', 60000)
    mgr.discoverCameras()
    const disc = await discP
    expect(disc.cameras.length).toBe(initialDisc.cameras.length)

    const stopAll = waitForEvent(mgr, 'status', 30000)
    mgr.stopCameras()
    await stopAll
  }, 90000)

  // --- many-cycle reliability ----------------------------------------------

  it('handles many configure/unconfigure cycles reliably', async () => {
    const cycles = 5
    for (let i = 0; i < cycles; i++) {
      const cfgP = waitForEvent(mgr, 'status', 5000)
      mgr.configureCameras(TEST_CONFIG)
      await cfgP

      // Half the cycles also visit RUNNING for full-pipeline exercise.
      if (i % 2 === 0) {
        const startP = waitForEvent(mgr, 'status', 5000)
        mgr.startCameras()
        await startP

        const stopP = waitForEventMatching(
          mgr,
          'status',
          (p) => typeof p.data?.frames_saved === 'number',
          10000,
        )
        mgr.stopCameras()
        await stopP
      }

      const unconfP = waitForEvent(mgr, 'status', 5000)
      mgr.unconfigure()
      await unconfP
    }
  }, 60000)
})
