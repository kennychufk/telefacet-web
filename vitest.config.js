// vitest config — kept separate from vite.config.js so the dev/build server
// configuration stays untouched.
//
// `fileParallelism: false` forces the test runner to execute test files
// sequentially. The e2e tests under `test/e2e/` connect to a live
// `camera_ws_server`, which enforces a single concurrent client at the WS
// upgrade layer; running multiple test files in parallel causes spurious 503
// upgrade rejections. The unit-level `protocol-rejection.test.js` spins up
// its own in-process server on a random port and is unaffected, but
// serialising it costs only a few seconds and keeps the npm script simple.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
