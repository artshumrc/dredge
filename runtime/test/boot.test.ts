import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";

import { beforeEach, describe, expect, it } from "vitest";

import { boot, closeDatabase, getExec, resetBootStateForTests, toDredgeError } from "../src/db";
import type { BootEnv, PoolLike, StorageEstimateLike } from "../src/db";
import type { DredgeManifest, DredgeStatus } from "../src/protocol";

// Boot lifecycle exercised through the injected BootEnv seam: a cold boot
// downloads + verifies the database, opens it in memory to reach ready, then
// persists it to OPFS in the background and swaps the connection onto the
// persisted handle; a warm boot opens the cached OPFS copy directly; download
// and integrity failures fail the boot; a quota-short device keeps the database
// in memory; and a background persist failure leaves the memory session serving.
// Nothing here touches the browser — fetch, the sqlite module, the OPFS pool and
// the storage estimate are all fakes, and boot runs in Node.

// A FakeDb stands in for both a pool-backed OpfsSAHPoolDb and an in-memory
// oo1.DB. Every instance records how it was opened so a test can inspect where
// it came from and whether it was later closed.
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

interface PoolOptions {
  // Invoked at the moment importDb runs, before the bytes are stored. Lets a
  // test observe what had already happened (e.g. that `ready` was reported)
  // when the deferred background write fired.
  onImport?: (path: string, bytes: Uint8Array) => void;
  // When set, importDb throws instead of storing — a persist failure.
  importThrows?: boolean;
}

class FakePool implements PoolLike {
  readonly files = new Map<string, Uint8Array>();
  readonly imported: Array<{ path: string; bytes: Uint8Array }> = [];
  readonly unlinked: string[] = [];
  readonly OpfsSAHPoolDb = FakeDb;
  private readonly onImport?: (path: string, bytes: Uint8Array) => void;
  private readonly importThrows: boolean;

  constructor(initial: Record<string, Uint8Array> = {}, options: PoolOptions = {}) {
    for (const [path, bytes] of Object.entries(initial)) {
      this.files.set(path, bytes);
    }
    this.onImport = options.onImport;
    this.importThrows = options.importThrows ?? false;
  }

  getFileNames(): string[] {
    return [...this.files.keys()];
  }

  importDb(path: string, bytes: Uint8Array): void {
    this.onImport?.(path, bytes);
    if (this.importThrows) {
      throw new Error("OPFS write failed");
    }
    this.files.set(path, bytes);
    this.imported.push({ path, bytes });
  }

  unlink(path: string): void {
    this.files.delete(path);
    this.unlinked.push(path);
  }
}

const MANIFEST_URL = "https://dredge.test/dredge/manifest.json";
const FULL_URL = "https://dredge.test/dredge/full.db";

const FULL_BYTES = new Uint8Array([0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
const FULL_SHA = createHash("sha256").update(FULL_BYTES).digest("hex");
const FULL_PATH = `/dredge/${FULL_SHA}.db`;

function makeManifest(overrides: Partial<DredgeManifest> = {}): DredgeManifest {
  return {
    manifest_version: 1,
    db_schema_version: 3,
    db_file: "full.db",
    db_sha256: FULL_SHA,
    // Served length equals db_bytes so decompress takes the host-decoded path
    // and never invokes brotli.
    db_bytes: FULL_BYTES.byteLength,
    db_compressed_bytes: FULL_BYTES.byteLength,
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
  manifestBody?: unknown;
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

describe("database boot lifecycle (BootEnv seam)", () => {
  it("cold OPFS boot reaches ready on the in-memory copy before persisting to OPFS", async () => {
    const { fetch, calls } = makeFetch();
    // Capture what had already been reported at the instant the deferred write
    // fired: `ready` must precede it.
    let statusesAtImport: DredgeStatus[] | undefined;
    const { status, seen } = recorder();
    const pool = new FakePool(
      {},
      { onImport: () => (statusesAtImport = statuses(seen)) },
    );
    const { env, sqlite } = makeEnv({ fetch, pool });

    const session = await boot(MANIFEST_URL, false, status, env);

    // Ready is reached from the in-memory (deserialized) copy, and the OPFS
    // write has not happened yet — it is deferred to the background.
    expect(session.fromCache).toBe(false);
    expect(statuses(seen)).toContain("ready");
    expect(statuses(seen)).not.toContain("writing_opfs");
    expect(pool.imported).toHaveLength(0);
    expect(sqlite.deserializeCalls).toEqual([{ length: FULL_BYTES.byteLength }]);
    // Only the in-memory handle exists so far.
    expect(dbInstances).toHaveLength(1);
    expect(dbInstances[0].openedFrom).toBeUndefined();
    // The status progression to ready never mentions the OPFS write.
    expect(statuses(seen)).toEqual([
      "checking_support",
      "fetching_manifest",
      "downloading_db",
      "decompressing_db",
      "opening_db",
      "ready",
    ]);

    // The background persist now writes to OPFS and swaps the connection onto it.
    await session.persistence;

    expect(calls).toEqual([MANIFEST_URL, FULL_URL]);
    // Import fired after ready was reported.
    expect(statusesAtImport).toContain("ready");
    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
    // The connection swapped to the OPFS handle; the in-memory copy was closed.
    expect(dbInstances).toHaveLength(2);
    expect(dbInstances[0].openedFrom).toBeUndefined();
    expect(dbInstances[0].closed).toBe(true);
    expect(dbInstances[1].openedFrom).toBe(FULL_PATH);
    expect(dbInstances[1].closed).toBe(false);
    // writing_opfs is emitted, but only after ready.
    expect(statuses(seen).indexOf("ready")).toBeLessThan(statuses(seen).indexOf("writing_opfs"));
  });

  it("records time-to-ready separately from the deferred OPFS write", async () => {
    const { fetch } = makeFetch();
    // A deliberately slow OPFS write so writeOpfsMs is clearly measurable and
    // clearly excluded from the ready timing (totalMs).
    const pool = new FakePool(
      {},
      {
        onImport: () => {
          const until = performance.now() + 25;
          while (performance.now() < until) {
            // Busy-wait: model an expensive synchronous OPFS import.
          }
        },
      },
    );
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    const readyTotal = session.timings.totalMs;
    expect(session.timings.writeOpfsMs).toBe(0); // not written yet

    await session.persistence;

    // The background write is recorded, and time-to-ready did not include it.
    expect(session.timings.writeOpfsMs).toBeGreaterThanOrEqual(20);
    expect(readyTotal).toBeLessThan(session.timings.writeOpfsMs);
  });

  it("keeps the memory session serving when the background OPFS write fails", async () => {
    const { fetch } = makeFetch();
    const pool = new FakePool({}, { importThrows: true });
    const { env, sqlite } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.persistence;

    // The write failed, so nothing was stored and no swap happened: the single
    // in-memory handle is still open and serving.
    expect(pool.imported).toHaveLength(0);
    expect(sqlite.deserializeCalls).toEqual([{ length: FULL_BYTES.byteLength }]);
    expect(dbInstances).toHaveLength(1);
    expect(dbInstances[0].openedFrom).toBeUndefined();
    expect(dbInstances[0].closed).toBe(false);
    // The session is still open (getExec does not throw); a status detail records
    // the downgrade.
    expect(() => getExec()).not.toThrow();
    const failDetail = seen.find(
      (event) => event.status === "checking_storage" && /OPFS/i.test(event.detail ?? ""),
    );
    expect(failDetail).toBeDefined();
    // Ready was reached regardless of the persist failure.
    expect(statuses(seen)).toContain("ready");
  });

  it("warm OPFS boot opens the cached database directly with no download", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool({ [FULL_PATH]: FULL_BYTES });
    const { env } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);

    expect(session.fromCache).toBe(true);
    expect(session.timings.fromCache).toBe(true);
    // Only the manifest was fetched: no database download.
    expect(calls).toEqual([MANIFEST_URL]);
    expect(pool.imported).toHaveLength(0);
    expect(dbInstances).toHaveLength(1);
    expect(dbInstances[0].openedFrom).toBe(FULL_PATH);
    expect(statuses(seen)).not.toContain("downloading_db");
    expect(statuses(seen)).toContain("ready");
  });

  it("reset forces a cold boot even when the database is already cached", async () => {
    const { fetch, calls } = makeFetch();
    const pool = new FakePool({ [FULL_PATH]: FULL_BYTES });
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, true, status, env);
    await session.persistence;

    // The cached database was unlinked and re-downloaded from scratch, then
    // re-persisted in the background.
    expect(session.fromCache).toBe(false);
    expect(pool.unlinked).toContain(FULL_PATH);
    expect(calls).toEqual([MANIFEST_URL, FULL_URL]);
    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
  });

  it("supersedes an in-flight background persist when a reset re-boots", async () => {
    // Boot #1's background persist is parked at the storage estimate; a reset
    // re-boot (#2) claims a newer boot generation before #1 resumes. The
    // superseded persist must neither write stale bytes to OPFS nor swap the
    // connection out from under the fresh boot — the boot-generation guard is
    // the only thing that stops it. Without it, #1 would import and swap a
    // second time after #2 already installed its handle.
    let releaseEstimate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseEstimate = resolve));
    let estimateCalls = 0;
    const { fetch } = makeFetch();
    const pool = new FakePool();
    const { sqlite3 } = makeFakeSqlite();
    const env: BootEnv = {
      fetch,
      initSqlite: async () => sqlite3,
      installPool: async () => pool,
      estimateStorage: async () => {
        estimateCalls += 1;
        if (estimateCalls === 1) {
          await gate; // hold boot #1's persist before it writes to OPFS
        }
        return undefined; // ample headroom → the persist would proceed to import
      },
    };
    const { status } = recorder();

    // Boot #1 (cold) reaches ready; its persistence is left pending, parked at
    // the storage estimate before importDb.
    const first = await boot(MANIFEST_URL, false, status, env);
    expect(first.fromCache).toBe(false);
    expect(pool.imported).toHaveLength(0);

    // Boot #2 (reset) re-boots, bumping the generation, and completes its own
    // persist (its ungated estimate is the 2nd call).
    const second = await boot(MANIFEST_URL, true, status, env);
    await second.persistence;
    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
    const instancesAfterSecond = dbInstances.length;

    // Release the superseded persist: the generation guard makes it a no-op —
    // no second import, no extra handle opened for a swap.
    releaseEstimate();
    await first.persistence;

    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
    expect(dbInstances).toHaveLength(instancesAfterSecond);
  });

  it("keeps teardown safe when close lands during an in-flight persist", async () => {
    // Ticket 04 contract: reset/close during any phase stays safe. Close the
    // database while the background persist is parked at the storage estimate;
    // the `!opened` re-check after the await must abandon the persist so nothing
    // is imported or swapped onto the torn-down handle, and the promise still
    // settles without rejecting.
    let releaseEstimate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseEstimate = resolve));
    const { fetch } = makeFetch();
    const pool = new FakePool();
    const { sqlite3 } = makeFakeSqlite();
    const env: BootEnv = {
      fetch,
      initSqlite: async () => sqlite3,
      installPool: async () => pool,
      estimateStorage: async () => {
        await gate; // hold the persist before importDb
        return undefined;
      },
    };
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    expect(pool.imported).toHaveLength(0);

    // Teardown mid-persist, then let the persist resume.
    closeDatabase();
    releaseEstimate();
    await expect(session.persistence).resolves.toBeUndefined();

    // The persist wrote nothing and did not swap onto the closed handle; the
    // session stays torn down.
    expect(pool.imported).toHaveLength(0);
    expect(() => getExec()).toThrow();
  });

  it("fails the boot when the database download fails", async () => {
    const { fetch } = makeFetch({ fullThrows: true });
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status, seen } = recorder();

    await expect(
      boot(MANIFEST_URL, false, status, env).catch((error) => {
        throw new Error(toDredgeError(error).code);
      }),
    ).rejects.toThrow("DB_DOWNLOAD_FAILED");
    // Nothing was persisted; the failure propagates rather than serving a
    // half-open database.
    expect(pool.imported).toHaveLength(0);
    expect(statuses(seen)).not.toContain("ready");
  });

  it("fails the boot when the database fails its integrity check", async () => {
    // Serve bytes that do not hash to manifest.db_sha256.
    const { fetch } = makeFetch({ fullBytes: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]) });
    const pool = new FakePool();
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    await expect(
      boot(MANIFEST_URL, false, status, env).catch((error) => {
        throw new Error(toDredgeError(error).code);
      }),
    ).rejects.toThrow("DB_STORAGE_CORRUPT");
    expect(pool.imported).toHaveLength(0);
  });

  it("opens the database in memory when the storage quota is too low", async () => {
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
    await session.persistence;

    expect(session.fromCache).toBe(false);
    expect(calls).toEqual([MANIFEST_URL, FULL_URL]);
    // The database was NOT persisted; it was deserialized into memory instead,
    // and the background persist skipped the write for want of headroom.
    expect(pool.imported).toHaveLength(0);
    expect(sqlite.deserializeCalls).toEqual([{ length: FULL_BYTES.byteLength }]);
    const quotaDetail = seen.find(
      (event) => event.status === "checking_storage" && /quota/i.test(event.detail ?? ""),
    );
    expect(quotaDetail).toBeDefined();
    expect(statuses(seen)).toContain("ready");
  });

  it("persists the database when the quota preflight reports ample headroom", async () => {
    const { fetch } = makeFetch();
    const pool = new FakePool();
    const { env } = makeEnv({
      fetch,
      pool,
      estimate: { quota: FULL_BYTES.byteLength * 100, usage: 0 },
    });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.persistence;

    expect(pool.imported).toEqual([{ path: FULL_PATH, bytes: FULL_BYTES }]);
  });

  it("boots in memory when OPFS is unavailable", async () => {
    const { fetch, calls } = makeFetch();
    // installPool resolves to undefined => memory backend, no pool at all.
    const { env, sqlite } = makeEnv({ fetch, pool: undefined });
    const { status, seen } = recorder();

    await boot(MANIFEST_URL, false, status, env);

    expect(calls).toEqual([MANIFEST_URL, FULL_URL]);
    // The database was deserialized into WASM memory; nothing imported.
    expect(sqlite.deserializeCalls).toEqual([{ length: FULL_BYTES.byteLength }]);
    expect(dbInstances).toHaveLength(1);
    expect(statuses(seen)).toContain("ready");
  });

  it("falls back to memory with a status detail when pool installation fails", async () => {
    const { fetch } = makeFetch();
    const { env, sqlite } = makeEnv({ fetch, installPoolThrows: true });
    const { status, seen } = recorder();

    await boot(MANIFEST_URL, false, status, env);

    // The database landed in memory; the install failure surfaced as a detail.
    expect(sqlite.deserializeCalls).toHaveLength(1);
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
    await session.persistence;

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

  it("cleans up stale /dredge databases after the database is imported", async () => {
    const stalePath = "/dredge/deadbeef.db";
    const { fetch } = makeFetch();
    const pool = new FakePool({ [stalePath]: new Uint8Array([9, 9, 9]) });
    const { env } = makeEnv({ fetch, pool });
    const { status } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.persistence;

    expect(pool.unlinked).toContain(stalePath);
    expect(pool.getFileNames()).toEqual([FULL_PATH]);
  });

  it("decodes brotli-compressed downloads through the decode-only decoder", async () => {
    // Unlike the tests above (which serve already-decoded bytes so decompress()
    // takes the host-decoded fast path), this serves genuinely brotli-compressed
    // bytes, forcing the in-worker decode. The decoder must reconstruct the exact
    // raw bytes — verified by the sha256 integrity check passing and by the
    // imported bytes matching.
    const fullRaw = new Uint8Array(1536).map((_, i) => (i * 13) % 249);
    const fullCompressed = new Uint8Array(brotliCompressSync(Buffer.from(fullRaw)));
    // Compression must actually shrink the fixture, otherwise decompress() would
    // see matching lengths and skip the decoder we mean to exercise.
    expect(fullCompressed.byteLength).toBeLessThan(fullRaw.byteLength);

    const fullSha = createHash("sha256").update(fullRaw).digest("hex");
    const fullPath = `/dredge/${fullSha}.db`;

    const manifest = makeManifest({
      db_sha256: fullSha,
      db_bytes: fullRaw.byteLength,
      db_compressed_bytes: fullCompressed.byteLength,
    });

    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, json: async () => manifest } as Response;
      }
      return { ok: true, status: 200, arrayBuffer: async () => fullCompressed.slice().buffer } as Response;
    };

    const pool = new FakePool();
    const { env } = makeEnv({ fetch: fetchImpl as BootEnv["fetch"], pool });
    const { status, seen } = recorder();

    const session = await boot(MANIFEST_URL, false, status, env);
    await session.persistence;

    expect(calls).toEqual([MANIFEST_URL, FULL_URL]);
    // The database decoded to its raw bytes and was imported to OPFS verbatim;
    // the path cleared the sha256 integrity check, which only passes on exact
    // bytes.
    expect(pool.imported).toEqual([{ path: fullPath, bytes: fullRaw }]);
    expect(statuses(seen)).toContain("ready");
  });
});
