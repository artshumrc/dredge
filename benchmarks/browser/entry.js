import { DEFAULT_BUDGET_MS, isTripped, nextStep } from "./sampling.js";

const params = new URLSearchParams(location.search);
const engine = params.get("engine");
const site = params.get("site");
const cold = params.get("cold") === "1";
const iterations = Number(params.get("iterations") ?? 20);
const operationTimeoutMs = Number(params.get("operation_timeout_ms") ?? 60_000);
// `once` is the cold single-pass mode: every config is run exactly once with no
// warmups, so first-visit network bytes stay honest without duplicating the warm
// matrix. `budget_ms` is the warm per-config time budget for sampling.
const once = params.get("once") === "1";
const budgetMs = Number(params.get("budget_ms") ?? DEFAULT_BUDGET_MS);
// measureUserAgentSpecificMemory() is deliberately rate-limited by the browser
// (a randomized delay of up to ~20s, to blunt it as a timing side-channel), so
// we take exactly one sample per page and let the runner skip it where a
// duplicate would add nothing (e.g. the single-tab cold page).
const measureMem = params.get("mem") !== "0";
// The sample resolves only after every agent in the tab has performed a
// garbage collection, and Chromium schedules that GC on a live dedicated
// worker at up to ~60s — so an engine that keeps a search worker alive
// (dredge) resolves right at the default operation timeout and loses the race
// by milliseconds. Memory is a property measurement, not a latency, so it gets
// its own deadline with real headroom, identical for every engine.
const memoryTimeoutMs = Math.max(operationTimeoutMs * 2, 120_000);

// Page sizes exercised by the pagination sweep. Larger pages expose per-hit
// result-hydration cost that a top-10 page hides.
const PAGE_SIZES = [10, 50, 100, 200];
// Deep-pagination probe: a fixed page size read at increasing offsets, so
// "jump to the last page" cost is measured, not just page one.
const DEEP_PAGE_SIZE = 20;

// Sorting policy for the whole suite: each config carries an explicit optional
// `sort`. When absent, the engine uses its native relevance ordering (the
// keyword/filtered/pagination/deep scenarios); the `sorted` and `browse`
// scenarios set an explicit alphabetical title sort.
const TITLE_SORT = { field: "title", direction: "asc" };

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

async function runOperation(label, operation) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${operationTimeoutMs}ms`)),
          operationTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function adapterFor(name) {
  if (name === "dredge") return import("./engines/dredge.js");
  if (name === "pagefind") return import("./engines/pagefind.js");
  if (name === "orama") return import("./engines/orama.js");
  if (name === "flexsearch") return import("./engines/flexsearch.js");
  if (name === "lunr") return import("./engines/lunr.js");
  throw new Error(`unknown engine: ${name}`);
}

// Total memory of this tab's whole agent cluster (main thread + the search
// worker + any WASM heap). Requires crossOriginIsolation, which the runner's
// COOP/COEP headers provide. JS-heap-only APIs would undercount engines whose
// index lives in a worker's WASM heap (dredge), so this is the fair measure.
async function measureMemoryBytes() {
  if (typeof performance.measureUserAgentSpecificMemory !== "function") {
    return null;
  }
  try {
    const sample = await performance.measureUserAgentSpecificMemory();
    return sample.bytes;
  } catch {
    return null;
  }
}

// Facet-count modes: none (no counts), one (first facet dimension), all (every
// available dimension). This is what shows how facet cost scales with the number
// of dimensions counted.
function facetSetsFor(workload) {
  const names = (workload.facets ?? []).map((facet) => facet.name);
  return { none: [], one: names.slice(0, 1), all: names };
}

// Build the warm test matrix — exactly the spec's ~40 configs per engine/site.
// Every config counts all results and returns a sorted page; configs with facets
// also count every requested facet value.
function buildConfigs(workload) {
  const base = { page_size: 10, offset: 0, facet_mode: "none", filtered: false, sort: undefined };
  const configs = [];
  const broad = workload.queries.find((query) => query.label === "broad");

  // Keyword: each query at page 10, no facet counts (diagnostic) and all facet
  // counts (the rich, headline scenario). Native relevance ordering.
  for (const item of workload.queries) {
    for (const mode of ["none", "all"]) {
      configs.push({ ...base, ...item, facet_mode: mode, scenario: "keyword" });
    }
  }
  // Facet scaling: the `one` facet mode, ONLY on the broad query. Its none/all
  // points reuse the broad keyword rows.
  if (broad) {
    configs.push({ ...base, ...broad, facet_mode: "one", scenario: "scaling" });
  }
  // Filtered (the disjunctive deliverable): each filtered query, no and all facets.
  for (const item of workload.filtered_queries) {
    for (const mode of ["none", "all"]) {
      configs.push({ ...base, ...item, facet_mode: mode, filtered: true, scenario: "filtered" });
    }
  }
  if (broad) {
    // Pagination sweep crossed with facet counting — every page size without and
    // with all facet counts.
    for (const pageSize of PAGE_SIZES) {
      for (const mode of ["none", "all"]) {
        configs.push({ ...base, ...broad, page_size: pageSize, facet_mode: mode, scenario: "pagination" });
      }
    }
    // Deep pagination — a fixed page read at the first, middle, and last offset of
    // the broad match set (sized from its document frequency), all facets. On a
    // tiny match set the three offsets may coincide; the three configs are kept
    // regardless so the schedule shape is identical across corpus sizes.
    const df = broad.document_frequency ?? 0;
    const offsets = [0, Math.max(0, Math.floor(df / 2)), Math.max(0, df - DEEP_PAGE_SIZE)];
    for (const offset of offsets) {
      configs.push({ ...base, ...broad, page_size: DEEP_PAGE_SIZE, offset, facet_mode: "all", scenario: "deep" });
    }
    // Sorted keyword: the broad query re-sorted alphabetically by title (the cost
    // of letting a user change result ordering away from relevance), no and all.
    for (const mode of ["none", "all"]) {
      configs.push({ ...base, ...broad, facet_mode: mode, scenario: "sorted", sort: TITLE_SORT });
    }
  }
  // No-keyword browse: the faceted landing state — every result alphabetical,
  // with a total count and (optionally) every facet count.
  for (const mode of ["none", "all"]) {
    configs.push({ ...base, label: "browse", query: "", facet_mode: mode, scenario: "browse", sort: TITLE_SORT });
  }
  return configs;
}

async function run() {
  // Adapter load and initialization are NOT gated by the per-operation (search)
  // timeout: a tiny --operation-timeout-seconds is meant to fail searches into
  // error rows, not the init. Init failure stays fatal for the page (a throw
  // rejects run()); a hung init is caught by the page-level timeout backstop.
  const workload = await fetch(`/${site}/workload.json`).then((response) => response.json());
  const adapter = await adapterFor(engine);
  const artifactBase = `/${site}/artifacts/${engine}`;
  const facetSets = facetSetsFor(workload);
  const facetNames = facetSets.all;
  const initStarted = performance.now();
  const search = await adapter.initialize({ artifactBase, cold, facetNames });
  const initMs = performance.now() - initStarted;

  const configs = buildConfigs(workload);
  const measurements = [];
  const maxSamples = iterations;
  const policy = { mode: once ? "cold" : "warm", budgetMs, maxSamples };
  // Failure handling: a per-config timeout or thrown error becomes an error row
  // and the run continues; three consecutive config failures trip a circuit
  // breaker that marks every remaining config skipped so a pathological
  // engine/site cannot consume unbounded wall-clock.
  let consecutiveFailures = 0;
  let breakerTripped = false;
  for (const config of configs) {
    const facetFields = facetSets[config.facet_mode] ?? [];
    const identity = {
      label: config.label,
      query: config.query,
      scenario: config.scenario,
      filtered: config.filtered,
      filter: config.filtered ? config.filter : undefined,
      page_size: config.page_size,
      offset: config.offset ?? 0,
      facet_mode: config.facet_mode,
      facet_field_count: facetFields.length,
    };
    if (breakerTripped) {
      measurements.push({
        ...identity,
        error: "circuit breaker: skipped after 3 consecutive failures",
        error_kind: "skipped",
      });
      continue;
    }
    const options = {
      filter: config.filtered ? config.filter : undefined,
      limit: config.page_size,
      offset: config.offset ?? 0,
      facets: facetFields,
      sort: config.sort,
    };
    const operationLabel = `${config.scenario}/${config.label}/${config.facet_mode}`;
    try {
      const warmups = [];
      const samples = [];
      let last = null;
      for (let guard = 0; guard < 10_000; guard += 1) {
        const step = nextStep(policy, { warmups, samples });
        if (step === "stop") break;
        const started = performance.now();
        const result = await runOperation(
          `${operationLabel} ${step}`,
          () => search(config.query, options),
        );
        const elapsed = performance.now() - started;
        if (step === "warmup") warmups.push(elapsed);
        else {
          samples.push(elapsed);
          last = result;
        }
      }
      measurements.push({
        ...identity,
        result_count: last?.count ?? null,
        count_exact: last?.countExact ?? null,
        checksum: last?.checksum ?? null,
        first_titles: last?.titles ?? null,
        facet_counts: config.facet_mode === "none" ? undefined : (last?.facets ?? null),
        sample_count: samples.length,
        p50_ms: percentile(samples, 0.5),
        p95_ms: percentile(samples, 0.95),
        p99_ms: percentile(samples, 0.99),
      });
      consecutiveFailures = 0;
    } catch (error) {
      const message = error?.message ?? String(error);
      const kind = /exceeded \d+ms$/.test(message) ? "timeout" : "exception";
      measurements.push({ ...identity, error: message, error_kind: kind });
      consecutiveFailures += 1;
      if (isTripped(consecutiveFailures)) breakerTripped = true;
    }
  }

  // Memory sampling is best-effort. measureUserAgentSpecificMemory() is
  // deliberately rate-limited by the browser and waits on a GC in every agent
  // (see memoryTimeoutMs above); a slow or absent sample must not discard a
  // whole page of latency measurements, so it races its own longer deadline and
  // records memory as unavailable rather than failing the page.
  let memoryBytes = null;
  if (measureMem) {
    let timeout;
    try {
      memoryBytes = await Promise.race([
        measureMemoryBytes(),
        new Promise((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(null), memoryTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    engine,
    site,
    cold,
    once,
    max_samples: maxSamples,
    init_ms: initMs,
    memory: {
      available: memoryBytes !== null,
      bytes: memoryBytes,
    },
    measurements,
  };
}

run().then(
  (result) => {
    window.__benchmark = { done: true, result };
  },
  (error) => {
    window.__benchmark = { done: true, error: error?.stack ?? String(error) };
  },
);
