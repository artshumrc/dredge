// Production build for the standalone Dredge browser library.
//
// Emits self-contained, framework-free assets into an output directory:
//   dredge-worker.js   – the search Web Worker (+ co-located sqlite/brotli wasm
//                        and the nested OPFS proxy worker chunk)
//   dredge-client.js   – ESM bundle exporting DredgeSearchClient
//
// A relative base ("./") makes the worker's `new URL(asset, import.meta.url)`
// lookups resolve next to wherever the worker is served, so the whole folder
// can be dropped under any path (the CLI installs it at <output_dir>/).

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// The package's own entry point (`index.mjs`) also imports the worker1 promiser,
// which spawns sqlite3-worker1-bundler-friendly.mjs as a nested worker and drags
// a second ~850 KB copy of sqlite3.wasm into the output. We only ever call
// sqlite3InitModule directly, so resolve straight to the module that provides it.
// The package's exports map does not expose this subpath, hence the alias.
const sqliteRoot = dirname(fileURLToPath(import.meta.resolve("@sqlite.org/sqlite-wasm/package.json")));
const sqliteEntry = join(sqliteRoot, "sqlite-wasm/jswasm/sqlite3-bundler-friendly.mjs");

const shared = {
  root,
  base: "./",
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  resolve: { alias: { "@sqlite.org/sqlite-wasm": sqliteEntry } },
};

// Content-hashed names for everything the entries pull in, so a host can serve
// them immutable; the two entry points keep stable names because the generated
// client and the site's HTML reference them by path.
//
// Every emitted file carries the `dredge-` prefix, which is what makes the
// installed set self-identifying: on reinstall the CLI can retire a previous
// version's hashed files (see runtime_assets.py) without a receipt, and without
// ever touching the `search.*` database artifacts sharing the directory.
const output = {
  format: "es",
  chunkFileNames: "dredge-[name]-[hash].js",
  assetFileNames: "dredge-[name]-[hash][extname]",
};

/**
 * Build the Dredge browser library (worker + client) into `outDir`.
 * @param {string} outDir absolute output directory
 */
export async function buildLibrary(outDir) {
  // 1. Worker bundle (side-effect entry; brings in sqlite + brotli wasm assets).
  await build({
    ...shared,
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      minify: true,
      sourcemap: false,
      // Flat output: every asset sits next to the worker that resolves it.
      assetsDir: ".",
      rollupOptions: {
        input: resolve(root, "src/search-worker.ts"),
        output: { ...output, entryFileNames: "dredge-worker.js" },
      },
    },
    // Nested workers (sqlite's OPFS async proxy) are emitted as entries of the
    // worker build, so they need the prefix applied there too.
    worker: {
      format: "es",
      rollupOptions: {
        output: { ...output, entryFileNames: "dredge-[name]-[hash].js" },
      },
    },
  });

  // 2. Client bundle (library entry; exports DredgeSearchClient). lib mode keeps
  //    the exports intact and never pulls in the worker/sqlite code.
  await build({
    ...shared,
    build: {
      outDir,
      emptyOutDir: false,
      target: "es2022",
      minify: true,
      sourcemap: false,
      lib: {
        entry: resolve(root, "src/client.ts"),
        formats: ["es"],
        fileName: () => "dredge-client.js",
      },
    },
  });

  return outDir;
}

// Run directly: build into dist-prod/search for local inspection.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await buildLibrary(resolve(root, "dist-prod/search"));
  console.log(`dredge library built into ${out}`);
}
