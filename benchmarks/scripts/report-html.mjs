// Renders the benchmark `report` object into a single self-contained HTML page.
// Every metric and test name is a "term": its verbose explanation lives in the
// GLOSSARY below and is surfaced through one shared, position-fixed tooltip so
// it never clips inside a horizontally scrolling table. The page embeds no
// external resources (fonts, scripts, styles) and works from file://.

const GLOSSARY = {
  build_s: "Wall-clock seconds to build the search index in an isolated process. Corpus extraction happens beforehand and is not counted.",
  build_rss: "Peak resident memory (RSS) of the indexer *process* during the build, via GNU time on Linux. This is a build-machine cost — not browser memory.",
  raw: "Total size of the deployable artifact files on disk, uncompressed.",
  brotli: "Sum of each artifact file compressed on its own at Brotli quality 5 — a proxy for what a CDN with Brotli would serve.",
  cold_bytes: "Bytes actually transferred over the network on a first visit (empty HTTP cache and, for Dredge, empty OPFS). Counted at the server, so it includes fetches made inside a Web Worker — notably Dredge downloading its database and WASM.",
  warm_bytes: "Bytes transferred on a repeat visit. The HTTP cache (and Dredge's persisted OPFS database) mean this is usually ~0.",
  cold_init: "Milliseconds from the adapter starting to the index being queryable, on a first visit. Page navigation and adapter download happen before this timer starts.",
  warm_init: "Initialization time on a repeat visit, reusing the HTTP cache and any persisted database.",
  warm_mem: "Total tab memory after querying — main thread, workers, and WASM heap together — via performance.measureUserAgentSpecificMemory(). This is the only fair cross-engine measure, because some engines keep their index in a worker's WASM heap rather than the JS heap.",
  p95: "95th-percentile query latency (ms) over the measured iterations, after three unrecorded warm-up queries, on a warm page.",
  lat_plain: "A free-text query returning a page of results sorted by relevance and the exact total match count. No filter, no facet counts.",
  lat_filtered: "The same query restricted to a single benchmark_group value — the engine's structured-filter path — still fully counted.",
  lat_facet: "The same query, also returning per-value counts for every facet dimension across the WHOLE match set. Native for Dredge/Pagefind/Orama; FlexSearch and Lunr must enumerate every match and tally in JavaScript.",
  facet_scaling: "How query latency grows as more facet dimensions are counted on the broad query — no facets, one facet, then all available facets. Each per-value count is the 'number next to a facet value' users expect: how many results would remain if that value were applied.",
  facet_none: "Baseline: the query with a full result count but no facet counting.",
  facet_one: "Counting per-value totals for a single facet dimension.",
  facet_all: "Counting per-value totals for every facet dimension at once. Pagefind computes all facet counts on every search regardless, so its cost is flat across these three.",
  pagination: "The broad query run at growing page sizes, both without and with all facet counts. Isolates result-hydration cost — materializing 10 vs 200 results — separate from finding and counting them.",
  deep: "The broad query read at increasing offsets: page one, the middle page, and the last page, all at a fixed page size with all facet counts. Exposes deep-offset cost — an in-memory engine slices an array, while a database must skip rows.",
  browse: "The no-keyword landing state: every document returned, sorted alphabetically by title, with an exact total count and (optionally) every facet count. This is the faceted-browse entry point before any search term.",
  counted: "Whether every run returns the true total match count, never a page-capped one. A faceted UI needs the real total for its result count and pagination, so lazy top-k results are disqualified.",
  sorted: "Whether the no-keyword browse page comes back in alphabetical title order — the defined sort when there is no relevance signal.",
  disjunctive: "When a filter is active on a facet, whether the engine still counts that facet's OTHER values (so a user can switch values within it). ✓ is disjunctive/skip-self counting; ✗ is conjunctive (only the applied value survives, so its neighbours read as zero).",
  facet_integrity: "Whether each facet dimension's own per-value counts sum to the engine's own total on unfiltered facet queries (facets partition the match set). Checked against each engine itself — cross-engine totals differ by design because stemming and prefix rules vary.",
  example: "A real query from this run and the exact facet counts it returned, to show the shape of what every engine computes on each search.",
  mt_tabs: "Number of browser tabs opened at once on the same origin.",
  mt_single: "Memory of a single tab running the full workload — the baseline instance.",
  mt_all: "Sum of every tab's own memory when all N are open together.",
  mt_leader: "Memory of the tab that owns the index. For Dredge this is the elected leader tab that holds the SQLite database; for other engines every tab is its own full instance, so this is just the largest.",
  mt_follower: "Memory of a non-owning tab. For Dredge a follower holds no database — it relays searches to the leader over a BroadcastChannel and downloads nothing. For other engines it is another full independent copy.",
  mt_ratio: "All-tabs memory divided by (tabs × leader memory), i.e. compared to N fully independent instances. ~1.0 means every tab pays full price; well under 1.0 means tabs share one index.",
  mt_leader_p95: "Query latency on the index-owning (leader) tab.",
  mt_follower_p95: "Query latency on a relaying (follower) tab — for Dredge this includes the round trip to the leader.",
};

const BAND_BASE = {
  rare: "Rare band: a term matching roughly one document.",
  selective: "Selective band: a term matching about 0.1% of the corpus.",
  moderate: "Moderate band: a term matching about 2% of the corpus.",
  broad: "Broad band: a term matching about 10% of the corpus — the widest, most expensive result set.",
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

function tableHtml(headerCells, rows) {
  const head = `<tr>${headerCells.map((cell) => `<th>${cell}</th>`).join("")}</tr>`;
  const body = rows
    .map(
      (row) =>
        `<tr${row.dredge ? ' class="row-dredge"' : ""}>${row.cells
          .map((cell, index) => `<td${index === 0 ? ' class="engine"' : ""}>${cell}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table>${head}${body}</table></div>`;
}

// Per-band column header whose tip names the actual query term and its frequency.
function bandHeader(band, query) {
  const base = BAND_BASE[band] ?? `${band} band.`;
  const detail = query
    ? ` Here: “${query.query}”, matching ${query.document_frequency} of the corpus.`
    : "";
  return term(band, base + detail);
}

function overviewSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("Build", GLOSSARY.build_s, "s"),
    head("Build RSS", GLOSSARY.build_rss, "MiB"),
    head("Raw", GLOSSARY.raw, "MiB"),
    head("Brotli", GLOSSARY.brotli, "MiB"),
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
        esc(engine),
        fmtNum(item?.build?.wall_ms, 1000),
        `${fmtMiB(item?.build?.max_rss_bytes)}`,
        `${fmtMiB(item?.artifact?.raw_bytes)}`,
        `${fmtMiB(item?.artifact?.brotli_q5_bytes)}`,
        `${fmtMiB(cold?.network_bytes)}`,
        `${fmtMiB(warm?.network_bytes)}`,
        fmtNum(cold?.init_ms),
        fmtNum(warm?.init_ms),
        `${fmtMiB(warm?.memory?.bytes)}`,
      ],
    };
  });
  return `<h3>Sizes, load &amp; memory</h3>${tableHtml(headers, rows)}`;
}

function latencySection(title, tip, site, siteReport, engines, { mode, filtered }) {
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
      cells: [esc(engine), ...workload.map((q) => fmtNum(slice[q.label]?.p95_ms))],
    };
  });
  return `<h3>${term(title, tip)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${tableHtml(headers, rows)}`;
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
      )?.p95_ms;
    return {
      dredge: engine === "dredge",
      cells: [esc(engine), fmtNum(at("none")), fmtNum(at("one")), fmtNum(at("all"))],
    };
  });
  const inventory = facetInventoryText(siteReport);
  const note = inventory ? `<p class="units">${esc(inventory)}</p>` : "";
  return `<h3>${term("Facet scaling — broad query", GLOSSARY.facet_scaling)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${note}${tableHtml(headers, rows)}`;
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
          esc(engine),
          ...pageSizes.map((size) => {
            const m = measurements.find(
              (row) => row.scenario === "pagination" && row.facet_mode === mode && row.page_size === size,
            );
            return fmtNum(m?.p95_ms);
          }),
        ],
      };
    });
    return `<h4 class="pane">${mode === "none" ? "no facet counts" : "with all facet counts"}</h4>${tableHtml(headers, rows)}`;
  };
  return (
    `<h3>${term("Pagination — broad query", GLOSSARY.pagination)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>` +
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
        esc(engine),
        ...offsets.map((offset) => {
          const m = measurements.find((row) => row.scenario === "deep" && row.offset === offset);
          return fmtNum(m?.p95_ms);
        }),
      ],
    };
  });
  return `<h3>${term("Deep pagination — broad query", GLOSSARY.deep)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${tableHtml(headers, rows)}`;
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
      measurements.find((row) => row.scenario === "browse" && row.facet_mode === mode)?.p95_ms;
    return { dredge: engine === "dredge", cells: [esc(engine), fmtNum(at("none")), fmtNum(at("all"))] };
  });
  return `<h3>${term("Browse — no keyword, alphabetical", GLOSSARY.browse)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${tableHtml(headers, rows)}`;
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
        esc(engine),
        ...workload.map((q) => {
          const m = measurements.find(
            (row) => row.scenario === "filtered" && row.facet_mode === "all" && row.label === q.label,
          );
          return fmtNum(m?.p95_ms);
        }),
      ],
    };
  });
  return `<h3>${term("Facet counts under an active filter", GLOSSARY.lat_facet)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${tableHtml(headers, rows)}`;
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
    `query: “${row.query}”  →  ${row.result_count} results (sorted by relevance)`,
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

function correctnessSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    term("Counted", GLOSSARY.counted),
    term("Sorted", GLOSSARY.sorted),
    term("Facet integrity", GLOSSARY.facet_integrity),
    term("Disjunctive", GLOSSARY.disjunctive),
  ];
  const mark = (value) =>
    value === null ? "–" : value ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
  const rows = engines.map((engine) => {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    const counted = measurements.length ? measurements.every((m) => m.count_exact !== false) : null;

    const browseRows = measurements.filter((m) => m.scenario === "browse" && m.first_titles);
    const sorted = browseRows.length
      ? browseRows.every((m) =>
          (m.first_titles ?? []).every(
            (title, i, all) =>
              i === 0 || String(all[i - 1]).toLowerCase() <= String(title).toLowerCase(),
          ),
        )
      : null;

    const facetRows = measurements.filter(
      (m) => m.facet_mode && m.facet_mode !== "none" && !m.filtered,
    );
    let integrity = null;
    if (facetRows.length) {
      integrity = facetRows.every((m) => {
        const fields = Object.values(m.facet_counts ?? {});
        if (!fields.length) return false;
        return fields.every((buckets) => {
          const sum = Object.values(buckets ?? {}).reduce((total, n) => total + Number(n), 0);
          return Object.keys(buckets ?? {}).length > 0 && sum === m.result_count;
        });
      });
    }

    const filteredAll = measurements.filter(
      (m) => m.scenario === "filtered" && m.facet_mode === "all" && m.filter,
    );
    const disjunctive = filteredAll.length
      ? filteredAll.some((m) => Object.keys(m.facet_counts?.[m.filter.field] ?? {}).length > 1)
      : null;

    return {
      dredge: engine === "dredge",
      cells: [esc(engine), mark(counted), mark(sorted), mark(integrity), mark(disjunctive)],
    };
  });
  return `<h3>Result correctness</h3>${tableHtml(headers, rows)}`;
}

function multiTabSection(site, siteReport, engines) {
  const headers = [
    "Engine",
    head("Tabs", GLOSSARY.mt_tabs, "n"),
    head("Single", GLOSSARY.mt_single, "MiB"),
    head("All-tabs", GLOSSARY.mt_all, "MiB"),
    head("Leader", GLOSSARY.mt_leader, "MiB"),
    head("Follower", GLOSSARY.mt_follower, "MiB"),
    head("vs N×", GLOSSARY.mt_ratio, "ratio"),
    head("Leader p95", GLOSSARY.mt_leader_p95, "ms"),
    head("Follower p95", GLOSSARY.mt_follower_p95, "ms"),
  ];
  const rows = engines.map((engine) => {
    const item = siteReport.engines[engine];
    const multitab = item?.browser?.multitab;
    const single = warmOf(item)?.memory?.bytes;
    if (!multitab?.pages?.length) {
      return { dredge: engine === "dredge", cells: [esc(engine), "–", fmtMiB(single), "–", "–", "–", "–", "–", "–"] };
    }
    const pages = multitab.pages;
    const mems = pages.map((page) => page.memory?.bytes).filter((v) => v != null);
    const total = mems.reduce((t, v) => t + v, 0);
    const leaderMem = mems.length ? Math.max(...mems) : null;
    const followerMem = mems.length ? Math.min(...mems) : null;
    const byMem = [...pages].sort((a, b) => (b.memory?.bytes ?? 0) - (a.memory?.bytes ?? 0));
    const p95Of = (page) => page?.measurements?.[0]?.p95_ms ?? null;
    const ratio = leaderMem && mems.length ? (total / (multitab.tabs * leaderMem)).toFixed(2) : "–";
    return {
      dredge: engine === "dredge",
      cells: [
        esc(engine),
        String(multitab.tabs),
        fmtMiB(single),
        fmtMiB(total),
        fmtMiB(leaderMem),
        fmtMiB(followerMem),
        ratio,
        fmtNum(p95Of(byMem[0])),
        fmtNum(p95Of(byMem[byMem.length - 1])),
      ],
    };
  });
  return `<h3>${term("Multi-tab", "N tabs open at once on the same origin. Dredge elects one leader tab to own the database; the rest relay to it. Other engines load a full independent index per tab.")} memory &amp; latency</h3>${tableHtml(headers, rows)}`;
}

const CAVEATS = [
  "Ranking scores are not comparable across engines; this is a product benchmark, not a claim of identical retrieval models.",
  "Match sets differ by design: Dredge uses ANDed FTS prefix terms, Pagefind applies its own stemming, Orama runs without typo tolerance, FlexSearch uses forward tokenization, Lunr uses its English pipeline. So two engines can legitimately return different totals for the same query.",
  "Latency is measured on localhost, so it is compute-bound; the Cold ↓ / Warm ↓ columns are the network-cost proxy. Bytes are served uncompressed, so a raw-JSON engine is compared against its own on-disk artifact while Dredge ships an already-compressed database.",
  "Every engine is measured doing the full faceted-search work: an exact total count, a fully sorted result set, and (where facets are counted) every facet's per-value counts. FlexSearch and Lunr have no native count/facet/browse, so they enumerate the whole match set and tally in JavaScript — the cost of matching product behaviour, not a handicap.",
  "Facet counts under an active filter differ by model: Dredge returns disjunctive (skip-self) counts, so the filtered facet still shows its other values; the JavaScript engines return conjunctive counts. See the Disjunctive column under Result correctness.",
  "Browser memory uses performance.measureUserAgentSpecificMemory(), which the browser deliberately rate-limits (a randomized delay up to ~20s), so it is sampled once per page.",
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
    const at = (mode) =>
      measurementsOf(engine).find(
        (r) => r.scenario === "keyword" && r.label === "broad" && r.facet_mode === mode,
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

  const card = (title, tip, unit, body) =>
    `<div class="chart-card"><h4 class="pane">${term(title, tip)} <span class="u">${esc(unit)}</span></h4>${body}</div>`;

  return `<div class="chart-grid">
    ${card("Faceted query latency", GLOSSARY.lat_facet, "warm p95 ms · lower is better", svgBars(series(broadAll)))}
    ${card("Browser memory", GLOSSARY.warm_mem, "MiB · lower is better", svgBars(series((i) => mib(warmOf(i)?.memory?.bytes))))}
    ${card("Cold bytes over the wire", GLOSSARY.cold_bytes, "MiB · lower is better", svgBars(series((i) => mib(coldOf(i)?.network_bytes))))}
    ${card("Index size (Brotli)", GLOSSARY.brotli, "MiB · lower is better", svgBars(series((i) => mib(i?.artifact?.brotli_q5_bytes))))}
    ${card("Facet scaling", GLOSSARY.facet_scaling, "warm p95 ms", legend(["none", "one", "all"]) + svgGroupedBars(scalingGroups, ["none", "one", "all"]))}
    ${card("Pagination (all facets)", GLOSSARY.pagination, "warm p95 ms", legend(["10", "50", "100", "200"], "n=") + svgGroupedBars(pageGroups, ["10", "50", "100", "200"]))}
  </div>`;
}

export function renderHtml(report, engines) {
  const env = report.environment ?? {};
  const sites = Object.entries(report.sites);
  const sections = sites
    .map(([site, siteReport]) => {
      const pages = siteReport.page_count?.toLocaleString?.() ?? siteReport.page_count;
      return `
<section class="site">
  <h2>${esc(siteReport.label ?? site)} <span class="pages">${esc(pages)} pages</span></h2>
  ${exampleSection(site, siteReport, engines)}
  <div class="view tables">
    ${overviewSection(site, siteReport, engines)}
    ${latencySection("Query latency", GLOSSARY.lat_plain, site, siteReport, engines, { mode: "none", filtered: false })}
    ${latencySection("Query latency — active filter", GLOSSARY.lat_filtered, site, siteReport, engines, { mode: "none", filtered: true })}
    ${latencySection("Facet-count latency — all facets", GLOSSARY.lat_facet, site, siteReport, engines, { mode: "all", filtered: false })}
    ${facetScalingSection(site, siteReport, engines)}
    ${paginationSection(site, siteReport, engines)}
    ${deepPaginationSection(site, siteReport, engines)}
    ${browseSection(site, siteReport, engines)}
    ${filteredFacetSection(site, siteReport, engines)}
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
.units { color: var(--muted); font-size: .76rem; margin: .1rem 0 .5rem; }
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
</header>

<details class="howto">
  <summary>How to read this &amp; caveats</summary>
  <ul>${caveatsHtml}</ul>
</details>

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
