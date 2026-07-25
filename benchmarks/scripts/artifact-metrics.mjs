import { createReadStream } from "node:fs";
import { createBrotliCompress, constants } from "node:zlib";

import { walkFiles } from "./lib.mjs";

const BROTLI_QUALITY = 5;

export async function compressedSize(path) {
  return new Promise((resolveSize, reject) => {
    let bytes = 0;
    const compressor = createBrotliCompress({
      params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    });
    createReadStream(path)
      .on("error", reject)
      .pipe(compressor)
      .on("data", (chunk) => {
        bytes += chunk.length;
      })
      .on("error", reject)
      .on("end", () => resolveSize(bytes));
  });
}

async function compressedTotal(files) {
  let nextFile = 0;
  const subtotals = await Promise.all(
    Array.from({ length: Math.min(16, files.length) }, async () => {
      let subtotal = 0;
      while (nextFile < files.length) subtotal += await compressedSize(files[nextFile++].path);
      return subtotal;
    }),
  );
  return subtotals.reduce((total, subtotal) => total + subtotal, 0);
}

export async function artifactMetrics(path, engine) {
  const files = (await walkFiles(path)).filter(({ path: file }) => !file.endsWith(".time.txt"));
  const shippedFiles = files.filter(({ path: file }) => !(engine === "dredge" && file.endsWith(".db")));

  // Normalize Dredge from its product-default q11 artifact back to the raw
  // database, then apply the same q5 compressor used for every other file.
  const normalizedFiles = engine === "dredge"
    ? files.filter(({ path: file }) => !file.endsWith(".db.br"))
    : shippedFiles;

  return {
    files: shippedFiles.length,
    shipped_bytes: shippedFiles.reduce((total, file) => total + file.bytes, 0),
    normalized_brotli_q5_bytes: await compressedTotal(normalizedFiles),
  };
}
