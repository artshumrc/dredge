import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

import { benchmarkRoot, distRoot } from "./lib.mjs";

const output = resolve(distRoot, "runner");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [resolve(benchmarkRoot, "browser", "entry.js")],
  outdir: output,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  entryNames: "entry",
  chunkNames: "chunks/[name]-[hash]",
  minify: true,
});
await cp(resolve(benchmarkRoot, "browser", "index.html"), resolve(output, "index.html"));
