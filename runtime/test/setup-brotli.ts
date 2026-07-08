// Test setup: make the decode-only brotli wasm usable under Node.
//
// `brotli-dec-wasm` is a `wasm-pack -t web` build: its default export lazily
// fetches `brotli_dec_wasm_bg.wasm` via `new URL(..., import.meta.url)`, which
// Node's fetch cannot resolve (file:// is unsupported). The package also exposes
// a synchronous `initSync(bytes)` on the same underlying module singleton, so if
// we initialize it here — before any `import("brotli-dec-wasm")` runs the fetch
// path — the default-export promise resolves against the already-initialized
// module and `decompress()` works in-process. In a real browser worker the
// production fetch path is used instead; this only bridges the Node test env.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { initSync } from "brotli-dec-wasm/web";

const wasmPath = fileURLToPath(
  new URL("../node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm", import.meta.url),
);
initSync({ module: readFileSync(wasmPath) });
