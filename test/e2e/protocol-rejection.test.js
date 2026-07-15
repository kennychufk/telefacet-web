// Unit-level test: WebSocketManager must reject CHUN frames whose version
// isn't 6, and must parse the v6 detection block (checkerboard corners or
// ArUco markers) selected by the header's detection_kind byte. We boot a tiny
// `ws` server in-process, send crafted CHUN packets, and assert on the emitted
// `frame` events.
//
// Unlike the live-server tests, this test doesn't need the Pi.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import { WebSocketManager } from '../../src/services/WebSocketManager.js'
import { disableReconnect, waitForEvent } from './setup.js'

function u32(view, offset, value) {
  view.setUint32(offset, value, true)
}

/**
 * Build a CHUN header-only packet with the given protocol version. When
 * `overrides.block` (a Uint8Array) is supplied it's appended right after the
 * 76-byte header as the detection block; set `overrides.detectionKind` and
 * `overrides.numCornerSets` to describe it (corner_block_size defaults to the
 * block's byte length).
 */
function buildChunPacket(version, overrides = {}) {
  const block = overrides.block ?? new Uint8Array(0)
  const buf = new ArrayBuffer(76 + block.byteLength)
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
  // timestamp_us (u64) @ 48, frame_duration_us @ 56 — left zero
  u32(view, 60, overrides.cornerBlockSize ?? block.byteLength) // corner_block_size
  view.setUint16(64, overrides.numCornerSets ?? 0, true)       // num_corner_sets
  // reserved @ 66 — zero
  // v5 focus metadata
  view.setFloat32(68, overrides.lensPosition ?? 0, true)
  view.setUint8(72, overrides.afState ?? 0xFF)
  // v6 detection_kind @ 73 (0=none, 1=checkerboard, 2=aruco)
  view.setUint8(73, overrides.detectionKind ?? 0)
  if (block.byteLength > 0) {
    new Uint8Array(buf, 76).set(block)
  }
  return buf
}

/** Serialize an aruco detection block: per marker, 8-byte MarkerSetHeader
 *  (int32 markerId, u8 quadrant, u8 flags, u16 numCorners) + numCorners×{f32,f32}. */
function buildMarkerBlock(markers) {
  let total = 0
  for (const m of markers) total += 8 + m.corners.length * 8
  const buf = new ArrayBuffer(total)
  const view = new DataView(buf)
  let off = 0
  for (const m of markers) {
    view.setInt32(off, m.markerId, true)
    view.setUint8(off + 4, m.quadrant ?? 0)
    view.setUint8(off + 5, m.flags ?? 0x01)
    view.setUint16(off + 6, m.corners.length, true)
    off += 8
    for (const c of m.corners) {
      view.setFloat32(off, c.x, true)
      view.setFloat32(off + 4, c.y, true)
      off += 8
    }
  }
  return new Uint8Array(buf)
}

/** Serialize a checkerboard detection block: per set, 4-byte CornerSetHeader
 *  (u8 setId, u8 flags, u16 numCorners) + numCorners×{f32,f32}. */
function buildCornerBlock(sets) {
  let total = 0
  for (const s of sets) total += 4 + s.corners.length * 8
  const buf = new ArrayBuffer(total)
  const view = new DataView(buf)
  let off = 0
  for (const s of sets) {
    view.setUint8(off, s.setId ?? 0)
    view.setUint8(off + 1, s.flags ?? 0x01)
    view.setUint16(off + 2, s.corners.length, true)
    off += 4
    for (const c of s.corners) {
      view.setFloat32(off, c.x, true)
      view.setFloat32(off + 4, c.y, true)
      off += 8
    }
  }
  return new Uint8Array(buf)
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

  it('drops frames with version != 6', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const msg = JSON.parse(data.toString())
        if (msg.cmd === 'discover') {
          ws.send(JSON.stringify({ type: 'discovery', cameras: [{ id: 0, type: 'FAKE' }] }))
          // Send a v5 CHUN header-only frame — the manager must reject it now.
          ws.send(buildChunPacket(5), { binary: true })
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

  it('accepts frames with version 6 (header-only) and parses focus metadata', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const msg = JSON.parse(data.toString())
        if (msg.cmd === 'discover') {
          ws.send(JSON.stringify({ type: 'discovery', cameras: [{ id: 0, type: 'FAKE' }] }))
          ws.send(buildChunPacket(6, { lensPosition: 4.5, afState: 2 }), { binary: true })
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
    expect(frame.lensPosition).toBeCloseTo(4.5, 5)
    expect(frame.afState).toBe(2)
    expect(frame.cornerSets).toEqual([])
    expect(frame.arucoSets).toEqual([])
  }, 10000)

  it('parses the v6 aruco marker block (detection_kind=2)', async () => {
    const markers = [
      { markerId: 7, quadrant: 0, corners: [
        { x: 10, y: 20 }, { x: 40, y: 22 }, { x: 42, y: 55 }, { x: 12, y: 53 } ] },
      // Negative id locks in signed getInt32 (guards against getUint32 regressions).
      { markerId: -3, quadrant: 3, corners: [
        { x: 100, y: 200 }, { x: 140, y: 202 }, { x: 142, y: 255 }, { x: 102, y: 253 } ] },
    ]
    const block = buildMarkerBlock(markers)

    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const msg = JSON.parse(data.toString())
        if (msg.cmd === 'discover') {
          ws.send(JSON.stringify({ type: 'discovery', cameras: [{ id: 0, type: 'FAKE' }] }))
          ws.send(buildChunPacket(6, { detectionKind: 2, numCornerSets: markers.length, block }),
                  { binary: true })
        }
      })
    })

    mgr = new WebSocketManager(`ws://localhost:${port}`, 0)
    const framePromise = waitForEvent(mgr, 'frame', 3000)
    mgr.connect()

    const frame = await framePromise
    expect(frame.cornerSets).toEqual([])
    expect(frame.arucoSets).toHaveLength(2)
    expect(frame.arucoSets[0].markerId).toBe(7)
    expect(frame.arucoSets[0].quadrant).toBe(0)
    expect(frame.arucoSets[0].corners).toHaveLength(4)
    expect(frame.arucoSets[0].corners[0]).toEqual({ x: 10, y: 20 })
    expect(frame.arucoSets[1].markerId).toBe(-3)
    expect(frame.arucoSets[1].quadrant).toBe(3)
    expect(frame.arucoSets[1].corners).toHaveLength(4)
  }, 10000)

  it('still parses the v6 checkerboard corner block (detection_kind=1)', async () => {
    const sets = [
      { setId: 0, corners: [ { x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 } ] },
    ]
    const block = buildCornerBlock(sets)

    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const msg = JSON.parse(data.toString())
        if (msg.cmd === 'discover') {
          ws.send(JSON.stringify({ type: 'discovery', cameras: [{ id: 0, type: 'FAKE' }] }))
          ws.send(buildChunPacket(6, { detectionKind: 1, numCornerSets: sets.length, block }),
                  { binary: true })
        }
      })
    })

    mgr = new WebSocketManager(`ws://localhost:${port}`, 0)
    const framePromise = waitForEvent(mgr, 'frame', 3000)
    mgr.connect()

    const frame = await framePromise
    expect(frame.arucoSets).toEqual([])
    expect(frame.cornerSets).toHaveLength(1)
    expect(frame.cornerSets[0].setId).toBe(0)
    expect(frame.cornerSets[0].corners).toHaveLength(3)
    expect(frame.cornerSets[0].corners[0]).toEqual({ x: 1, y: 2 })
  }, 10000)
})
