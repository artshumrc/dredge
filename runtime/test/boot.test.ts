import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { boot, resetBootStateForTests, toDredgeError } from "../src/db";
import type { BootEnv, PoolLike } from "../src/db";
import type { DredgeManifest, DredgeStatus } from "../src/protocol";

// These tests pin CURRENT boot behavior through the injected BootEnv seam so
// later tier work (ticket 13) can change boot logic against a green baseline.
// Nothing here exercises the browser: fetch, the sqlite module, and the OPFS
// pool are all fakes, and boot runs in Node.

// A FakeDb stands in for both a pool-backed OpfsSAHPoolDb and an in-memory
// oo1.DB. Every instance records itself so a test can inspect how it was opened
// and which pragmas were applied.
const dbInstances: FakeDb[] = [];

class FakeDb {
  readonly openedFrom: string | undefined;
  readonly execCalls: string[] = [];
  readonly pointer = 1;
  closed = false;

  constructor(openedFrom?: string) {
    this.openedFrom = openedFrom;
    dbInstances.push(this);
  }

  exec(arg: string | { sql: string }): unknown[][] {
    this.execCalls.push(typeof arg === "string" ? arg : arg.sql);
    return [];
  }

  checkRc(rc: number): void {
    if (rc !== 0) {
      throw new Error(`unexpected sqlite rc ${rc}`);
    }
  }

  close(): void {
    this.closed = true;
  }
}

interface FakeSqlite {
  sqlite3: unknown;
  deserializeCalls: Array<{ length: number }>;
  allocCalls: Uint8Array[];
}

function makeFakeSqlite(): FakeSqlite {
  const deserializeCalls: Array<{ length: number }> = [];
  const allocCalls: Uint8Array[] = [];
  const sqlite3 = {
    oo1: { DB: FakeDb },
    wasm: {
      allocFromTypedArray(bytes: Uint8Array): number {
        allocCalls.push(bytes);
        return 0xdead;
      },
    },
    capi: {
      SQLITE_DESERIALIZE_FREEONCLOSE: 8,
      sqlite3_deserialize(
        _dbPtr: number,
        _schema: string,
        _ptr: number,
        length: number,
      ): number {
        deserializeCalls.push({ length });
        return 0;
      },
    },
  };
  return { sqlite3, deserializeCalls, allocCalls };
}

class FakePool implements PoolLike {
  readonly files = new Map<string, Uint8Array>();
  readonly imported: Array<{ path: string; bytes: Uint8Array }> = [];
  readonly unlinked: string[] = [];
  readonly OpfsSAHPoolDb = FakeDb;

  constructor(initial: Record<string, Uint8Array> = {}) {
    for (const [path, bytes] of Object.entries(initial)) {
      this.files.set(path, bytes);
    }
  }

  getFileNames(): string[] {
    return [...this.files.keys()];
  }

  importDb(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
    this.imported.push({ path, bytes });
  }

  unlink(path: string): void {
    this.files.delete(path);
    this.unlinked.push(path);
  }
}

const MANIFEST_URL = "https://dredge.test/dredge/manifest.json";
const DB_URL = "https://dredge.test/dredge/app.db";
const DB_BYTES = new Uint8Array([0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
const DB_SHA256 = createHash("sha256").update(DB_BYTES).digest("hex");
const DB_PATH = `/dredge/${DB_SHA256}.db`;

function makeManifest(overrides: Partial<DredgeManifest> = {}): DredgeManifest {
  return {
    manifest_version: 1,
    db_schema_version: 2,
    db_file: "app.db",
    db_sha256: DB_SHA256,
    // db_bytes equals the served length so decompress takes the host-decoded
    // path and never invokes brotli.
    db_bytes: DB_BYTES.byteLength,
    db_compressed_bytes: DB_BYTES.byteLength,
    db_compression: "br",
    sqlite_page_size: 4096,
    page_count: 1,
    config_hash: "cfg",
    runtime_min_version: "0.1.0",
    ...overrides,
  };
}

interface FetchOptions {
  manifestStatus?: number;
  manifestThrows?: boolean;
  manifestBody?: unknown;
  dbBytes?: Uint8Array;
}

function makeFetch(options: FetchOptions = {}): { fetch: BootEnv["fetch"]; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("manifest.json")) {
      if (options.manifestThrows) {
        throw new TypeError("network unreachable");
      }
      const status = options.manifestStatus ?? 200;
      const body = options.manifestBody ?? makeManifest();
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    }
    const bytes = options.dbBytes ?? DB_BYTES;
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => bytes.slice().buffer,
    } as Response;
  };
  return { fetch: fetchImpl as BootEnv["fetch"], calls };
}

interface EnvOptions {
  fetch?: BootEnv["fetch"];
  pool?: PoolLike;
  installPoolThrows?: boolean;
}

function makeEnv(options: EnvOptions = {}): { env: BootEnv; sqlite: FakeSqlite; pool?: PoolLike } {
  const sqlite = makeFakeSqlite();
  const fetch = options.fetch ?? makeFetch().fetch;
  const env: BootEnv = {
    fetch,
    initSqlite: async () => sqlite.sqlite3,
    installPool: async () => {
      if (options.installPoolThrows) {
        throw new Error("locked by another tab");
      }
      return options.pool;
    },
  };
  return { env, sqlite, pool: options.pool };
}

function recorder(): { status: (s: DredgeStatus, detail?: string) => void; seen: DredgeStatus[] } {
  const seen: DredgeStatus[] = [];
  return { status: (s) => seen.push(s), seen };
}

beforeEach(() => {
  resetBootStateForTests();
  dbInstances.length = 0;
});

describe("boot orchestration (BootEnv seam)", () => {
  it("cold OPFS boot downloads, decompresses, imports, and opens", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    const timings = await boot(MANIFEST_URL, false, status, env);

    expect(timings.fromCache).toBe(false);
    // Both the manifest and the database were fetched.
    expect(calls).toEqual([MANIFEST_URL, DB_URL]);
    // The decompressed bytes were imported under the content-hash path...
    expect(pool.imported).toHaveLength(1);
    expect(pool.imported[0].path).toBe(DB_PATH);
    expect([...pool.imported[0].bytes]).toEqual([...DB_BYTES]);
    // ...and a database was opened from exactly that pool file.
    expect(dbInstances).toHaveLength(1);
    expect(dbInstances[0].openedFrom).toBe(DB_PATH);
    expect(dbInstances[0].execCalls).toContain("PRAGMA temp_store = MEMORY");
    expect(seen).toEqual([
      "checking_support",
      "fetching_manifest",
      "checking_storage",
      "downloading_db",
      "decompressing_db",
      "writing_opfs",
      "opening_db",
      "ready",
    ]);
  });

  it("warm OPFS boot skips the download and opens the cached file", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool({ [DB_PATH]: DB_BYTES });
    const { env } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    const timings = await boot(MANIFEST_URL, false, status, env);

    expect(timings.fromCache).toBe(true);
    // Only the manifest was fetched; the database file was never requested.
    expect(calls).toEqual([MANIFEST_URL]);
    expect(pool.imported).toHaveLength(0);
    expect(dbInstances).toHaveLength(1);
    expect(dbInstances[0].openedFrom).toBe(DB_PATH);
    expect(seen).not.toContain("downloading_db");
    expect(seen).toContain("ready");
  });

  it("falls back to the in-memory backend when the pool is unavailable", async () => {
    const { fetch, calls } = makeFetch();
    // installPool resolves to undefined => memory backend.
    const { env, sqlite } = makeEnv({ fetch, pool: undefined });
    const { status, seen } = recorder();

    const timings = await boot(MANIFEST_URL, false, status, env);

    expect(timings.fromCache).toBe(false);
    // Memory mode always downloads and deserializes into WASM memory.
    expect(calls).toEqual([MANIFEST_URL, DB_URL]);
    expect(sqlite.allocCalls).toHaveLength(1);
    expect(sqlite.deserializeCalls).toEqual([{ length: DB_BYTES.byteLength }]);
    expect(dbInstances).toHaveLength(1);
    expect(dbInstances[0].openedFrom).toBeUndefined();
    // Memory path has no storage-check or OPFS-write step.
    expect(seen).not.toContain("checking_storage");
    expect(seen).not.toContain("writing_opfs");
    expect(seen).toEqual([
      "checking_support",
      "fetching_manifest",
      "downloading_db",
      "decompressing_db",
      "opening_db",
      "ready",
    ]);
  });

  it("falls back to memory with a status detail when pool installation fails", async () => {
    const { fetch } = makeFetch();
    const { env, sqlite } = makeEnv({ fetch, installPoolThrows: true });
    const details: Array<string | undefined> = [];
    const status = (s: DredgeStatus, detail?: string): void => {
      if (s === "checking_support") {
        details.push(detail);
      }
    };

    const timings = await boot(MANIFEST_URL, false, status, env);

    expect(timings.fromCache).toBe(false);
    expect(sqlite.deserializeCalls).toHaveLength(1);
    // The install failure surfaced as a checking_support status detail.
    expect(details.some((d) => typeof d === "string" && d.includes("locked by another tab"))).toBe(
      true,
    );
  });

  it("reuses already-decoded bytes and never invokes brotli", async () => {
    // The served bytes are not valid brotli; if decode ran it would throw
    // DB_DECOMPRESS_FAILED. Because db_bytes equals the served length, boot
    // must skip the decoder entirely and import the bytes unchanged.
    const { fetch } = makeFetch();
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    await expect(boot(MANIFEST_URL, false, status, env)).resolves.toMatchObject({
      fromCache: false,
    });
    expect([...pool.imported[0].bytes]).toEqual([...DB_BYTES]);
  });

  it("surfaces a manifest HTTP error as MANIFEST_FETCH_FAILED", async () => {
    const { fetch } = makeFetch({ manifestStatus: 503 });
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    await expect(boot(MANIFEST_URL, false, status, env).catch((e) => {
      throw new Error(toDredgeError(e).code);
    })).rejects.toThrow("MANIFEST_FETCH_FAILED");
  });

  it("cleans up stale /dredge databases after a cold import", async () => {
    const stalePath = "/dredge/deadbeef.db";
    const { fetch } = makeFetch();
    const pool = new FakePool({ [stalePath]: new Uint8Array([9, 9, 9]) });
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    await boot(MANIFEST_URL, false, status, env);

    // The stale file was unlinked and the freshly imported one retained.
    expect(pool.unlinked).toContain(stalePath);
    expect(pool.getFileNames()).toEqual([DB_PATH]);
  });
});
