import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliCompressSync, constants } from "node:zlib";

import { artifactMetrics } from "../scripts/artifact-metrics.mjs";

const q5Size = (value) =>
  brotliCompressSync(value, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
  }).byteLength;

test("Dredge benchmark build keeps the compiler's default Brotli quality", async () => {
  const buildScript = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(buildScript, /--brotli-quality/);
});

test("Dredge artifact metrics separate shipped q11 bytes from normalized q5 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dredge-artifact-metrics-"));
  try {
    const rawDatabase = Buffer.from("database row\n".repeat(2_000));
    const shippedDatabase = brotliCompressSync(rawDatabase, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    const runtime = Buffer.from("export const search = () => 'search';\n".repeat(50));
    await Promise.all([
      writeFile(join(root, "search.db"), rawDatabase),
      writeFile(join(root, "search.db.br"), shippedDatabase),
      writeFile(join(root, "dredge-client.js"), runtime),
      writeFile(join(root, "ignored.time.txt"), "not an artifact"),
    ]);

    const metrics = await artifactMetrics(root, "dredge");

    assert.deepEqual(metrics, {
      files: 2,
      shipped_bytes: shippedDatabase.byteLength + runtime.byteLength,
      normalized_brotli_q5_bytes: q5Size(rawDatabase) + q5Size(runtime),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
