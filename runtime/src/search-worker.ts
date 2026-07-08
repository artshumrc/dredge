/// <reference lib="webworker" />

import { browserBootEnv } from "./browser-boot-env";
import { boot, closeDatabase, getExec, getTier, toDredgeError } from "./db";
import type { Tier } from "./db";
import { introspectSchema, search } from "./search";
import type { DredgeSearchRequest, DredgeSearchResponse, SchemaInfo } from "./search";
import type { DredgeError, DredgeStatus } from "./protocol";

type WorkerRequest =
  | { type: "init"; id: number; manifestUrl: string; reset?: boolean }
  | { type: "search"; id: number; request: DredgeSearchRequest }
  | { type: "destroy"; id: number };

type WorkerResponse =
  | { type: "status"; status: DredgeStatus; detail?: string }
  | { type: "ready"; id: number; tier: Tier }
  | { type: "searchResult"; id: number; response: DredgeSearchResponse }
  | { type: "error"; id?: number; error: DredgeError };

let schema: SchemaInfo | undefined;
// The tier `schema` was introspected from. When the Tier Swap flips the active
// handle from hot to full, we re-introspect so facet/store roles and columns
// reflect the tier now serving searches.
let schemaTier: Tier | undefined;

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
      // Resolves once the first tier is open (Hot Tier on a cold visit, Full
      // Tier on a warm one); any background Full Tier upgrade keeps running and
      // reports `ready` via a status message when it swaps in.
      await boot(message.manifestUrl, message.reset ?? false, status, browserBootEnv);
      schema = introspectSchema(getExec());
      schemaTier = getTier();
      post({ type: "ready", id: message.id, tier: getTier() });
      return;
    }
    if (message.type === "search") {
      const exec = getExec();
      const tier = getTier();
      if (!schema || schemaTier !== tier) {
        schema = introspectSchema(exec);
        schemaTier = tier;
      }
      const response = search(exec, schema, message.request, tier);
      post({ type: "searchResult", id: message.id, response });
      return;
    }
    if (message.type === "destroy") {
      closeDatabase();
      schema = undefined;
      schemaTier = undefined;
      return;
    }
  } catch (error) {
    status("failed");
    post({ type: "error", id: (message as { id?: number }).id, error: toDredgeError(error) });
  }
};
