// Resource guards: the server bounds the RAM held by captured-but-unwritten
// frames, refuses a process mode that provably cannot keep up with the camera,
// and reports what it dropped (protocol §4.5.1, §4.6, §4.9).
//
// These exist because an unbounded backlog does not merely waste memory — it
// permanently kills capture: the box swap-thrashes, libcamera's completion
// thread misses the RPi dequeue watchdog, the PiSP frontend times out, and
// requestCompleted never fires again. The client saw an open socket and
// silence. Everything below is a regression guard on that.
//
// Determinism note: the checks depend on hardware (frame size, disk rate,
// MemAvailable), so these tests *declare* the inputs — disk_write_bytes_per_sec
// instead of letting the server probe, an explicit backlog_max_bytes instead of
// one derived from MemAvailable — so a fast dev box and a 1 GB Pi behave alike.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WebSocketManager } from '../../src/services/WebSocketManager.js'
import { disableReconnect, waitForEvent, waitForEventMatching } from './setup.js'

const WS_URL = process.env.TELEFACET_WS_URL || 'ws://localhost:9001'

// The rest of the suite hard-codes an imx519 rig at 1456x1088. These tests are
// about resource arithmetic, which is exactly what differs between rigs, so
// the sensor and geometry are overridable — point them at an imx708 Pi with
//   TELEFACET_SENSOR=imx708 TELEFACET_WIDTH=4608 TELEFACET_HEIGHT=2592
const SENSOR = process.env.TELEFACET_SENSOR || 'imx519'
const TEST_CONFIG = {
  width: Number(process.env.TELEFACET_WIDTH) || 1456,
  height: Number(process.env.TELEFACET_HEIGHT) || 1088,
}

// Slower than any real capture, so checkDiskThroughput always refuses. Declared
// rather than measured, which also skips the server's 32 MiB O_DIRECT probe.
const IMPOSSIBLY_SLOW_DISK = 1000

// Smaller than a single frame at any resolution this server supports, so every
// frame is refused at the budget and the backlog can never grow.
const SUB_FRAME_BUDGET = 1000

/** Read the server's own view of its lifecycle state. */
async function serverState(mgr) {
  const p = waitForEvent(mgr, 'server-state', 5000)
  mgr.getState()
  return (await p).state
}

describe('Resource guards', () => {
  /** @type {WebSocketManager} */
  let mgr

  beforeEach(async () => {
    mgr = new WebSocketManager(WS_URL, 0, { sensor: SENSOR })
    disableReconnect(mgr)
    mgr.on('error', () => {})
    const connected = waitForEvent(mgr, 'connected', 15000)
    mgr.connect()
    await connected

    // The manager auto-discovers on open, but with the *default* sensor; ask
    // again with ours and fail loudly on a mismatch, since every later
    // assertion would otherwise die as an unexplained hook timeout.
    const discP = waitForEvent(mgr, 'cameras-discovered', 10000)
    mgr.discoverCameras()
    const disc = await discP
    if (!disc.cameras?.length) {
      throw new Error(
        `No cameras matched sensor '${SENSOR}' on ${WS_URL} — set TELEFACET_SENSOR`)
    }

    const configured = waitForEvent(mgr, 'status', 15000)
    mgr.configureCameras(TEST_CONFIG)
    await configured
  }, 45000)

  afterEach(async () => {
    if (!mgr) return
    try {
      mgr.stopCameras()
      mgr.unconfigure()
      mgr.setSaveMode('none')
      await new Promise((r) => setTimeout(r, 1500))
    } catch (_) { /* ignore */ }
    mgr.disconnect()
  }, 30000)

  // --- set_process_mode accepts the guards ---------------------------------

  it('accepts the resource-guard params on set_process_mode', async () => {
    const statusP = waitForEvent(mgr, 'status', 5000)
    mgr.setSaveMode('buffer', {
      save_frames: true,
      output_dir: 'e2e_guards',
      backlog_max_bytes: 64 * 1024 * 1024,
      disk_write_bytes_per_sec: 50 * 1000 * 1000,
      allow_overcommit: false,
    })
    const status = await statusP
    expect(status.message).toMatch(/buffer/i)
  }, 15000)

  // --- start_cameras refuses an infeasible mode ----------------------------

  it('refuses to start batch mode when the declared disk is too slow', async () => {
    mgr.setSaveMode('batch', {
      save_frames: true,
      output_dir: 'e2e_guards',
      disk_write_bytes_per_sec: IMPOSSIBLY_SLOW_DISK,
    })

    const errP = waitForEvent(mgr, 'server-error', 10000)
    mgr.startCameras()
    const err = await errP

    // The refusal has to name the arithmetic, or the operator cannot act on it.
    expect(err.message).toMatch(/too slow/i)
    expect(err.message).toMatch(/MB\/s/)

    // And it must really not have started — this is the whole point. Assuming
    // success here is what left the UI showing "Running" over a dead pipeline.
    expect(await serverState(mgr)).toBe('configured')
  }, 30000)

  it('starts the same infeasible mode when allow_overcommit is set', async () => {
    mgr.setSaveMode('batch', {
      save_frames: true,
      output_dir: 'e2e_guards',
      disk_write_bytes_per_sec: IMPOSSIBLY_SLOW_DISK,
      allow_overcommit: true,
    })

    const statusP = waitForEventMatching(
      mgr, 'status', (s) => /started/i.test(s.message), 15000)
    mgr.startCameras()
    await statusP

    expect(await serverState(mgr)).toBe('running')
  }, 30000)

  // --- error payload shape --------------------------------------------------

  it('forwards the full error payload, not just the message', async () => {
    mgr.setSaveMode('batch', {
      save_frames: true,
      output_dir: 'e2e_guards',
      disk_write_bytes_per_sec: IMPOSSIBLY_SLOW_DISK,
    })

    const errP = waitForEvent(mgr, 'server-error', 10000)
    mgr.startCameras()
    const err = await errP

    // A plain refusal carries no `code`; the fields still have to be present
    // and null rather than undefined, so a consumer can branch on them. The
    // raw message is passed through for anything not named explicitly.
    expect(err).toHaveProperty('code', null)
    expect(err).toHaveProperty('cameraId', null)
    expect(err).toHaveProperty('stalledForUs', null)
    expect(err.data).toMatchObject({ type: 'error', message: err.message })
  }, 30000)

  // --- the backlog bound itself --------------------------------------------

  it('keeps capturing and reports the drops when the budget is exhausted', async () => {
    // A budget below one frame means every frame is refused: the backlog can
    // never grow, which is precisely the condition that used to OOM the server
    // and take the capture pipeline down with it.
    mgr.setSaveMode('buffer', {
      save_frames: true,
      output_dir: 'e2e_guards',
      backlog_max_bytes: SUB_FRAME_BUDGET,
      allow_overcommit: true, // the budget is deliberately infeasible
    })

    const started = waitForEventMatching(
      mgr, 'status', (s) => /started/i.test(s.message), 15000)
    mgr.startCameras()
    await started

    mgr.startStream(0)

    // Capture must survive: frames keep arriving even though none are kept.
    const frames = []
    const onFrame = (f) => frames.push(f)
    mgr.on('frame', onFrame)
    await new Promise((r) => setTimeout(r, 6000))
    mgr.off('frame', onFrame)

    expect(frames.length).toBeGreaterThan(0)
    expect(await serverState(mgr)).toBe('running')

    // And the client is told the recording has a gap.
    const stopped = waitForEventMatching(
      mgr, 'status', (s) => /stopped/i.test(s.message), 15000)
    mgr.stopCameras()
    const status = await stopped

    expect(status.data).toHaveProperty('frames_dropped_backlog')
    expect(status.data.frames_dropped_backlog).toBeGreaterThan(0)
  }, 60000)
})
