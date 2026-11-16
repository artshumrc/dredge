/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import type { BootEnv, PoolLike } from "./db";
import { lockName } from "./coordination";
import type { BroadcastChannelLike, CoordinationEnv, LockManagerLike } from "./coordination";

// Name of the OPFS SAH pool VFS. Files imported into the pool live under this
// namespace inside OPFS.
const VFS_NAME = "dredge-sahpool";

// Where the SAH pool keeps its files, and how long the path header at the start
// of each one is. Both are the pool's persistent on-disk format.
const POOL_FILES = [`.${VFS_NAME}`, ".opaque"];
const POOL_PATH_BYTES = 512;

// Read the pool's file headers directly rather than installing the pool, which
// would take every file's exclusive access handle away from the tab that leads.
async function poolHolds(path: string): Promise<boolean> {
  let directory = await navigator.storage.getDirectory();
  try {
    for (const name of POOL_FILES) {
      directory = await directory.getDirectoryHandle(name);
    }
  } catch {
    return false;
  }
  const expected = new TextEncoder().encode(path);
  for await (const handle of (directory as any).values() as AsyncIterable<FileSystemHandle>) {
    if (handle.kind !== "file") {
      continue;
    }
    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      const header = new Uint8Array(await file.slice(0, POOL_PATH_BYTES).arrayBuffer());
      if (header[expected.length] === 0 && expected.every((byte, index) => header[index] === byte)) {
        return true;
      }
    } catch {
      // A file another context holds open cannot be read; it is not ours.
    }
  }
  return false;
}

function canUseSyncAccessHandles(): boolean {
  // The persistent OPFS path requires synchronous access handles inside a
  // worker. When they are unavailable we transparently fall back to memory.
  const proto = (globalThis as any).FileSystemFileHandle?.prototype;
  if (typeof proto?.createSyncAccessHandle !== "function") {
    return false;
  }
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    return false;
  }
  return true;
}

// The real boot environment for a browser worker: network fetch, the sqlite3
// WASM module, the OPFS SAH pool installer, and the storage estimator. This is
// the only place the runtime touches these globals; boot orchestration in db.ts
// consumes them exclusively through the injected BootEnv. Shared by the search
// worker and the validation-harness worker so both drive the one boot state
// machine.
export const browserBootEnv: BootEnv = {
  fetch: (input, init) => fetch(input, init),
  initSqlite() {
    return sqlite3InitModule();
  },
  async installPool(sqlite3): Promise<PoolLike | undefined> {
    const api = sqlite3 as { installOpfsSAHPoolVfs?: (opts: { name: string }) => Promise<PoolLike> };
    if (!canUseSyncAccessHandles() || typeof api.installOpfsSAHPoolVfs !== "function") {
      return undefined;
    }
    return await api.installOpfsSAHPoolVfs({ name: VFS_NAME });
  },
  estimateStorage() {
    if (typeof navigator !== "undefined" && typeof navigator.storage?.estimate === "function") {
      return navigator.storage.estimate();
    }
    return Promise.resolve(undefined);
  },
  async hasPersisted(path, sha256) {
    // A leader for this database means another tab already serves it, so a
    // search here relays to it and downloads nothing.
    const locks = (navigator as unknown as { locks?: LockManager }).locks;
    const held = await locks?.query().catch(() => undefined);
    if (held?.held?.some((lock) => lock.name === lockName(sha256))) {
      return true;
    }
    if (!canUseSyncAccessHandles()) {
      return false;
    }
    return poolHolds(path);
  },
};

// Real multi-tab coordination primitives for a browser worker: the Web Locks
// manager (leadership election) and BroadcastChannel (relay), plus timer and id
// sources. `undefined` when either primitive is missing — the worker then runs
// the single-tab path (today's behavior, in-memory fallback and all). Both
// `navigator.locks` and `BroadcastChannel` are available in worker contexts on
// every browser that also supports the OPFS SAH pool, so this is `undefined`
// only on legacy engines that already take the memory fallback anyway.
export const browserCoordinationEnv: CoordinationEnv | undefined = createBrowserCoordinationEnv();

function createBrowserCoordinationEnv(): CoordinationEnv | undefined {
  const locks =
    typeof navigator !== "undefined"
      ? ((navigator as unknown as { locks?: LockManagerLike }).locks ?? undefined)
      : undefined;
  if (!locks || typeof locks.request !== "function" || typeof BroadcastChannel === "undefined") {
    return undefined;
  }
  let seq = 0;
  const tabId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${performance.now()}`;
  return {
    locks,
    createChannel: (name) => new BroadcastChannel(name) as unknown as BroadcastChannelLike,
    scheduleTimeout: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
    // Per-tab prefix + counter keeps relay ids unique across every tab sharing
    // the channel without another randomUUID() call per keystroke.
    newId: () => `${tabId}-${(seq += 1)}`,
  };
}
