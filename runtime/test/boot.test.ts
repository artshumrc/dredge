import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";

import { beforeEach, describe, expect, it } from "vitest";

import { boot, getTier, resetBootStateForTests, toDredgeError } from "../src/db";
import type { BootEnv, PoolLike, StorageEstimateLike } from "../src/db";
import type { DredgeManifest, DredgeStatus } from "../src/protocol";

// Ticket 13 (Hot Tier runtime lifecycle) exercised through the injected BootEnv
// seam: cold boot serves the Hot Tier, the Full Tier swaps in behind it, warm
// boot skips the Hot Tier entirely, a failed Full Tier download stays on hot,
// integrity failures fail the boot, and a quota-short device keeps the Full Tier
// in memory. Nothing here touches the browser — fetch, the sqlite module, the
// OPFS pool and the storage estimate are all fakes, and boot runs in Node.

// A FakeDb stands in for both a pool-backed OpfsSAHPoolDb and an in-memory
// oo1.DB. Every instance records how it was opened so a test can inspect which
// tier it belongs to and whether the swap closed it.
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
const HOT_URL = "https://dredge.test/dredge/hot.db";
const FULL_URL = "https://dredge.test/dredge/full.db";

const HOT_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
const FULL_BYTES = new Uint8Array([0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
const HOT_SHA = createHash("sha256").update(HOT_BYTES).digest("hex");
const FULL_SHA = createHash("sha256").update(FULL_BYTES).digest("hex");
const FULL_PATH = `/dredge/${FULL_SHA}.db`;

function makeManifest(overrides: Partial<DredgeManifest> = {}): DredgeManifest {
  return {
    manifest_version: 1,
    db_schema_version: 2,
    db_file: "full.db",
    db_sha256: FULL_SHA,
    // Served length equals db_bytes so decompress takes the host-decoded path
    // and never invokes brotli.
    db_bytes: FULL_BYTES.byteLength,
    db_compressed_bytes: FULL_BYTES.byteLength,
    db_compression: "br",
    hot_db_file: "hot.db",
    hot_db_sha256: HOT_SHA,
    hot_db_bytes: HOT_BYTES.byteLength,
    hot_db_compressed_bytes: HOT_BYTES.byteLength,
    sqlite_page_size: 4096,
    page_count: 1,
    config_hash: "cfg",
    runtime_min_version: "0.1.0",
    ...overrides,
  };
}

interface FetchOptions {
  manifestStatus?: number;
  manifestBody?: unknown;
  hotBytes?: Uint8Array;
  fullBytes?: Uint8Array;
  fullThrows?: boolean;
  fullStatus?: number;
}

function makeFetch(options: FetchOptions = {}): { fetch: BootEnv["fetch"]; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("manifest.json")) {
      const status = options.manifestStatus ?? 200;
      const body = options.manifestBody ?? makeManifest();
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    }
    if (url.endsWith("hot.db")) {
      const bytes = options.hotBytes ?? HOT_BYTES;
      return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer } as Response;
    }
    // full.db
    if (options.fullThrows) {
      throw new TypeError("connection reset");
    }
    const status = options.fullStatus ?? 200;
    const bytes = options.fullBytes ?? FULL_BYTES;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => bytes.slice().buffer,
    } as Response;
  };
  return { fetch: fetchImpl as BootEnv["fetch"], calls };
}

interface EnvOptions {
  fetch?: BootEnv["fetch"];
  pool?: PoolLike;
  installPoolThrows?: boolean;
  estimate?: StorageEstimateLike | undefined;
  estimateThrows?: boolean;
  omitEstimate?: boolean;
}

function makeEnv(options: EnvOptions = {}): { env: BootEnv; sqlite: FakeSqlite } {
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
  if (!options.omitEstimate) {
    env.estimateStorage = async () => {
      if (options.estimateThrows) {
        throw new Error("estimate blew up");
      }
      return options.estimate;
    };
  }
  return { env, sqlite };
}

interface StatusEvent {
  status: DredgeStatus;
  detail?: string;
}

function recorder(): { status: (s: DredgeStatus, detail?: string) => void; seen: StatusEvent[] } {
  const seen: StatusEvent[] = [];
  return { status: (status, detail) => seen.push({ status, detail }), seen };
}

function statuses(seen: StatusEvent[]): DredgeStatus[] {
  return seen.map((event) => event.status);
}

beforeEach(() => {
  resetBootStateForTests();
  dbInstances.length = 0;
});

describe("hot/full tier boot lifecycle (BootEnv seam)", () => {
  it("cold OPFS boot serves the hot tier, then swaps the full tier in atomically", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool();
    const { env, sqlite } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);

    // boot() resolves on the hot tier: the full tier has not swapped in yet
    // (its download awaits after boot returns), so only the hot db is live.
    expect(session.tier).toBe("hot");
    expect(getTier()).toBe("hot");
    expect(sqlite.deserializeCalls).toEqual([{ length: HOT_BYTES.byteLength }]);
    expect(pool.imported).toHaveLength(0);
    // The hot boot ran to ready_hot before any full-tier work.
    expect(statuses(seen).slice(0, 6)).toEqual([
      "checking_support",
      "fetching_manifest",
      "downloading_db",
      "decompressing_db",
      "opening_db",
      "ready_hot",
    ]);

    // The background full-tier upgrade completes and swaps in.
    expect(session.fullTier).toBeDefined();
    await session.fullTier;

    expect(getTier()).toBe("full");
    expect(calls).toEqual([MANIFEST_URL, HOT_URL, FULL_URL]);
    // The full tier was imported to OPFS under the content-hash path and opened
    // from exactly that pool file.
    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
    const hotDb = dbInstances[0];
    const fullDb = dbInstances[1];
    expect(hotDb.openedFrom).toBeUndefined();
    expect(fullDb.openedFrom).toBe(FULL_PATH);
    // Swap order: the full handle stays open; the old hot handle is closed
    // (freeing its memory) only after the full handle is installed.
    expect(fullDb.closed).toBe(false);
    expect(hotDb.closed).toBe(true);
    expect(statuses(seen)).toContain("ready");
  });

  it("warm OPFS boot opens the full tier directly and never fetches the hot tier", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool({ [FULL_PATH]: FULL_BYTES });
    const { env } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);

    expect(session.tier).toBe("full");
    expect(getTier()).toBe("full");
    expect(session.fullTier).toBeUndefined();
    expect(session.timings.fromCache).toBe(true);
    // Only the manifest was fetched: no hot tier, no full download.
    expect(calls).toEqual([MANIFEST_URL]);
    expect(pool.imported).toHaveLength(0);
    expect(dbInstances).toHaveLength(1);
    expect(dbInstances[0].openedFrom).toBe(FULL_PATH);
    expect(statuses(seen)).not.toContain("ready_hot");
    expect(statuses(seen)).not.toContain("downloading_db");
    expect(statuses(seen)).toContain("ready");
  });

  it("reset forces a cold boot even when the full tier is already cached", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool({ [FULL_PATH]: FULL_BYTES });
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, true, status, env);
    await session.fullTier;

    // The cached full tier was unlinked and the hot-then-full lifecycle ran.
    expect(pool.unlinked).toContain(FULL_PATH);
    expect(calls).toEqual([MANIFEST_URL, HOT_URL, FULL_URL]);
    expect(getTier()).toBe("full");
  });

  it("keeps the session on the hot tier when the full-tier download fails", async () => {
    const { fetch, calls } = makeFetch({ fullThrows: true });
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    // The upgrade promise settles (never rejects) even though the download died.
    await session.fullTier;

    expect(getTier()).toBe("hot");
    // We attempted the full download but stayed on hot; the swap never happened.
    expect(calls).toEqual([MANIFEST_URL, HOT_URL, FULL_URL]);
    expect(pool.imported).toHaveLength(0);
    // Never transitioned to "failed"; the last status is ready_hot with a detail.
    expect(statuses(seen)).not.toContain("failed");
    const lastReadyHot = [...seen].reverse().find((event) => event.status === "ready_hot");
    expect(lastReadyHot?.detail).toMatch(/full tier unavailable/i);
  });

  it("fails the boot when the hot tier fails its integrity check", async () => {
    // Serve hot bytes that do not hash to manifest.hot_db_sha256.
    const { fetch } = makeFetch({ hotBytes: new Uint8Array([9, 9, 9, 9, 9]) });
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    await expect(
      boot(MANIFEST_URL, false, status, env).catch((error) => {
        throw new Error(toDredgeError(error).code);
      }),
    ).rejects.toThrow("DB_STORAGE_CORRUPT");
  });

  it("opens the full tier in memory when the storage quota is too low", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool();
    // Headroom (quota - usage) below db_bytes * 1.1 → skip OPFS persistence.
    const { env, sqlite } = makeEnv({
      fetch,
      pool,
      estimate: { quota: FULL_BYTES.byteLength, usage: 0 },
    });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.fullTier;

    expect(getTier()).toBe("full");
    expect(calls).toEqual([MANIFEST_URL, HOT_URL, FULL_URL]);
    // The full tier was NOT persisted; it was deserialized into memory instead.
    expect(pool.imported).toHaveLength(0);
    expect(sqlite.deserializeCalls).toEqual([
      { length: HOT_BYTES.byteLength },
      { length: FULL_BYTES.byteLength },
    ]);
    const quotaDetail = seen.find(
      (event) => event.status === "ready_hot" && /quota/i.test(event.detail ?? ""),
    );
    expect(quotaDetail).toBeDefined();
    expect(statuses(seen)).toContain("ready");
  });

  it("persists the full tier when the quota preflight reports ample headroom", async () => {
    const { fetch } = makeFetch();
    const pool = new FakePool();
    const { env } = makeEnv({
      fetch,
      pool,
      estimate: { quota: FULL_BYTES.byteLength * 100, usage: 0 },
    });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.fullTier;

    expect(getTier()).toBe("full");
    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
  });

  it("boots both tiers in memory when OPFS is unavailable", async () => {
    const { fetch, calls } = makeFetch();
    // installPool resolves to undefined => memory backend, no pool at all.
    const { env, sqlite } = makeEnv({ fetch, pool: undefined });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    expect(session.tier).toBe("hot");
    expect(getTier()).toBe("hot");
    await session.fullTier;

    expect(getTier()).toBe("full");
    expect(calls).toEqual([MANIFEST_URL, HOT_URL, FULL_URL]);
    // Both tiers deserialized into WASM memory; nothing imported.
    expect(sqlite.deserializeCalls).toEqual([
      { length: HOT_BYTES.byteLength },
      { length: FULL_BYTES.byteLength },
    ]);
    // Hot handle closed after the in-memory full handle swapped in.
    expect(dbInstances).toHaveLength(2);
    expect(dbInstances[0].closed).toBe(true);
    expect(dbInstances[1].closed).toBe(false);
    expect(statuses(seen)).toContain("ready_hot");
    expect(statuses(seen)).toContain("ready");
  });

  it("falls back to memory with a status detail when pool installation fails", async () => {
    const { fetch } = makeFetch();
    const { env, sqlite } = makeEnv({ fetch, installPoolThrows: true });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.fullTier;

    expect(getTier()).toBe("full");
    // Both tiers landed in memory; the install failure surfaced as a detail.
    expect(sqlite.deserializeCalls).toHaveLength(2);
    const installDetail = seen.find(
      (event) => event.status === "checking_support" && (event.detail ?? "").includes("locked by another tab"),
    );
    expect(installDetail).toBeDefined();
  });

  it("proceeds to persist when the storage estimate is unavailable", async () => {
    const { fetch } = makeFetch();
    const pool = new FakePool();
    // No estimateStorage on the env at all → preflight is skipped.
    const { env } = makeEnv({ fetch, pool, omitEstimate: true });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.fullTier;

    expect(getTier()).toBe("full");
    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
  });

  it("surfaces a manifest HTTP error as MANIFEST_FETCH_FAILED", async () => {
    const { fetch } = makeFetch({ manifestStatus: 503 });
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    await expect(
      boot(MANIFEST_URL, false, status, env).catch((error) => {
        throw new Error(toDredgeError(error).code);
      }),
    ).rejects.toThrow("MANIFEST_FETCH_FAILED");
  });

  it("cleans up stale /dredge databases after the full tier is imported", async () => {
    const stalePath = "/dredge/deadbeef.db";
    const { fetch } = makeFetch();
    const pool = new FakePool({ [stalePath]: new Uint8Array([9, 9, 9]) });
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.fullTier;

    expect(pool.unlinked).toContain(stalePath);
    expect(pool.getFileNames()).toEqual([FULL_PATH]);
  });

  it("decodes brotli-compressed downloads through the decode-only decoder", async () => {
    // Ticket 14: unlike every test above (which serves already-decoded bytes so
    // decompress() takes the host-decoded fast path), this serves genuinely
    // brotli-compressed bytes for both tiers, forcing the in-worker decode. The
    // decoder must reconstruct the exact raw bytes — verified by the sha256
    // integrity check passing and by the deserialize length / imported bytes.
    const hotRaw = new Uint8Array(768).map((_, i) => (i * 7) % 251);
    const fullRaw = new Uint8Array(1536).map((_, i) => (i * 13) % 249);
    const hotCompressed = new Uint8Array(brotliCompressSync(Buffer.from(hotRaw)));
    const fullCompressed = new Uint8Array(brotliCompressSync(Buffer.from(fullRaw)));
    // Compression must actually shrink these fixtures, otherwise decompress()
    // would see matching lengths and skip the decoder we mean to exercise.
    expect(hotCompressed.byteLength).toBeLessThan(hotRaw.byteLength);
    expect(fullCompressed.byteLength).toBeLessThan(fullRaw.byteLength);

    const hotSha = createHash("sha256").update(hotRaw).digest("hex");
    const fullSha = createHash("sha256").update(fullRaw).digest("hex");
    const fullPath = `/dredge/${fullSha}.db`;

    const manifest = makeManifest({
      db_sha256: fullSha,
      db_bytes: fullRaw.byteLength,
      db_compressed_bytes: fullCompressed.byteLength,
      hot_db_sha256: hotSha,
      hot_db_bytes: hotRaw.byteLength,
      hot_db_compressed_bytes: hotCompressed.byteLength,
    });

    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, json: async () => manifest } as Response;
      }
      const bytes = url.endsWith("hot.db") ? hotCompressed : fullCompressed;
      return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer } as Response;
    };

    const pool = new FakePool();
    const { env, sqlite } = makeEnv({ fetch: fetchImpl as BootEnv["fetch"], pool });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.fullTier;

    expect(calls).toEqual([MANIFEST_URL, HOT_URL, FULL_URL]);
    // Hot tier decoded to its raw length and deserialized into memory; the full
    // tier decoded to its raw bytes and was imported to OPFS verbatim. Both
    // paths cleared the sha256 integrity check, which only passes on exact bytes.
    expect(sqlite.deserializeCalls).toEqual([{ length: hotRaw.byteLength }]);
    expect(pool.imported).toEqual([{ path: fullPath, bytes: fullRaw }]);
    expect(getTier()).toBe("full");
    expect(statuses(seen)).toContain("ready");
  });
});
