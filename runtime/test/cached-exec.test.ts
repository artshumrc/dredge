import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it } from "vitest";

import { makeExec } from "../src/db";
import type { Exec } from "../src/db";
import type { DredgeSearchRequest, DredgeSearchResponse, DredgeFacetBucket } from "../src/search";
import { createSearchSession, introspectSchema, search } from "../src/search";
import { makeNodeSqliteExec } from "./node-sqlite-exec";

// The prepared-statement cache lives in the WASM exec layer (`makeExec`), which
// the fixture suite never touches — those tests run through the Node adapter.
// These tests drive the real WASM oo1.DB exec so the cache itself is exercised:
// its rows must be byte-identical to the same connection's uncached db.exec
// (caching is transparent), and an SQL error must not poison it.

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");

function fixtureDbPath(): string {
  const manifestPath = join(fixtureRoot, "search", "search-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Fixture database is missing; run `pnpm fixture` in runtime/ before `pnpm test`.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { db_file: string };
  const dbFile = manifest.db_file.endsWith(".br")
    ? manifest.db_file.slice(0, -".br".length)
    : manifest.db_file;
  const dbPath = join(fixtureRoot, "search", dbFile);
  if (!existsSync(dbPath)) {
    throw new Error(`Fixture database is missing at ${dbPath}; run \`pnpm fixture\` first.`);
  }
  return dbPath;
}

// Deserialize the fixture bytes into a fresh in-memory oo1.DB, mirroring the
// worker's memory backend (openInMemoryDatabase). Each call owns its own copy.
let sqlite3: any;
function openWasmFixture(): any {
  const bytes = new Uint8Array(readFileSync(fixtureDbPath()));
  const db = new sqlite3.oo1.DB();
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer,
    "main",
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
  );
  db.checkRc(rc);
  return db;
}

// The uncached reference: prepare-per-call db.exec array rows — the exact
// behavior makeExec replaces, over the same WASM connection.
function uncachedWasmExec(db: any): Exec {
  return (sql, bind = []) =>
    db.exec({ sql, bind, returnValue: "resultRows", rowMode: "array" }) as unknown[][];
}

// A mixed workload: browse (no/all/subset facets), filtered browse, keyword
// search with facets (rank path), pagination across a match, an explicit-sort
// keyword page (no rank), match changes, a narrow query, an empty query, and a
// repeat — enough distinct SQL shapes that the cache both fills and reuses.
const WORKLOAD: DredgeSearchRequest[] = [
  {},
  { includeFacets: true },
  { includeFacets: ["category", "tags"] },
  { filters: { category: "object" }, includeFacets: ["category", "year"] },
  { query: "temple", includeFacets: true },
  { query: "temple", limit: 5, offset: 5 },
  { query: "temple", limit: 5, offset: 10 },
  { query: "stone", includeFacets: ["tags"] },
  { query: "temple", sort: { field: "title" }, limit: 8 },
  { query: "temple", filters: { category: "object" }, includeFacets: ["category", "year", "tags"], limit: 3 },
  { query: "uid50" },
  { query: "" },
  { query: "temple", includeFacets: true },
];

function withoutElapsed(response: DredgeSearchResponse): Omit<DredgeSearchResponse, "elapsedMs"> {
  const { elapsedMs: _elapsed, ...rest } = response;
  return rest;
}

function runWorkload(exec: Exec): Array<Omit<DredgeSearchResponse, "elapsedMs">> {
  const schema = introspectSchema(exec);
  return WORKLOAD.map((request) => withoutElapsed(search(exec, schema, request)));
}

// Facet buckets keyed value -> count, order-insensitive, for cross-engine
// comparison where equal-count tie order is not guaranteed to match.
function facetMap(buckets: DredgeFacetBucket[] | undefined): Record<string, number> {
  const map: Record<string, number> = {};
  for (const bucket of buckets ?? []) {
    map[String(bucket.value)] = bucket.count;
  }
  return map;
}

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

describe("cached WASM exec", () => {
  it("is byte-identical to the same connection's uncached db.exec over a mixed workload", () => {
    const cachedDb = openWasmFixture();
    const uncachedDb = openWasmFixture();
    try {
      const cached = runWorkload(makeExec(cachedDb).exec);
      const uncached = runWorkload(uncachedWasmExec(uncachedDb));
      expect(cached).toEqual(uncached);
    } finally {
      cachedDb.close();
      uncachedDb.close();
    }
  });

  it("returns the same workload results when run twice, so statement reuse never corrupts", () => {
    const db = openWasmFixture();
    try {
      const exec = makeExec(db).exec;
      const first = runWorkload(exec);
      const second = runWorkload(exec);
      expect(second).toEqual(first);
    } finally {
      db.close();
    }
  });

  it("matches the uncached Node adapter on totals, hits and facet counts", () => {
    const wasmDb = openWasmFixture();
    const nodeDb = new DatabaseSync(fixtureDbPath());
    try {
      const cachedExec = makeExec(wasmDb).exec;
      const cachedSchema = introspectSchema(cachedExec);
      const nodeExec = makeNodeSqliteExec(nodeDb);
      const nodeSchema = introspectSchema(nodeExec);

      for (const request of WORKLOAD) {
        const cached = search(cachedExec, cachedSchema, request);
        const reference = search(nodeExec, nodeSchema, request);
        expect(cached.total).toBe(reference.total);
        // Hits are ordered deterministically (rank/sort with a d.id tiebreak);
        // score is a bm25 float that can differ in its last bits between the
        // native and WASM builds, so compare identity, not the float.
        expect(cached.hits.map((hit) => hit.id)).toEqual(reference.hits.map((hit) => hit.id));
        expect(cached.hits.map((hit) => hit.title)).toEqual(reference.hits.map((hit) => hit.title));
        const cachedFacets = cached.facets ?? {};
        const referenceFacets = reference.facets ?? {};
        expect(Object.keys(cachedFacets).sort()).toEqual(Object.keys(referenceFacets).sort());
        for (const name of Object.keys(cachedFacets)) {
          expect(facetMap(cachedFacets[name])).toEqual(facetMap(referenceFacets[name]));
        }
      }
    } finally {
      wasmDb.close();
      nodeDb.close();
    }
  });

  it("serves a session workload identically through the cached exec", () => {
    // Through a SearchSession the match table persists across requests, so the
    // cached CREATE/DROP/count/hits statements are reused most aggressively.
    const cachedDb = openWasmFixture();
    const uncachedDb = openWasmFixture();
    try {
      const cachedExec = makeExec(cachedDb).exec;
      const cachedSession = createSearchSession(cachedExec, introspectSchema(cachedExec));
      const uncachedExec = uncachedWasmExec(uncachedDb);
      const uncachedSession = createSearchSession(uncachedExec, introspectSchema(uncachedExec));

      for (const request of WORKLOAD) {
        const cached = withoutElapsed(cachedSession.search(request));
        const uncached = withoutElapsed(uncachedSession.search(request));
        expect(cached).toEqual(uncached);
      }
    } finally {
      cachedDb.close();
      uncachedDb.close();
    }
  });

  it("finalizes cached statements and rebuilds the cache lazily", () => {
    const db = openWasmFixture();
    try {
      const { exec, finalize } = makeExec(db);
      const before = exec("SELECT COUNT(*) FROM documents");
      finalize();
      // The connection is still open; the next call re-prepares transparently.
      const after = exec("SELECT COUNT(*) FROM documents");
      expect(after).toEqual(before);
      // Finalizing an empty cache is a no-op.
      expect(() => finalize()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("does not poison the cache when a statement fails to prepare", () => {
    const db = openWasmFixture();
    try {
      const exec = makeExec(db).exec;
      expect(() => exec("SELECT * FROM no_such_table")).toThrow();
      // A later valid call is unaffected.
      expect(exec("SELECT COUNT(*) FROM documents")[0][0]).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("does not poison the cache when a prepared statement fails at step time", () => {
    const db = openWasmFixture();
    try {
      const exec = makeExec(db).exec;
      // Prepares cleanly, then errors at step (integer overflow).
      const failing = "SELECT abs(-9223372036854775807 - 1)";
      expect(() => exec(failing)).toThrow();
      // Re-running the same SQL re-prepares and errors again — the removed entry
      // did not leave a broken statement behind.
      expect(() => exec(failing)).toThrow();
      // And an interleaved valid call works.
      const rows = exec("SELECT id, title FROM documents ORDER BY id LIMIT 3");
      expect(rows).toHaveLength(3);
      expect(typeof rows[0][0]).toBe("number");
      expect(typeof rows[0][1]).toBe("string");
    } finally {
      db.close();
    }
  });
});
