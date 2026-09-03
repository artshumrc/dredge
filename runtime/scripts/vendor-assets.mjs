// Build the browser library and vendor it into the Python package, so that
// `pip install dredge` ships the worker, client and wasm payloads and
// `dredge compile` can write them into a site with no Node toolchain present.
//
// Assets are stored brotli-compressed (quality 11): it keeps the wheel small,
// and the stored bytes double as the `.br` sidecar the CLI can install for
// hosts that serve precompressed responses.

import { constants, brotliCompressSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLibrary } from "./build-prod.mjs";
import { sourceFingerprint } from "./fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const vendorDir = resolve(root, "..", "src", "dredge", "vendor");
const runtimeDir = join(vendorDir, "runtime");

const TEXT_TYPES = new Set([".js", ".mjs", ".json", ".css"]);

function compress(name, bytes) {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: constants.BROTLI_MAX_WINDOW_BITS,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      [constants.BROTLI_PARAM_MODE]: TEXT_TYPES.has(extname(name))
        ? constants.BROTLI_MODE_TEXT
        : constants.BROTLI_MODE_GENERIC,
    },
  });
}

const buildDir = await mkdtemp(join(tmpdir(), "dredge-vendor-"));
try {
  await buildLibrary(buildDir);

  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });

  let raw = 0;
  let stored = 0;
  const rows = [];
  for (const name of (await readdir(buildDir)).sort()) {
    const bytes = await readFile(join(buildDir, name));
    const compressed = compress(name, bytes);
    await writeFile(join(runtimeDir, `${name}.br`), compressed);
    raw += bytes.length;
    stored += compressed.length;
    rows.push([name, bytes.length, compressed.length]);
  }

  // The generated client is expanded from this template at `dredge codegen`
  // time, so the package needs its own copy alongside the built assets.
  await writeFile(
    join(vendorDir, "client.template.ts"),
    await readFile(resolve(root, "src", "client.template.ts")),
  );

  // Records which runtime sources these assets were built from. A test compares
  // it against the working tree, so vendored assets cannot silently go stale
  // when someone edits runtime/src and forgets to re-run this script.
  const fingerprint = await sourceFingerprint(root);
  await writeFile(
    join(vendorDir, "sources.json"),
    JSON.stringify(fingerprint, null, 2) + "\n",
  );

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  for (const [name, from, to] of rows) {
    console.log(`  ${name.padEnd(38)} ${kb(from).padStart(10)} → ${kb(to).padStart(10)}`);
  }
  console.log(`  ${"total".padEnd(38)} ${kb(raw).padStart(10)} → ${kb(stored).padStart(10)}`);
  console.log(`vendored ${rows.length} runtime assets into ${runtimeDir}`);
} finally {
  await rm(buildDir, { recursive: true, force: true });
}
