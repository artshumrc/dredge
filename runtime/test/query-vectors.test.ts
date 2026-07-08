import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildMatchExpression } from "../src/search";

// The single shared fixture (see tests/fixtures/query-vectors.json) is asserted
// identically by pytest (escape_fts_query) and here (buildMatchExpression), so
// any tokenization drift between the two implementations fails a test.
const vectorsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "fixtures",
  "query-vectors.json",
);

interface QueryVector {
  q: string;
  fts: string | null;
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as QueryVector[];

describe("buildMatchExpression shared vectors", () => {
  it("has a non-empty fixture", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(`matches vector ${JSON.stringify(vector.q)}`, () => {
      expect(buildMatchExpression(vector.q)).toBe(vector.fts);
    });
  }
});
