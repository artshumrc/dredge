/// <reference lib="webworker" />

import { browserBootEnv } from "./browser-boot-env";
import { boot, getExec, toDredgeError } from "./db";
import type { Exec } from "./db";

import type {
  BenchmarkReport,
  BootTimings,
  DredgeStatus,
  QueryTiming,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

// Milestone 4 validation harness worker. Boot is delegated to the shared tier
// state machine in db.ts (via the injected BootEnv), so the harness exercises
// the real Hot Tier → Full Tier lifecycle and its status progression
// (downloading_db → ready_hot → ... → ready). Benchmarks then run against the
// Full Tier once it has swapped in.

let lastBoot: BootTimings | undefined;

function post(message: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function status(status: DredgeStatus, detail?: string): void {
  post({ type: "status", status, detail });
}

async function init(manifestUrl: string, reset: boolean): Promise<BootTimings> {
  const session = await boot(manifestUrl, reset, status, browserBootEnv);
  // On a cold visit boot() resolves on the Hot Tier; wait for the Full Tier to
  // swap in before benchmarking so query timings measure the full database.
  if (session.fullTier) {
    await session.fullTier;
  }
  return session.timings;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function timeQuery(
  label: string,
  sql: string,
  bind: unknown[],
  runs: number,
  warmup = false,
): QueryTiming {
  const exec: Exec = getExec();
  const run = (): unknown[][] => {
    try {
      return exec(sql, bind);
    } catch (error) {
      console.error(`[bench] query "${label}" failed:`, error);
      throw new Error(`Query "${label}" failed: ${(error as Error).message}`);
    }
  };
  const samples: number[] = [];
  let rows = 0;
  // Optional untimed warmup so steady-state percentiles exclude the cold
  // (page-in + FTS global stats) penalty, which is reported separately.
  if (warmup) {
    run();
  }
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const result = run();
    samples.push(performance.now() - start);
    rows = result.length;
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    sql,
    runs,
    rows,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    minMs: samples[0],
    maxMs: samples[samples.length - 1],
  };
}

function runBenchmark(runsPerQuery: number): BenchmarkReport {
  // Ensure the database is open (throws QUERY_FAILED otherwise).
  getExec();

  const runs = Math.max(1, runsPerQuery);
  const queries: QueryTiming[] = [];

  // Idiomatic FTS5 ranked-search query (top-N by bm25 with deterministic
  // tie-breaker), joined back to the document row for result fields.
  const ranked = `SELECT d.id, d.url, d.title, bm25(documents_fts) AS rank
       FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
       WHERE documents_fts MATCH ?
       ORDER BY rank, d.id LIMIT 20`;

  // Cold first query: the very first ranked search after open pays a one-time
  // penalty (paging the FTS index in from OPFS + computing global stats).
  // Measured once, with no warmup, against a broad term.
  queries.push(timeQuery("cold_first_search", ranked, ["ancient"], 1, false));

  // --- Warm steady-state (each warmed once, then timed `runs` times) ---

  // Empty query / pagination straight off the documents table.
  queries.push(
    timeQuery(
      "empty_paginate",
      "SELECT id, url, title FROM documents ORDER BY id LIMIT 20 OFFSET 1000",
      [],
      runs,
      true,
    ),
  );

  // Point lookup: a single matching document (most selective FTS case).
  queries.push(timeQuery("point_lookup", ranked, ["uid77777"], runs, true));

  // Selective search: ~count/1000 matches (~150 docs at 150k).
  queries.push(timeQuery("selective_search", ranked, ["grp42"], runs, true));

  // Moderate search: ~count/50 matches (~3000 docs at 150k).
  queries.push(timeQuery("moderate_search", ranked, ["cohort7"], runs, true));

  // Broad search: a near-ubiquitous term (~all docs) — worst case for ranking.
  queries.push(timeQuery("broad_search", ranked, ["ancient"], runs, true));

  // Selective search + scalar filters (composite index path).
  queries.push(
    timeQuery(
      "filtered_search",
      `SELECT d.id, d.url, d.title, bm25(documents_fts) AS rank
       FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
       WHERE documents_fts MATCH ? AND d.category = ? AND d.year BETWEEN ? AND ?
       ORDER BY rank, d.id LIMIT 20`,
      ["cohort7", "object", 2010, 2024],
      runs,
      true,
    ),
  );

  // Facet counts: full GROUP BY scan of the documents table.
  queries.push(
    timeQuery(
      "facet_category_counts",
      "SELECT category, COUNT(*) AS n FROM documents GROUP BY category ORDER BY n DESC",
      [],
      runs,
      true,
    ),
  );

  // Array-facet filter via EXISTS against the generated join table.
  queries.push(
    timeQuery(
      "array_facet_filter",
      `SELECT d.id, d.url
       FROM documents d
       WHERE EXISTS (SELECT 1 FROM facet_tags ft WHERE ft.document_id = d.id AND ft.value = ?)
       ORDER BY d.id LIMIT 20`,
      ["royal"],
      runs,
      true,
    ),
  );

  return {
    boot: lastBoot ?? {
      fromCache: false,
      manifestMs: 0,
      downloadMs: 0,
      decompressMs: 0,
      writeOpfsMs: 0,
      openMs: 0,
      totalMs: 0,
      compressedBytes: 0,
      decompressedBytes: 0,
    },
    queries,
    userAgent: navigator.userAgent,
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      const boot = await init(message.manifestUrl, message.reset ?? false);
      lastBoot = boot;
      post({ type: "ready", id: message.id, boot });
      return;
    }
    if (message.type === "benchmark") {
      const report = runBenchmark(message.runsPerQuery ?? 25);
      post({ type: "benchmarkResult", id: message.id, report });
      return;
    }
    if (message.type === "destroy") {
      // The harness worker owns no persistent state to tear down here; boot
      // handles reopen on the next init.
      return;
    }
  } catch (error) {
    status("failed");
    post({ type: "error", id: (message as { id?: number }).id, error: toDredgeError(error) });
  }
};
