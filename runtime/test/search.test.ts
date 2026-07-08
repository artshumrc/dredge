import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { introspectSchema, search } from "../src/search";
import { makeNodeSqliteExec } from "./node-sqlite-exec";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");

interface FixtureManifest {
  db_file: string;
}

function fixtureDbPath(): string {
  const manifestPath = join(fixtureRoot, "search", "search-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "Fixture database is missing; run `pnpm fixture` in runtime/ before `pnpm test`.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest;
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

      const response = search(exec, schema, { query: "uid50", limit: 5 });

      expect(response.total).toBe(1);
      expect(response.hits.map((hit) => hit.title)).toEqual(["Royal Mask 50"]);
    } finally {
      db.close();
    }
  });
});
