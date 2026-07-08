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
  manifest: DredgeManifest,
  baseUrl: string,
): Promise<Uint8Array> {
  const url = new URL(manifest.db_file, baseUrl).toString();
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

async function decompress(compressed: Uint8Array, manifest: DredgeManifest): Promise<Uint8Array> {
  // If the host transparently decoded Content-Encoding: br, the bytes will
  // already match db_bytes and we skip the in-worker decode.
  if (compressed.byteLength === manifest.db_bytes) {
    return compressed;
  }
  let decompressed: Uint8Array;
  try {
    const brotli = await (await import("brotli-wasm")).default;
    decompressed = brotli.decompress(compressed);
  } catch (error) {
    throw new WorkerError({
      code: "DB_DECOMPRESS_FAILED",
      message: `Brotli decompression failed: ${(error as Error).message}`,
    });
  }
  if (decompressed.byteLength !== manifest.db_bytes) {
    throw new WorkerError({
      code: "DB_SIZE_MISMATCH",
      message: `Decompressed database is ${decompressed.byteLength} bytes; manifest expects ${manifest.db_bytes}.`,
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
// truncated or corrupted download must never be stored and served. Reusable
// across every download path (full tier here; hot tier once it lands).
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

async function bootInMemory(
  env: BootEnv,
  manifest: DredgeManifest,
  manifestUrl: string,
  status: StatusFn,
  t0: number,
  manifestDone: number,
): Promise<BootTimings> {
  // In-memory mode cannot reuse a cached copy; always fetch + decode. The
  // download honours the HTTP cache, so a warm browser cache keeps this cheap.
  status("downloading_db");
  const downloadStart = performance.now();
  const manifestBase = resolveManifestBase(manifestUrl);
  const compressed = await downloadCompressed(env, manifest, manifestBase);
  const downloadMs = performance.now() - downloadStart;
  const compressedBytes = compressed.byteLength;

  status("decompressing_db");
  const decompressStart = performance.now();
  const raw = await decompress(compressed, manifest);
  await verifyDatabaseHash(raw, manifest.db_sha256);
  const decompressMs = performance.now() - decompressStart;
  const decompressedBytes = raw.byteLength;

  status("opening_db");
  const openStart = performance.now();
  closeDatabase();
  const db = openInMemoryDatabase(raw);
  const openMs = performance.now() - openStart;

  opened = { db, manifest, exec: makeExec(db) };
  status("ready");

  const totalMs = performance.now() - t0;
  return {
    fromCache: false,
    manifestMs: manifestDone - t0,
    downloadMs,
    decompressMs,
    writeOpfsMs: 0,
    openMs,
    totalMs,
    compressedBytes,
    decompressedBytes,
  };
}

export async function boot(
  manifestUrl: string,
  reset: boolean,
  status: StatusFn,
  env: BootEnv,
): Promise<BootTimings> {
  status("checking_support");
  await ensureSqlite(env, status);

  const t0 = performance.now();
  status("fetching_manifest");
  const manifest = await fetchManifest(env, manifestUrl);
  validateManifest(manifest);
  const manifestDone = performance.now();

  if (backend === "memory") {
    return bootInMemory(env, manifest, manifestUrl, status, t0, manifestDone);
  }

  const path = dbPathFor(manifest);
  if (reset) {
    closeDatabase();
    if (poolHasFile(path)) {
      try {
        poolUtil.unlink(path);
      } catch {
        // ignore
      }
    }
  }

  status("checking_storage");
  const cached = poolHasFile(path);

  let downloadMs = 0;
  let decompressMs = 0;
  let writeOpfsMs = 0;
  let compressedBytes = manifest.db_compressed_bytes;
  let decompressedBytes = manifest.db_bytes;

  if (!cached) {
    status("downloading_db");
    const downloadStart = performance.now();
    const manifestBase = resolveManifestBase(manifestUrl);
    const compressed = await downloadCompressed(env, manifest, manifestBase);
    const downloadEnd = performance.now();
    downloadMs = downloadEnd - downloadStart;
    compressedBytes = compressed.byteLength;

    status("decompressing_db");
    const decompressStart = performance.now();
    const raw = await decompress(compressed, manifest);
    await verifyDatabaseHash(raw, manifest.db_sha256);
    const decompressEnd = performance.now();
    decompressMs = decompressEnd - decompressStart;
    decompressedBytes = raw.byteLength;

    status("writing_opfs");
    const writeStart = performance.now();
    try {
      poolUtil.importDb(path, raw);
    } catch (error) {
      throw new WorkerError({
        code: "QUOTA_EXCEEDED",
        message: `Failed to store database in OPFS: ${(error as Error).message}`,
      });
    }
    writeOpfsMs = performance.now() - writeStart;
    cleanupStaleDatabases(path);
  }

  status("opening_db");
  const openStart = performance.now();
  closeDatabase();
  const db = openDatabaseHandle(path);
  const openMs = performance.now() - openStart;

  opened = { db, manifest, exec: makeExec(db) };
  status("ready");

  const totalMs = performance.now() - t0;
  return {
    fromCache: cached,
    manifestMs: manifestDone - t0,
    downloadMs,
    decompressMs,
    writeOpfsMs,
    openMs,
    totalMs,
    compressedBytes,
    decompressedBytes,
  };
}
