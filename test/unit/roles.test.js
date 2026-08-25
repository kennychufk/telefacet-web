// Unit-level checks for the client-role plumbing (protocol §1.1). No server,
// no hardware: pure functions of the config loader and the connection layer.

import { describe, expect, it } from 'vitest'

import { ConfigLoader } from '../../src/services/ConfigLoader.js'
import { ROLE_COMMANDER, ROLE_OBSERVER, WebSocketManager } from '../../src/services/WebSocketManager.js'

const loader = new ConfigLoader()

describe('ConfigLoader roles', () => {
  it('defaults every server to the commander role', () => {
    const cfg = loader.parseAndValidate('servers:\n  - address: ws://pi:9001\n')
    expect(cfg.servers[0].role).toBe('commander')
    expect(cfg.servers[0].subsample).toBe(1)
    expect(cfg.servers[0].max_fps).toBe(0)
  })

  it('accepts observer servers with stream options', () => {
    const cfg = loader.parseAndValidate(
      'servers:\n  - address: ws://pi:9001\n    role: observer\n    subsample: 4\n    max_fps: 2.5\n'
    )
    expect(cfg.servers[0].role).toBe('observer')
    expect(cfg.servers[0].subsample).toBe(4)
    expect(cfg.servers[0].max_fps).toBe(2.5)
  })

  it('rejects unknown roles and bad stream options', () => {
    expect(() => loader.parseAndValidate('servers:\n  - address: ws://pi:9001\n    role: viewer\n'))
      .toThrow(/role/)
    expect(() => loader.parseAndValidate('servers:\n  - address: ws://pi:9001\n    subsample: 3\n'))
      .toThrow(/subsample/)
    expect(() => loader.parseAndValidate('servers:\n  - address: ws://pi:9001\n    max_fps: -1\n'))
      .toThrow(/max_fps/)
  })
})

describe('WebSocketManager.roleUrl', () => {
  it('leaves the commander address untouched', () => {
    expect(WebSocketManager.roleUrl('ws://pi:9001', ROLE_COMMANDER)).toBe('ws://pi:9001')
    expect(WebSocketManager.roleUrl('ws://pi:9001/', ROLE_COMMANDER)).toBe('ws://pi:9001/')
  })

  it('routes observers to the /observer path', () => {
    expect(WebSocketManager.roleUrl('ws://pi:9001', ROLE_OBSERVER)).toBe('ws://pi:9001/observer')
    expect(WebSocketManager.roleUrl('ws://pi:9001/', ROLE_OBSERVER)).toBe('ws://pi:9001/observer')
    expect(WebSocketManager.roleUrl('wss://pi.example:9001/', ROLE_OBSERVER)).toBe('wss://pi.example:9001/observer')
  })
})

describe('WebSocketManager role options', () => {
  it('observers retry the initial connection without limit', () => {
    const observer = new WebSocketManager('ws://pi:9001', 0, { role: 'observer' })
    expect(observer.isObserver).toBe(true)
    expect(observer.retryInitialConnect).toBe(true)
    expect(observer.maxReconnectAttempts).toBe(Infinity)
    observer.disconnect()

    const commander = new WebSocketManager('ws://pi:9001', 1)
    expect(commander.isObserver).toBe(false)
    expect(commander.retryInitialConnect).toBe(false)
    expect(commander.maxReconnectAttempts).toBe(10)
    commander.disconnect()
  })

  it('only puts non-default stream options on the wire', () => {
    const sent = []
    const m = new WebSocketManager('ws://pi:9001', 0, { subsample: 2, maxFps: 5 })
    m.send = (command) => { sent.push(command); return true }
    m.startStream(3)
    m.startStream(4, { subsample: 1, maxFps: 0 })
    m.startStream(5, { maxFps: 1 })
    expect(sent).toEqual([
      { cmd: 'start_stream', camera_id: 3, subsample: 2, max_fps: 5 },
      { cmd: 'start_stream', camera_id: 4 },
      { cmd: 'start_stream', camera_id: 5, subsample: 2, max_fps: 1 },
    ])
    expect(m.isStreaming(3)).toBe(true)
    m.disconnect()
  })
})
