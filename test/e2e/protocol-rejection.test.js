// Unit-level test: WebSocketManager must reject CHUN frames whose version
// isn't 2. We boot a tiny `ws` server in-process, send a crafted v1 CHUN,
// and assert the manager doesn't emit a `frame` for it.
//
// Unlike the live-server tests, this test doesn't need the Pi.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import { WebSocketManager } from '../../src/services/WebSocketManager.js'
import { disableReconnect, waitForEvent } from './setup.js'

function u32(view, offset, value) {
  view.setUint32(offset, value, true)
}

/** Build a 48-byte CHUN packet with the given version. */
function buildChunPacket(version, overrides = {}) {
  const buf = new ArrayBuffer(48)
  const view = new DataView(buf)
  u32(view, 0, 0x4348554E) // 'CHUN'
  u32(view, 4, version)
  u32(view, 8, overrides.frameUuid ?? 1)
  u32(view, 12, overrides.frameId ?? 1)
  u32(view, 16, overrides.cameraId ?? 0)
  u32(view, 20, overrides.totalChunks ?? 0)
  u32(view, 24, overrides.totalSize ?? 0)
  u32(view, 28, overrides.bytesPerLine ?? 0)
  u32(view, 32, overrides.width ?? 1456)
  u32(view, 36, overrides.height ?? 1088)
  u32(view, 40, overrides.pixelFormat ?? 0x32315559)
  u32(view, 44, overrides.framesSaved ?? 0)
  return buf
}

describe('Protocol version rejection', () => {
  /** @type {WebSocketServer} */
  let wss
  /** @type {number} */
  let port
  /** @type {WebSocketManager} */
  let mgr

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 })
    await new Promise((resolve) => wss.on('listening', resolve))
    port = wss.address().port
  })

  afterEach(async () => {
    if (mgr) {
      disableReconnect(mgr)
      mgr.disconnect()
    }
    await new Promise((resolve) => wss.close(resolve))
  })

  it('drops frames with version != 2', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const msg = JSON.parse(data.toString())
        if (msg.cmd === 'discover') {
          ws.send(JSON.stringify({ type: 'discovery', cameras: [{ id: 0, type: 'FAKE' }] }))
          // Send a v1 CHUN header-only frame — the manager must reject.
          ws.send(buildChunPacket(1), { binary: true })
        }
      })
    })

    mgr = new WebSocketManager(`ws://localhost:${port}`, 0)

    let frameSeen = false
    mgr.on('frame', () => {
      frameSeen = true
    })

    mgr.connect()
    await waitForEvent(mgr, 'cameras-discovered', 3000)

    // Give the bogus frame time to arrive and (not) propagate.
    await new Promise((r) => setTimeout(r, 200))

    expect(frameSeen).toBe(false)
  }, 10000)

  it('accepts frames with version 2 (header-only)', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const msg = JSON.parse(data.toString())
        if (msg.cmd === 'discover') {
          ws.send(JSON.stringify({ type: 'discovery', cameras: [{ id: 0, type: 'FAKE' }] }))
          ws.send(buildChunPacket(2), { binary: true })
        }
      })
    })

    mgr = new WebSocketManager(`ws://localhost:${port}`, 0)
    // Subscribe before `connect()` — the stub sends discovery JSON and the
    // CHUN packet back-to-back, and both are processed synchronously in Node.
    // If we awaited `cameras-discovered` first, the `frame` event would fire
    // before our listener was attached.
    const framePromise = waitForEvent(mgr, 'frame', 3000)
    mgr.connect()

    const frame = await framePromise
    expect(frame.isHeaderOnly).toBe(true)
    expect(frame.width).toBe(1456)
    expect(frame.height).toBe(1088)
    expect(frame.data.length).toBe(0)
  }, 10000)
})
