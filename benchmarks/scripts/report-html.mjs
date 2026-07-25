import { bm25Engines, rankingModelFor } from "./ranking-models.mjs";

// Renders the benchmark `report` object into a single self-contained HTML page.
// Every metric and test name is a "term": its verbose explanation lives in the
// GLOSSARY below and is surfaced through one shared, position-fixed tooltip so
// it never clips inside a horizontally scrolling table. The page embeds no
// external resources (fonts, scripts, styles) and works from file://.

const GLOSSARY = {
  build_s: "Wall-clock seconds to build the search index in an isolated process. Corpus extraction happens beforehand and is not counted.",
  build_rss: "Peak resident memory (RSS) of the indexer *process* during the build, via GNU time on Linux. This is a build-machine cost — not browser memory.",
  shipped: "Total size of the product-default deployable artifact files on disk. Compiler intermediates are excluded; Dredge's shipped database uses its default Brotli quality 11.",
  normalized_brotli: "A format-compressibility comparison: every logical artifact file is compressed independently at Brotli quality 5. Dredge's raw database is used instead of its product-default quality-11 .db.br, so every engine is measured at the same compression quality.",
  cold_bytes: "Encoded response-body bytes sent on a first visit (empty HTTP cache and, for Dredge, empty OPFS). HTTP headers and transport framing are excluded. The server applies negotiated Brotli quality 5 to ordinary compressible responses and passes intrinsic precompressed artifacts such as Dredge's .db.br through unchanged. Counted at the server, including Web Worker fetches.",
  warm_bytes: "Encoded response-body bytes sent on a repeat visit, excluding HTTP headers and transport framing. The HTTP cache (and Dredge's persisted OPFS database) mean this is usually ~0.",
  cold_init: "Milliseconds from the adapter starting to the index being queryable, on a first visit. Page navigation and adapter download happen before this timer starts.",
  warm_init: "Initialization time on a repeat visit, reusing the HTTP cache and any persisted database.",
  warm_mem: "Total tab memory after querying — main thread, workers, and WASM heap together — via performance.measureUserAgentSpecificMemory(). This is the only fair cross-engine measure, because some engines keep their index in a worker's WASM heap rather than the JS heap.",
  p95: "95th-percentile query latency (ms) over the measured iterations, after three unrecorded warm-up queries, on a warm page.",
  lat_plain: "Diagnostic only: a free-text query returning a page of results and the exact total, but NO facet counting. Compare against the rich query table to see what always-accurate facet counts add.",
  lat_filtered: "The same query restricted to a single benchmark_group value — the engine's structured-filter path — still fully counted.",
  lat_facet: "The headline scenario: a keyword query returning a page of results, the exact total match count, AND per-value counts for every facet dimension over the WHOLE match set — the full experience a rich search UI ships. Native for Dredge and Pagefind; FlexSearch, Lunr, and Orama enumerate every match and tally in JavaScript (the honest cost).",
  facet_scaling: "How query latency grows as more facet dimensions are counted on the broad query — no facets, one facet, then all available facets. Each per-value count is the 'number next to a facet value' users expect: how many results would remain if that value were applied.",
  facet_none: "Baseline: the query with a full result count but no facet counting.",
  facet_one: "Counting per-value totals for a single facet dimension.",
  facet_all: "Counting per-value totals for every facet dimension at once. Pagefind computes all facet counts on every search regardless, so its cost is flat across these three.",
  pagination: "The broad query run at growing page sizes, both without and with all facet counts. Isolates result-hydration cost — materializing 10 vs 200 results — separate from finding and counting them.",
  deep: "The broad query read at increasing offsets: page one, the middle page, and the last page, all at a fixed page size with all facet counts. Exposes deep-offset cost — an in-memory engine slices an array, while a database must skip rows.",
  browse: "The no-keyword landing state: every document returned, sorted alphabetically by title, with an exact total count and (optionally) every facet count. This is the faceted-browse entry point before any search term.",
  counted: "Whether every run returns the true total match count, never a page-capped one. A faceted UI needs the real total for its result count and pagination, so lazy top-k results are disqualified.",
  sorted_browse: "Whether the no-keyword browse page comes back in alphabetical title order — the defined sort when there is no relevance signal.",
  sorted_keyword: "A keyword query whose native relevance order is replaced by an explicit alphabetical title sort, with and without facet counts.",
  sortable_keyword: "Whether the explicit alphabetical-sort keyword scenario returns titles in alphabetical order — the cost of letting a user re-sort keyword results away from relevance.",
  disjunctive: "When a filter is active on a facet, whether the engine still counts that facet's OTHER values (so a user can switch values within it). Verified numerically: the filtered dimension's counts must reproduce the same query's UNFILTERED counts for that dimension. ✓ is disjunctive/skip-self counting; ✗ is conjunctive (only the applied value survives, so its neighbours read as zero).",
  facet_integrity: "Whether each facet dimension's own per-value counts sum to the engine's own total on unfiltered facet queries (facets partition the match set). Checked against each engine itself — cross-engine totals differ by design because stemming and prefix rules vary.",
  filter_consistency: "Whether a filtered query's total equals that value's bucket in the same engine's own unfiltered facet counts. A native filter that silently drops matches (as FlexSearch's tag search does) fails here — its filtered total reads far below its own unfiltered bucket.",
  example: "A real query from this run and the exact facet counts it returned, to show the shape of what every engine computes on each search.",
  mt_tabs: "Number of browser tabs opened at once on the same origin.",
  mt_single: "Memory of a single tab running the full workload — the baseline instance.",
  mt_total: "Every tab's memory summed with all N open at once. Engines that load a full independent index per tab scale toward N× a single tab (the ~4× jump seen here for Orama, FlexSearch and Lunr). Dredge elects one leader tab to own the SQLite index while the rest relay to it over a BroadcastChannel and download nothing, so the index is held once however many tabs are open — each tab still pays a fixed runtime baseline, so Dredge's total climbs slowly, not with corpus size.",
  mt_p95: "Query p95 on the slowest of the N tabs while all of them search at once — the worst latency a user sees under multi-tab contention.",
};

// Band tooltips for the six-query workload: two single-token endpoints and four
// phrases mined from real corpus text. Phrases are sent unquoted and executed as
// AND-of-terms, so the band's document frequency is an *adjacency* floor — each
// engine's own result_count shows how far its stemming/prefix expansion diverges.
const BAND_BASE = {
  rare: "Rare band: a single token matching roughly one document.",
  broad: "Broad band: a single token matching about 10% of the corpus — the widest single-token result set.",
  "phrase-selective":
    "Selective phrase (two words), adjacency ~0.1% of the corpus. Sent unquoted and run as AND-of-terms; the band is an adjacency floor.",
  "phrase-moderate":
    "Moderate phrase (two words), adjacency ~2% of the corpus. Sent unquoted and run as AND-of-terms; the band is an adjacency floor.",
  "phrase-broad":
    "Broad phrase (two words), adjacency ~10% of the corpus. Sent unquoted and run as AND-of-terms; the band is an adjacency floor.",
  phrase3:
    "Three-word phrase, adjacency ~0.5% of the corpus. Sent unquoted and run as AND-of-terms; the band is an adjacency floor.",
};

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Attribute-safe: also encodes quotes and newlines (rendered via white-space).
function attr(value) {
  return esc(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

const fmtMiB = (bytes) =>
  bytes === undefined || bytes === null ? "–" : (bytes / 1024 / 1024).toFixed(2);
const fmtNum = (value, divisor = 1) =>
  value === undefined || value === null ? "–" : (value / divisor).toFixed(2);

function timeoutSeconds(row) {
  const match = /exceeded (\d+)ms/.exec(row?.error ?? "");
  return match ? Math.round(Number(match[1]) / 1000) : null;
}

// A value-bearing cell: { value, text }. `value` is the comparable number (for
// best/worst-in-column highlighting) or null when the cell is not comparable
// (absent / failed). `text` is the rendered HTML.
function numCell(value, text) {
  return { value: Number.isFinite(value) ? value : null, text };
}
const miBCell = (bytes) => numCell(bytes == null ? null : bytes / 1024 / 1024, fmtMiB(bytes));

// A latency cell: p95 for a measured row (a superscript discloses a thin sample
// count), a ✗ failure cell whose reason is in its tooltip — rendered distinctly
// from a "–" not-measured cell — and "–" when the row is absent. Failed/absent
// cells carry value:null so they are excluded from best/worst highlighting.
function cellHtml(row) {
  if (!row) return numCell(null, "–");
  if (row.error_kind) {
    const seconds = timeoutSeconds(row);
    const label =
      row.error_kind === "skipped"
        ? "✗ skipped"
        : row.error_kind === "timeout"
          ? seconds
            ? `✗ >${seconds}s`
            : "✗ timeout"
          : "✗ error";
    return numCell(null, `<span class="fail" title="${attr(row.error ?? row.error_kind)}">${esc(label)}</span>`);
  }
  if (row.p95_ms === undefined || row.p95_ms === null) return numCell(null, "–");
  let text = fmtNum(row.p95_ms);
  if (row.sample_count !== undefined && row.sample_count < 10) {
    text += `<sup class="lown" title="p95 over ${row.sample_count} sample${row.sample_count === 1 ? "" : "s"}">${row.sample_count}</sup>`;
  }
  return numCell(row.p95_ms, text);
}

// A term: label with a dotted underline that reveals its glossary tip.
function term(label, tip) {
  return `<span class="term" tabindex="0" role="button" aria-label="${attr(label)}: ${attr(tip)}" data-tip="${attr(tip)}">${esc(label)}</span>`;
}

// A column header: the (tooltipped) term followed by its plain-text unit, so a
// glance tells you whether a cell is MiB, ms, seconds, or a ratio.
function head(label, tip, unit) {
  return `${term(label, tip)}${unit ? ` <span class="u">${esc(unit)}</span>` : ""}`;
}

const warmOf = (item) => item?.browser?.warm;
const coldOf = (item) => item?.browser?.cold;

function sliceByLabel(item, { mode, filtered, pageSize = 10 }) {
  const out = {};
  for (const m of warmOf(item)?.measurements ?? []) {
    if (m.facet_mode === mode && m.filtered === filtered && m.page_size === pageSize) {
      out[m.label] = m;
    }
  }
  return out;
}

function facetInventoryText(siteReport) {
  const facets = siteReport.facets ?? [];
  if (!facets.length) return "";
  return (
    `${facets.length} facet ${facets.length === 1 ? "dimension" : "dimensions"}: ` +
    facets.map((facet) => `${facet.name} (${facet.values} values)`).join(", ")
  );
}

// Renders a table with generic best-in-column highlighting. A cell is either a
// plain string (engine names, ✓/✗ marks — never highlighted) or a value-bearing
// { value, text } object. For every column with at least two comparable values,
// the minimum is marked `.best` and the maximum `.worst` (lower is better for
// every metric in this report). Implemented once here so scaling and per-site
// tables highlight identically.
function tableHtml(headerCells, rows) {
  const columnStats = headerCells.map((_, index) => {
    const values = rows
      .map((row) => row.cells[index])
      .filter((cell) => cell && typeof cell === "object" && cell.value != null)
      .map((cell) => cell.value);
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? null : { min, max };
  });
  const head = `<tr>${headerCells.map((cell) => `<th>${cell}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => {
      const cells = row.cells
        .map((cell, index) => {
          const isObject = cell && typeof cell === "object";
          const text = isObject ? cell.text : cell;
          const classes = [];
          if (index === 0) classes.push("engine");
          const stats = columnStats[index];
          if (isObject && stats && cell.value != null) {
            if (cell.value === stats.min) classes.push("best");
            else if (cell.value === stats.max) classes.push("worst");
          }
          const attr = classes.length ? ` class="${classes.join(" ")}"` : "";
          return `<td${attr}>${text}</td>`;
        })
        .join("");
      return `<tr${row.dredge ? ' class="row-dredge"' : ""}>${cells}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table>${head}${body}</table></div>`;
}

// Per-band column header: the label (with a tooltip carrying the band detail)
// plus the actual query text shown inline, so a reader never has to open a
// tooltip to see what was searched.
function bandHeader(band, query) {
  const base = BAND_BASE[band] ?? `${band} band.`;
  const detail = query
    ? ` Here: “${query.query}”, adjacency/document frequency ${query.document_frequency}.`
    : "";
  const queryText = query ? `<span class="qtext">${esc(query.query)}</span>` : "";
  return `${term(band, base + detail)}${queryText}`;
}

// A labeled banner separating build-machine metrics from in-browser metrics.
function banner(text, tip) {
  return `<div class="banner">${tip ? term(text, tip) : esc(text)}</div>`;
}

function rankingNoteHtml(engines) {
  const models = engines
    .map((engine) => {
      const model = rankingModelFor(engine);
      return `${esc(engine)} ${term(model.label, model.detail)}`;
    })
    .join(" · ");
  return `<p class="ranking-note"><strong>Ranking in this timing:</strong> ${models}. Relevance quality is not measured.</p>`;
}

function engineCellHtml(engine) {
  const model = rankingModelFor(engine);
  return `${esc(engine)}<span class="engine-ranking">${term(model.label, model.detail)}</span>`;
}

function bm25NoteHtml(engines) {
  return `<p class="ranking-note bm25-note"><strong>BM25-only view:</strong> ${esc(engines.join(", "))}. Non-BM25 engines are not eligible for best-in-column highlighting here; that is a capability boundary, not a failure.</p>`;
}

function explicitOrderNoteHtml(noKeyword = false) {
  const verb = noKeyword ? "is not used" : "is replaced by the requested sort";
  return `<p class="ranking-note"><strong>Order in this timing:</strong> alphabetical title. Native relevance ranking ${verb}.</p>`;
}

function rankingOverviewHtml(engines) {
  const headers = ["Engine", "Keyword ranking model", "BM25-only view"];
  const rows = engines.map((engine) => {
    const model = rankingModelFor(engine);
    return {
      dredge: engine === "dredge",
      cells: [
        esc(engine),
        `${term(model.label, model.detail)}<span class="model-detail">${esc(model.detail)}</span>`,
        model.bm25 ? '<span class="ok">eligible</span>' : '<span class="muted">not eligible</span>',
      ],
    };
  });
  return `<section class="ranking-overview"><h2>Ranking models</h2><p class="units">Keyword timings include each engine's native relevance work. Raw timings compare complete product behaviour, not equivalent relevance quality.</p>${tableHtml(headers, rows)}</section>`;
}

// Measured on the build machine: index build cost and artifact size.
function buildMachineSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("Build", GLOSSARY.build_s, "s"),
    head("Build RSS", GLOSSARY.build_rss, "MiB"),
    head("Shipped", GLOSSARY.shipped, "MiB"),
    head("Normalized br q5", GLOSSARY.normalized_brotli, "MiB"),
  ];
  const rows = engines.map((engine) => {
    const item = siteReport.engines[engine];
    return {
      dredge: engine === "dredge",
      cells: [
        engineCellHtml(engine),
        numCell(item?.build?.wall_ms, fmtNum(item?.build?.wall_ms, 1000)),
        miBCell(item?.build?.max_rss_bytes),
        miBCell(item?.artifact?.shipped_bytes),
        miBCell(item?.artifact?.normalized_brotli_q5_bytes),
      ],
    };
  });
  return `<h3>Index build &amp; artifact size</h3>${tableHtml(headers, rows)}`;
}

// Measured in the browser: what a visitor downloads and how long init takes.
function deliveryInitSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("Cold ↓", GLOSSARY.cold_bytes, "MiB"),
    head("Warm ↓", GLOSSARY.warm_bytes, "MiB"),
    head("Cold init", GLOSSARY.cold_init, "ms"),
    head("Warm init", GLOSSARY.warm_init, "ms"),
    head("Warm mem", GLOSSARY.warm_mem, "MiB"),
  ];
  const rows = engines.map((engine) => {
    const item = siteReport.engines[engine];
    const cold = coldOf(item);
    const warm = warmOf(item);
    return {
      dredge: engine === "dredge",
      cells: [
        engineCellHtml(engine),
        miBCell(cold?.network_bytes),
        miBCell(warm?.network_bytes),
        numCell(cold?.init_ms, fmtNum(cold?.init_ms)),
        numCell(warm?.init_ms, fmtNum(warm?.init_ms)),
        miBCell(warm?.memory?.bytes),
      ],
    };
  });
  return `<h3>Delivery &amp; initialization</h3>${tableHtml(headers, rows)}`;
}

function latencySection(title, tip, site, siteReport, engines, { mode, filtered, bm25Only = false }) {
  const workload = filtered ? siteReport.filtered_queries : siteReport.queries;
  const byLabelQuery = Object.fromEntries(workload.map((q) => [q.label, q]));
  const headers = [
    "Engine",
    ...workload.map((q) => bandHeader(q.label, byLabelQuery[q.label])),
  ];
  const rows = engines.map((engine) => {
    const slice = sliceByLabel(siteReport.engines[engine], { mode, filtered });
    return {
      dredge: engine === "dredge",
      cells: [engineCellHtml(engine), ...workload.map((q) => cellHtml(slice[q.label]))],
    };
  });
  const rankingNote = bm25Only ? bm25NoteHtml(engines) : rankingNoteHtml(engines);
  return `<h3>${term(title, tip)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${rankingNote}${tableHtml(headers, rows)}`;
}

// How facet-count latency scales with the number of dimensions counted.
function facetScalingSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("none", GLOSSARY.facet_none, "ms"),
    head("one facet", GLOSSARY.facet_one, "ms"),
    head("all facets", GLOSSARY.facet_all, "ms"),
  ];
  const rows = engines.map((engine) => {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    const at = (mode) =>
      measurements.find(
        (row) =>
          row.label === "broad" && row.facet_mode === mode && !row.filtered && row.page_size === 10,
      );
    return {
      dredge: engine === "dredge",
      cells: [engineCellHtml(engine), cellHtml(at("none")), cellHtml(at("one")), cellHtml(at("all"))],
    };
  });
  const inventory = facetInventoryText(siteReport);
  const note = inventory ? `<p class="units">${esc(inventory)}</p>` : "";
  return `<h3>${term("Facet scaling — broad query", GLOSSARY.facet_scaling)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${rankingNoteHtml(engines)}${note}${tableHtml(headers, rows)}`;
}

function paginationSection(site, siteReport, engines) {
  const pageSizes = [10, 50, 100, 200];
  const tableFor = (mode) => {
    const headers = ["Engine", ...pageSizes.map((size) => `n=${size}`)];
    const rows = engines.map((engine) => {
      const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
      return {
        dredge: engine === "dredge",
        cells: [
          engineCellHtml(engine),
          ...pageSizes.map((size) => {
            const m = measurements.find(
              (row) => row.scenario === "pagination" && row.facet_mode === mode && row.page_size === size,
            );
            return cellHtml(m);
          }),
        ],
      };
    });
    return `<h4 class="pane">${mode === "none" ? "no facet counts" : "with all facet counts"}</h4>${tableHtml(headers, rows)}`;
  };
  return (
    `<h3>${term("Pagination — broad query", GLOSSARY.pagination)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>` +
    rankingNoteHtml(engines) +
    tableFor("none") +
    tableFor("all")
  );
}

// Deep pagination: fixed page size at growing offsets on the broad query.
function deepPaginationSection(site, siteReport, engines) {
  const first = warmOf(siteReport.engines[engines[0]])?.measurements ?? [];
  const offsets = [...new Set(first.filter((r) => r.scenario === "deep").map((r) => r.offset))].sort(
    (a, b) => a - b,
  );
  if (!offsets.length) return "";
  const headers = ["Engine", ...offsets.map((o) => `offset ${o}`)];
  const rows = engines.map((engine) => {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    return {
      dredge: engine === "dredge",
      cells: [
        engineCellHtml(engine),
        ...offsets.map((offset) => {
          const m = measurements.find((row) => row.scenario === "deep" && row.offset === offset);
          return cellHtml(m);
        }),
      ],
    };
  });
  return `<h3>${term("Deep pagination — broad query", GLOSSARY.deep)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${rankingNoteHtml(engines)}${tableHtml(headers, rows)}`;
}

// Sorted keyword: the broad query re-sorted alphabetically, with and without
// facet counts — the cost of letting a user change result ordering.
function sortedSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("no facets", GLOSSARY.facet_none, "ms"),
    head("all facets", GLOSSARY.facet_all, "ms"),
  ];
  const rows = engines.map((engine) => {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    const at = (mode) =>
      measurements.find((row) => row.scenario === "sorted" && row.facet_mode === mode);
    return { dredge: engine === "dredge", cells: [engineCellHtml(engine), cellHtml(at("none")), cellHtml(at("all"))] };
  });
  return `<h3>${term("Sorted keyword — broad + alphabetical title", GLOSSARY.sorted_keyword)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${explicitOrderNoteHtml()}${tableHtml(headers, rows)}`;
}

// No-keyword alphabetical browse, with and without facet counts.
function browseSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("no facets", GLOSSARY.facet_none, "ms"),
    head("all facets", GLOSSARY.facet_all, "ms"),
  ];
  const rows = engines.map((engine) => {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    const at = (mode) =>
      measurements.find((row) => row.scenario === "browse" && row.facet_mode === mode);
    return { dredge: engine === "dredge", cells: [engineCellHtml(engine), cellHtml(at("none")), cellHtml(at("all"))] };
  });
  return `<h3>${term("Browse — no keyword, alphabetical", GLOSSARY.browse)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${explicitOrderNoteHtml(true)}${tableHtml(headers, rows)}`;
}

// Facet-count latency when a structured filter is already active (gap 3).
function filteredFacetSection(site, siteReport, engines) {
  const workload = siteReport.filtered_queries ?? [];
  if (!workload.length) return "";
  const byLabelQuery = Object.fromEntries(workload.map((q) => [q.label, q]));
  const headers = ["Engine", ...workload.map((q) => bandHeader(q.label, byLabelQuery[q.label]))];
  const rows = engines.map((engine) => {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    return {
      dredge: engine === "dredge",
      cells: [
        engineCellHtml(engine),
        ...workload.map((q) => {
          const m = measurements.find(
            (row) => row.scenario === "filtered" && row.facet_mode === "all" && row.label === q.label,
          );
          return cellHtml(m);
        }),
      ],
    };
  });
  return `<h3>${term("Facet counts under an active filter", GLOSSARY.lat_facet)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${rankingNoteHtml(engines)}${tableHtml(headers, rows)}`;
}

// A worked example: a real query from this run and the actual facet counts it
// returned. Hidden behind a tooltip so it illustrates without cluttering.
function exampleSection(site, siteReport, engines) {
  // Prefer dredge's broad all-facets row; fall back to any engine with counts.
  let example = null;
  for (const engine of ["dredge", ...engines]) {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    const row = measurements.find(
      (m) => m.scenario === "keyword" && m.label === "broad" && m.facet_mode === "all" && m.facet_counts,
    );
    if (row) {
      example = { engine, row };
      break;
    }
  }
  if (!example) return "";
  const { engine, row } = example;
  const lines = [
    `query: “${row.query}”  →  ${row.result_count} results (sorted by ${rankingModelFor(engine).label})`,
    "",
    "facet counts returned — “how many results if I pick this value”:",
  ];
  for (const [field, buckets] of Object.entries(row.facet_counts ?? {})) {
    const pairs = Object.entries(buckets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([value, count]) => `${value}: ${count}`)
      .join("   ");
    lines.push(`  ${field}  →  ${pairs}`);
  }
  const tip = lines.join("\n");
  return `<p class="example">${term("See a real search and its facet counts", tip)} <span class="sub">(from ${esc(engine)}, this run)</span></p>`;
}

// Result correctness reads the stored `correctness` block verbatim — the shared
// module (scripts/correctness.mjs) is the sole evaluator, so this table can
// never disagree with the Markdown report or the gate.
const CORRECTNESS_COLUMNS = [
  ["counted", "Counted", GLOSSARY.counted],
  ["sorted_browse", "Sorted-browse", GLOSSARY.sorted_browse],
  ["sortable_keyword", "Sortable-keyword", GLOSSARY.sortable_keyword],
  ["facet_integrity", "Facet integrity", GLOSSARY.facet_integrity],
  ["disjunctive", "Disjunctive", GLOSSARY.disjunctive],
  ["filter_consistency", "Filter consistency", GLOSSARY.filter_consistency],
];

function correctnessSection(site, siteReport, engines) {
  const headers = ["Engine", ...CORRECTNESS_COLUMNS.map(([, label, tip]) => term(label, tip))];
  const mark = (value) =>
    value === null || value === undefined
      ? "–"
      : value
        ? '<span class="ok">✓</span>'
        : '<span class="bad">✗</span>';
  const rows = engines.map((engine) => {
    const correctness = siteReport.engines[engine]?.correctness ?? {};
    return {
      dredge: engine === "dredge",
      cells: [engineCellHtml(engine), ...CORRECTNESS_COLUMNS.map(([key]) => mark(correctness[key]))],
    };
  });
  return `<h3>Result correctness</h3><p class="ranking-note"><strong>Ranking:</strong> these checks validate totals, facets, filters, and explicit sorts; they do not evaluate relevance ordering or quality.</p>${tableHtml(headers, rows)}`;
}

function multiTabSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("Tabs", GLOSSARY.mt_tabs, "n"),
    head("Single", GLOSSARY.mt_single, "MiB"),
    head("Total", GLOSSARY.mt_total, "MiB"),
    head("p95", GLOSSARY.mt_p95, "ms"),
  ];
  const rows = engines.map((engine) => {
    const item = siteReport.engines[engine];
    const multitab = item?.browser?.multitab;
    const single = warmOf(item)?.memory?.bytes;
    if (!multitab?.pages?.length) {
      return { dredge: engine === "dredge", cells: [engineCellHtml(engine), "–", miBCell(single), "–", "–"] };
    }
    const pages = multitab.pages;
    const mems = pages.map((page) => page.memory?.bytes).filter((v) => v != null);
    const total = mems.length ? mems.reduce((t, v) => t + v, 0) : null;
    const p95s = pages.map((page) => page?.measurements?.[0]?.p95_ms).filter((v) => v != null);
    const worstP95 = p95s.length ? Math.max(...p95s) : null;
    return {
      dredge: engine === "dredge",
      cells: [
        engineCellHtml(engine),
        String(multitab.tabs),
        miBCell(single),
        miBCell(total),
        numCell(worstP95, fmtNum(worstP95)),
      ],
    };
  });
  return `<h3>${term("Multi-tab", "N tabs open at once on the same origin. The total is every tab's memory summed. Engines that load a full independent index per tab scale toward N× a single tab; Dredge elects one leader tab to own the SQLite index and the rest relay to it, downloading nothing, so the index is held once no matter how many tabs are open. p95 is the slowest tab with all N searching at once.")} memory &amp; latency</h3>${rankingNoteHtml(engines)}${tableHtml(headers, rows)}`;
}

const CAVEATS = [
  "Relevance *quality* is not measured or compared. Ranking scores differ across engines (this is a product benchmark, not a claim of identical retrieval models); notably FlexSearch's ordering is not BM25, which is part of why some of its operations are cheap.",
  "Multi-word queries are normalized to AND on every engine so they answer the same question: Lunr with a required (+) clause per token; native AND on Dredge, Pagefind, and FlexSearch; and Orama by intersecting per-token result sets in adapter JS, because its threshold:0 does NOT enforce AND across prefix-expanded tokens in the pinned version (a single token that expands to several indexed words would otherwise satisfy the multi-token gate). Phrases are sent unquoted and executed as AND-of-terms — no engine here runs true quoted-phrase (adjacency) queries — so each band's document frequency is an adjacency floor and every engine's own result_count shows its divergence.",
  "Match sets still differ by design: Dredge uses ANDed FTS prefix terms, Pagefind and Lunr apply their own stemming, Orama intersects prefix-expanded per-token matches, FlexSearch uses forward tokenization. Two engines can legitimately return different totals for the same query — so every correctness check judges an engine against itself.",
  "Every engine is measured doing the full faceted-search work: an exact total, a fully sorted result set, and (where facets are counted) every facet's per-value counts. FlexSearch, Lunr, and Orama enumerate the whole match set and tally facets in JavaScript — FlexSearch and Lunr because they have no native count/facet/browse, and Orama because enforcing correct multi-token AND requires materializing the match set. FlexSearch's active filter is also applied in JavaScript because its native tag search verifiably drops matches (a 400-doc/50-expected probe returned 25). This is the honest cost of matching product behaviour, not a handicap.",
  "Facet counts under an active filter are disjunctive (skip-self) on every engine, computed differently per engine: Dredge natively in one round trip; FlexSearch, Lunr, and Orama as a second tally over the already-enumerated unfiltered match set; Pagefind from result.totalFilters (empirically verified to equal the unfiltered search's counts). All of that work happens inside the timed search call.",
  "Latency is measured on localhost, so it is compute-bound; the Cold ↓ / Warm ↓ columns are the network-cost proxy. The server negotiates Brotli quality 5 for ordinary compressible files and preserves product-provided compressed artifacts such as Dredge's quality-11 .db.br.",
  "Warm p95 is taken over a time-budgeted number of samples; a cell annotated with a small superscript (or a `*n` suffix in Markdown) had fewer than 10 samples and should be weighed accordingly. A ✗ cell is a scenario that timed out, errored, or was skipped by the circuit breaker (reason in its tooltip) — distinct from a – cell, which was not measured.",
  "Browser memory uses performance.measureUserAgentSpecificMemory(), which the browser deliberately rate-limits (a randomized delay up to ~20s), so it is sampled once per page; a slow sample that exceeds the operation timeout is recorded as unavailable rather than failing the run.",
];

// --- Charts (inline SVG, no external libraries) ------------------------------

const CHART_W = 560;
const CHART_PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

// Horizontal bar chart: one bar per engine. dredge is drawn in the accent color.
function svgBars(items, { decimals = 2 } = {}) {
  const rowH = 30;
  const padTop = 6;
  const labelW = 92;
  const barMax = CHART_W - labelW - 70;
  const max = Math.max(1e-9, ...items.map((i) => i.value ?? 0));
  const height = padTop * 2 + items.length * rowH;
  const rows = items
    .map((it, idx) => {
      const y = padTop + idx * rowH;
      const value = it.value;
      const width = value ? Math.max(2, (value / max) * barMax) : 2;
      const fill = it.highlight ? "var(--accent)" : "var(--bar)";
      return `<text x="0" y="${y + rowH / 2}" class="cl ${it.highlight ? "hl" : ""}" dominant-baseline="middle">${esc(it.label)}</text>` +
        `<rect x="${labelW}" y="${y + 6}" width="${width.toFixed(1)}" height="${rowH - 14}" rx="3" fill="${fill}"></rect>` +
        `<text x="${(labelW + width + 6).toFixed(1)}" y="${y + rowH / 2}" class="cv" dominant-baseline="middle">${value == null ? "–" : value.toFixed(decimals)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${CHART_W} ${height}" class="chart" role="img" preserveAspectRatio="xMinYMin meet">${rows}</svg>`;
}

// Grouped horizontal bars: one cluster per engine, one sub-bar per key.
function svgGroupedBars(groups, keys, { decimals = 2 } = {}) {
  const subH = 15;
  const subGap = 3;
  const groupPad = 12;
  const padTop = 6;
  const labelW = 92;
  const barMax = CHART_W - labelW - 70;
  const max = Math.max(1e-9, ...groups.flatMap((g) => keys.map((k) => g.values[k] ?? 0)));
  const groupH = keys.length * (subH + subGap) + groupPad;
  const height = padTop * 2 + groups.length * groupH;
  let y = padTop;
  const blocks = groups
    .map((g) => {
      const groupTop = y;
      const bars = keys
        .map((key, ki) => {
          const value = g.values[key];
          const width = value ? Math.max(2, (value / max) * barMax) : 2;
          const barY = y;
          y += subH + subGap;
          return `<rect x="${labelW}" y="${barY}" width="${width.toFixed(1)}" height="${subH}" rx="2" fill="${CHART_PALETTE[ki % CHART_PALETTE.length]}"></rect>` +
            `<text x="${(labelW + width + 5).toFixed(1)}" y="${barY + subH / 2}" class="cv" dominant-baseline="middle">${value == null ? "–" : value.toFixed(decimals)}</text>`;
        })
        .join("");
      const labelY = groupTop + (keys.length * (subH + subGap)) / 2 - subGap / 2;
      y += groupPad;
      return `<text x="0" y="${labelY}" class="cl ${g.highlight ? "hl" : ""}" dominant-baseline="middle">${esc(g.label)}</text>${bars}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${CHART_W} ${height}" class="chart" role="img" preserveAspectRatio="xMinYMin meet">${blocks}</svg>`;
}

function legend(keys, prefix = "") {
  const items = keys
    .map(
      (key, index) =>
        `<span class="lg"><i style="background:${CHART_PALETTE[index % CHART_PALETTE.length]}"></i>${esc(prefix + key)}</span>`,
    )
    .join("");
  return `<div class="legend">${items}</div>`;
}

function chartsSection(site, siteReport, engines) {
  const mib = (bytes) => (bytes == null ? null : bytes / 1024 / 1024);
  const series = (fn) =>
    engines.map((engine) => ({ label: engine, highlight: engine === "dredge", value: fn(siteReport.engines[engine]) }));
  const measurementsOf = (engine) => warmOf(siteReport.engines[engine])?.measurements ?? [];

  const broadAll = (item) =>
    (warmOf(item)?.measurements ?? []).find(
      (r) => r.scenario === "keyword" && r.label === "broad" && r.facet_mode === "all",
    )?.p95_ms ?? null;

  const scalingGroups = engines.map((engine) => {
    // none/all live on the broad keyword rows; the `one` facet mode lives on the
    // separate scaling scenario. Match on label + facet_mode across both.
    const at = (mode) =>
      measurementsOf(engine).find(
        (r) => r.label === "broad" && !r.filtered && r.page_size === 10 && r.facet_mode === mode,
      )?.p95_ms ?? null;
    return { label: engine, highlight: engine === "dredge", values: { none: at("none"), one: at("one"), all: at("all") } };
  });
  const pageGroups = engines.map((engine) => {
    const at = (size) =>
      measurementsOf(engine).find(
        (r) => r.scenario === "pagination" && r.facet_mode === "all" && r.page_size === size,
      )?.p95_ms ?? null;
    return {
      label: engine,
      highlight: engine === "dredge",
      values: { 10: at(10), 50: at(50), 100: at(100), 200: at(200) },
    };
  });

  const card = (title, tip, unit, body, ranking = false) =>
    `<div class="chart-card"><h4 class="pane">${term(title, tip)} <span class="u">${esc(unit)}</span></h4>${ranking ? rankingNoteHtml(engines) : ""}${body}</div>`;

  return `<div class="chart-grid">
    ${card("Faceted query latency", GLOSSARY.lat_facet, "warm p95 ms · lower is better", svgBars(series(broadAll)), true)}
    ${card("Browser memory", GLOSSARY.warm_mem, "MiB · lower is better", svgBars(series((i) => mib(warmOf(i)?.memory?.bytes))))}
    ${card("Cold encoded response bytes", GLOSSARY.cold_bytes, "MiB · lower is better", svgBars(series((i) => mib(coldOf(i)?.network_bytes))))}
    ${card("Normalized index size (br q5)", GLOSSARY.normalized_brotli, "MiB · lower is better", svgBars(series((i) => mib(i?.artifact?.normalized_brotli_q5_bytes))))}
    ${card("Facet scaling", GLOSSARY.facet_scaling, "warm p95 ms", legend(["none", "one", "all"]) + svgGroupedBars(scalingGroups, ["none", "one", "all"]), true)}
    ${card("Pagination (all facets)", GLOSSARY.pagination, "warm p95 ms", legend(["10", "50", "100", "200"], "n=") + svgGroupedBars(pageGroups, ["10", "50", "100", "200"]), true)}
  </div>`;
}

// The cross-corpus scaling story — the thesis of the benchmark — leads the page:
// engines as rows, corpora as columns ordered by page count, one compact table
// per headline metric. Best-in-column highlighting (via tableHtml) surfaces the
// transfer-size crossover and large-corpus latency at a glance. Failed/missing
// cells render ✗/– inline.
function scalingSection(report, engines) {
  const sites = Object.entries(report.sites).sort(
    (a, b) => (a[1].page_count ?? 0) - (b[1].page_count ?? 0),
  );
  if (!sites.length) return "";
  const headers = [
    "Engine",
    ...sites.map(([site, sr]) =>
      head(sr.label ?? site, `The ${sr.label ?? site} corpus.`, `${(sr.page_count ?? 0).toLocaleString()} pages`),
    ),
  ];
  const metricTable = (
    title,
    tip,
    unit,
    cellFor,
    { ranking = false, bm25Only = false, onlyEngines = engines } = {},
  ) => {
    const rows = onlyEngines.map((engine) => ({
      dredge: engine === "dredge",
      cells: [engineCellHtml(engine), ...sites.map(([, sr]) => cellFor(sr.engines[engine]))],
    }));
    const note = bm25Only
      ? bm25NoteHtml(onlyEngines)
      : ranking
        ? rankingNoteHtml(onlyEngines)
        : "";
    return `<h3>${term(title, tip)} <span class="sub">${esc(unit)}</span></h3>${note}${tableHtml(headers, rows)}`;
  };
  const richP95 = (item) =>
    cellHtml(
      (warmOf(item)?.measurements ?? []).find(
        (r) => r.scenario === "keyword" && r.label === "broad" && r.facet_mode === "all",
      ),
    );
  const bm25 = bm25Engines(engines);
  return `
<section class="scaling" id="scaling">
  <h2>Cross-corpus scaling <span class="pages">engines × corpus size — lower is better</span></h2>
  <p class="units">The whole thesis in four tables: how each engine scales from the smallest corpus to the largest. Best value per column is highlighted, worst de-emphasized.</p>
  ${metricTable("Cold response bytes", GLOSSARY.cold_bytes, "MiB", (item) => miBCell(coldOf(item)?.network_bytes))}
  ${metricTable("Cold initialization", GLOSSARY.cold_init, "ms", (item) => numCell(coldOf(item)?.init_ms, fmtNum(coldOf(item)?.init_ms)))}
  ${metricTable("Rich query p95 — broad, all facets", GLOSSARY.lat_facet, "warm p95 ms", richP95, { ranking: true })}
  ${bm25.length ? metricTable("BM25-only rich query p95 — broad, all facets", GLOSSARY.lat_facet, "warm p95 ms", richP95, { bm25Only: true, onlyEngines: bm25 }) : ""}
  ${metricTable("Warm tab memory", GLOSSARY.warm_mem, "MiB", (item) => miBCell(warmOf(item)?.memory?.bytes))}
</section>`;
}

// Sticky in-page navigation: the scaling section plus one link per site.
function navHtml(report) {
  const links = [`<a href="#scaling">Scaling</a>`];
  for (const [site, sr] of Object.entries(report.sites)) {
    links.push(`<a href="#site-${esc(site)}">${esc(sr.label ?? site)}</a>`);
  }
  return `<nav class="sitenav">${links.join("")}</nav>`;
}

export function renderHtml(report, engines) {
  const env = report.environment ?? {};
  const sites = Object.entries(report.sites);
  const sections = sites
    .map(([site, siteReport]) => {
      const pages = siteReport.page_count?.toLocaleString?.() ?? siteReport.page_count;
      const bm25 = bm25Engines(engines);
      return `
<section class="site" id="site-${esc(site)}">
  <h2>${esc(siteReport.label ?? site)} <span class="pages">${esc(pages)} pages</span></h2>
  ${exampleSection(site, siteReport, engines)}
  <div class="view tables">
    ${banner("Measured on the build machine", "Costs paid once when the site is built — not by a visitor. Index build time, indexer peak memory, and the deployable artifact size.")}
    ${buildMachineSection(site, siteReport, engines)}
    ${banner("Measured in the browser (Chromium, localhost)", "Costs a visitor pays: bytes over the wire, initialization, query latency, and tab memory. Localhost removes bandwidth, so latency is compute-bound and the Cold ↓ column is the network-cost proxy.")}
    ${deliveryInitSection(site, siteReport, engines)}
    ${latencySection("Rich query latency — exact total + all facet counts", GLOSSARY.lat_facet, site, siteReport, engines, { mode: "all", filtered: false })}
    ${bm25.length ? latencySection("BM25-only rich query latency — exact total + all facet counts", GLOSSARY.lat_facet, site, siteReport, bm25, { mode: "all", filtered: false, bm25Only: true }) : ""}
    ${filteredFacetSection(site, siteReport, engines)}
    ${latencySection("Filtered query latency — no facet counts", GLOSSARY.lat_filtered, site, siteReport, engines, { mode: "none", filtered: true })}
    ${facetScalingSection(site, siteReport, engines)}
    ${sortedSection(site, siteReport, engines)}
    ${browseSection(site, siteReport, engines)}
    ${paginationSection(site, siteReport, engines)}
    ${deepPaginationSection(site, siteReport, engines)}
    ${latencySection("Plain query latency — diagnostic", GLOSSARY.lat_plain, site, siteReport, engines, { mode: "none", filtered: false })}
    ${correctnessSection(site, siteReport, engines)}
    ${multiTabSection(site, siteReport, engines)}
  </div>
  <div class="view charts">
    ${chartsSection(site, siteReport, engines)}
  </div>
</section>`;
    })
    .join("\n");

  const versions = Object.entries(env.engine_versions ?? {})
    .map(([name, version]) => `${esc(name)} ${esc(version)}`)
    .join(", ");

  const caveatsHtml = CAVEATS.map((line) => `<li>${esc(line)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Static search benchmark</title>
<style>
:root {
  --bg: #ffffff; --fg: #1a1a1c; --muted: #6b6b72; --line: #e6e6ea;
  --card: #fafafb; --accent: #3b5bdb; --accent-soft: #eef2ff;
  --tip-bg: #1f2937; --tip-fg: #f3f4f6; --ok: #1f9d55; --bad: #d64545;
  --bar: #b9c2e8; --chart-1: #3b5bdb; --chart-2: #12b886; --chart-3: #e8963b; --chart-4: #ae3ec9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a; --fg: #e8e8ea; --muted: #9a9aa2; --line: #2b2b31;
    --card: #1d1d22; --accent: #8aa0ff; --accent-soft: #23273a;
    --tip-bg: #f3f4f6; --tip-fg: #1f2937; --ok: #4ade80; --bad: #f87171;
    --bar: #3a4266; --chart-1: #8aa0ff; --chart-2: #38d9a9; --chart-3: #ffb454; --chart-4: #da77f2;
  }
}
:root[data-theme="dark"] {
  --bg: #16161a; --fg: #e8e8ea; --muted: #9a9aa2; --line: #2b2b31;
  --card: #1d1d22; --accent: #8aa0ff; --accent-soft: #23273a;
  --tip-bg: #f3f4f6; --tip-fg: #1f2937; --ok: #4ade80; --bad: #f87171;
  --bar: #3a4266; --chart-1: #8aa0ff; --chart-2: #38d9a9; --chart-3: #ffb454; --chart-4: #da77f2;
}
:root[data-theme="light"] {
  --bg: #ffffff; --fg: #1a1a1c; --muted: #6b6b72; --line: #e6e6ea;
  --card: #fafafb; --accent: #3b5bdb; --accent-soft: #eef2ff;
  --tip-bg: #1f2937; --tip-fg: #f3f4f6; --ok: #1f9d55; --bad: #d64545;
  --bar: #b9c2e8; --chart-1: #3b5bdb; --chart-2: #12b886; --chart-3: #e8963b; --chart-4: #ae3ec9;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 2.2rem 1.2rem 4rem; }
header h1 { font-size: 1.7rem; margin: 0 0 .3rem; letter-spacing: -0.01em; }
header .meta { color: var(--muted); font-size: .85rem; margin: 0; }
header .versions { color: var(--muted); font-size: .78rem; margin: .3rem 0 0; }
details.howto { margin: 1.4rem 0 .5rem; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
details.howto > summary { cursor: pointer; padding: .7rem 1rem; font-weight: 600; }
details.howto ul { margin: 0 0 1rem; padding: 0 1.4rem; }
details.howto li { margin: .45rem 0; color: var(--fg); font-size: .88rem; }
section.site { margin-top: 2.4rem; }
section.site > h2 {
  font-size: 1.25rem; margin: 0 0 .2rem; padding-bottom: .4rem;
  border-bottom: 2px solid var(--accent-soft);
}
section.site > h2 .pages { color: var(--muted); font-weight: 400; font-size: .9rem; }
h3 { font-size: .98rem; margin: 1.5rem 0 .2rem; }
h3 .sub { color: var(--muted); font-weight: 400; font-size: .82rem; }
.banner {
  margin: 1.8rem 0 .2rem; padding: .35rem .7rem; border-radius: 8px;
  font-size: .8rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  background: var(--accent-soft); color: var(--accent); border: 1px solid var(--line);
}
.qtext {
  display: block; color: var(--muted); font-weight: 400; font-size: .74rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: .15rem;
  max-width: 12ch; overflow: hidden; text-overflow: ellipsis;
}
.units { color: var(--muted); font-size: .76rem; margin: .1rem 0 .5rem; }
.ranking-note {
  margin: .25rem 0 .55rem; padding: .45rem .65rem; border-left: 3px solid var(--accent);
  background: var(--accent-soft); color: var(--fg); font-size: .78rem;
}
.ranking-note .term { white-space: nowrap; }
.engine-ranking { display: block; color: var(--muted); font-size: .7rem; font-weight: 400; }
.model-detail { display: block; max-width: 48rem; color: var(--muted); font-size: .74rem; white-space: normal; }
.ranking-overview { margin-top: 1.4rem; }
.ranking-overview > h2 { font-size: 1.1rem; margin: 0 0 .2rem; }
.muted { color: var(--muted); }
.u { color: var(--muted); font-weight: 400; font-size: .74rem; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: .5rem .7rem; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
th { background: var(--card); font-weight: 600; font-size: .82rem; position: sticky; top: 0; }
th:first-child, td.engine { text-align: left; }
td.engine { font-weight: 600; }
tr:last-child td { border-bottom: none; }
tr.row-dredge td { background: var(--accent-soft); }
tr.row-dredge td.engine { box-shadow: inset 3px 0 0 var(--accent); }
.ok { color: var(--ok); font-weight: 700; }
.bad { color: var(--bad); font-weight: 700; }
/* Failure cell (timeout/error/skipped): distinct from a "–" not-measured cell. */
.fail { color: var(--bad); font-weight: 600; cursor: help; }
sup.lown { color: var(--muted); font-size: .7em; margin-left: 1px; cursor: help; }
/* Best-in-column (lowest, since lower is better) highlighted; worst de-emphasized. */
td.best { font-weight: 700; color: var(--ok); }
td.worst { color: var(--muted); }
.term {
  border-bottom: 1px dotted var(--muted); cursor: help; outline: none;
}
.term:focus { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
#tooltip {
  position: fixed; z-index: 100; max-width: 320px; padding: .6rem .75rem;
  background: var(--tip-bg); color: var(--tip-fg); border-radius: 8px;
  font-size: .8rem; line-height: 1.45; white-space: pre-line;
  box-shadow: 0 8px 30px rgba(0,0,0,.28); opacity: 0; visibility: hidden;
  transition: opacity .12s ease; pointer-events: none;
}
#tooltip.show { opacity: 1; visibility: visible; }
.theme-toggle {
  float: right; background: var(--card); color: var(--fg); border: 1px solid var(--line);
  border-radius: 8px; padding: .35rem .6rem; font-size: .8rem; cursor: pointer; margin-left: .4rem;
}
h4.pane { font-size: .82rem; font-weight: 600; color: var(--muted); margin: 1rem 0 .3rem; }
p.example { margin: .5rem 0 .2rem; font-size: .9rem; }
p.example .sub { color: var(--muted); font-size: .8rem; }
/* View switching: tables by default, charts when the body opts in. */
.view.charts { display: none; }
body.show-charts .view.tables { display: none; }
body.show-charts .view.charts { display: block; }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; margin-top: .6rem; }
.chart-card { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: .7rem .9rem 1rem; }
svg.chart { width: 100%; height: auto; display: block; margin-top: .3rem; overflow: visible; }
svg.chart .cl { fill: var(--fg); font-size: 12px; }
svg.chart .cl.hl { font-weight: 700; fill: var(--accent); }
svg.chart .cv { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.legend { display: flex; flex-wrap: wrap; gap: .1rem .9rem; margin: .2rem 0 .1rem; }
.legend .lg { display: inline-flex; align-items: center; gap: .3rem; color: var(--muted); font-size: .76rem; }
.legend .lg i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.legend-key { font-size: .8rem; color: var(--muted); margin: .5rem 0 0; }
.legend-key .muted { color: var(--muted); }
/* Sticky in-page navigation. */
.sitenav {
  position: sticky; top: 0; z-index: 50; display: flex; flex-wrap: wrap; gap: .35rem .4rem;
  padding: .5rem .2rem; margin: 1rem -.2rem 0; background: var(--bg); border-bottom: 1px solid var(--line);
}
.sitenav a {
  color: var(--muted); text-decoration: none; font-size: .78rem; padding: .2rem .55rem;
  border-radius: 999px; border: 1px solid var(--line);
}
.sitenav a:hover, .sitenav a:focus { color: var(--accent); border-color: var(--accent); outline: none; }
/* Cross-corpus scaling section (leads the page). */
section.scaling { margin-top: 1.6rem; }
section.scaling > h2 {
  font-size: 1.25rem; margin: 0 0 .2rem; padding-bottom: .4rem; border-bottom: 2px solid var(--accent-soft);
}
section.scaling > h2 .pages { color: var(--muted); font-weight: 400; font-size: .9rem; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <button class="theme-toggle" id="theme" type="button">◐ theme</button>
  <button class="theme-toggle" id="view" type="button">◧ charts</button>
  <h1>Static search benchmark</h1>
  <p class="meta">Generated ${esc(report.generated_at ?? "")}${env.cpu ? " · " + esc(env.cpu) : ""}${env.node ? " · Node " + esc(env.node) : ""}</p>
  ${versions ? `<p class="versions">${versions}</p>` : ""}
  <p class="meta">Hover, tap, or focus any <span class="term" tabindex="0" data-tip="Underlined terms carry a definition. Hover or focus to preview it; click to pin it open.">underlined term</span> for its definition. The Dredge row is highlighted.</p>
  <p class="legend-key">
    <span class="ok">✓</span> pass ·
    <span class="bad">✗</span> failed (timeout/error/skipped — reason in tooltip) ·
    – not measured ·
    <span class="ok">best</span> / <span class="muted">worst</span> per column (lower is better)
  </p>
</header>

${navHtml(report)}

${rankingOverviewHtml(engines)}

<details class="howto">
  <summary>How to read this &amp; caveats</summary>
  <ul>${caveatsHtml}</ul>
</details>

${scalingSection(report, engines)}
${sections}
</div>

<div id="tooltip" role="tooltip"></div>
<script>
(function () {
  var tip = document.getElementById("tooltip");
  var pinned = null;

  function place(el) {
    var r = el.getBoundingClientRect();
    tip.textContent = el.getAttribute("data-tip") || "";
    tip.classList.add("show");
    var tr = tip.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left), window.innerWidth - tr.width - 8);
    var top = r.bottom + 8;
    if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 8;
    tip.style.left = left + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function hide() { if (!pinned) { tip.classList.remove("show"); } }

  document.querySelectorAll(".term").forEach(function (el) {
    el.addEventListener("mouseenter", function () { if (!pinned) place(el); });
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", function () { if (!pinned) place(el); });
    el.addEventListener("blur", hide);
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      if (pinned === el) { pinned = null; tip.classList.remove("show"); }
      else { pinned = el; place(el); }
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); }
      if (e.key === "Escape") { pinned = null; hide(); el.blur(); }
    });
  });
  document.addEventListener("click", function () { pinned = null; tip.classList.remove("show"); });
  window.addEventListener("scroll", function () { if (pinned) place(pinned); }, true);

  var toggle = document.getElementById("theme");
  toggle.addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    var next = current === "dark" ? "light" : current === "light" ? "dark" : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
  });

  var viewToggle = document.getElementById("view");
  viewToggle.addEventListener("click", function () {
    var charts = document.body.classList.toggle("show-charts");
    viewToggle.textContent = charts ? "▤ tables" : "◧ charts";
  });
})();
</script>
</body>
</html>
`;
}
