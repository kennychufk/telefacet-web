# telefacet-web

Vue 3 + Vite multi-camera client for `cherupi-v4l2` camera servers (WebSocket
protocol v6): YUV420 frames over a chunked binary protocol, WebGL YUV→RGB
rendering, detection overlays, and a control panel for the camera lifecycle.

```bash
npm install
npm run dev        # http://localhost:5173 — drop a YAML config on the panel
npm run build
npm run test:unit  # no hardware
npm run test:e2e   # needs a live camera_ws_server (see test/e2e/README.md)
```

## Configuration

```yaml
servers:
  # A server this client commands (read-write; the default role).
  - address: ws://192.168.1.100:9001
    sensor: imx519
    width: 2328
    height: 1748
  # A server some other client commands, watched read-only as telemetry.
  # Observers subscribe to every camera automatically, wait for the commander
  # to start the cameras, and keep their subscription across its stop/start.
  - address: ws://192.168.1.101:9001
    role: observer
    subsample: 2      # 1/2/4/8 — quarter of the bytes at 2
    max_fps: 5        # 0 = uncapped
processing:           # applies to commander servers only
  mode: none
```

The server admits one **commander** and one **observer** connection at a time;
observers connect to its `/observer` path and are refused every command that
changes anything (`code: "forbidden"`). When both stream at once the server
gives the commander's frames priority. See `CLAUDE.md` for the architecture
and `../../cppWs/cherupi-v4l2/docs/websocket-protocol.md` for the protocol.

---

# Vue 3 + Vite

This template should help get you started developing with Vue 3 in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about IDE Support for Vue in the [Vue Docs Scaling up Guide](https://vuejs.org/guide/scaling-up/tooling.html#ide-support).
