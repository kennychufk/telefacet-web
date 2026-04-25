// Vitest setup file: make the production WebSocketManager.js runnable under
// Node by installing the npm `ws` package as `globalThis.WebSocket`. The
// `ws` package's WebSocket class is API-compatible with the browser builtin.
//
// On Node ≥ 22 the runtime ships an undici-backed WebSocket global, so we
// only install the `ws` shim if nothing is there yet — disconnect.test.js
// opts back into the `ws` implementation locally because it needs
// `terminate()` for abrupt-close, which undici doesn't expose.

import { WebSocket } from 'ws'

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket
}

/**
 * Resolve on the next occurrence of `eventName`, or reject on timeout.
 * Listener is cleaned up in either path.
 */
export function waitForEvent(emitter, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent)
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for '${eventName}'`))
    }, timeoutMs)
    const onEvent = (payload) => {
      clearTimeout(timer)
      resolve(payload)
    }
    emitter.once(eventName, onEvent)
  })
}

/**
 * Wait for one emission of `eventName` that satisfies the predicate.
 * Intermediate emissions are ignored.
 */
export function waitForEventMatching(emitter, eventName, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent)
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for '${eventName}' matching predicate`))
    }, timeoutMs)
    const onEvent = (payload) => {
      if (predicate(payload)) {
        clearTimeout(timer)
        emitter.off(eventName, onEvent)
        resolve(payload)
      }
    }
    emitter.on(eventName, onEvent)
  })
}

/**
 * Collect up to `count` frames from the manager, or timeout.
 */
export async function collectFrames(manager, count, timeoutMs = 10000) {
  const frames = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off('frame', onFrame)
      reject(new Error(`Only collected ${frames.length}/${count} frames in ${timeoutMs}ms`))
    }, timeoutMs)
    const onFrame = (frame) => {
      frames.push(frame)
      if (frames.length >= count) {
        clearTimeout(timer)
        manager.off('frame', onFrame)
        resolve(frames)
      }
    }
    manager.on('frame', onFrame)
  })
}

/**
 * Prevent auto-reconnect during teardown — setting max attempts to 0 makes
 * handleReconnect() give up immediately if close() happens to trigger it.
 */
export function disableReconnect(manager) {
  manager.maxReconnectAttempts = 0
  manager.reconnectAttempts = Infinity
}

/**
 * Drop the underlying TCP socket without sending a WebSocket close frame.
 * Server observes WS close code 1006 (abnormal closure) — used to simulate
 * a client crash / network drop mid-session.
 *
 * NOTE: Auto-reconnect must be disabled first; otherwise the manager will
 * race to grab the slot back as soon as the server releases it.
 */
export function abruptClose(manager) {
  if (manager.ws) {
    // ws@8 exposes terminate(); falls back to destroying the underlying
    // socket if for some reason terminate is unavailable.
    if (typeof manager.ws.terminate === 'function') {
      manager.ws.terminate()
    } else if (manager.ws._socket) {
      manager.ws._socket.destroy()
    }
  }
}

/**
 * Wait until `predicate()` returns truthy or `timeoutMs` elapses.
 * Polls every 50 ms. Used to wait for server-side state changes that aren't
 * surfaced as events (e.g. the client slot freeing after a remote close).
 */
export async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`waitUntil: predicate not satisfied within ${timeoutMs}ms`)
}
