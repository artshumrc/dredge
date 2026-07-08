import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { toDredgeError, validateManifest, verifyDatabaseHash } from "../src/db";
import { introspectSchema, search } from "../src/search";
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

  it("keeps facet counts under all-filters-except-own after single-pass", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      const response = search(exec, schema, {
        query: "temple",
        filters: { category: "object" },
        includeFacets: ["category", "year"],
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

  it("tags each response with the tier that served it", () => {
    const db = new DatabaseSync(fixtureDbPath());
    try {
      const exec = makeNodeSqliteExec(db);
      const schema = introspectSchema(exec);

      // Keyword (single-pass) and browse both stamp the tier they were told.
      expect(search(exec, schema, { query: "temple", limit: 2 }, "hot").tier).toBe("hot");
      expect(search(exec, schema, { limit: 2 }, "hot").tier).toBe("hot");
      expect(search(exec, schema, { query: "temple", limit: 2 }, "full").tier).toBe("full");
      // The default (no tier argument) is the steady-state full tier.
      expect(search(exec, schema, { limit: 2 }).tier).toBe("full");
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
