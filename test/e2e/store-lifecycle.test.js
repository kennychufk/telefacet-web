// Store-level lifecycle against a live camera_ws_server.
//
// The rest of test/e2e drives WebSocketManager directly. This file drives the
// Pinia store, because the bug it guards lives there: startAllCameras() used to
// send start_cameras, sleep 500 ms, and set camerasRunning = true regardless.
// Once the server gained the ability to *refuse* a process mode it judges
// unable to keep up (protocol §4.6), that optimism became a hang — the UI would
// show Running over a pipeline that had never started, open streams that never
// delivered, and the operator would be back to staring at a frozen preview.
//
// The store now confirms every lifecycle transition by polling get_state.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useCameraStore } from '../../src/stores/cameraStore.js'
import { waitForEvent } from './setup.js'

const WS_URL = process.env.TELEFACET_WS_URL || 'ws://localhost:9001'
const SENSOR = process.env.TELEFACET_SENSOR || 'imx519'
const WIDTH = Number(process.env.TELEFACET_WIDTH) || 1456
const HEIGHT = Number(process.env.TELEFACET_HEIGHT) || 1088

// Slower than any real capture, so the server's disk check always refuses.
// Declared rather than measured, so the outcome does not depend on the host.
const IMPOSSIBLY_SLOW_DISK = 1000

function makeConfig(processing) {
  return {
    servers: [{ address: WS_URL, sensor: SENSOR, width: WIDTH, height: HEIGHT }],
    processing: {
      mode: 'none',
      save_frames: true,
      output_dir: 'e2e_store',
      prepend_timestamp_to_dir: false,
      batch_size: 10,
      writer_threads: 4,
      backlog_max_bytes: 0,
      disk_write_bytes_per_sec: 0,
      allow_overcommit: false,
      ...processing,
    },
  }
}

describe('Store lifecycle', () => {
  let store

  beforeEach(async () => {
    setActivePinia(createPinia())
    store = useCameraStore()
  }, 30000)

  afterEach(async () => {
    if (!store?.serverManager) return
    try {
      // Walk the server all the way back to IDLE. Leaving it CONFIGURED makes
      // the next test's canConfigure getter false (the store, freshly built,
      // learns the server's real state from the get_state on connect) and
      // configureAllCameras would refuse before sending anything.
      store.serverManager.stopAllCameras()
      await new Promise((r) => setTimeout(r, 500))
      store.serverManager.unconfigureAll()
      store.serverManager.setSaveModeAll('none', {})
      await new Promise((r) => setTimeout(r, 1500))
      store.serverManager.disconnectAll()
    } catch (_) { /* ignore */ }
  }, 30000)

  /** Bring the store up to CONFIGURED with the given processing config. */
  async function bringUp(processing) {
    store.config = makeConfig(processing)
    store.configLoaded = true
    store.initializeServers()

    await waitForEvent(store.serverManager, 'server-connected', 15000)
    const disc = await waitForEvent(store.serverManager, 'cameras-discovered', 10000)
    if (!disc.cameras?.length) {
      throw new Error(`No cameras matched sensor '${SENSOR}' — set TELEFACET_SENSOR`)
    }
    store.updateCameraList()

    expect(await store.configureAllCameras()).toBe(true)
    expect(store.camerasConfigured).toBe(true)
  }

  it('reports failure and stays stopped when the server refuses to start', async () => {
    await bringUp({ mode: 'batch', disk_write_bytes_per_sec: IMPOSSIBLY_SLOW_DISK })

    const ok = await store.startAllCameras()

    // The regression: this used to return true with camerasRunning set.
    expect(ok).toBe(false)
    expect(store.camerasRunning).toBe(false)
    // And the server's own reasoning is what the operator sees, not a generic
    // "failed to start" that hides the arithmetic.
    expect(store.lastError).toMatch(/too slow/i)
  }, 90000)

  it('starts and reports running when the mode is feasible', async () => {
    await bringUp({ mode: 'none' })

    expect(await store.startAllCameras()).toBe(true)
    expect(store.camerasRunning).toBe(true)
    expect(await store.stopAllCameras()).toBe(true)
    expect(store.camerasRunning).toBe(false)
  }, 90000)

  it('starts an infeasible mode when the config allows overcommit', async () => {
    await bringUp({
      mode: 'batch',
      disk_write_bytes_per_sec: IMPOSSIBLY_SLOW_DISK,
      allow_overcommit: true,
    })

    expect(await store.startAllCameras()).toBe(true)
    expect(store.camerasRunning).toBe(true)
  }, 90000)

  it('recoverCapture rebuilds the pipeline and reopens the streams', async () => {
    // The documented capture_timeout recovery. Inducing a real frontend
    // timeout on demand is impractical, but the mechanics it depends on are
    // exactly what a stall would exercise — and they only work because a
    // stalled camera is latched rather than moved to CameraState::ERROR,
    // which would make stop()/start() refuse.
    await bringUp({ mode: 'none' })
    expect(await store.startAllCameras()).toBe(true)

    store.serverManager.startStream(0)
    const cam = store.cameras.find((c) => c.globalId === 0)
    cam.streaming = true

    expect(await store.recoverCapture()).toBe(true)
    expect(store.camerasRunning).toBe(true)
    expect(store.captureTimeout).toBe(null)
    expect(store.cameras.find((c) => c.globalId === 0).streaming).toBe(true)
  }, 90000)

  it('surfaces frames dropped at the backlog budget', async () => {
    // A budget below one frame: every frame is refused, so the backlog cannot
    // grow — the condition that used to OOM the server instead.
    await bringUp({
      mode: 'buffer',
      backlog_max_bytes: 1000,
      allow_overcommit: true,
    })

    expect(await store.startAllCameras()).toBe(true)
    store.serverManager.startStream(0)
    await new Promise((r) => setTimeout(r, 5000))

    // Capture survived the whole time.
    expect(store.camerasRunning).toBe(true)

    await store.stopAllCameras()
    await new Promise((r) => setTimeout(r, 1000))
    expect(store.lastFramesDroppedBacklog).toBeGreaterThan(0)
  }, 90000)
})
