// Commander / observer roles against a live camera_ws_server (protocol §1.1).
//
// An observer connects to the server's /observer path, is refused every write
// command with code "forbidden", receives the server's pushed `state`
// messages, and keeps a persistent subscription that delivers frames whenever
// a commander has the cameras running. These tests drive one commander and
// one observer WebSocketManager at the same server.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MultiServerManager, WebSocketManager } from '../../src/services/WebSocketManager.js'
import { disableReconnect, waitForEvent, waitForEventMatching } from './setup.js'

const WS_URL = process.env.TELEFACET_WS_URL || 'ws://localhost:9001'
const SENSOR = process.env.TELEFACET_SENSOR || 'imx519'
const WIDTH = Number(process.env.TELEFACET_WIDTH) || 1456
const HEIGHT = Number(process.env.TELEFACET_HEIGHT) || 1088

async function connect(role) {
  const m = new WebSocketManager(WS_URL, role === 'observer' ? 1 : 0, { role, sensor: SENSOR })
  m.on('error', () => {})
  disableReconnect(m)
  const connected = waitForEvent(m, 'connected', 10000)
  m.connect()
  await connected
  return m
}

describe('Observer role', () => {
  /** @type {WebSocketManager} */
  let commander
  /** @type {WebSocketManager} */
  let observer

  beforeEach(async () => {
    commander = await connect('commander')
    observer = await connect('observer')
  }, 30000)

  afterEach(async () => {
    try {
      observer?.disconnect()
      if (commander?.connected) {
        commander.setHeaderOnlyMode(false)
        commander.stopCameras()
        commander.unconfigure()
        commander.setSaveMode('none')
        await new Promise((r) => setTimeout(r, 1500))
      }
    } catch (_) { /* ignore */ }
    commander?.disconnect()
  }, 30000)

  it('connects on /observer and learns its role from get_state', async () => {
    expect(observer.url).toMatch(/\/observer$/)
    const stateP = waitForEventMatching(observer, 'server-state', (s) => s.cause === 'query', 5000)
    observer.getState()
    const state = await stateP
    expect(state.role).toBe('observer')
    expect(state.commanderConnected).toBe(true)
    expect(state.observerConnected).toBe(true)
  }, 15000)

  it('is refused every write command with code "forbidden"', async () => {
    for (const send of [
      () => observer.configureCameras({ width: WIDTH, height: HEIGHT }),
      () => observer.startCameras(),
      () => observer.setSaveMode('none'),
      () => observer.setLensPosition(-1),
      () => observer.resetFrameCounts(),
    ]) {
      const errP = waitForEvent(observer, 'server-error', 5000)
      send()
      const err = await errP
      expect(err.code).toBe('forbidden')
      expect(err.message).toMatch(/observer/)
    }
  }, 30000)

  it('receives pushed state on the commander\'s transitions and keeps its subscription', async () => {
    const disc = await (async () => {
      const p = waitForEvent(observer, 'cameras-discovered', 5000)
      observer.discoverCameras()
      return p
    })()
    if (!disc.cameras.length) throw new Error(`No cameras matched sensor '${SENSOR}'`)
    const cameraId = disc.cameras[0].id

    // Subscribe while idle: allowed for an observer, and persistent.
    const subP = waitForEvent(observer, 'status', 5000)
    observer.startStream(cameraId, { subsample: 2 })
    expect((await subP).message).toMatch(/Started streaming camera/)

    // Commander brings the cameras up; the observer is told each step.
    const configuredP = waitForEventMatching(observer, 'server-state', (s) => s.cause === 'configure', 10000)
    commander.configureCameras({ width: WIDTH, height: HEIGHT })
    await waitForEvent(commander, 'status', 5000)
    expect((await configuredP).state).toBe('configured')

    const runningP = waitForEventMatching(observer, 'server-state', (s) => s.cause === 'start_cameras', 10000)
    commander.startCameras()
    await waitForEvent(commander, 'status', 10000)
    expect((await runningP).state).toBe('running')

    // Frames arrive without a new start_stream, at the subsampled geometry.
    const frame = await waitForEvent(observer, 'frame', 30000)
    expect(frame.cameraId).toBe(cameraId)
    expect(frame.isHeaderOnly).toBe(false)
    expect(frame.bytesPerLine).toBe(frame.width)
    expect(frame.data.length).toBe(frame.width * frame.height * 3 / 2)

    // The commander stops the cameras: the observer hears about it and its
    // subscription survives for the next start.
    const stoppedP = waitForEventMatching(observer, 'server-state', (s) => s.cause === 'stop_cameras', 15000)
    commander.stopCameras()
    await waitForEventMatching(commander, 'status', (p) => typeof p.data?.frames_saved === 'number', 15000)
    expect((await stoppedP).state).toBe('configured')
    expect(observer.isStreaming(cameraId)).toBe(true)

    const runningAgainP = waitForEventMatching(observer, 'server-state', (s) => s.cause === 'start_cameras', 10000)
    commander.startCameras()
    await waitForEvent(commander, 'status', 10000)
    await runningAgainP
    const again = await waitForEvent(observer, 'frame', 30000)
    expect(again.cameraId).toBe(cameraId)
  }, 120000)

  it('MultiServerManager keeps write broadcasts away from observer servers', async () => {
    // Fresh managers so the beforeEach ones don't hold the slots.
    observer.disconnect()
    commander.disconnect()
    await new Promise((r) => setTimeout(r, 300))

    const multi = new MultiServerManager()
    multi.on('error', () => {})
    const cmd = multi.addServer(WS_URL, 0, { role: 'commander', sensor: SENSOR, cameraConfig: { width: WIDTH, height: HEIGHT } })
    const obs = multi.addServer(WS_URL, 1, { role: 'observer', sensor: SENSOR, subsample: 2 })
    cmd.on('error', () => {}); obs.on('error', () => {})
    disableReconnect(cmd); disableReconnect(obs)
    const both = Promise.all([waitForEvent(cmd, 'connected', 10000), waitForEvent(obs, 'connected', 10000)])
    multi.connectAll()
    await both
    try {
      expect(multi.commanderServers).toEqual([cmd])
      expect(multi.observerServers).toEqual([obs])

      // No forbidden error must reach the observer from a broadcast.
      let forbidden = 0
      obs.on('server-error', (e) => { if (e.code === 'forbidden') forbidden++ })
      const configuredP = waitForEvent(cmd, 'status', 5000)
      multi.configureAll()
      await configuredP
      multi.setSaveModeAll('none', {})
      await waitForEvent(cmd, 'status', 5000)
      await new Promise((r) => setTimeout(r, 300))
      expect(forbidden).toBe(0)

      const unconfP = waitForEvent(cmd, 'status', 5000)
      multi.unconfigureAll()
      await unconfP
    } finally {
      multi.disconnectAll()
      // Re-create the beforeEach managers' expectations for afterEach.
      commander = cmd
      observer = obs
    }
  }, 60000)
})
