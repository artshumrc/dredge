/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import type { BootEnv, PoolLike } from "./db";

// Name of the OPFS SAH pool VFS. Files imported into the pool live under this
// namespace inside OPFS.
const VFS_NAME = "dredge-sahpool";

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
};
