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
| `resource-guards.test.js` | Backlog budget, the `start_cameras` feasibility refusal, and the shape of coded `error` payloads |
| `store-lifecycle.test.js` | Drives the Pinia store rather than `WebSocketManager`: guards that a refused `start_cameras` is reported as failure instead of assumed success |
| `observer.test.js` | Commander + observer roles against one server: the `/observer` path, `code: "forbidden"` refusals, pushed `state` messages, a persistent subsampled observer subscription across the commander's stop/start, and `MultiServerManager` keeping write broadcasts away from observer servers. Sensor-aware (`TELEFACET_SENSOR` / `TELEFACET_WIDTH` / `TELEFACET_HEIGHT`). |

Hardware-free unit tests for the role plumbing (config `role`/`subsample`/`max_fps`,
`WebSocketManager.roleUrl`, observer reconnect policy, `start_stream` wire options)
live in `test/unit/roles.test.js` — `npm run test:unit`.

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

The live-server tests need a Pi with a running `camera_ws_server`. Everything
except `resource-guards` and `store-lifecycle` assumes an IMX519 rig at
1456x1088; those two take the sensor and geometry from the environment:

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
| `TELEFACET_SENSOR` | `imx519` | Sensor model to discover. Only `resource-guards` and `store-lifecycle` read it; the older files assume an imx519 rig. |
| `TELEFACET_WIDTH` / `TELEFACET_HEIGHT` | `1456` / `1088` | Resolution those two files configure. |

Against an imx708 Pi, for example:

```bash
TELEFACET_WS_URL=ws://192.168.5.249:9001 TELEFACET_SENSOR=imx708 \
  TELEFACET_WIDTH=4608 TELEFACET_HEIGHT=2592 \
  npx vitest run test/e2e/resource-guards.test.js test/e2e/store-lifecycle.test.js
```

## Why Node.js and not a headless browser?

`WebSocketManager.js` is a pure ES6 module that happens to use the global
`WebSocket` constructor. Stubbing that constructor with the `ws` package makes
the entire module runnable under Node, so we can exercise the full chunked
binary protocol without the overhead (and flakiness) of a browser. The Vue UI
layer is intentionally out of scope here — its components hold no
protocol-level logic.
