/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { boot, closeDatabase, getExec, toDredgeError } from "./db";
import type { BootEnv, PoolLike } from "./db";
import { introspectSchema, search } from "./search";
import type { DredgeSearchRequest, DredgeSearchResponse, SchemaInfo } from "./search";
import type { DredgeError, DredgeStatus } from "./protocol";

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

// The real boot environment for the browser worker: network fetch, the sqlite3
// WASM module, and the OPFS SAH pool installer. This is the only place the
// runtime touches these globals; boot orchestration in db.ts consumes them
// exclusively through the injected BootEnv.
const browserBootEnv: BootEnv = {
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
};

type WorkerRequest =
  | { type: "init"; id: number; manifestUrl: string; reset?: boolean }
  | { type: "search"; id: number; request: DredgeSearchRequest }
  | { type: "destroy"; id: number };

type WorkerResponse =
  | { type: "status"; status: DredgeStatus; detail?: string }
  | { type: "ready"; id: number }
  | { type: "searchResult"; id: number; response: DredgeSearchResponse }
  | { type: "error"; id?: number; error: DredgeError };

let schema: SchemaInfo | undefined;

function post(message: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function status(value: DredgeStatus, detail?: string): void {
  post({ type: "status", status: value, detail });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      await boot(message.manifestUrl, message.reset ?? false, status, browserBootEnv);
      schema = introspectSchema(getExec());
      post({ type: "ready", id: message.id });
      return;
    }
    if (message.type === "search") {
      const exec = getExec();
      if (!schema) {
        schema = introspectSchema(exec);
      }
      const response = search(exec, schema, message.request);
      post({ type: "searchResult", id: message.id, response });
      return;
    }
    if (message.type === "destroy") {
      closeDatabase();
      schema = undefined;
      return;
    }
  } catch (error) {
    status("failed");
    post({ type: "error", id: (message as { id?: number }).id, error: toDredgeError(error) });
  }
};
