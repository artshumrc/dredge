import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliCompressSync, constants } from "node:zlib";

import { acceptsBrotli, startStaticServer } from "../scripts/static-server.mjs";

const q5 = (value) =>
  brotliCompressSync(value, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
  });

test("Brotli negotiation honors explicit quality values", () => {
  assert.equal(acceptsBrotli("gzip, deflate, br"), true);
  assert.equal(acceptsBrotli("gzip, br;q=0, *;q=1"), false);
  assert.equal(acceptsBrotli("gzip, *;q=0.5"), true);
  assert.equal(acceptsBrotli(undefined), false);
});

test("static server compresses ordinary files and preserves intrinsic .br files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dredge-static-server-"));
  const artifact = join(root, "artifacts");
  await mkdir(artifact);
  const javascript = Buffer.from("export const value = 'production transfer';\n".repeat(100));
  const database = q5(Buffer.from("database page\n".repeat(1_000)));
  await Promise.all([
    writeFile(join(artifact, "app.js"), javascript),
    writeFile(join(artifact, "search.db.br"), database),
  ]);

  const { server, origin, state } = await startStaticServer(root, { precompressPaths: [artifact] });
  try {
    let before = state.bytesServed;
    const compressed = await fetch(`${origin}/artifacts/app.js`, {
      headers: { "accept-encoding": "br" },
    });
    assert.equal(compressed.headers.get("content-encoding"), "br");
    assert.equal(compressed.headers.get("vary"), "Accept-Encoding");
    assert.equal(await compressed.text(), javascript.toString());
    assert.equal(state.bytesServed - before, q5(javascript).byteLength);
    assert.equal(state.dynamicCompressions, 0);

    before = state.bytesServed;
    const raw = await fetch(`${origin}/artifacts/app.js`, {
      headers: { "accept-encoding": "br;q=0" },
    });
    assert.equal(raw.headers.get("content-encoding"), null);
    assert.equal(Number(raw.headers.get("content-length")), javascript.byteLength);
    assert.equal(await raw.text(), javascript.toString());
    assert.equal(state.bytesServed - before, javascript.byteLength);

    before = state.bytesServed;
    const precompressed = await fetch(`${origin}/artifacts/search.db.br`, {
      headers: { "accept-encoding": "br" },
    });
    assert.equal(precompressed.headers.get("content-encoding"), null);
    assert.deepEqual(Buffer.from(await precompressed.arrayBuffer()), database);
    assert.equal(state.bytesServed - before, database.byteLength);
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
