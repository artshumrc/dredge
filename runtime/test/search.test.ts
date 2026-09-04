import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { Exec } from "../src/db";
import {
  clearConnectionCaches,
  closeDatabase,
  setConnectionCacheClearer,
  setSessionCacheClearer,
  toDredgeError,
  validateManifest,
  verifyDatabaseHash,
} from "../src/db";
import type {
  DredgeHit,
  DredgeSearchRequest,
  DredgeSearchResponse,
  SchemaInfo,
} from "../src/search";
import { createSearchSession, introspectSchema, search, suggest } from "../src/search";
import { makeNodeSqliteExec } from "./node-sqlite-exec";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");

interface FixtureManifest {
  manifest_version: number;
  db_schema_version: number;
  db_file: string;
  db_sha256: string;
  db_bytes: number;
  db_compressed_bytes: number;
  db_compression: string;
  sqlite_page_size: number;
  page_count: number;
  config_hash: string;
  runtime_min_version: string;
}

function fixtureManifest(): FixtureManifest {
  const manifestPath = join(fixtureRoot, "search", "search-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "Fixture database is missing; run `pnpm fixture` in runtime/ before `pnpm test`.",
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest;
}

function fixtureDbPath(): string {
  const manifest = fixtureManifest();
  const dbFile = manifest.db_file.endsWith(".br")
    ? manifest.db_file.slice(0, -".br".length)
    : manifest.db_file;
  const dbPath = join(fixtureRoot, "search", dbFile);
  if (!existsSync(dbPath)) {
    throw new Error(
      `Fixture database is missing at ${dbPath}; run \`pnpm fixture\` in runtime/ before \`pnpm test\`.`,
    );
  }
  return dbPath;
}

// Open the compiled fixture database, run `body` against a live Exec, and close
// it. The fixture is immutable, so every case is independent.
function withFixture(
  body: (exec: ReturnType<typeof makeNodeSqliteExec>, schema: SchemaInfo) => void,
): void {
  const db = new DatabaseSync(fixtureDbPath());
  try {
    const exec = makeNodeSqliteExec(db);
    body(exec, introspectSchema(exec));
  } finally {
    db.close();
  }
}

describe("runtime search fixture", () => {
  it("searches a compiler-built fixture database through the Exec seam", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      const response = search(exec, schema, { query: "uid50", limit: 5, includeFacets: true });

      expect(response.total).toBe(1);
      expect(response.hits.map((hit) => hit.title)).toEqual(["Royal Mask 50"]);
      expect(response.hits[0].image).toBe("/images/50.jpg");
      expect(Object.keys(response.facets ?? {})).toContain("category");
      expect(Object.keys(response.facets ?? {})).not.toContain("image");
    } finally {
      db.close();
    }
  });

  it("evaluates the FTS match exactly once per request with facets requested", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const base = makeNodeSqliteExec(db);
      let matchExecutions = 0;
      const exec: typeof base = (sql, bind) => {
        if (/documents_fts\s+match/i.test(sql)) {
          matchExecutions += 1;
        }
        return base(sql, bind);
      };
      const schema = introspectSchema(exec);

      search(exec, schema, { query: "temple", limit: 5, includeFacets: true });

      expect(matchExecutions).toBe(1);
    } finally {
      db.close();
    }
  });

  it("prefix-matches only the final term of a multi-word query", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // "temp" is a strict prefix of the indexed word "temple" but is not itself
      // an indexed term. As the final term it prefix-matches the temple docs; as
      // a non-final term it is exact and matches none of them, so the same
      // two-word query no longer finds them once "temp" leads.
      const finalPrefix = search(exec, schema, { query: "stone temp", limit: 0 });
      const leadingPrefix = search(exec, schema, { query: "temp stone", limit: 0 });

      expect(finalPrefix.total).toBeGreaterThan(0);
      expect(leadingPrefix.total).toBe(0);

      // The same word alone still prefix-matches (single term is always final),
      // so the drop is the non-final position, not the word.
      const alone = search(exec, schema, { query: "temp", limit: 0 });
      expect(alone.total).toBe(finalPrefix.total);
    } finally {
      db.close();
    }
  });

  it("matches a quoted phrase only where the words are adjacent", () => {
    withFixture((exec, schema) => {
      // Both words are common in the synthetic bodies, so nearly every document
      // holds each of them somewhere; only a fraction have them side by side.
      const loose = search(exec, schema, { query: "image temple", limit: 0 });
      const phrase = search(exec, schema, { query: '"image temple"', limit: 0 });

      expect(loose.total).toBe(49);
      expect(phrase.total).toBe(13);

      const phraseIds = new Set(
        search(exec, schema, { query: '"image temple"', limit: 1000 }).hits.map((hit) => hit.id),
      );
      const looseIds = search(exec, schema, { query: "image temple", limit: 1000 }).hits.map(
        (hit) => hit.id,
      );
      for (const id of phraseIds) {
        expect(looseIds).toContain(id);
      }
    });
  });

  it("removes the excluded term's documents with a leading minus", () => {
    withFixture((exec, schema) => {
      const all = search(exec, schema, { query: "temple", limit: 1000 });
      const excluded = search(exec, schema, { query: "sarcophagus", limit: 1000 });
      const kept = search(exec, schema, { query: "temple -sarcophagus", limit: 1000 });

      expect(kept.total).toBe(22);
      const excludedIds = new Set(excluded.hits.map((hit) => hit.id));
      const keptIds = kept.hits.map((hit) => hit.id);
      for (const id of keptIds) {
        expect(excludedIds.has(id)).toBe(false);
      }
      expect(kept.total).toBe(all.total - all.hits.filter((h) => excludedIds.has(h.id)).length);
    });
  });

  it("returns the union of both alternatives for OR", () => {
    withFixture((exec, schema) => {
      const left = search(exec, schema, { query: "obelisk", limit: 1000 });
      const right = search(exec, schema, { query: "cartouche", limit: 1000 });
      const union = search(exec, schema, { query: "obelisk OR cartouche", limit: 1000 });

      const expected = new Set([
        ...left.hits.map((hit) => hit.id),
        ...right.hits.map((hit) => hit.id),
      ]);
      expect(union.total).toBe(expected.size);
      expect(new Set(union.hits.map((hit) => hit.id))).toEqual(expected);
    });
  });

  it("restricts a field-scoped term to that column", () => {
    withFixture((exec, schema) => {
      const anywhere = search(exec, schema, { query: "temple", limit: 1000 });
      const titled = search(exec, schema, { query: "title:temple", limit: 1000 });

      expect(anywhere.total).toBe(49);
      expect(titled.total).toBe(6);
      for (const hit of titled.hits) {
        expect(String(hit.title)).toContain("Temple");
      }
      // Every body-only mention is dropped, so the scoped result is a strict
      // subset of the unscoped one.
      const anywhereIds = new Set(anywhere.hits.map((hit) => hit.id));
      for (const hit of titled.hits) {
        expect(anywhereIds.has(hit.id)).toBe(true);
      }
    });
  });

  it("requires NEAR operands to appear within the given distance", () => {
    withFixture((exec, schema) => {
      const both = search(exec, schema, { query: "stone temple", limit: 0 });
      const near = search(exec, schema, { query: "near(stone temple, 3)", limit: 0 });

      expect(both.total).toBe(49);
      expect(near.total).toBe(46);
      expect(near.total).toBeLessThan(both.total);
    });
  });

  it("combines scoping, exclusion and alternatives in one query", () => {
    withFixture((exec, schema) => {
      const combined = search(exec, schema, {
        query: "title:temple -sarcophagus OR cartouche",
        limit: 1000,
      });
      const titled = new Set(
        search(exec, schema, { query: "title:temple", limit: 1000 }).hits.map((hit) => hit.id),
      );
      const sarcophagus = new Set(
        search(exec, schema, { query: "sarcophagus", limit: 1000 }).hits.map((hit) => hit.id),
      );
      const cartouche = new Set(
        search(exec, schema, { query: "cartouche", limit: 1000 }).hits.map((hit) => hit.id),
      );

      // AND binds tighter than OR, so this reads (title:temple NOT sarcophagus)
      // OR cartouche.
      const expected = new Set(
        [...titled].filter((id) => !sarcophagus.has(id)).concat([...cartouche]),
      );
      expect(new Set(combined.hits.map((hit) => hit.id))).toEqual(expected);
      expect(combined.total).toBe(expected.size);
    });
  });

  it("degrades a malformed query to its terms instead of throwing", () => {
    withFixture((exec, schema) => {
      const plain = search(exec, schema, { query: "temple stone", limit: 0 });
      for (const malformed of ['"temple stone', "temple (stone", "temple stone)"]) {
        const response = search(exec, schema, { query: malformed, limit: 0 });
        expect(response.total).toBe(plain.total);
      }
      expect(plain.total).toBeGreaterThan(0);
    });
  });

  it("reads each Search Column and its bm25 weight from the artifact", () => {
    withFixture((_exec, schema) => {
      // The fixture config names `catalog` and weights it above title; title and
      // body keep the compiler's defaults. Nothing in the runtime knows these
      // numbers — they are read out of the compiled database.
      expect(schema.searchColumns).toEqual([
        { name: "title", weight: 10 },
        { name: "body", weight: 1 },
        { name: "catalog", weight: 30 },
      ]);
    });
  });

  it("ranks a term in a heavy Search Column above the same term in a light one", () => {
    withFixture((exec, schema) => {
      // `ledger` is the catalog value of one page and a body word of the other.
      const ranked = search(exec, schema, { query: "ledger", limit: 10 });
      expect(ranked.total).toBe(2);
      expect(ranked.hits.map((hit) => hit.title)).toEqual([
        "Storeroom Inventory",
        "Field Diary",
      ]);

      // Same index, same query, only the weight the artifact declared for the
      // catalog column changed: the order follows it, so the weight bm25 sees
      // is the artifact's rather than a constant.
      const lightened: SchemaInfo = {
        ...schema,
        searchColumns: schema.searchColumns.map((column) =>
          column.name === "catalog" ? { ...column, weight: 0.01 } : column,
        ),
      };
      const flipped = search(exec, lightened, { query: "ledger", limit: 10 });
      expect(flipped.hits.map((hit) => hit.title)).toEqual([
        "Field Diary",
        "Storeroom Inventory",
      ]);
    });
  });

  it("scopes a field term to the maintainer's own Search Column", () => {
    withFixture((exec, schema) => {
      const anywhere = search(exec, schema, { query: "ledger", limit: 10 });
      const scoped = search(exec, schema, { query: "catalog:ledger", limit: 10 });

      expect(anywhere.total).toBe(2);
      expect(scoped.total).toBe(1);
      expect(scoped.hits.map((hit) => hit.title)).toEqual(["Storeroom Inventory"]);
    });
  });

  it("degrades an unknown field name to its terms instead of throwing", () => {
    withFixture((exec, schema) => {
      // `image` is a Store Field, not a Search Column, so the scope cannot be
      // honoured; the query reads as the two words the reader typed.
      const plain = search(exec, schema, { query: "image temple", limit: 0 });
      const unknown = search(exec, schema, { query: "image:temple", limit: 0 });

      expect(plain.total).toBe(49);
      expect(unknown.total).toBe(plain.total);
    });
  });

  it("keeps scalar and array facet counts under all-filters-except-own", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      const response = search(exec, schema, {
        query: "temple",
        filters: { category: "object" },
        includeFacets: ["category", "year", "tags"],
        limit: 0,
      });

      // Filtered to category=object, so the total counts only object docs...
      expect(response.total).toBe(32);
      // ...but the category facet skips its own filter and still surfaces the
      // other categories present among "temple" matches.
      const category = Object.fromEntries(
        (response.facets?.category ?? []).map((bucket) => [bucket.value, bucket.count]),
      );
      expect(category).toEqual({ object: 32, site: 10, media: 5, publication: 2 });
      // The year facet, whose own filter is not set, is constrained by the
      // category filter and so sums to the filtered total.
      const yearTotal = (response.facets?.year ?? []).reduce((sum, b) => sum + b.count, 0);
      expect(yearTotal).toBe(32);
      expect(response.facets?.tags).toEqual([
        { value: "ritual", count: 8 },
        { value: "inscription", count: 6 },
        { value: "art", count: 5 },
        { value: "military", count: 5 },
        { value: "architecture", count: 4 },
        { value: "domestic", count: 4 },
        { value: "jewelry", count: 4 },
        { value: "pottery", count: 4 },
        { value: "tooling", count: 4 },
        { value: "burial", count: 3 },
        { value: "funerary", count: 3 },
        { value: "religious", count: 3 },
        { value: "royal", count: 3 },
        { value: "trade", count: 2 },
      ]);
      // Facets appear in the requested order, not sorted or reordered.
      expect(Object.keys(response.facets ?? {})).toEqual(["category", "year", "tags"]);
    } finally {
      db.close();
    }
  });

  it("keeps disjunctive facet counts under an active array-facet filter", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // The active filter is an ARRAY facet (tags), so every other facet's count
      // applies it as an EXISTS against `facet_tags` keyed by the match-table id.
      const response = search(exec, schema, {
        query: "temple",
        filters: { tags: "ritual" },
        includeFacets: ["category", "tags", "year"],
        limit: 0,
      });

      // Filtered to tag=ritual, so the total counts only temple docs tagged ritual.
      expect(response.total).toBe(10);
      // The category facet is a non-own facet: it is constrained by the active
      // array filter (applied as EXISTS on `facet_tags`) and so sums to the
      // filtered total, with each bucket exactly the ritual-tagged distribution.
      const category = Object.fromEntries(
        (response.facets?.category ?? []).map((bucket) => [bucket.value, bucket.count]),
      );
      expect(category).toEqual({ object: 8, site: 1, publication: 1 });
      const categoryTotal = (response.facets?.category ?? []).reduce((sum, b) => sum + b.count, 0);
      expect(categoryTotal).toBe(response.total);
      const yearTotal = (response.facets?.year ?? []).reduce((sum, b) => sum + b.count, 0);
      expect(yearTotal).toBe(response.total);
      // The tags facet skips its own filter (disjunctive), so it surfaces every
      // tag among the "temple" matches and its `ritual` bucket equals the
      // filtered total — the same value that constrains the other facets.
      const ritualBucket = (response.facets?.tags ?? []).find((b) => b.value === "ritual");
      expect(ritualBucket?.count).toBe(response.total);
      expect((response.facets?.tags ?? []).length).toBeGreaterThan(1);
      // Facets appear in requested order regardless of an array facet in the middle.
      expect(Object.keys(response.facets ?? {})).toEqual(["category", "tags", "year"]);
    } finally {
      db.close();
    }
  });

  it("keeps all-facet p95 close to one-facet p95", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const base = makeNodeSqliteExec(db);
      const exec: typeof base = (sql, bind) => {
        // Model the fixed worker/WASM cost paid for every aggregation call. A
        // single aggregate pays it once regardless of the requested dimensions.
        if (/\bgroup\s+by\b/i.test(sql)) {
          const until = performance.now() + 1;
          while (performance.now() < until) {
            // Intentionally synchronous: Exec is the worker's synchronous seam.
          }
        }
        return base(sql, bind);
      };
      const schema = introspectSchema(exec);
      const facetNames = [...schema.scalarColumns, ...schema.arrayFacets.keys()];

      const measure = (includeFacets: string[]) => {
        const samples: number[] = [];
        for (let index = 0; index < 20; index += 1) {
          const started = performance.now();
          search(exec, schema, { query: "temple", includeFacets, limit: 0 });
          samples.push(performance.now() - started);
        }
        samples.sort((left, right) => left - right);
        return samples[Math.ceil(samples.length * 0.95) - 1];
      };

      measure(facetNames);
      const oneFacetP95 = measure(facetNames.slice(0, 1));
      const allFacetsP95 = measure(facetNames);

      expect(allFacetsP95).toBeLessThan(oneFacetP95 * 2.5);
    } finally {
      db.close();
    }
  });

  it("ranks title matches above body mentions", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // 49 documents match "temple"; exactly 6 carry it in their title. With the
      // fixed 10x title weight those six must sort ahead of every body-only hit.
      const response = search(exec, schema, { query: "temple", limit: 6 });
      for (const hit of response.hits) {
        expect(String(hit.title)).toContain("Temple");
      }
    } finally {
      db.close();
    }
  });

  it("paginates relevance-ordered hits without dropping or duplicating across page boundaries", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // A broad keyword with many matches, so several full pages exist.
      const full = search(exec, schema, { query: "temple", limit: 1000 });
      expect(full.total).toBeGreaterThan(30);
      expect(full.hits.length).toBe(full.total);
      const reference = full.hits.map((hit) => ({ id: hit.id, score: hit.score }));

      // Walking fixed-size pages reproduces the single-shot ordering exactly:
      // same ids, same scores, no gaps or repeats at the page seams.
      const limit = 7;
      const walked: { id: unknown; score: unknown }[] = [];
      for (let offset = 0; offset < full.total; offset += limit) {
        const page = search(exec, schema, { query: "temple", limit, offset });
        expect(page.total).toBe(full.total);
        walked.push(...page.hits.map((hit) => ({ id: hit.id, score: hit.score })));
      }
      expect(walked).toEqual(reference);
      expect(new Set(walked.map((h) => h.id)).size).toBe(reference.length);

      // A deep offset returns exactly the tail of the reference ordering.
      const deep = search(exec, schema, { query: "temple", limit, offset: full.total - 3 });
      expect(deep.hits.map((hit) => hit.id)).toEqual(reference.slice(full.total - 3).map((h) => h.id));

      // Past-the-end offset yields an empty page with the correct total; LIMIT 0
      // is empty regardless of offset.
      const past = search(exec, schema, { query: "temple", limit, offset: full.total + 50 });
      expect(past.total).toBe(full.total);
      expect(past.hits).toEqual([]);
      const zero = search(exec, schema, { query: "temple", limit: 0, offset: 0 });
      expect(zero.total).toBe(full.total);
      expect(zero.hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("paginates filtered relevance hits consistently with the single-shot page", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // Scalar filter (binds against the match table's materialized column).
      const scalarFull = search(exec, schema, {
        query: "temple",
        filters: { category: "object" },
        limit: 1000,
      });
      expect(scalarFull.hits.length).toBe(scalarFull.total);
      const scalarRef = scalarFull.hits.map((hit) => hit.id);
      const scalarWalked: unknown[] = [];
      for (let offset = 0; offset < scalarFull.total; offset += 4) {
        const page = search(exec, schema, {
          query: "temple",
          filters: { category: "object" },
          limit: 4,
          offset,
        });
        scalarWalked.push(...page.hits.map((hit) => hit.id));
      }
      expect(scalarWalked).toEqual(scalarRef);

      // Array filter (EXISTS keyed by the match table id inside the page query).
      const arrayFull = search(exec, schema, {
        query: "temple",
        filters: { tags: "ritual" },
        limit: 1000,
      });
      expect(arrayFull.hits.length).toBe(arrayFull.total);
      const arrayRef = arrayFull.hits.map((hit) => hit.id);
      const arrayWalked: unknown[] = [];
      for (let offset = 0; offset < arrayFull.total; offset += 3) {
        const page = search(exec, schema, {
          query: "temple",
          filters: { tags: "ritual" },
          limit: 3,
          offset,
        });
        arrayWalked.push(...page.hits.map((hit) => hit.id));
      }
      expect(arrayWalked).toEqual(arrayRef);
    } finally {
      db.close();
    }
  });

  it("includes a finite bm25 score on FTS hits and 0 on browse hits", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      const keyword = search(exec, schema, { query: "temple", limit: 3 });
      expect(keyword.hits.length).toBeGreaterThan(0);
      for (const hit of keyword.hits) {
        expect(typeof hit.score).toBe("number");
        expect(Number.isFinite(hit.score as number)).toBe(true);
      }
      // bm25 ranks are non-positive; better matches sort first (ascending).
      const scores = keyword.hits.map((hit) => hit.score as number);
      for (let i = 1; i < scores.length; i += 1) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }

      const browse = search(exec, schema, { limit: 3 });
      expect(browse.hits.length).toBeGreaterThan(0);
      for (const hit of browse.hits) {
        expect(hit.score).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("scores explicit-sort keyword hits 0 while relevance keyword hits keep bm25", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      const sorted = search(exec, schema, {
        query: "temple",
        sort: { field: "title" },
        limit: 5,
      });
      expect(sorted.hits.length).toBeGreaterThan(0);
      for (const hit of sorted.hits) {
        expect(hit.score).toBe(0);
      }
      // Explicit sort orders by the requested column, not relevance.
      const titles = sorted.hits.map((hit) => String(hit.title));
      const sortedTitles = [...titles].sort((left, right) =>
        left.toLowerCase().localeCompare(right.toLowerCase()),
      );
      expect(titles).toEqual(sortedTitles);

      // Same query without a sort still ranks by bm25 (non-zero scores).
      const relevance = search(exec, schema, { query: "temple", limit: 5 });
      expect(relevance.total).toBe(sorted.total);
      expect(relevance.hits.some((hit) => (hit.score as number) !== 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps a filtered total equal to that value's unfiltered facet bucket", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // Unfiltered counts for a keyword query: with no filters set, each bucket
      // is the full count of that value among the matches.
      const unfiltered = search(exec, schema, {
        query: "temple",
        includeFacets: ["category", "tags"],
        limit: 0,
      });

      // Scalar facet: filtering to category=object must total that bucket.
      const categoryBucket = (unfiltered.facets?.category ?? []).find(
        (bucket) => bucket.value === "object",
      );
      expect(categoryBucket).toBeDefined();
      const filteredCategory = search(exec, schema, {
        query: "temple",
        filters: { category: "object" },
        limit: 0,
      });
      expect(filteredCategory.total).toBe(categoryBucket?.count);

      // Array facet: filtering to a tag must total that tag's bucket, proving
      // the count reads the match table via EXISTS with no `documents` join.
      const tagBucket = (unfiltered.facets?.tags ?? []).find(
        (bucket) => bucket.value === "ritual",
      );
      expect(tagBucket).toBeDefined();
      const filteredTag = search(exec, schema, {
        query: "temple",
        filters: { tags: "ritual" },
        limit: 0,
      });
      expect(filteredTag.total).toBe(tagBucket?.count);
    } finally {
      db.close();
    }
  });

  it("matches browse facet counts to an independent GROUP BY over documents", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // Browse: no keyword, no temp table. Scalar facets group `documents`
      // directly, the array facet joins `facet_tags`. Every bucket must equal a
      // plain independent aggregation and stay ordered by descending count.
      const response = search(exec, schema, { includeFacets: true, limit: 0 });

      for (const name of schema.scalarColumns) {
        const expected = countMap(
          exec,
          `SELECT "${name}", COUNT(*) FROM documents WHERE "${name}" IS NOT NULL GROUP BY "${name}"`,
        );
        expectBuckets(response.facets?.[name], expected);
      }
      for (const [name, table] of schema.arrayFacets) {
        const expected = countMap(
          exec,
          `SELECT ft.value, COUNT(*) FROM "${table}" ft ` +
            `JOIN documents d ON d.id = ft.document_id GROUP BY ft.value`,
        );
        expectBuckets(response.facets?.[name], expected);
      }
    } finally {
      db.close();
    }
  });

  it("keeps browse disjunctive counts and filter consistency", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      const unfiltered = search(exec, schema, {
        includeFacets: ["category", "tags"],
        limit: 0,
      });
      const objectBucket = (unfiltered.facets?.category ?? []).find((b) => b.value === "object");
      expect(objectBucket).toBeDefined();

      const filtered = search(exec, schema, {
        filters: { category: "object" },
        includeFacets: ["category", "year"],
        limit: 0,
      });
      // Filtered total equals that value's bucket in the engine's own
      // unfiltered counts.
      expect(filtered.total).toBe(objectBucket?.count);
      // The category facet skips its own filter (disjunctive), so it still
      // surfaces every category rather than only `object`.
      const filteredCategory = countMap(
        exec,
        "SELECT category, COUNT(*) FROM documents WHERE category IS NOT NULL GROUP BY category",
      );
      expectBuckets(filtered.facets?.category, filteredCategory);
      // A non-own facet is constrained by the active filter and sums to total.
      const yearTotal = (filtered.facets?.year ?? []).reduce((sum, b) => sum + b.count, 0);
      expect(yearTotal).toBe(filtered.total);
    } finally {
      db.close();
    }
  });

  it("keeps multi-select IN and range filter totals consistent with buckets", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      const unfiltered = search(exec, schema, {
        query: "temple",
        includeFacets: ["category", "year"],
        limit: 0,
      });
      const category = bucketMap(unfiltered.facets?.category);
      const year = bucketMap(unfiltered.facets?.year);

      // Multi-select IN: filtered total equals the sum of the selected values'
      // unfiltered buckets.
      const inFilter = search(exec, schema, {
        query: "temple",
        filters: { category: ["object", "site"] },
        limit: 0,
      });
      expect(inFilter.total).toBe((category.get("object") ?? 0) + (category.get("site") ?? 0));

      // Range filter: filtered total equals the sum of the in-range buckets.
      const inRange = search(exec, schema, {
        query: "temple",
        filters: { year: { min: 2000, max: 2024 } },
        limit: 0,
      });
      let rangeSum = 0;
      for (const [value, count] of year) {
        if (Number(value) >= 2000 && Number(value) <= 2024) {
          rangeSum += count;
        }
      }
      expect(inRange.total).toBe(rangeSum);
    } finally {
      db.close();
    }
  });

  it("rejects store fields and unknown fields in query validation", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      expectErrorCode(() => search(exec, schema, { filters: { image: "/images/50.jpg" } }), {
        code: "FILTER_INVALID",
        message: "image",
      });
      expectErrorCode(() => search(exec, schema, { filters: { nope: "x" } }), {
        code: "FILTER_INVALID",
        message: "nope",
      });
      expectErrorCode(() => search(exec, schema, { includeFacets: ["image"] }), {
        code: "QUERY_INVALID",
        message: "image",
      });
      expectErrorCode(() => search(exec, schema, { sort: { field: "image" } }), {
        code: "QUERY_INVALID",
        message: "image",
      });
    } finally {
      db.close();
    }
  });

  it("rejects unsupported manifest and database schema versions", () => {
    const manifest = fixtureManifest();

    expectErrorCode(() => validateManifest({ ...manifest, db_schema_version: 1 }), {
      code: "SCHEMA_VERSION_MISMATCH",
      message: "Database schema version 1",
    });
    expectErrorCode(() => validateManifest({ ...manifest, manifest_version: 0 }), {
      code: "SCHEMA_VERSION_MISMATCH",
      message: "Manifest version 0",
    });
  });
});

// Term Variants widen a reader's term across its Variant Group before matching,
// and the exact band puts the pages holding the reader's own word back in front.
// The fixture carries purpose-built pages for this (see scripts/build-fixture.mjs):
// `photograph` / `photographs` / `photographed` are one generated group, and
// `ramses`/`ramesses` and `khufu`/`cheops` are declared synonym groups.
describe("term variant widening", () => {
  const titlesFor = (query: string, request: Partial<DredgeSearchRequest> = {}): string[] => {
    let titles: string[] = [];
    withFixture((exec, schema) => {
      titles = search(exec, schema, { query, limit: 1000, ...request }).hits.map((hit) =>
        String(hit.title),
      );
    });
    return titles;
  };

  // Titles reached by the reader's own word or a Term Variant of it, leaving out
  // pages a correction alone reached.
  const variantTitlesFor = (query: string): string[] => {
    let titles: string[] = [];
    withFixture((exec, schema) => {
      titles = search(exec, schema, { query, limit: 1000 })
        .hits.filter((hit) => Number(hit.band) <= 1)
        .map((hit) => String(hit.title));
    });
    return titles;
  };

  it("returns a term's whole Variant Group from a single search", () => {
    // `photographs` is on one page; the other two hold only other forms, and
    // neither is a prefix of the query, so only widening can reach them.
    expect(titlesFor("photographs").sort()).toEqual([
      "Chamber Survey Notes",
      "Glass Plate Negatives",
      "Photographed Chambers Photographed Again",
    ]);
  });

  it("reaches another verb form of the same stem", () => {
    expect(titlesFor("excavation").sort()).toEqual(["Excavation Register", "Trench Notes"]);
  });

  it("reaches declared spelling variants and synonyms", () => {
    // Neither `ramses` nor `khufu` appears anywhere in the corpus: the group is
    // declared in config, so the only widened hit is the other member's page.
    // `ramses` is also absent from the index's vocabulary, so the correction
    // pass reaches a distant page of its own at band 2; the variant's page is
    // what widening owes the reader.
    expect(variantTitlesFor("ramses")).toEqual(["Ramesses Inscription"]);
    expect(variantTitlesFor("khufu")).toEqual(["Cheops Plateau"]);
  });

  it("matches a quoted term only in the form the reader typed", () => {
    expect(titlesFor('"photographs"')).toEqual(["Chamber Survey Notes"]);
  });

  it("matches a field-scoped term only in the form the reader typed", () => {
    // `photographed` is the only one of the three forms in any title, so a
    // widened scope would return that page for either spelling.
    expect(titlesFor("title:photographed")).toEqual([
      "Photographed Chambers Photographed Again",
    ]);
    expect(titlesFor("title:photographs")).toEqual([]);
  });

  it("leaves an identifier lookup unwidened", () => {
    expect(titlesFor("uid50")).toEqual(["Royal Mask 50"]);
  });

  it("sorts every exact-form page ahead of every variant-only page", () => {
    withFixture((exec, schema) => {
      const response = search(exec, schema, { query: "photographs", limit: 1000 });

      // The exact page holds the word once, in its body; the variant page holds
      // its own form twice, once in its title. bm25 alone would put the variant
      // page first, so a worse score leading the list is the band at work.
      expect(response.hits.map((hit) => String(hit.title))).toEqual([
        "Chamber Survey Notes",
        "Photographed Chambers Photographed Again",
        "Glass Plate Negatives",
      ]);
      expect(response.hits.map((hit) => hit.band)).toEqual([0, 1, 1]);
      expect(response.hits[0].score as number).toBeGreaterThan(response.hits[1].score as number);
    });
  });

  it("bands only where relevance ordering applies", () => {
    withFixture((exec, schema) => {
      const sorted = search(exec, schema, {
        query: "photographs",
        sort: { field: "title" },
        limit: 1000,
      });
      expect(sorted.hits.map((hit) => String(hit.title))).toEqual([
        "Chamber Survey Notes",
        "Glass Plate Negatives",
        "Photographed Chambers Photographed Again",
      ]);
      for (const hit of sorted.hits) {
        expect(hit.band).toBe(0);
      }
    });
  });

  it("changes the order of a widened query and nothing else", () => {
    withFixture((exec, schema) => {
      const request: DredgeSearchRequest = {
        query: "photographs",
        includeFacets: true,
        limit: 1000,
      };
      const banded = search(exec, schema, request);
      // An explicit sort suppresses rank materialization and the band with it,
      // over the same widened match set.
      const unbanded = search(exec, schema, { ...request, sort: { field: "title" } });

      expect(banded.total).toBe(unbanded.total);
      expect(banded.facets).toEqual(unbanded.facets);
      expect(banded.hits.map((hit) => hit.id).sort()).toEqual(
        unbanded.hits.map((hit) => hit.id).sort(),
      );
    });
  });

  it("serves searches unchanged from an artifact with no Term Variant table", () => {
    const scratch = join(mkdtempSync(join(tmpdir(), "dredge-novariants-")), "novariants.db");
    copyFileSync(fixtureDbPath(), scratch);
    const db = new DatabaseSync(scratch);
    try {
      db.exec("DROP TABLE dredge_term_variants");
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);
      expect(schema.hasTermVariants).toBe(false);

      const widened = search(exec, schema, { query: "photographs", limit: 1000 });
      expect(widened.hits.map((hit) => String(hit.title))).toEqual(["Chamber Survey Notes"]);
      expect(widened.hits[0].band).toBe(0);

      withFixture((fixtureExec, fixtureSchema) => {
        const request: DredgeSearchRequest = { query: "uid50", limit: 5, includeFacets: true };
        const bare = search(exec, schema, request);
        const withVariants = search(fixtureExec, fixtureSchema, request);
        expect(bare.total).toBe(withVariants.total);
        expect(bare.hits).toEqual(withVariants.hits);
        expect(bare.facets).toEqual(withVariants.facets);
      });
    } finally {
      db.close();
    }
  });

  it("keys a session's match table on the banding probe", () => {
    withFixture((exec, schema) => {
      const session = createSearchSession(exec, schema);
      const widened = session.search({ query: "photographs", limit: 1000 });
      // Same match set, reached without widening: the quoted form must not be
      // served the widened query's cached table.
      const quoted = session.search({ query: '"photographs"', limit: 1000 });
      expect(quoted.total).toBe(1);
      // ...and repeating the widened query still hits the cache.
      expect(session.search({ query: "photographs", limit: 1000 })).toEqual({
        ...widened,
        elapsedMs: expect.any(Number),
      });
    });
  });
});

// Correction is the query-time widening of a word the index does not hold to the
// nearest words it does. It reads the FTS index's own vocabulary, so nothing
// about it ships in the artifact. `cartouchr` is on no page and `cartouche` is on
// 27, so every hit a corrected query returns is one only the correction reached.
describe("out-of-vocabulary correction", () => {
  const responseFor = (
    query: string,
    request: Partial<DredgeSearchRequest> = {},
  ): DredgeSearchResponse => {
    let response!: DredgeSearchResponse;
    withFixture((exec, schema) => {
      response = search(exec, schema, { query, limit: 1000, ...request });
    });
    return response;
  };

  const titlesOf = (response: DredgeSearchResponse): string[] =>
    response.hits.map((hit) => String(hit.title)).sort();

  it("finds the pages the reader's word was a typo for", () => {
    const corrected = responseFor("cartouchr limestone");
    const spelled = responseFor("cartouche limestone");

    expect(corrected.total).toBeGreaterThan(0);
    expect(titlesOf(corrected)).toEqual(titlesOf(spelled));
    expect(corrected.corrections).toEqual([{ term: "cartouchr", to: ["cartouche"] }]);
    // Nothing on these pages holds the word the reader typed, so every one of
    // them is here only through the correction.
    expect(corrected.hits.map((hit) => hit.band)).toEqual(corrected.hits.map(() => 2));
  });

  it("sorts the reader's own words first, then variants, then corrections", () => {
    const response = responseFor("cartouchr OR photographs");
    const bands = response.hits.map((hit) => Number(hit.band));

    expect(bands).toEqual([...bands].sort((a, b) => a - b));
    expect(new Set(bands)).toEqual(new Set([0, 1, 2]));
    expect(response.hits.filter((hit) => hit.band === 0).map((hit) => String(hit.title))).toEqual([
      "Chamber Survey Notes",
    ]);
    expect(
      response.hits
        .filter((hit) => hit.band === 1)
        .map((hit) => String(hit.title))
        .sort(),
    ).toEqual(["Glass Plate Negatives", "Photographed Chambers Photographed Again"]);
  });

  it("leaves a correctly spelled query exactly as it was", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const base = makeNodeSqliteExec(db);
      let matchSql = "";
      const exec: typeof base = (sql, bind) => {
        if (sql.startsWith("CREATE TEMP TABLE m ")) {
          matchSql = sql;
        }
        return base(sql, bind);
      };
      const schema = introspectSchema(exec);
      const response = search(exec, schema, { query: "cartouche limestone", limit: 1000 });

      expect(response).not.toHaveProperty("corrections");
      // Neither term is widened by anything, so all three planned expressions
      // are the reader's own. `0 AS band` is what that equality looks like from
      // outside the planner: both probes are dropped, leaving the SQL an
      // unwidened query emitted before corrections existed.
      expect(matchSql).toContain("0 AS band");
      expect(matchSql).not.toContain("documents_fts MATCH ?) THEN");
      expect(response.hits.map((hit) => hit.band)).toEqual(response.hits.map(() => 0));
    } finally {
      db.close();
    }
  });

  it("leaves the word still being typed alone while a dictionary word extends it", () => {
    // `cartou` is half of `cartouche`, so the prefix search already reaches the
    // pages the reader is heading for and there is nothing to correct.
    const partial = responseFor("cartou");

    expect(partial).not.toHaveProperty("corrections");
    expect(partial.total).toBeGreaterThan(0);
    expect(titlesOf(partial)).toEqual(titlesOf(responseFor("cartouche")));
  });

  it("corrects the word still being typed when no dictionary word extends it", () => {
    const corrected = responseFor("cartouchr");

    expect(corrected.corrections).toEqual([{ term: "cartouchr", to: ["cartouche"] }]);
    expect(corrected.total).toBeGreaterThan(0);
    expect(titlesOf(corrected)).toEqual(titlesOf(responseFor("cartouche")));
    expect(corrected.hits.map((hit) => hit.band)).toEqual(corrected.hits.map(() => 2));
  });

  it("corrects the word still being typed after a trailing space", () => {
    // The search path trims the query, so the space the reader has just typed
    // leaves the misspelling as the trailing prefix term it already was.
    expect(responseFor("cartouchr ")).toEqual({
      ...responseFor("cartouchr"),
      elapsedMs: expect.any(Number),
    });
  });

  it("never corrects a word of fewer than three code points", () => {
    // One is a live prefix of much of the vocabulary and one is a prefix of
    // nothing; at two code points neither is far enough from the dictionary to
    // be called a misspelling.
    for (const query of ["ca", "zq"]) {
      expect(responseFor(query)).not.toHaveProperty("corrections");
    }
  });

  it("corrects a typo in the reader's first letter", () => {
    const corrected = responseFor("kartouche limestone");
    const spelled = responseFor("cartouche limestone");

    expect(corrected.total).toBeGreaterThan(0);
    expect(titlesOf(corrected)).toEqual(titlesOf(spelled));
    expect(corrected.corrections).toEqual([{ term: "kartouche", to: ["cartouche"] }]);
    expect(corrected.hits.map((hit) => hit.band)).toEqual(corrected.hits.map(() => 2));
  });

  it("leaves the reader's precision tools exact", () => {
    // A phrase, a `field:` operand, a `near()` operand: none is wideable, so
    // none is corrected and none finds the pages the corrected word would have.
    for (const query of [
      '"cartouchr limestone"',
      "title:cartouchr limestone",
      "near(cartouchr limestone, 5)",
    ]) {
      const response = responseFor(query);
      expect(response.total).toBe(0);
      expect(response).not.toHaveProperty("corrections");
    }
  });

  it("never corrects an excluded term", () => {
    // A guess at a word the index lacks must not be able to remove pages: the
    // exclusion matches nothing, so the result is the unexcluded query's.
    const excluded = responseFor("limestone -cartouchr granite");
    const plain = responseFor("limestone granite");

    expect(excluded).not.toHaveProperty("corrections");
    expect(titlesOf(excluded)).toEqual(titlesOf(plain));
    expect(titlesOf(plain).length).toBeGreaterThan(0);
  });

  it("never offers a term held by a single document", () => {
    // `photograph`, `photographs` and `photographed` are each on one page, so
    // the whole of this misspelling's neighbourhood is below the frequency floor.
    const response = responseFor("photographz limestone");

    expect(response).not.toHaveProperty("corrections");
    expect(response.total).toBe(0);
  });

  it("marks the correction that matched", () => {
    const response = responseFor("chambar survey");
    const hit = response.hits.find((candidate) => candidate.title === "Chamber Survey Notes");

    expect(response.corrections).toEqual([{ term: "chambar", to: ["chamber"] }]);
    expect(hit).toBeDefined();
    expect(
      (hit!.marks?.title ?? []).map((mark) =>
        String(hit!.title).slice(mark.start, mark.start + mark.length),
      ),
    ).toEqual(["Chamber", "Survey"]);
  });

  it("corrects against an artifact built before Term Variants existed", () => {
    const scratch = join(mkdtempSync(join(tmpdir(), "dredge-correct-novariants-")), "novariants.db");
    copyFileSync(fixtureDbPath(), scratch);
    const db = new DatabaseSync(scratch);
    try {
      db.exec("DROP TABLE dredge_term_variants");
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);
      expect(schema.hasTermVariants).toBe(false);

      const corrected = search(exec, schema, { query: "cartouchr limestone", limit: 1000 });
      expect(corrected.corrections).toEqual([{ term: "cartouchr", to: ["cartouche"] }]);
      expect(titlesOf(corrected)).toEqual(titlesOf(responseFor("cartouche limestone")));
      expect(corrected.hits.map((hit) => hit.band)).toEqual(corrected.hits.map(() => 2));
    } finally {
      db.close();
    }
  });

  it("bands only where relevance ordering applies", () => {
    const relevance = responseFor("cartouchr limestone");
    const sorted = responseFor("cartouchr limestone", { sort: { field: "title" } });

    expect(sorted.total).toBe(relevance.total);
    expect(sorted.corrections).toEqual(relevance.corrections);
    for (const hit of sorted.hits) {
      expect(hit.band).toBe(0);
    }
  });

  it("keys a session's caches on the corrected expressions", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const base = makeNodeSqliteExec(db);
      let builds = 0;
      const exec: typeof base = (sql, bind) => {
        if (sql.startsWith("CREATE TEMP TABLE m ")) {
          builds += 1;
        }
        return base(sql, bind);
      };
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);

      const corrected = session.search({ query: "cartouchr limestone", limit: 1000 });
      // The same match set reached without correction: the spelled query must
      // not be served the corrected query's table or its cached response.
      const spelled = session.search({ query: "cartouche limestone", limit: 1000 });
      // A different typo for the same word: same corrections, different reader
      // word, so the two responses may not collapse into one another.
      const other = session.search({ query: "cartouchw limestone", limit: 1000 });
      expect(builds).toBe(3);

      expect(spelled.total).toBe(corrected.total);
      expect(spelled).not.toHaveProperty("corrections");
      expect(other.corrections).toEqual([{ term: "cartouchw", to: ["cartouche"] }]);
      expect(corrected.corrections).toEqual([{ term: "cartouchr", to: ["cartouche"] }]);

      // An unchanged triple of expressions reuses the match table: the deeper
      // page rebuilds nothing.
      session.search({ query: "cartouchw limestone", limit: 5, offset: 3 });
      expect(builds).toBe(3);
      expect(session.search({ query: "cartouchr limestone", limit: 1000 })).toEqual({
        ...corrected,
        elapsedMs: expect.any(Number),
      });
    } finally {
      db.close();
    }
  });
});

// Highlighting is a function over the response, never over the index: `snippet()`
// and `highlight()` return NULL against a contentless index, so a hit's own title
// and description are the whole of the text there is to mark. The marks are
// asserted by slicing the field they came back with, because a span that does not
// line up with the returned string is worse than no span.
describe("boosted relevance ordering", () => {
  // The same schema with every declared boost removed, which is the only way to
  // read the ordering the artifact would have had without them.
  const unboosted = (schema: SchemaInfo): SchemaInfo => ({ ...schema, boosts: [] });

  it("reads each declared boost from the artifact", () => {
    withFixture((_exec, schema) => {
      // Nothing in the runtime names these facets or numbers: both shapes are
      // read out of the compiled database.
      expect(schema.boosts).toEqual([
        {
          shape: "value",
          facet: "category",
          values: [{ value: "collection", multiplier: 8 }],
        },
        { shape: "recency", facet: "revised", maximum: 3, halfLifeDays: 730 },
      ]);
    });
  });

  it("orders a boosted facet value ahead of a better bm25 match", () => {
    withFixture((exec, schema) => {
      const boosted = search(exec, schema, { query: "canopic", limit: 10 });
      expect(boosted.hits.map((hit) => hit.title)).toEqual([
        "Register Index Beta",
        "Register Index Alpha",
      ]);
      // bm25 ranks are negative, so the leading hit holding the *worse* score is
      // the multiplier at work rather than relevance.
      expect(boosted.hits[0].score as number).toBeGreaterThan(
        boosted.hits[1].score as number,
      );
      // Same index, same query, boosts removed: relevance alone reads the other
      // way round.
      const plain = search(exec, unboosted(schema), { query: "canopic", limit: 10 });
      expect(plain.hits.map((hit) => hit.title)).toEqual([
        "Register Index Alpha",
        "Register Index Beta",
      ]);
    });
  });

  it("changes the order of a boosted query and nothing else", () => {
    withFixture((exec, schema) => {
      const request: DredgeSearchRequest = {
        query: "canopic",
        includeFacets: true,
        limit: 1000,
      };
      const boosted = search(exec, schema, request);
      const plain = search(exec, unboosted(schema), request);

      expect(boosted.total).toBe(plain.total);
      expect(boosted.facets).toEqual(plain.facets);
      expect(boosted.hits.map((hit) => hit.id).sort()).toEqual(
        plain.hits.map((hit) => hit.id).sort(),
      );
      // Every hit's score is its own bm25 rank either way: the boost orders the
      // page without rewriting what the engine reports about a hit.
      const scoreById = new Map(plain.hits.map((hit) => [hit.id, hit.score]));
      for (const hit of boosted.hits) {
        expect(hit.score).toBe(scoreById.get(hit.id));
      }
    });
  });

  it("orders a current page above a superseded one at equal relevance", () => {
    withFixture((exec, schema) => {
      const boosted = search(exec, schema, { query: "shabti", limit: 10 });
      expect(boosted.hits.map((hit) => hit.title)).toEqual([
        "Shabti Notes Updated",
        "Shabti Notes Superseded",
      ]);
      // The two pages are word-for-word identical, so bm25 cannot separate them
      // and the recency curve over `revised` is the whole of the ordering.
      expect(boosted.hits[0].score).toBe(boosted.hits[1].score);

      // Without the curve the tie falls to document id, which is the order the
      // two pages were written in.
      const plain = search(exec, unboosted(schema), { query: "shabti", limit: 10 });
      expect(plain.hits.map((hit) => hit.title)).toEqual([
        "Shabti Notes Superseded",
        "Shabti Notes Updated",
      ]);
    });
  });

  it("never lifts a variant-only match above an exact one", () => {
    withFixture((exec, schema) => {
      const boosted = search(exec, schema, { query: "photographs", limit: 1000 });

      // The best-scoring page of the three carries the boosted category and is
      // reached only through a Variant Group. Its boosted ordering beats the
      // exact page's unboosted one several times over, so the band is the only
      // thing keeping it second.
      expect(boosted.hits[1].category).toBe("collection");
      expect((boosted.hits[1].score as number) * 8).toBeLessThan(
        boosted.hits[0].score as number,
      );

      const plain = search(exec, unboosted(schema), { query: "photographs", limit: 1000 });
      expect(boosted.hits.map((hit) => hit.title)).toEqual(
        plain.hits.map((hit) => hit.title),
      );
      expect(boosted.hits.map((hit) => hit.band)).toEqual([0, 1, 1]);
    });
  });

  it("ignores boosts under an explicit sort", () => {
    withFixture((exec, schema) => {
      const request: DredgeSearchRequest = {
        query: "canopic",
        sort: { field: "title" },
        limit: 10,
      };
      const boosted = search(exec, schema, request);
      const plain = search(exec, unboosted(schema), request);

      // An explicit sort suppresses rank materialization, and a boost is a
      // factor of the rank ordering: there is nothing left for it to multiply.
      expect(boosted.hits.map((hit) => hit.title)).toEqual([
        "Register Index Alpha",
        "Register Index Beta",
      ]);
      expect(boosted.hits.map((hit) => hit.title)).toEqual(
        plain.hits.map((hit) => hit.title),
      );
      for (const hit of boosted.hits) {
        expect(hit.score).toBe(0);
      }
    });
  });
});

describe("marked terms on a hit", () => {
  const hitsFor = (query: string): DredgeHit[] => {
    let hits: DredgeHit[] = [];
    withFixture((exec, schema) => {
      hits = search(exec, schema, { query, limit: 1000 }).hits;
    });
    return hits;
  };

  const hitFor = (query: string, title: string): DredgeHit => {
    const hit = hitsFor(query).find((candidate) => candidate.title === title);
    if (!hit) {
      throw new Error(`No hit titled ${JSON.stringify(title)} for ${JSON.stringify(query)}`);
    }
    return hit;
  };

  const marked = (hit: DredgeHit, field: "title" | "description"): string[] =>
    (hit.marks?.[field] ?? []).map((mark) =>
      String(hit[field]).slice(mark.start, mark.start + mark.length),
    );

  it("marks the reader's terms in the title and the description", () => {
    const hit = hitFor("chamber survey", "Chamber Survey Notes");

    expect(marked(hit, "title")).toEqual(["Chamber", "Survey"]);
    expect(marked(hit, "description")).toEqual(["Chamber", "Survey"]);
    // Spans, not markup: the fields come back exactly as they were indexed.
    expect(hit.title).toBe("Chamber Survey Notes");
    expect(hit.description).toBe("Chamber Survey Notes.");
  });

  it("marks the variant that matched rather than the form the reader typed", () => {
    // `khufu` is on no page in the fixture, so the only reason this hit exists is
    // its synonym group's other member — which is the word that has to be marked.
    expect(marked(hitFor("khufu", "Cheops Plateau"), "title")).toEqual(["Cheops"]);
    // The same for a generated group: the reader typed the plural, the page
    // holds the past participle twice.
    expect(
      marked(hitFor("photographs", "Photographed Chambers Photographed Again"), "title"),
    ).toEqual(["Photographed", "Photographed"]);
  });

  it("leaves a term that did not match this hit unmarked", () => {
    // This page is in the union for `plateau` alone; nothing in the widened
    // `photographs` group is on it.
    expect(marked(hitFor("photographs OR plateau", "Cheops Plateau"), "title")).toEqual([
      "Plateau",
    ]);
  });

  it("returns no spans for a field nothing matched in", () => {
    // This page holds `photographs` only in its body, and the body is not in the
    // artifact: neither returned field has anything to mark.
    const hit = hitFor("photographs OR plateau", "Chamber Survey Notes");

    expect(hit.marks).toBeUndefined();
  });

  it("marks a diacritic-folded match at the returned text's own offsets", () => {
    const hit = hitFor("cafe", "Café Notes on Ostraka");

    // The index folded the diacritic away to match; the mark is reported back in
    // the coordinates of the title as returned, where the é is one character.
    expect(hit.marks?.title).toEqual([{ start: 0, length: 4 }]);
    expect(marked(hit, "title")).toEqual(["Café"]);
    expect(marked(hit, "description")).toEqual(["Café"]);
  });

  it("marks only as far as a prefix term matched", () => {
    // The final term is prefix-expanded, so marking the whole word would make the
    // highlight flicker over it between keystrokes.
    const hit = hitFor("photog", "Photographed Chambers Photographed Again");

    expect(hit.marks?.title).toEqual([
      { start: 0, length: 6 },
      { start: 22, length: 6 },
    ]);
    expect(marked(hit, "title")).toEqual(["Photog", "Photog"]);
  });
});

describe("database integrity verification", () => {
  it("accepts decompressed bytes matching the manifest sha256", async () => {
    const manifest = fixtureManifest();
    const bytes = new Uint8Array(readFileSync(fixtureDbPath()));

    await expect(verifyDatabaseHash(bytes, manifest.db_sha256)).resolves.toBeUndefined();
  });

  it("rejects valid-size but hash-mismatched bytes with DB_STORAGE_CORRUPT", async () => {
    const manifest = fixtureManifest();
    const bytes = new Uint8Array(readFileSync(fixtureDbPath()));
    const corrupted = bytes.slice();
    corrupted[0] ^= 0xff;
    expect(corrupted.byteLength).toBe(bytes.byteLength);

    await expect(verifyDatabaseHash(corrupted, manifest.db_sha256)).rejects.toMatchObject({
      code: "DB_STORAGE_CORRUPT",
    });
  });
});

// Session memoization: the database is immutable for the life of a session, so
// a cached response must be field-identical to a freshly computed one (except
// elapsedMs), pagination over a cached match must reproduce a cold engine's
// pages, interleaved requests must never observe each other's results, and the
// close/reset seam must drop every cache so a changed database is never served
// stale.
describe("search session memoization", () => {
  it("serves an exact repeat field-identically except elapsedMs", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);
      const request: DredgeSearchRequest = { query: "temple", limit: 5, includeFacets: true };

      const first = session.search(request); // cold: computed
      const second = session.search(request); // warm: served from the response cache

      expect(typeof second.elapsedMs).toBe("number");
      expect(stripElapsed(second)).toEqual(stripElapsed(first));
      // The cache is unobservable to a cold stateless engine.
      const cold = search(makeNodeSqliteExec(new DatabaseSync(fixtureDbPath())), schema, request);
      expect(stripElapsed(first)).toEqual(stripElapsed(cold));
    } finally {
      db.close();
    }
  });

  it("recomputes elapsedMs for the serving request on a cache hit", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const base = makeNodeSqliteExec(db);
      // Inflate the cold computation's elapsed time. A response-cache hit touches
      // no SQLite, so its elapsedMs is its own tiny measurement — unambiguously
      // below the inflated cold time. Guards against a regression that returns the
      // cached response verbatim (carrying the original's elapsedMs).
      let slow = true;
      const exec: typeof base = (sql, bind) => {
        if (slow) {
          const until = performance.now() + 5;
          while (performance.now() < until) {
            // Busy-wait per exec call so the cold search's elapsed time is large.
          }
        }
        return base(sql, bind);
      };
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);
      const request: DredgeSearchRequest = { query: "temple", limit: 5, includeFacets: true };

      const first = session.search(request); // cold: several inflated exec calls
      slow = false;
      const second = session.search(request); // response-cache hit: no SQLite at all

      expect(second.elapsedMs).toBeLessThan(first.elapsedMs);
      expect(stripElapsed(second)).toEqual(stripElapsed(first));
    } finally {
      db.close();
    }
  });

  it("paginates a cached match into the same pages a cold engine produces", () => {
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const schema = introspectSchema(makeNodeSqliteExec(db));
      const session = createSearchSession(makeNodeSqliteExec(db), schema);
      const coldExec = makeNodeSqliteExec(coldDb);

      const limit = 7;
      const total = session.search({ query: "temple", limit: 0 }).total;
      expect(total).toBeGreaterThan(30);
      for (let offset = 0; offset < total + limit; offset += limit) {
        const request: DredgeSearchRequest = {
          query: "temple",
          limit,
          offset,
          includeFacets: ["category", "tags"],
        };
        const paged = session.search(request);
        const cold = search(coldExec, schema, request);
        expect(stripElapsed(paged)).toEqual(stripElapsed(cold));
      }
    } finally {
      db.close();
      coldDb.close();
    }
  });

  it("returns A's exact results after an A/B/A interleave", () => {
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const schema = introspectSchema(makeNodeSqliteExec(db));
      const session = createSearchSession(makeNodeSqliteExec(db), schema);
      const coldExec = makeNodeSqliteExec(coldDb);

      const a: DredgeSearchRequest = { query: "temple", limit: 5, includeFacets: ["category"] };
      const b: DredgeSearchRequest = { query: "mask", limit: 3, includeFacets: ["year"] };
      const coldA = search(coldExec, schema, a);
      const coldB = search(coldExec, schema, b);

      const a1 = session.search(a);
      const b1 = session.search(b); // rebuilds the match table for B
      const a2 = session.search(a); // response-cache hit: must be A, not B
      // A re-run that misses the response cache (deeper page) rebuilds the match
      // table back to A from B and must still be A's results, never B's.
      const a3 = session.search({ ...a, offset: 2 });
      const coldA3 = search(coldExec, schema, { ...a, offset: 2 });

      expect(stripElapsed(a1)).toEqual(stripElapsed(coldA));
      expect(stripElapsed(b1)).toEqual(stripElapsed(coldB));
      expect(stripElapsed(a2)).toEqual(stripElapsed(coldA));
      expect(stripElapsed(a3)).toEqual(stripElapsed(coldA3));
    } finally {
      db.close();
      coldDb.close();
    }
  });

  it("rebuilds with rank when a rank-needing request follows a rank-less cached match", () => {
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const schema = introspectSchema(makeNodeSqliteExec(db));
      const session = createSearchSession(makeNodeSqliteExec(db), schema);
      const coldExec = makeNodeSqliteExec(coldDb);

      // Explicit sort → the match table is materialized WITHOUT bm25 rank.
      const sortedReq: DredgeSearchRequest = { query: "temple", sort: { field: "title" }, limit: 5 };
      const sorted = session.search(sortedReq);
      expect(stripElapsed(sorted)).toEqual(stripElapsed(search(coldExec, schema, sortedReq)));
      for (const hit of sorted.hits) {
        expect(hit.score).toBe(0);
      }

      // Same query with no sort now needs rank; the rank-less table cannot be
      // reused, so it is rebuilt with rank and the hits carry real bm25 scores.
      const rankedReq: DredgeSearchRequest = { query: "temple", limit: 5 };
      const ranked = session.search(rankedReq);
      expect(stripElapsed(ranked)).toEqual(stripElapsed(search(coldExec, schema, rankedReq)));
      expect(ranked.hits.some((hit) => (hit.score as number) !== 0)).toBe(true);
    } finally {
      db.close();
      coldDb.close();
    }
  });

  it("never leaks results across interleaved queries, filters, facets, and browse", () => {
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const schema = introspectSchema(makeNodeSqliteExec(db));
      const session = createSearchSession(makeNodeSqliteExec(db), schema);
      const coldExec = makeNodeSqliteExec(coldDb);

      const requests: DredgeSearchRequest[] = [
        { query: "temple", includeFacets: ["category"], limit: 3 },
        { filters: { category: "object" }, includeFacets: ["tags"], limit: 4 },
        { query: "temple", filters: { tags: "ritual" }, includeFacets: ["category", "year"], limit: 2 },
        { query: "mask", limit: 5 },
        { query: "temple", includeFacets: ["category"], limit: 3 },
        { includeFacets: true, limit: 6 },
        { query: "temple", sort: { field: "title" }, limit: 3 },
        { query: "temple", limit: 3 },
      ];

      for (const request of requests) {
        const got = session.search(request);
        const want = search(coldExec, schema, request);
        expect(stripElapsed(got)).toEqual(stripElapsed(want));
      }
    } finally {
      db.close();
      coldDb.close();
    }
  });

  it("clears every cache on the close/reset seam so a changed database is never served stale", () => {
    const scratch = join(mkdtempSync(join(tmpdir(), "dredge-reset-")), "reset.db");
    copyFileSync(fixtureDbPath(), scratch);
    const db = new DatabaseSync(scratch);
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);
      // Register the session behind the db.ts seam that closeDatabase() drives.
      setSessionCacheClearer(() => session.clear());

      const request: DredgeSearchRequest = { query: "uid50", limit: 5 };
      const before = session.search(request);
      expect(before.hits[0].title).toBe("Royal Mask 50");

      // Mutate the stored document. The match set is unchanged (uid50 is not the
      // title), only the display column.
      db.exec("UPDATE documents SET title = 'Changed Title' WHERE title = 'Royal Mask 50'");

      // Still served from the cache — deliberately, until invalidated.
      expect(session.search(request).hits[0].title).toBe("Royal Mask 50");

      // The close/reset seam drops the caches...
      closeDatabase();

      // ...so the next identical request re-reads the changed database.
      expect(session.search(request).hits[0].title).toBe("Changed Title");
    } finally {
      setSessionCacheClearer(undefined);
      db.close();
    }
  });
});

// Unfiltered-browse facet totals are corpus constants served from a per-facet
// session map: buckets served from the map must be byte-identical to a cold
// engine's, partial facet requests must compose (each facet computed once), an
// active filter must bypass the map entirely, and close/reset must clear it so a
// different database is never served stale totals.
describe("browse facet totals cache", () => {
  it("serves unfiltered browse facets identically on repeat and equal to a cold engine", () => {
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const schema = introspectSchema(makeNodeSqliteExec(db));
      const session = createSearchSession(makeNodeSqliteExec(db), schema);
      const coldExec = makeNodeSqliteExec(coldDb);
      const request: DredgeSearchRequest = { includeFacets: ["category", "tags", "year"], limit: 6 };

      const first = session.search(request); // cold: computes each facet once
      const second = session.search(request); // served from the map (and response cache)
      const cold = search(coldExec, schema, request);

      expect(stripElapsed(second)).toEqual(stripElapsed(first));
      expect(stripElapsed(first)).toEqual(stripElapsed(cold));
    } finally {
      db.close();
      coldDb.close();
    }
  });

  it("composes partial facet requests, computing each facet only once", () => {
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const base = makeNodeSqliteExec(db);
      let groupBys = 0;
      const exec: typeof base = (sql, bind) => {
        if (/\bgroup\s+by\b/i.test(sql)) {
          groupBys += 1;
        }
        return base(sql, bind);
      };
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);
      const coldExec = makeNodeSqliteExec(coldDb);

      const a: DredgeSearchRequest = { includeFacets: ["category"], limit: 0 };
      const ab: DredgeSearchRequest = { includeFacets: ["category", "tags"], limit: 0 };
      const b: DredgeSearchRequest = { includeFacets: ["tags"], limit: 0 };

      groupBys = 0;
      expect(stripElapsed(session.search(a))).toEqual(stripElapsed(search(coldExec, schema, a)));
      expect(groupBys).toBe(1); // category aggregated once

      groupBys = 0;
      expect(stripElapsed(session.search(ab))).toEqual(stripElapsed(search(coldExec, schema, ab)));
      expect(groupBys).toBe(1); // only tags is new; category is served from the map

      groupBys = 0;
      expect(stripElapsed(session.search(b))).toEqual(stripElapsed(search(coldExec, schema, b)));
      expect(groupBys).toBe(0); // tags already in the map
    } finally {
      db.close();
      coldDb.close();
    }
  });

  it("bypasses the map for a filtered browse and leaves the map intact", () => {
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const schema = introspectSchema(makeNodeSqliteExec(db));
      const session = createSearchSession(makeNodeSqliteExec(db), schema);
      const coldExec = makeNodeSqliteExec(coldDb);

      // Populate the map with the unfiltered category buckets first.
      const unfiltered: DredgeSearchRequest = { includeFacets: ["category"], limit: 0 };
      expect(stripElapsed(session.search(unfiltered))).toEqual(
        stripElapsed(search(coldExec, schema, unfiltered)),
      );

      // A filtered browse must not be served from the map: the constrained
      // `year` total and the filtered result must equal a cold engine's.
      const filtered: DredgeSearchRequest = {
        filters: { category: "object" },
        includeFacets: ["category", "year"],
        limit: 0,
      };
      const got = session.search(filtered);
      expect(stripElapsed(got)).toEqual(stripElapsed(search(coldExec, schema, filtered)));

      // The populated map is untouched by the filtered request.
      expect(stripElapsed(session.search(unfiltered))).toEqual(
        stripElapsed(search(coldExec, schema, unfiltered)),
      );
    } finally {
      db.close();
      coldDb.close();
    }
  });

  it("keeps the browse map across a connection swap while dropping the connection caches", () => {
    // Ticket 04's memory→OPFS swap clears only the connection-scoped caches
    // (match table, aggregates, responses) through db.ts's clearConnectionCaches
    // seam; the browse facet-totals map is data about the same database and must
    // survive. A keyword result must still be correct after the drop, and the
    // browse totals must be served without re-aggregation.
    const db = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      const base = makeNodeSqliteExec(db);
      let groupBys = 0;
      const exec: typeof base = (sql, bind) => {
        if (/\bgroup\s+by\b/i.test(sql)) {
          groupBys += 1;
        }
        return base(sql, bind);
      };
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);
      const coldExec = makeNodeSqliteExec(coldDb);
      // Register the session behind the connection-only clearer the swap drives.
      setConnectionCacheClearer(() => session.clearConnectionCaches());

      const browse: DredgeSearchRequest = { includeFacets: ["category", "tags"], limit: 0 };
      const keyword: DredgeSearchRequest = { query: "temple", includeFacets: ["category"], limit: 3 };

      const browseBefore = session.search(browse); // populates the browse map
      session.search(keyword); // populates match/aggregate/response caches

      // Simulate the connection swap's cache handling.
      clearConnectionCaches();

      // The browse totals are still served from the surviving map — no GROUP BY.
      groupBys = 0;
      const browseAfter = session.search(browse);
      expect(groupBys).toBe(0);
      expect(stripElapsed(browseAfter)).toEqual(stripElapsed(browseBefore));

      // The keyword caches were dropped, so the match table + aggregate recompute;
      // the result stays field-identical to a cold engine's.
      const keywordAfter = session.search(keyword);
      expect(stripElapsed(keywordAfter)).toEqual(stripElapsed(search(coldExec, schema, keyword)));
    } finally {
      setConnectionCacheClearer(undefined);
      db.close();
      coldDb.close();
    }
  });

  it("answers searches identically after the live connection is genuinely swapped", () => {
    // Ticket 04's memory→OPFS swap replaces the underlying connection while the
    // session keeps running, exactly as the worker wires it: the session's exec
    // is an indirection to the *live* connection (search-worker.ts: (sql, bind)
    // => getExec()(sql, bind)), and the swap installs a new exec. Drive that end
    // to end — search, swap the exec onto a different physical handle, clear the
    // connection caches, then search again — and assert the swapped connection
    // serves results identical to pre-swap and to a cold engine, with the browse
    // map surviving the swap.
    const dbA = new DatabaseSync(fixtureDbPath());
    const dbB = new DatabaseSync(fixtureDbPath());
    const coldDb = new DatabaseSync(fixtureDbPath());
    try {
      let live = makeNodeSqliteExec(dbA);
      const exec: typeof live = (sql, bind) => live(sql, bind);
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);
      setConnectionCacheClearer(() => session.clearConnectionCaches());

      const keyword: DredgeSearchRequest = {
        query: "temple",
        limit: 5,
        includeFacets: ["category", "tags"],
      };
      const browse: DredgeSearchRequest = { includeFacets: ["category"], limit: 6 };

      const keywordBefore = session.search(keyword);
      const browseBefore = session.search(browse); // populates the browse map on A

      // Swap the live connection onto a genuinely different handle and run the
      // connection-cache clear the swap performs.
      live = makeNodeSqliteExec(dbB);
      clearConnectionCaches();

      const keywordAfter = session.search(keyword); // recomputed on B
      const browseAfter = session.search(browse); // served from the surviving map
      const coldExec = makeNodeSqliteExec(coldDb);

      expect(stripElapsed(keywordAfter)).toEqual(stripElapsed(keywordBefore));
      expect(stripElapsed(keywordAfter)).toEqual(stripElapsed(search(coldExec, schema, keyword)));
      expect(stripElapsed(browseAfter)).toEqual(stripElapsed(browseBefore));
    } finally {
      setConnectionCacheClearer(undefined);
      dbA.close();
      dbB.close();
      coldDb.close();
    }
  });

  it("clears the browse map on close/reset so a changed database is not served stale", () => {
    const scratch = join(mkdtempSync(join(tmpdir(), "dredge-browse-reset-")), "reset.db");
    copyFileSync(fixtureDbPath(), scratch);
    const db = new DatabaseSync(scratch);
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);
      const session = createSearchSession(exec, schema);
      setSessionCacheClearer(() => session.clear());

      const request: DredgeSearchRequest = { includeFacets: ["category"], limit: 0 };
      const objectCount = (name: DredgeSearchResponse) =>
        (name.facets?.category ?? []).find((bucket) => bucket.value === "object")?.count;

      const before = objectCount(session.search(request));
      expect(before).toBeGreaterThan(0);

      // Move one document out of the `object` category. The corpus constant has
      // changed, but the map still serves the old bucket until invalidated.
      db.exec(
        "UPDATE documents SET category = 'site' " +
          "WHERE id = (SELECT id FROM documents WHERE category = 'object' LIMIT 1)",
      );
      expect(objectCount(session.search(request))).toBe(before);

      // The close/reset seam clears the map...
      closeDatabase();

      // ...so the next browse re-aggregates the changed database.
      expect(objectCount(session.search(request))).toBe((before as number) - 1);
    } finally {
      setSessionCacheClearer(undefined);
      db.close();
    }
  });
});

function stripElapsed(response: DredgeSearchResponse): Omit<DredgeSearchResponse, "elapsedMs"> {
  const { elapsedMs: _elapsedMs, ...rest } = response;
  return rest;
}

function countMap(exec: ReturnType<typeof makeNodeSqliteExec>, sql: string): Map<unknown, number> {
  const map = new Map<unknown, number>();
  for (const row of exec(sql)) {
    map.set(row[0], Number(row[1]));
  }
  return map;
}

function bucketMap(
  buckets: { value: string | number | boolean; count: number }[] | undefined,
): Map<unknown, number> {
  return new Map((buckets ?? []).map((bucket) => [bucket.value, bucket.count]));
}

// Assert a facet's buckets carry exactly the expected value->count pairs and are
// ordered by descending count.
function expectBuckets(
  buckets: { value: string | number | boolean; count: number }[] | undefined,
  expected: Map<unknown, number>,
): void {
  expect(bucketMap(buckets)).toEqual(expected);
  const counts = (buckets ?? []).map((bucket) => bucket.count);
  for (let i = 1; i < counts.length; i += 1) {
    expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
  }
}

function expectErrorCode(fn: () => unknown, expected: { code: string; message: string }): void {
  try {
    fn();
  } catch (error) {
    const dredgeError = toDredgeError(error);
    expect(dredgeError.code).toBe(expected.code);
    expect(dredgeError.message).toContain(expected.message);
    return;
  }
  throw new Error(`Expected ${expected.code} error`);
}

describe("suggestions from the index vocabulary", () => {
  // The contract's own check: a suggestion is only legitimate if the index
  // actually holds the term, so read the vocabulary view directly rather than
  // trusting the engine's own view of it.
  function indexTerms(exec: ReturnType<typeof makeNodeSqliteExec>): Set<string> {
    exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.audit_vocab " +
        "USING fts5vocab(main, documents_fts, 'row')",
    );
    return new Set(exec("SELECT term FROM temp.audit_vocab").map((row) => String(row[0])));
  }

  // An Exec that records every statement it runs and how many rows each returned.
  function recordingExec(
    exec: ReturnType<typeof makeNodeSqliteExec>,
    log: Array<{ sql: string; rows: number }>,
  ): Exec {
    return (sql, bind) => {
      const rows = exec(sql, bind);
      log.push({ sql, rows: rows.length });
      return rows;
    };
  }

  it("corrects a one-character misspelling to the fixture term it meant", () => {
    withFixture((exec) => {
      const { suggestions } = suggest(exec, { term: "cartouchr", kind: "correction" });

      expect(suggestions[0].term).toBe("cartouche");
      expect(suggestions[0].distance).toBe(1);
      // Ranking is distance first, so nothing further away may precede it.
      expect(suggestions.every((s) => s.distance >= suggestions[0].distance)).toBe(true);
    });
  });

  it("corrects a typo in the first letter of a long enough word", () => {
    withFixture((exec) => {
      const { suggestions } = suggest(exec, { term: "kartouche", kind: "correction" });

      expect(suggestions[0].term).toBe("cartouche");
      expect(suggestions[0].distance).toBe(1);
    });
  });

  it("keeps the first letter of a short word exact", () => {
    withFixture((exec) => {
      // `the` is in the fixture's vocabulary and `zhe` is one edit from it, but
      // at three code points a changed first letter is not treated as a typo:
      // too much of the dictionary is within one edit of a word that short.
      expect(suggest(exec, { term: "zhe", kind: "correction" }).suggestions).toEqual([]);
    });
  });

  it("ranks equal-distance corrections by document frequency", () => {
    withFixture((exec) => {
      // `names` and `notes` are both one edit from `nates`; `notes` is in more
      // documents, so it is the better guess.
      const { suggestions } = suggest(exec, { term: "nates", kind: "correction" });
      const terms = suggestions.filter((s) => s.distance === 1).map((s) => s.term);

      expect(terms).toEqual(["notes", "names"]);
    });
  });

  it("returns only terms the index holds, for corrections and completions alike", () => {
    withFixture((exec) => {
      const terms = indexTerms(exec);
      const responses = [
        suggest(exec, { term: "cartouchr", kind: "correction" }),
        suggest(exec, { term: "limstone", kind: "correction" }),
        suggest(exec, { term: "st", kind: "completion" }),
        suggest(exec, { term: "c", kind: "completion" }),
      ];

      const suggested = responses.flatMap((response) => response.suggestions);
      expect(suggested.length).toBeGreaterThan(0);
      for (const suggestion of suggested) {
        expect(terms.has(suggestion.term)).toBe(true);
      }
    });
  });

  it("completes a prefix only with terms that extend it", () => {
    withFixture((exec) => {
      const { suggestions } = suggest(exec, { term: "st", kind: "completion" });

      expect(suggestions.length).toBeGreaterThan(1);
      for (const suggestion of suggestions) {
        expect(suggestion.term.startsWith("st")).toBe(true);
        expect(suggestion.term).not.toBe("st");
        expect(suggestion.distance).toBe(suggestion.term.length - 2);
      }
      // Commonest first: a completion list is a guess, and frequency is the prior.
      const frequencies = suggestions.map((s) => s.documentFrequency);
      expect([...frequencies].sort((a, b) => b - a)).toEqual(frequencies);
    });
  });

  it("returns an empty list, not an error, when nothing plausible exists", () => {
    withFixture((exec) => {
      expect(suggest(exec, { term: "zzqxwv", kind: "correction" }).suggestions).toEqual([]);
      expect(suggest(exec, { term: "zzqxwv", kind: "completion" }).suggestions).toEqual([]);
      expect(suggest(exec, { term: "   ", kind: "correction" }).suggestions).toEqual([]);
    });
  });

  it("scores only a prefiltered slice of the vocabulary", () => {
    withFixture((exec) => {
      const vocabulary = indexTerms(exec);
      const log: Array<{ sql: string; rows: number }> = [];

      suggest(recordingExec(exec, log), { term: "cartouchr", kind: "correction" });

      const candidates = log.filter((entry) => entry.sql.includes("BETWEEN"));
      expect(candidates).toHaveLength(1);
      expect(vocabulary.size).toBeGreaterThan(300);
      expect(candidates[0].rows).toBeLessThan(vocabulary.size / 10);
    });
  });

  it("creates the vocabulary view once per session, not per request", () => {
    withFixture((exec, schema) => {
      const log: Array<{ sql: string; rows: number }> = [];
      const session = createSearchSession(recordingExec(exec, log), schema);

      session.suggest({ term: "cartouchr", kind: "correction" });
      session.suggest({ term: "st", kind: "completion" });
      session.suggest({ term: "limstone", kind: "correction" });

      expect(log.filter((entry) => entry.sql.includes("fts5vocab"))).toHaveLength(1);
    });
  });

  it("offers only completions that co-occur with the Suggestion Context", () => {
    withFixture((exec, schema) => {
      const { suggestions } = suggest(exec, {
        term: "st",
        kind: "completion",
        context: { query: "cartouche" },
      });

      // `stages` and `storeroom` extend `st` in the corpus but appear on no
      // page with `cartouche`, so accepting them would land on zero results.
      expect(suggestions.map((s) => s.term)).toEqual(["stone", "stela", "statue"]);
      // Commonest in context first, and the reported frequency is the
      // in-context count rather than the corpus one.
      const counts = suggestions.map((s) => s.documentFrequency);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
      for (const suggestion of suggestions) {
        expect(suggestion.documentFrequency).toBeGreaterThan(0);
        const combined = search(exec, schema, {
          query: `cartouche ${suggestion.term}`,
          limit: 0,
        });
        expect(combined.total).toBe(suggestion.documentFrequency);
      }
    });
  });

  it("drops a completion present only outside the context's filters", () => {
    withFixture((exec) => {
      const unfiltered = suggest(exec, {
        term: "st",
        kind: "completion",
        context: { query: "cartouche" },
      });
      const filtered = suggest(exec, {
        term: "st",
        kind: "completion",
        context: { query: "cartouche", filters: { category: "publication" } },
      });

      // `statue` co-occurs with `cartouche` only on `object` pages.
      expect(unfiltered.suggestions.map((s) => s.term)).toContain("statue");
      expect(filtered.suggestions.map((s) => s.term)).not.toContain("statue");
      expect(filtered.suggestions.map((s) => s.term)).toEqual(["stela", "stone"]);
    });
  });

  it("treats the context's last word as complete, not as a live prefix", () => {
    withFixture((exec) => {
      // `cartou` extends to `cartouche`, so prefix-expanding it would make this
      // the `cartouche` context. The context's last word is one the reader has
      // finished, so it is the exact word `cartou` — which is on no page.
      const asWritten = suggest(exec, {
        term: "st",
        kind: "completion",
        context: { query: "cartou" },
      });
      const expanded = suggest(exec, {
        term: "st",
        kind: "completion",
        context: { query: "cartouche" },
      });

      expect(asWritten.suggestions).toEqual([]);
      expect(expanded.suggestions.length).toBeGreaterThan(0);
    });
  });

  it("excludes a correction that never co-occurs with the context", () => {
    withFixture((exec) => {
      const bare = suggest(exec, { term: "stane", kind: "correction" });
      const inContext = suggest(exec, {
        term: "stane",
        kind: "correction",
        context: { query: "mask" },
      });

      // Both are within the edit-distance bound of `stane`, but `statue` shares
      // no page with `mask`, so a "did you mean" must not offer it here.
      expect(bare.suggestions.map((s) => s.term)).toEqual(["stone", "statue"]);
      expect(inContext.suggestions.map((s) => s.term)).toEqual(["stone"]);
      expect(inContext.suggestions[0].documentFrequency).toBe(10);
    });
  });

  it("answers a request without a context exactly as it did before", () => {
    withFixture((exec) => {
      expect(suggest(exec, { term: "st", kind: "completion" }).suggestions).toEqual([
        { term: "stone", documentFrequency: 50, distance: 3 },
        { term: "stela", documentFrequency: 27, distance: 3 },
        { term: "statue", documentFrequency: 5, distance: 4 },
        { term: "stages", documentFrequency: 1, distance: 4 },
        { term: "storeroom", documentFrequency: 1, distance: 7 },
      ]);
      expect(suggest(exec, { term: "cartouchr", kind: "correction" }).suggestions).toEqual([
        { term: "cartouche", documentFrequency: 27, distance: 1 },
      ]);
      // An empty context is no context: the corpus counts stand.
      expect(suggest(exec, { term: "st", kind: "completion", context: {} }).suggestions).toEqual(
        suggest(exec, { term: "st", kind: "completion" }).suggestions,
      );
    });
  });
});
