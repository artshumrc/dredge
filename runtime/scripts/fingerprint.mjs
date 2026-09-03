// The identity of the runtime sources a vendored build was produced from.
//
// Both this script and tests/test_compiler.py compute it, so the algorithm is
// fixed: sha256 over "<relpath>\0<sha256 of file bytes>\n" for each input path
// in sorted order. Inputs are everything that can change the emitted bundles —
// the TypeScript sources, the production build script, and the dependency
// versions pinned by the manifest and lockfile.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

const EXTRA_INPUTS = ["scripts/build-prod.mjs", "package.json", "pnpm-lock.yaml"];

async function typescriptSources(root) {
  const srcDir = join(root, "src");
  const names = (await readdir(srcDir)).filter((name) => name.endsWith(".ts")).sort();
  return names.map((name) => posix.join("src", name));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @param {string} root the runtime workspace directory
 * @returns {Promise<{algorithm: string, inputs: string[], hash: string}>}
 */
export async function sourceFingerprint(root) {
  const inputs = [...(await typescriptSources(root)), ...EXTRA_INPUTS].sort();
  const digest = createHash("sha256");
  for (const input of inputs) {
    const bytes = await readFile(join(root, input));
    digest.update(`${input}\0${sha256(bytes)}\n`);
  }
  return { algorithm: "sha256-of-path-and-content", inputs, hash: digest.digest("hex") };
}
