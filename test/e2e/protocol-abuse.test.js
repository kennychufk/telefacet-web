// Protocol-level abuse: malformed inputs, wrong opcodes, pipelining,
// out-of-range configure values.
//
// These tests do not exercise the camera state machine — they exercise the
// server's robustness when the client violates protocol expectations. The
// contract is: respond with `{"type":"error", ...}` and keep the connection
// alive. The server must never crash.
//
// We bypass WebSocketManager's typed command methods and write directly to
// the underlying socket so we can craft inputs the manager would never send
// (binary frames, malformed JSON, non-string `cmd`, etc).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WebSocketManager } from '../../src/services/WebSocketManager.js'
import { disableReconnect, waitForEvent } from './setup.js'

const WS_URL = process.env.TELEFACET_WS_URL || 'ws://localhost:9001'

/** Send a string straight down the WS without going through manager methods. */
function sendRawText(mgr, text) {
  mgr.ws.send(text)
}

/** Send a binary buffer (rejected by the server — text-only command channel). */
function sendRawBinary(mgr, bytes) {
  mgr.ws.send(Buffer.from(bytes))
}

/**
 * Capture the next N text messages the server emits, in arrival order, as
 * decoded JSON. WebSocketManager classifies them into 'discovery' / 'status'
 * / 'server-error' events; we listen on all three.
 */
function captureNext(mgr, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const seen = []
    const t = setTimeout(() => {
      detach()
      reject(new Error(`Captured ${seen.length}/${count} messages in ${timeoutMs}ms`))
    }, timeoutMs)
    const onDisc = (p) => {
      seen.push({ type: 'discovery', cameras: p.cameras })
      check()
    }
    const onStatus = (p) => {
      seen.push({ type: 'status', message: p.message, data: p.data })
      check()
    }
    const onErr = (p) => {
      seen.push({ type: 'error', message: p.message })
      check()
    }
    const detach = () => {
      mgr.off('cameras-discovered', onDisc)
      mgr.off('status', onStatus)
      mgr.off('server-error', onErr)
    }
    const check = () => {
      if (seen.length >= count) {
        clearTimeout(t)
        detach()
        resolve(seen)
      }
    }
    mgr.on('cameras-discovered', onDisc)
    mgr.on('status', onStatus)
    mgr.on('server-error', onErr)
  })
}

describe('Protocol abuse', () => {
  /** @type {WebSocketManager} */
  let mgr

  beforeEach(async () => {
    mgr = new WebSocketManager(WS_URL, 0)
    disableReconnect(mgr)
    const connected = waitForEvent(mgr, 'connected', 5000)
    mgr.connect()
    await connected
    // Drain the auto-discovery that fires on connect.
    await waitForEvent(mgr, 'cameras-discovered', 5000)
  })

  afterEach(async () => {
    if (!mgr) return
    try {
      mgr.setHeaderOnlyMode(false)
      mgr.stopCameras()
      mgr.unconfigure()
      mgr.setSaveMode('none')
      await new Promise((r) => setTimeout(r, 500))
    } catch (_) { /* ignore */ }
    mgr.disconnect()
  })

  // --- malformed messages --------------------------------------------------

  it('returns an error for a binary frame from the client', async () => {
    const errP = waitForEvent(mgr, 'server-error', 3000)
    sendRawBinary(mgr, [0x00, 0x01, 0x02, 0x03])
    await errP

    // Connection must still work after the error.
    const discP = waitForEvent(mgr, 'cameras-discovered', 3000)
    mgr.discoverCameras()
    await discP
  }, 10000)

  it('returns an error for empty JSON', async () => {
    const errP = waitForEvent(mgr, 'server-error', 3000)
    sendRawText(mgr, '{}')
    await errP
  }, 10000)

  it('returns an error for non-string cmd', async () => {
    const errP = waitForEvent(mgr, 'server-error', 3000)
    sendRawText(mgr, JSON.stringify({ cmd: 42 }))
    await errP
  }, 10000)

  it('returns an error for null cmd', async () => {
    const errP = waitForEvent(mgr, 'server-error', 3000)
    sendRawText(mgr, JSON.stringify({ cmd: null }))
    await errP
  }, 10000)

  it('returns an error for a JSON array payload', async () => {
    const errP = waitForEvent(mgr, 'server-error', 3000)
    sendRawText(mgr, '[1,2,3]')
    await errP

    // Connection still healthy.
    const discP = waitForEvent(mgr, 'cameras-discovered', 3000)
    mgr.discoverCameras()
    await discP
  }, 10000)

  // --- pipelining ----------------------------------------------------------

  it('processes pipelined commands in order', async () => {
    // Three back-to-back sends, no awaits between. The uWS handler is
    // single-threaded so per-command ordering is guaranteed by the server.
    const cap = captureNext(mgr, 3, 5000)
    sendRawText(mgr, JSON.stringify({ cmd: 'discover' }))
    sendRawText(mgr, JSON.stringify({ cmd: 'reset_frame_counts' }))
    sendRawText(mgr, JSON.stringify({ cmd: 'set_header_only', enabled: false }))
    const [r1, r2, r3] = await cap
    expect(r1.type).toBe('discovery')
    expect(r2.type).toBe('status')
    expect(r3.type).toBe('status')
  }, 10000)

  it('processes pipelined valid + invalid commands', async () => {
    const cap = captureNext(mgr, 2, 5000)
    sendRawText(mgr, JSON.stringify({ cmd: 'discover' }))
    sendRawText(mgr, 'not json at all')
    const [r1, r2] = await cap
    expect(r1.type).toBe('discovery')
    expect(r2.type).toBe('error')
  }, 10000)

  // --- configure out-of-range ---------------------------------------------
  //
  // Contract: the server should *not* clamp or pre-validate dimensions. It
  // passes them to libcamera, which either coerces (CameraConfiguration::
  // validate adjusts to a supported mode) or returns an error that the
  // server surfaces. Either outcome is acceptable. The only thing we forbid
  // is a server crash — verified by issuing a fresh discover afterwards.

  /**
   * Send a configure with `params`, await either a status or server-error
   * (whichever comes first), and then verify the connection is still alive.
   */
  async function configureAndProbe(params) {
    const settled = new Promise((resolve) => {
      const onStatus = (p) => { cleanup(); resolve({ kind: 'status', p }) }
      const onErr = (p) => { cleanup(); resolve({ kind: 'error', p }) }
      const cleanup = () => {
        mgr.off('status', onStatus)
        mgr.off('server-error', onErr)
      }
      mgr.once('status', onStatus)
      mgr.once('server-error', onErr)
    })
    sendRawText(mgr, JSON.stringify({ cmd: 'configure', params }))
    const result = await settled
    // If we accidentally entered CONFIGURED, walk back so afterEach is happy.
    if (result.kind === 'status') {
      const back = waitForEvent(mgr, 'status', 5000).catch(() => {})
      mgr.unconfigure()
      await back
    }
    // Sentinel: server is still alive.
    const discP = waitForEvent(mgr, 'cameras-discovered', 3000)
    mgr.discoverCameras()
    await discP
  }

  it('does not crash on configure with width=0, height=0', async () => {
    await configureAndProbe({ width: 0, height: 0 })
  }, 15000)

  it('does not crash on configure with negative dimensions', async () => {
    // -1 over the wire becomes uint32 wrap-around (4294967295) in the server.
    await configureAndProbe({ width: -1, height: -1 })
  }, 15000)

  it('does not crash on absurdly large dimensions', async () => {
    await configureAndProbe({ width: 99999, height: 99999 })
  }, 15000)

  it('silently ignores extra unknown fields under params', async () => {
    const okP = waitForEvent(mgr, 'status', 5000)
    sendRawText(mgr, JSON.stringify({
      cmd: 'configure',
      params: {
        width: 1456,
        height: 1088,
        future_param: true,
        nested: { a: 1, b: [2, 3] },
      },
    }))
    await okP
    // afterEach will unconfigure.
  }, 15000)
})
