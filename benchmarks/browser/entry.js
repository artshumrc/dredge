const params = new URLSearchParams(location.search);
const engine = params.get("engine");
const site = params.get("site");
const cold = params.get("cold") === "1";
const iterations = Number(params.get("iterations") ?? 20);
const operationTimeoutMs = Number(params.get("operation_timeout_ms") ?? 60_000);
// `light` mode runs a single representative query with few iterations. It is
// used by the multi-tab scenario, where the interesting signal is per-tab
// memory and follower relay latency rather than a full latency matrix.
const light = params.get("light") === "1";
// measureUserAgentSpecificMemory() is deliberately rate-limited by the browser
// (a randomized delay of up to ~20s, to blunt it as a timing side-channel), so
// we take exactly one sample per page and let the runner skip it where a
// duplicate would add nothing (e.g. the single-tab cold page).
const measureMem = params.get("mem") !== "0";

// Page sizes exercised by the pagination sweep. Larger pages expose per-hit
// result-hydration cost that a top-10 page hides.
const PAGE_SIZES = [10, 50, 100, 200];
// Deep-pagination probe: a fixed page size read at increasing offsets, so
// "jump to the last page" cost is measured, not just page one.
const DEEP_PAGE_SIZE = 20;

// Sorting policy for the whole suite: relevance when a keyword is present,
// alphabetical by title for the no-keyword browse. Returning `undefined` lets
// each engine use its native relevance ordering.
function sortFor(query) {
  return query.trim() === "" ? { field: "title", direction: "asc" } : undefined;
}

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

// Build the test matrix. Every config counts all results and returns a fully
// sorted page; configs with facets also count every requested facet value. In
// light mode this is just one moderate query at page size 10.
function buildConfigs(workload) {
  const base = { page_size: 10, offset: 0, facet_mode: "none", filtered: false };
  if (light) {
    const item =
      workload.queries.find((query) => query.label === "moderate") ?? workload.queries[0];
    return [{ ...base, ...item, scenario: "light" }];
  }
  const configs = [];
  // Facet scaling: each keyword query at page 10 with no / one / all facet counts.
  for (const item of workload.queries) {
    for (const mode of ["none", "one", "all"]) {
      configs.push({ ...base, ...item, facet_mode: mode, scenario: "keyword" });
    }
  }
  const broad = workload.queries.find((query) => query.label === "broad");
  if (broad) {
    // Gap 1: pagination sweep crossed with facet counting — every page size is
    // measured both without and with all facet counts.
    for (const pageSize of PAGE_SIZES) {
      for (const mode of ["none", "all"]) {
        configs.push({ ...base, ...broad, page_size: pageSize, facet_mode: mode, scenario: "pagination" });
      }
    }
    // Gap 2: deep pagination — a fixed page read at the first, middle, and last
    // offset of the broad match set (sized from its known document frequency).
    const df = broad.document_frequency ?? 0;
    const offsets = [...new Set([0, Math.max(0, Math.floor(df / 2)), Math.max(0, df - DEEP_PAGE_SIZE)])];
    for (const offset of offsets) {
      configs.push({ ...base, ...broad, page_size: DEEP_PAGE_SIZE, offset, facet_mode: "all", scenario: "deep" });
    }
  }
  // Gap 3: facet counts under an active filter (dredge computes disjunctive,
  // skip-self counts natively; the JS engines compute conjunctive counts).
  for (const item of workload.filtered_queries) {
    for (const mode of ["none", "all"]) {
      configs.push({ ...base, ...item, facet_mode: mode, filtered: true, scenario: "filtered" });
    }
  }
  // No-keyword browse: the faceted landing state — all results, sorted
  // alphabetically, with a total count and (optionally) every facet count.
  for (const mode of ["none", "all"]) {
    configs.push({ ...base, label: "browse", query: "", facet_mode: mode, scenario: "browse" });
  }
  return configs;
}

async function run() {
  const workload = await runOperation("workload fetch", () =>
    fetch(`/${site}/workload.json`).then((response) => response.json()),
  );
  const adapter = await runOperation("adapter load", () => adapterFor(engine));
  const artifactBase = `/${site}/artifacts/${engine}`;
  const facetSets = facetSetsFor(workload);
  const facetNames = facetSets.all;
  const initStarted = performance.now();
  const search = await runOperation("adapter initialization", () =>
    adapter.initialize({ artifactBase, cold, facetNames }),
  );
  const initMs = performance.now() - initStarted;

  const configs = buildConfigs(workload);
  const measurements = [];
  const sampleIterations = light ? Math.min(iterations, 5) : iterations;
  for (const config of configs) {
    const facetFields = facetSets[config.facet_mode] ?? [];
    const options = {
      filter: config.filtered ? config.filter : undefined,
      limit: config.page_size,
      offset: config.offset ?? 0,
      facets: facetFields,
      sort: sortFor(config.query),
    };
    const operationLabel = `${config.scenario}/${config.label}/${config.facet_mode}`;
    for (let index = 0; index < 3; index += 1) {
      await runOperation(`${operationLabel} warmup`, () => search(config.query, options));
    }
    const samples = [];
    let last = null;
    for (let index = 0; index < sampleIterations; index += 1) {
      const started = performance.now();
      last = await runOperation(`${operationLabel} search`, () => search(config.query, options));
      samples.push(performance.now() - started);
    }
    measurements.push({
      label: config.label,
      query: config.query,
      scenario: config.scenario,
      filtered: config.filtered,
      filter: config.filtered ? config.filter : undefined,
      page_size: config.page_size,
      offset: config.offset ?? 0,
      facet_mode: config.facet_mode,
      facet_field_count: facetFields.length,
      result_count: last?.count ?? null,
      count_exact: last?.countExact ?? null,
      checksum: last?.checksum ?? null,
      first_titles: last?.titles ?? null,
      facet_counts: config.facet_mode === "none" ? undefined : (last?.facets ?? null),
      p50_ms: percentile(samples, 0.5),
      p95_ms: percentile(samples, 0.95),
      p99_ms: percentile(samples, 0.99),
    });
  }

  const memoryBytes = measureMem
    ? await runOperation("memory measurement", () => measureMemoryBytes())
    : null;

  return {
    engine,
    site,
    cold,
    light,
    iterations: sampleIterations,
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
