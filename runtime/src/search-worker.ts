/// <reference lib="webworker" />

import { browserBootEnv, browserCoordinationEnv } from "./browser-boot-env";
import { boot, closeDatabase, getExec, loadValidatedManifest, WorkerError, toDredgeError } from "./db";
import type { StatusFn } from "./db";
import { startCoordinatedSession } from "./coordination";
import type { CoordinatedSession, LocalBackend } from "./coordination";
import { introspectSchema, search } from "./search";
import type { DredgeSearchRequest, DredgeSearchResponse } from "./search";
import type { DredgeError, DredgeStatus } from "./protocol";

type WorkerRequest =
  | { type: "init"; id: number; manifestUrl: string; reset?: boolean }
  | { type: "search"; id: number; request: DredgeSearchRequest }
  | { type: "destroy"; id: number };

type WorkerResponse =
  | { type: "status"; status: DredgeStatus; detail?: string }
  | { type: "ready"; id: number }
  | { type: "searchResult"; id: number; response: DredgeSearchResponse }
  | { type: "error"; id?: number; error: DredgeError };

// The active session: a leader that owns the database, or a follower relaying to
// the leader tab. Election happens on `init`.
let session: CoordinatedSession | undefined;
let manifestUrl = "";
let reset = false;

function post(message: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function status(value: DredgeStatus, detail?: string): void {
  post({ type: "status", status: value, detail });
}

// Boot the database and expose it as a LocalBackend for the coordinator. Only a
// leader tab reaches this; followers never boot. `reset` applies to the first
// boot only — a follower promoted on failover must reopen the OPFS copy the
// departed leader left, never wipe it.
async function bootLocal(onStatus: StatusFn): Promise<LocalBackend> {
  const useReset = reset;
  reset = false;
  await boot(manifestUrl, useReset, onStatus, browserBootEnv);
  // The worker opens the database exactly once per session, so the handle and
  // its schema are stable — introspect once and reuse.
  const exec = getExec();
  const schema = introspectSchema(exec);
  return {
    search: (request) => search(exec, schema, request),
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "init") {
    try {
      manifestUrl = message.manifestUrl;
      reset = message.reset ?? false;
      // The manifest sha namespaces the leadership lock and relay channel, and
      // must be known before election — followers decide not to boot on it.
      const manifest = await loadValidatedManifest(browserBootEnv, manifestUrl);
      session = await startCoordinatedSession({
        manifestSha: manifest.db_sha256,
        status,
        bootLocal,
        env: browserCoordinationEnv,
      });
      post({ type: "ready", id: message.id });
    } catch (error) {
      status("failed");
      post({ type: "error", id: message.id, error: toDredgeError(error) });
    }
    return;
  }

  if (message.type === "search") {
    // A per-search failure (e.g. a relay timeout, or leader loss mid-flight)
    // rejects only this request — it does NOT flip the session to `failed`. The
    // client's coalescing turns the rejection into a re-typed keystroke.
    try {
      if (!session) {
        throw new WorkerError({ code: "QUERY_FAILED", message: "Search issued before init." });
      }
      const response = await session.search(message.request);
      post({ type: "searchResult", id: message.id, response });
    } catch (error) {
      post({ type: "error", id: message.id, error: toDredgeError(error) });
    }
    return;
  }

  if (message.type === "destroy") {
    session?.destroy();
    session = undefined;
    closeDatabase();
  }
};
