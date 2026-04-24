# End-to-End Tests (web client)

Node.js test suite that imports the production `src/services/WebSocketManager.js`
**unchanged** and runs it against a live `camera_ws_server`. The browser
`WebSocket` API is stubbed with the [`ws`](https://www.npmjs.com/package/ws)
package; `WebSocketManager.js` has no other browser dependency.

This catches wire-protocol regressions between server and web client without
booting a browser or the Vue app.

## Layout

| File | Purpose |
|---|---|
| `setup.js` | Installs `globalThis.WebSocket`, helpers (`waitForEvent`, `collectFrames`, `disableReconnect`) |
| `websocket-manager.test.js` | Tests against a live server + real cameras |
| `protocol-rejection.test.js` | Unit-level: spins an in-process `ws` server, validates v1/v2 CHUN handling |

## Install

```bash
cd telefacet-web
npm install
```

## Run

The unit-level tests run anywhere:

```bash
npm run test:e2e -- protocol-rejection.test.js
```

The live-server tests need a Pi with IMX519s and a running `camera_ws_server`:

```bash
# on the Pi
./build/camera_ws_server &

# on the same host (or any machine with network access)
TELEFACET_WS_URL=ws://pi.local:9001 npm run test:e2e
```

Variables:

| Variable | Default | Notes |
|---|---|---|
| `TELEFACET_WS_URL` | `ws://localhost:9001` | WebSocket URL of the server |

## Why Node.js and not a headless browser?

`WebSocketManager.js` is a pure ES6 module that happens to use the global
`WebSocket` constructor. Stubbing that constructor with the `ws` package makes
the entire module runnable under Node, so we can exercise the full chunked
binary protocol without the overhead (and flakiness) of a browser. The Vue UI
layer is intentionally out of scope here — its components hold no
protocol-level logic.
