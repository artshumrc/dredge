import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildMatchExpression } from "../src/search";

// The golden fixture (see tests/fixtures/query-vectors.json) pins the shape of
// every emitted match expression. This is the one place an expression is
// asserted as a string; reader-facing semantics are asserted as documents
// returned in search.test.ts.
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
  // Query-time corrections for words the index does not hold, as the search
  // engine would have computed them from the vocabulary. Eligibility is decided
  // there; here the lookup is a stub pinning the emitted alternation.
  corrections?: Record<string, string[]>;
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as QueryVector[];

describe("buildMatchExpression shared vectors", () => {
  it("has a non-empty fixture", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(`matches vector ${JSON.stringify(vector.q)}`, () => {
      const correct = vector.corrections
        ? (term: string) => vector.corrections![term]
        : undefined;
      expect(buildMatchExpression(vector.q, undefined, undefined, correct)).toBe(vector.fts);
    });
  }
});
