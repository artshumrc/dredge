/// <reference lib="webworker" />

import type { BootTimings, DredgeError, DredgeManifest, DredgeStatus } from "./protocol";

const MANIFEST_VERSION = 1;
const DB_SCHEMA_VERSION = 2;

export type StatusFn = (status: DredgeStatus, detail?: string) => void;

// The SAH pool utility installed into a sqlite3 module. Boot logic uses only
// this surface, which the fake pool in tests mirrors.
export interface PoolLike {
  getFileNames(): string[];
  importDb(path: string, bytes: Uint8Array): void;
  unlink(path: string): void;
  OpfsSAHPoolDb: new (path: string) => unknown;
}

// A subset of the DOM `StorageEstimate` — just what the quota preflight reads.
export interface StorageEstimateLike {
  quota?: number;
  usage?: number;
}

// The injectable boot environment: everything boot orchestration needs from the
// outside world (network, sqlite WASM module, OPFS persistence). The worker
// entry point (`search-worker.ts`) constructs the real implementation; Node
// tests pass fakes. Boot logic never touches global fetch, the sqlite WASM
// initializer or the OPFS pool installer directly — it all arrives here.
export interface BootEnv {
  fetch: typeof fetch;
  // Initialize the sqlite3 WASM module.
  initSqlite(): Promise<any>;
  // Install the OPFS SAH pool VFS. Resolves to the pool utility when persistent
  // storage is available, or `undefined` to select the in-memory backend. A
  // rejection is treated as an install failure (memory fallback, with a status
  // detail), matching today's behavior.
  installPool(sqlite3: unknown): Promise<PoolLike | undefined>;
  // Estimate available persistent storage (browser: navigator.storage.estimate).
  // Used only for the OPFS quota preflight. Optional: when absent, or when it
  // resolves without a numeric `quota`, the preflight is skipped and the OPFS
  // import proceeds as before.
  estimateStorage?(): Promise<StorageEstimateLike | undefined>;
}

export class WorkerError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(error: DredgeError) {
    super(error.message);
    this.code = error.code;
    this.details = error.details;
  }
}

export function toDredgeError(error: unknown): DredgeError {
  if (error instanceof WorkerError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return { code: (error as { code: string }).code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "QUERY_FAILED", message: error.message };
  }
  return { code: "QUERY_FAILED", message: String(error) };
}

export type Exec = (sql: string, bind?: unknown[]) => unknown[][];

interface OpenDatabase {
  db: unknown;
  manifest: DredgeManifest;
  exec: Exec;
}

// Storage backend chosen at boot. "opfs" uses the SAH pool VFS for persistence;
// "memory" deserializes the database into WASM memory and is used as a fallback
// when the SAH pool is unavailable — most commonly because another tab in the
// same origin already holds the pool's exclusive access handles
// (NoModificationAllowedError), or when the environment lacks OPFS sync access.
type StorageBackend = "opfs" | "memory";

let sqlite3: any;
let poolUtil: any;
let opened: OpenDatabase | undefined;
let backend: StorageBackend = "opfs";

// Test-only: clear the cached sqlite module, pool, backend and open handle so a
// fresh boot can be driven with a new injected environment. Production never
// calls this — a worker boots once (reset re-boots reuse the cached module).
export function resetBootStateForTests(): void {
  sqlite3 = undefined;
  poolUtil = undefined;
  opened = undefined;
  backend = "opfs";
}

async function ensureSqlite(env: BootEnv, status: StatusFn): Promise<void> {
  if (sqlite3) {
    return;
  }
  try {
    sqlite3 = await env.initSqlite();
  } catch (error) {
    throw new WorkerError({
      code: "SQLITE_OPEN_FAILED",
      message: `Failed to initialize SQLite WASM: ${(error as Error).message}`,
    });
  }

  // Prefer the persistent OPFS SAH pool VFS. `installPool` resolves to
  // `undefined` when persistence is unsupported (silent memory fallback) and
  // rejects when installation itself fails — most commonly because another tab
  // already holds the pool's exclusive access handles — in which case we fall
  // back to an in-memory database with a status detail instead of failing boot.
  try {
    poolUtil = await env.installPool(sqlite3);
    backend = poolUtil ? "opfs" : "memory";
  } catch (error) {
    poolUtil = undefined;
    backend = "memory";
    status(
      "checking_support",
      `OPFS persistence unavailable (${(error as Error).message}); using in-memory database for this tab.`,
    );
  }
}

async function fetchManifest(env: BootEnv, manifestUrl: string): Promise<DredgeManifest> {
  let response: Response;
  try {
    response = await env.fetch(manifestUrl, { cache: "no-cache" });
  } catch (error) {
    throw new WorkerError({
      code: "MANIFEST_FETCH_FAILED",
      message: `Failed to fetch manifest: ${(error as Error).message}`,
    });
  }
  if (!response.ok) {
    throw new WorkerError({
      code: "MANIFEST_FETCH_FAILED",
      message: `Manifest request returned HTTP ${response.status}`,
    });
  }
  try {
    return (await response.json()) as DredgeManifest;
  } catch (error) {
    throw new WorkerError({
      code: "MANIFEST_FETCH_FAILED",
      message: `Manifest is not valid JSON: ${(error as Error).message}`,
    });
  }
}

export function validateManifest(manifest: DredgeManifest): void {
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    throw new WorkerError({
      code: "SCHEMA_VERSION_MISMATCH",
      message: `Manifest version ${manifest.manifest_version} is not supported; expected ${MANIFEST_VERSION}.`,
    });
  }
  if (manifest.db_schema_version !== DB_SCHEMA_VERSION) {
    throw new WorkerError({
      code: "SCHEMA_VERSION_MISMATCH",
      message: `Database schema version ${manifest.db_schema_version} is not supported; expected ${DB_SCHEMA_VERSION}.`,
    });
  }
}

// Fetch and validate the manifest without booting a database. Multi-tab leader
// election needs the manifest's sha256 (to namespace the leadership lock and
// relay channel per deployment) before deciding whether this tab boots the
// database or follows another tab — followers never call boot(), so they load
// the manifest through here instead.
export async function loadValidatedManifest(
  env: BootEnv,
  manifestUrl: string,
): Promise<DredgeManifest> {
  const manifest = await fetchManifest(env, manifestUrl);
  validateManifest(manifest);
  return manifest;
}

function dbPathFor(manifest: DredgeManifest): string {
  // Namespace the stored database by its content hash so a new database never
  // collides with a stale one.
  return `/dredge/${manifest.db_sha256}.db`;
}

function poolHasFile(path: string): boolean {
  try {
    const names: string[] = poolUtil.getFileNames();
    return names.includes(path);
  } catch {
    return false;
  }
}

// Base URL that relative `db_file` entries resolve against. In a browser worker
// this is the worker's own location; in Node (tests) there is no `self`, so the
// already-absolute manifest URL serves as its own base.
function resolveManifestBase(manifestUrl: string): string {
  if (typeof self !== "undefined" && self.location) {
    return new URL(manifestUrl, self.location.href).toString();
  }
  return manifestUrl;
}

async function downloadCompressed(
  env: BootEnv,
  fileName: string,
  baseUrl: string,
): Promise<Uint8Array> {
  const url = new URL(fileName, baseUrl).toString();
  let response: Response;
  try {
    response = await env.fetch(url, { cache: "force-cache" });
  } catch (error) {
    throw new WorkerError({
      code: "DB_DOWNLOAD_FAILED",
      message: `Failed to download database: ${(error as Error).message}`,
    });
  }
  if (!response.ok) {
    throw new WorkerError({
      code: "DB_DOWNLOAD_FAILED",
      message: `Database request returned HTTP ${response.status}`,
    });
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompress(compressed: Uint8Array, expectedBytes: number): Promise<Uint8Array> {
  // If the host transparently decoded Content-Encoding: br, the bytes will
  // already match the expected length and we skip the in-worker decode.
  if (compressed.byteLength === expectedBytes) {
    return compressed;
  }
  let decompressed: Uint8Array;
  try {
    // Decode-only brotli build (~200 KB vs brotli-wasm's ~1.1 MB encoder+decoder).
    // The worker only ever decompresses; this lazy import is reached solely when
    // the host did NOT transparently decode Content-Encoding: br. We import the
    // `/web` (wasm-pack) entry and its named `decompress` rather than awaiting the
    // package's default promise-to-namespace: awaiting a module namespace breaks
    // under Node test runners that expose namespaces as thenables. `default()`
    // instantiates the wasm (fetched relative to the bundled asset in the
    // browser) and is idempotent, so repeated decodes reuse the one instance.
    const brotli = await import("brotli-dec-wasm/web");
    await brotli.default();
    decompressed = brotli.decompress(compressed);
  } catch (error) {
    throw new WorkerError({
      code: "DB_DECOMPRESS_FAILED",
      message: `Brotli decompression failed: ${(error as Error).message}`,
    });
  }
  if (decompressed.byteLength !== expectedBytes) {
    throw new WorkerError({
      code: "DB_SIZE_MISMATCH",
      message: `Decompressed database is ${decompressed.byteLength} bytes; manifest expects ${expectedBytes}.`,
    });
  }
  return decompressed;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// Verify that raw (already-decompressed) database bytes hash to the sha256 the
// manifest recorded, before anything is persisted to OPFS or opened. A
// truncated or corrupted download must never be stored and served.
export async function verifyDatabaseHash(
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  // The DOM BufferSource type is backed by ArrayBuffer specifically; our bytes
  // are a Uint8Array<ArrayBufferLike>, which is safe to hash directly.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const actual = toHex(digest);
  if (actual !== expectedSha256) {
    throw new WorkerError({
      code: "DB_STORAGE_CORRUPT",
      message: `Downloaded database failed integrity check: sha256 ${actual} does not match manifest ${expectedSha256}.`,
    });
  }
}

function cleanupStaleDatabases(keepPath: string): void {
  try {
    const names: string[] = poolUtil.getFileNames();
    for (const name of names) {
      if (name.startsWith("/dredge/") && name !== keepPath) {
        try {
          poolUtil.unlink(name);
        } catch {
          // Best-effort cleanup; ignore failures.
        }
      }
    }
  } catch {
    // Ignore — cleanup is non-critical.
  }
}

function applyReadOnlyPragmas(db: any): void {
  // Read-only workload tuning: a large page cache avoids re-reading pages
  // through the (relatively expensive) OPFS sync-access-handle path during
  // large FTS doclist scans, and temp tables/sorts stay in memory.
  db.exec("PRAGMA cache_size = -131072"); // 128 MB, enough to hold the whole DB
  db.exec("PRAGMA temp_store = MEMORY");
  // PRAGMA query_only is intentionally NOT set: single-pass query execution
  // builds a per-request TEMP TABLE holding the FTS match, and query_only = 1
  // forbids CREATE TABLE. The database file itself is opened read-only via the
  // SAH pool / in-memory deserialize, so writes can only ever touch temp.
}

function openDatabaseHandle(path: string): unknown {
  try {
    // OpfsSAHPoolDb opens a database file that lives inside the SAH pool.
    const db = new poolUtil.OpfsSAHPoolDb(path);
    applyReadOnlyPragmas(db);
    return db;
  } catch (error) {
    throw new WorkerError({
      code: "SQLITE_OPEN_FAILED",
      message: `Failed to open database: ${(error as Error).message}`,
    });
  }
}

function openInMemoryDatabase(bytes: Uint8Array): unknown {
  try {
    // Load the downloaded database bytes straight into WASM memory. This works
    // regardless of how many tabs are open because it never touches OPFS.
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
    applyReadOnlyPragmas(db);
    return db;
  } catch (error) {
    throw new WorkerError({
      code: "SQLITE_OPEN_FAILED",
      message: `Failed to open in-memory database: ${(error as Error).message}`,
    });
  }
}

function makeExec(db: any): Exec {
  return (sql: string, bind: unknown[] = []) => {
    return db.exec({ sql, bind, returnValue: "resultRows", rowMode: "array" }) as unknown[][];
  };
}

export function closeDatabase(): void {
  if (opened) {
    try {
      (opened.db as any).close();
    } catch {
      // ignore
    }
    opened = undefined;
  }
}

export function getExec(): Exec {
  if (!opened) {
    throw new WorkerError({ code: "QUERY_FAILED", message: "Database is not open." });
  }
  return opened.exec;
}

export function getManifest(): DredgeManifest | undefined {
  return opened?.manifest;
}

// Install a freshly opened handle as the active database. No prior handle is
// closed — a worker boots the database exactly once per session.
function installDatabase(db: unknown, manifest: DredgeManifest): void {
  opened = { db, manifest, exec: makeExec(db) };
}

// OPFS quota preflight. Returns true when it is safe to persist the database to
// OPFS. When the environment cannot estimate storage, we optimistically proceed
// (returning true) exactly as before the preflight existed.
async function hasStorageHeadroom(env: BootEnv, dbBytes: number): Promise<boolean> {
  if (!env.estimateStorage) {
    return true;
  }
  let estimate: StorageEstimateLike | undefined;
  try {
    estimate = await env.estimateStorage();
  } catch {
    return true;
  }
  if (!estimate || typeof estimate.quota !== "number") {
    return true;
  }
  const usage = typeof estimate.usage === "number" ? estimate.usage : 0;
  const headroom = estimate.quota - usage;
  // Require a 10% margin over the raw database size before committing to OPFS.
  return headroom >= dbBytes * 1.1;
}

export interface BootSession {
  // Timings for the database boot() opened.
  timings: BootTimings;
  // Whether the database was opened from the OPFS cache (a warm visit).
  fromCache: boolean;
}

export async function boot(
  manifestUrl: string,
  reset: boolean,
  status: StatusFn,
  env: BootEnv,
): Promise<BootSession> {
  status("checking_support");
  await ensureSqlite(env, status);

  const t0 = performance.now();
  status("fetching_manifest");
  const manifest = await fetchManifest(env, manifestUrl);
  validateManifest(manifest);
  const manifestDone = performance.now();
  const manifestBase = resolveManifestBase(manifestUrl);

  const useOpfs = backend === "opfs";
  const dbPath = dbPathFor(manifest);

  if (useOpfs && reset) {
    // Force a cold boot: drop any cached database so the warm path below is
    // skipped and the database is downloaded from scratch.
    closeDatabase();
    if (poolHasFile(dbPath)) {
      try {
        poolUtil.unlink(dbPath);
      } catch {
        // ignore
      }
    }
  }

  // Warm visit: the database is already persisted in OPFS. Open it directly —
  // no download, no decompression.
  if (useOpfs && !reset && poolHasFile(dbPath)) {
    status("checking_storage");
    status("opening_db");
    const openStart = performance.now();
    closeDatabase();
    const db = openDatabaseHandle(dbPath);
    const openMs = performance.now() - openStart;
    installDatabase(db, manifest);
    status("ready");
    return {
      timings: {
        fromCache: true,
        manifestMs: manifestDone - t0,
        downloadMs: 0,
        decompressMs: 0,
        writeOpfsMs: 0,
        openMs,
        totalMs: performance.now() - t0,
        compressedBytes: manifest.db_compressed_bytes,
        decompressedBytes: manifest.db_bytes,
      },
      fromCache: true,
    };
  }

  // Cold visit: download + verify the database, persist it to OPFS (or fall back
  // to memory), and open it. An integrity failure is fatal — it propagates and
  // fails boot.
  status("downloading_db");
  const downloadStart = performance.now();
  const compressed = await downloadCompressed(env, manifest.db_file, manifestBase);
  const downloadMs = performance.now() - downloadStart;

  status("decompressing_db");
  const decompressStart = performance.now();
  const raw = await decompress(compressed, manifest.db_bytes);
  await verifyDatabaseHash(raw, manifest.db_sha256);
  const decompressMs = performance.now() - decompressStart;

  // Persist to OPFS unless there is no pool (memory backend) or the quota
  // preflight reports insufficient headroom — either way, open it in memory.
  let persist = useOpfs;
  if (persist && !(await hasStorageHeadroom(env, manifest.db_bytes))) {
    persist = false;
    status(
      "checking_storage",
      "insufficient storage quota to persist the database; opening it in memory for this session.",
    );
  }

  closeDatabase();
  let writeOpfsMs = 0;
  let openMs = 0;
  let db: unknown;
  if (persist) {
    status("writing_opfs");
    const writeStart = performance.now();
    try {
      poolUtil.importDb(dbPath, raw);
    } catch (error) {
      throw new WorkerError({
        code: "QUOTA_EXCEEDED",
        message: `Failed to store database in OPFS: ${(error as Error).message}`,
      });
    }
    cleanupStaleDatabases(dbPath);
    writeOpfsMs = performance.now() - writeStart;
    status("opening_db");
    const openStart = performance.now();
    db = openDatabaseHandle(dbPath);
    openMs = performance.now() - openStart;
  } else {
    status("opening_db");
    const openStart = performance.now();
    db = openInMemoryDatabase(raw);
    openMs = performance.now() - openStart;
  }
  installDatabase(db, manifest);
  status("ready");

  return {
    timings: {
      fromCache: false,
      manifestMs: manifestDone - t0,
      downloadMs,
      decompressMs,
      writeOpfsMs,
      openMs,
      totalMs: performance.now() - t0,
      compressedBytes: compressed.byteLength,
      decompressedBytes: raw.byteLength,
    },
    fromCache: false,
  };
}
