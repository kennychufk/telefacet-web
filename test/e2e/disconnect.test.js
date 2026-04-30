// Disconnect / reconnect / single-client policy.
//
// These tests exercise the server's behaviour when the client goes away
// unexpectedly: abrupt TCP drop without a WebSocket close frame, leaving the
// server to detect the loss via EOF and run cleanupConnection.
//
// Server contract being verified (see WebSocketServer::cleanupConnection):
//
//   * system_state is preserved across a disconnect — cameras keep capturing
//     so frame saving can continue uninterrupted.
//   * streaming_cameras is cleared (the sink is gone), so a reconnecting
//     client must re-issue start_stream.
//   * The single-client slot is released; a new client can take over.
//   * Concurrent second client at upgrade time gets HTTP 503 and never becomes
//     a WebSocket.
//
// Each test does its own teardown because the standard `mgr` afterEach pattern
// can't drive cleanup through a terminated socket. We always use a fresh
// (second) manager to walk the server back to IDLE.

import { mkdirSync } from 'node:fs'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket as RawWS } from 'ws'

// WebSocketManager.js reads `globalThis.WebSocket` at runtime in connect();
// the file-level setup picks the ambient (undici) WebSocket on Node ≥ 22,
// which lacks `terminate()`. For this file's abrupt-close tests we need the
// `ws` package's implementation, so we override the global here and restore
// it on afterAll. Other test files keep whatever the file-level setup chose.
const originalWebSocket = globalThis.WebSocket
globalThis.WebSocket = RawWS

import { WebSocketManager } from '../../src/services/WebSocketManager.js'
import {
  abruptClose,
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

/** Build a WebSocketManager, suppress reconnect, and connect synchronously.
 *
 * Attaches a no-op `error` listener up-front: WebSocketManager emits 'error'
 * via Node EventEmitter, and an unhandled 'error' event terminates the test
 * process. During retry loops (slot-still-occupied, server briefly down), we
 * see those errors as expected — we just want them to not throw.
 */
async function connectFresh(timeoutMs = 5000) {
  const m = new WebSocketManager(WS_URL, 0)
  m.on('error', () => { /* swallow */ })
  disableReconnect(m)
  const connected = waitForEvent(m, 'connected', timeoutMs)
  m.connect()
  await connected
  return m
}

/** Drive the server back to IDLE via a fresh manager (best-effort). */
async function driveToIdle() {
  let m
  try {
    m = await connectFresh(5000)
  } catch (_) {
    return
  }
  try {
    m.setHeaderOnlyMode(false)
    m.stopCameras()
    m.unconfigure()
    m.setSaveMode('none')
    await new Promise((r) => setTimeout(r, 500))
  } catch (_) {
    /* ignore */
  } finally {
    m.disconnect()
  }
}

/** Retry connect via WebSocketManager until it succeeds or timeoutMs elapses. */
async function retryConnect(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      return await connectFresh(2000)
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`Could not reconnect within ${timeoutMs}ms: ${lastErr?.message}`)
}

describe('Disconnect handling', () => {
  // Track every manager a test creates, so afterEach can force-close any
  // that the test failed to release. Without this, an early test failure
  // (e.g. libcamera frame timeout) can leave a manager holding the slot,
  // and subsequent tests pile up 503s for the entire afterEach window.
  /** @type {WebSocketManager[]} */
  let managers
  beforeEach(() => {
    managers = []
  })

  afterEach(async () => {
    // Force-drop any manager the test created but didn't close itself.
    for (const m of managers) {
      try { abruptClose(m) } catch (_) { /* ignore */ }
    }
    managers = []
    // Tiny pause to let the server's close handler run before driveToIdle's
    // upgrade attempt — otherwise we race the slot release.
    await new Promise((r) => setTimeout(r, 100))
    await driveToIdle()
  })

  afterAll(() => {
    // Restore whatever WebSocket the runtime / setup.js originally picked,
    // so subsequent files in the same worker don't inherit the `ws` shim.
    globalThis.WebSocket = originalWebSocket
  })

  /** Connect a manager AND register it for forced cleanup in afterEach. */
  async function trackedConnect(timeoutMs = 5000) {
    const m = await connectFresh(timeoutMs)
    managers.push(m)
    return m
  }
  async function trackedRetryConnect(timeoutMs = 5000) {
    const m = await retryConnect(timeoutMs)
    managers.push(m)
    return m
  }

  it('rejects a second concurrent client with HTTP 503', async () => {
    const first = await trackedConnect()
    try {
      // Bypass WebSocketManager so we can inspect the raw HTTP upgrade response.
      const second = new RawWS(WS_URL)
      const result = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no upgrade response')), 5000)
        second.once('unexpected-response', (req, res) => {
          clearTimeout(t)
          resolve({ statusCode: res.statusCode })
          res.resume() // drain so the socket can close cleanly
        })
        second.once('open', () => {
          clearTimeout(t)
          reject(new Error('upgrade unexpectedly succeeded'))
        })
        second.once('error', () => { /* suppress; unexpected-response already handled */ })
      })
      expect(result.statusCode).toBe(503)
    } finally {
      first.disconnect()
    }
  }, 10000)

  it('releases the slot after a graceful close', async () => {
    const a = await trackedConnect()
    a.disconnect()
    // Should be able to reconnect almost immediately.
    const b = await trackedRetryConnect(3000)
    b.disconnect()
  }, 10000)

  it('releases the slot after an abrupt close', async () => {
    const a = await trackedConnect()
    abruptClose(a)
    // Server's close handler runs on the uWS event loop after EOF; allow
    // a few hundred ms before retrying.
    const b = await trackedRetryConnect(5000)
    b.disconnect()
  }, 10000)

  it('preserves CONFIGURED state across an abrupt close', async () => {
    const a = await trackedConnect()
    a.configureCameras(TEST_CONFIG)
    await waitForEvent(a, 'status', 5000)
    abruptClose(a)

    const b = await trackedRetryConnect(5000)
    try {
      // State is still CONFIGURED → re-configure must be rejected.
      const errP = waitForEvent(b, 'server-error', 3000)
      b.configureCameras(TEST_CONFIG)
      await errP

      // start_cameras must succeed without re-configuring.
      const startP = waitForEvent(b, 'status', 5000)
      b.startCameras()
      await startP

      const stopP = waitForEvent(b, 'status', 10000)
      b.stopCameras()
      await stopP

      const unconfP = waitForEvent(b, 'status', 5000)
      b.unconfigure()
      await unconfP
    } finally {
      b.disconnect()
    }
  }, 20000)

  it('preserves RUNNING state across an abrupt close during streaming', async () => {
    const a = await trackedConnect()
    const discA = await waitForEvent(a, 'cameras-discovered', 5000)
    const cameraId = discA.cameras[0].id

    a.configureCameras(TEST_CONFIG)
    await waitForEvent(a, 'status', 5000)
    a.startCameras()
    await waitForEvent(a, 'status', 5000)
    a.startStream(cameraId)
    await waitForEvent(a, 'status', 5000)

    // Confirm streaming is live before the drop. First frame can take a
    // moment as libcamera warms up; on a real LAN the chunked transfer is
    // also ~1s per 6 MB IMX519 frame.
    await waitForEvent(a, 'frame', 30000)
    abruptClose(a)

    const b = await trackedRetryConnect(10000)
    try {
      // Still RUNNING → configure is rejected.
      const errP = waitForEvent(b, 'server-error', 5000)
      b.configureCameras(TEST_CONFIG)
      await errP

      // streaming_cameras was cleared on disconnect; re-issue start_stream.
      const ssP = waitForEvent(b, 'status', 15000)
      b.startStream(cameraId)
      await ssP

      const frame = await waitForEvent(b, 'frame', 15000)
      expect(frame.cameraId).toBe(cameraId)

      // stop_cameras succeeds → confirms we were in RUNNING.
      const stopP = waitForEventMatching(
        b,
        'status',
        (p) => typeof p.data?.frames_saved === 'number',
        30000,
      )
      b.stopCameras()
      await stopP

      const unconfP = waitForEvent(b, 'status', 15000)
      b.unconfigure()
      await unconfP
    } finally {
      b.disconnect()
    }
  }, 90000)

  it('keeps the BATCH frame saver running during a disconnect window', async () => {
    const a = await trackedConnect()
    const discA = await waitForEvent(a, 'cameras-discovered', 5000)
    const cameraId = discA.cameras[0].id

    // /tmp is tmpfs on the Pi and BATCH writes with O_DIRECT; use a local
    // dir. Ensure it exists — the server's mkdir is non-recursive and falls
    // back to CWD if the parent is missing, which scatters .yuv files into
    // the project root and (in some build configs) crashes the writer
    // mid-stream. Belt and braces: we make the dir ourselves.
    const outDir = `${process.cwd()}/.vitest-e2e-save/disconnect`
    mkdirSync(outDir, { recursive: true })

    a.configureCameras(TEST_CONFIG)
    await waitForEvent(a, 'status', 5000)
    a.setSaveMode('batch', { output_dir: outDir, batch_size: 5, writer_threads: 2 })
    await waitForEvent(a, 'status', 5000)
    a.startCameras()
    await waitForEvent(a, 'status', 5000)
    a.startStream(cameraId)
    await waitForEvent(a, 'status', 5000)

    // Streaming is live.
    await waitForEvent(a, 'frame', 5000)
    abruptClose(a)

    // Saving must continue while we are gone.
    await new Promise((r) => setTimeout(r, 2000))

    const b = await trackedRetryConnect(5000)
    try {
      const stopP = waitForEventMatching(
        b,
        'status',
        (p) => typeof p.data?.frames_saved === 'number',
        15000,
      )
      b.stopCameras()
      const stop = await stopP
      // ~30 fps × ~2 s ≈ 60 frames; floor low to keep the test robust.
      expect(stop.data.frames_saved).toBeGreaterThanOrEqual(10)
      expect(stop.data.bytes_written).toBeGreaterThan(0)

      const unconfP = waitForEvent(b, 'status', 5000)
      b.unconfigure()
      await unconfP
    } finally {
      b.disconnect()
    }
  }, 30000)

  it('survives many connect / disconnect cycles without leaking the slot', async () => {
    const cycles = 8
    for (let i = 0; i < cycles; i++) {
      const m = await trackedRetryConnect(5000)
      // Mix graceful and abrupt closes to exercise both code paths.
      try {
        await waitForEvent(m, 'cameras-discovered', 3000)
        if (i % 2 === 0) {
          abruptClose(m)
        } else {
          m.disconnect()
        }
      } catch (e) {
        abruptClose(m)
        throw e
      }
      // Brief pause to let the server's close handler run before the next
      // iteration's upgrade attempt — avoids a tight reconnect race.
      await new Promise((r) => setTimeout(r, 50))
    }

    // Final sanity check: a normal session still works end-to-end.
    const final = await trackedRetryConnect(5000)
    try {
      const disc = await waitForEvent(final, 'cameras-discovered', 3000)
      expect(Array.isArray(disc.cameras)).toBe(true)
    } finally {
      final.disconnect()
    }
  }, 60000)
})
