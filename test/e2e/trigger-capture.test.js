// Unit-level test for the `trigger` process mode's save-on-demand shutter
// (protocol §4.17): the client must send a well-formed `trigger_capture`
// command and surface the server's asynchronous `trigger_result` ack as a
// `trigger-result` event — including through MultiServerManager's re-forward,
// which is the wiring that's easy to forget.
//
// Like protocol-rejection.test.js, this boots a tiny `ws` server in-process,
// so it doesn't need the Pi.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import { MultiServerManager, WebSocketManager } from '../../src/services/WebSocketManager.js'
import { disableReconnect, waitForEvent } from './setup.js'

/**
 * Stub server: answers `discover` with one camera and `trigger_capture` with a
 * `trigger_result` after `ackDelayMs` (mimicking the real server, which only
 * acks once the triggered frame has actually been captured). Records every
 * command it received in `received`.
 */
function stubServer(wss, { received, ackDelayMs = 20, cancelled = false } = {}) {
  let triggerId = 0
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse(data.toString())
      received.push(msg)
      if (msg.cmd === 'discover') {
        ws.send(JSON.stringify({ type: 'discovery', cameras: [{ id: 0, type: 'FAKE' }] }))
      } else if (msg.cmd === 'trigger_capture') {
        triggerId++
        const id = triggerId
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'trigger_result',
            trigger_id: id,
            cancelled,
            captures: [{ camera_id: 0, frame_id: 42, filename: `calib/cam0-42.yuv` }]
          }))
        }, ackDelayMs)
      }
    })
  })
}

describe('trigger_capture', () => {
  /** @type {WebSocketServer} */
  let wss
  /** @type {number} */
  let port
  let mgr
  let multi

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 })
    await new Promise((resolve) => wss.on('listening', resolve))
    port = wss.address().port
  })

  afterEach(async () => {
    if (mgr) {
      disableReconnect(mgr)
      mgr.disconnect()
      mgr = null
    }
    if (multi) {
      multi.disconnectAll()
      multi = null
    }
    await new Promise((resolve) => wss.close(resolve))
  })

  it('sends a bare trigger_capture and emits the ack', async () => {
    const received = []
    stubServer(wss, { received })

    mgr = new WebSocketManager(`ws://localhost:${port}`, 0)
    mgr.connect()
    await waitForEvent(mgr, 'cameras-discovered', 3000)

    const ackPromise = waitForEvent(mgr, 'trigger-result', 3000)
    expect(mgr.triggerCapture()).toBe(true)
    const ack = await ackPromise

    expect(ack.serverIndex).toBe(0)
    expect(ack.triggerId).toBe(1)
    expect(ack.cancelled).toBe(false)
    expect(ack.captures).toEqual([
      { camera_id: 0, frame_id: 42, filename: 'calib/cam0-42.yuv' }
    ])

    // No camera_id ⇒ the server arms every running camera; no skip_frames ⇒ it
    // uses the configured trigger_skip_frames. Neither key must be sent.
    const cmd = received.find((m) => m.cmd === 'trigger_capture')
    expect(cmd).toEqual({ cmd: 'trigger_capture' })
  }, 10000)

  it('forwards camera_id and skip_frames when given', async () => {
    const received = []
    stubServer(wss, { received })

    mgr = new WebSocketManager(`ws://localhost:${port}`, 0)
    mgr.connect()
    await waitForEvent(mgr, 'cameras-discovered', 3000)

    const ackPromise = waitForEvent(mgr, 'trigger-result', 3000)
    mgr.triggerCapture({ cameraId: 2, skipFrames: 3 })
    await ackPromise

    const cmd = received.find((m) => m.cmd === 'trigger_capture')
    expect(cmd).toEqual({ cmd: 'trigger_capture', camera_id: 2, skip_frames: 3 })
  }, 10000)

  it('surfaces a cancelled ack', async () => {
    stubServer(wss, { received: [], cancelled: true })

    mgr = new WebSocketManager(`ws://localhost:${port}`, 0)
    mgr.connect()
    await waitForEvent(mgr, 'cameras-discovered', 3000)

    const ackPromise = waitForEvent(mgr, 'trigger-result', 3000)
    mgr.triggerCapture()
    expect((await ackPromise).cancelled).toBe(true)
  }, 10000)

  it('MultiServerManager re-forwards trigger-result and counts armed servers', async () => {
    const received = []
    stubServer(wss, { received })

    multi = new MultiServerManager()
    multi.addServer(`ws://localhost:${port}`, 0)
    multi.connectAll()
    await waitForEvent(multi, 'cameras-discovered', 3000)

    const ackPromise = waitForEvent(multi, 'trigger-result', 3000)
    expect(multi.triggerCaptureAll()).toBe(1)
    const ack = await ackPromise

    expect(ack.serverIndex).toBe(0)
    expect(ack.captures).toHaveLength(1)
  }, 10000)
})
