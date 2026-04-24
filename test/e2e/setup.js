// Vitest setup file: make the production WebSocketManager.js runnable under
// Node by installing the npm `ws` package as `globalThis.WebSocket`. The
// `ws` package's WebSocket class is API-compatible with the browser builtin.

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
