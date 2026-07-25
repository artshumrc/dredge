import { bm25Engines, rankingModelFor } from "./ranking-models.mjs";

// Renders the benchmark `report` object into a single self-contained HTML page.
// Every metric and test name is a "term": its verbose explanation lives in the
// GLOSSARY below and is surfaced through one shared, position-fixed tooltip so
// it never clips inside a horizontally scrolling table. The page embeds no
// external resources (fonts, scripts, styles) and works from file://.

const GLOSSARY = {
  build_s: "How long it took to build the search index, in seconds. This happens once, when the site is published — visitors never wait for it.",
  build_rss: "How much memory the computer needed while building the index. A one-time cost of publishing the site, not something a visitor's device pays.",
  shipped: "The total size of the files that get deployed with the site — what a visitor's browser has to download to make search work.",
  normalized_brotli: "A fairer size comparison: every engine's files are compressed the same way and by the same amount, so no engine gets an edge just from using stronger compression.",
  cold_bytes: "How many bytes a visitor's browser downloads, after compression, to make search work the very first time they visit.",
  warm_bytes: "How many bytes a returning visitor's browser has to download again. Usually close to zero, since the browser already saved everything from the first visit.",
  cold_init: "How many milliseconds until search is ready to use on a visitor's very first visit, once the page and its search files have already arrived.",
  warm_init: "How many milliseconds search takes to become ready on a repeat visit, when the browser already has everything saved from before.",
  warm_mem: "How much memory the browser uses after doing a search, added up across the whole tab (including anything running in the background). This is the fairest way to compare engines that store their data differently behind the scenes.",
  p95: "A 'typical worst case' response time, in milliseconds: 95 out of 100 searches were at least this fast. The slowest few outliers are set aside so one fluke doesn't distort the number.",
  lat_plain: "For comparison only: how fast a plain search is when it just returns matching results and a total count, with none of the per-category counts a real search box would also show. See the row below for what those extra counts cost.",
  lat_filtered: "How fast a search is once a visitor has already narrowed things down with a filter, like clicking a category.",
  lat_facet: "The real-world case: a search that returns matching results, an exact total, and also counts how many results sit under every filter option — everything a good search box shows a visitor at once.",
  facet_scaling: "How much slower a search gets as it's asked to count more filter categories at once: none, then one, then all of them.",
  facet_none: "A search that returns a result count but doesn't count anything for the filters.",
  facet_one: "A search that also counts how many results fall under one filter category.",
  facet_all: "A search that counts how many results fall under every filter category at once — the most counting work a search can be asked to do.",
  pagination: "How much slower a search gets simply from returning more results per page at once — 10 vs. 50 vs. 100 vs. 200.",
  deep: "How much slower a search gets when a visitor jumps deep into the results (say, page 50) instead of staying on page one.",
  browse: "What a visitor sees before typing anything: every item listed, sorted alphabetically, with an exact count.",
  counted: "Does the engine report the real, exact number of matches — rather than an estimate, or a number capped at whatever fit on one page?",
  sorted_browse: "When a visitor hasn't typed a search term yet, are the results actually shown in alphabetical order, like they should be?",
  sorted_keyword: "What happens when a visitor searches for something, but then asks to see the results sorted alphabetically instead of by best match.",
  sortable_keyword: "When a visitor asks for alphabetical order during a search, does the engine actually deliver it?",
  disjunctive: "If a visitor has already filtered by one option in a category, can they still see accurate counts for the OTHER options in that same category, so they could switch? ✓ means yes. ✗ means picking one option makes every other option in that category look like it has zero results.",
  facet_integrity: "Do a category's own counts add up correctly? For example, do all of an engine's 'genre' counts add up to that same engine's own total number of results?",
  filter_consistency: "If a visitor filters by a category value, does the result count match what that same value showed before the filter was applied? A mismatch means the filter is quietly losing matches.",
  example: "A real search from this test run, showing exactly what came back — the results and the count for each filter option.",
  mt_tabs: "How many browser tabs were open on the site at once, to see what happens when a visitor keeps several tabs open at the same time.",
  mt_single: "How much memory the heaviest of the open tabs uses on its own — for engines that elect one tab to hold the shared index, that's the leader; for the rest, every tab is about the same size anyway. Taken from this same multi-tab run (not a separate single-tab test), so it's directly comparable to the total next to it.",
  mt_total: "How much memory ALL the open tabs use, added together. Most engines load a full, separate copy of the search index into every tab, so memory use multiplies with each extra tab a visitor opens. Dredge instead keeps one shared copy across all of a visitor's tabs, so its total climbs much more slowly.",
  mt_p95: "How slow the worst-performing tab gets when every open tab is searching at the same moment — the worst wait a visitor sees with several tabs open.",
};

// Band tooltips for the six-query workload: two single-token endpoints and four
// phrases mined from real corpus text. Phrases are sent unquoted and executed as
// AND-of-terms, so the band's document frequency is an *adjacency* floor — each
// engine's own result_count shows how far its stemming/prefix expansion diverges.
const BAND_BASE = {
  rare: "A rare search word — one that only matches about one page in the whole site.",
  broad: "A common search word — one that matches roughly 1 out of every 10 pages, the widest single-word test here.",
  "phrase-selective": "A specific two-word phrase that only turns up on a small slice of pages (roughly 1 in 1,000).",
  "phrase-moderate": "A moderately common two-word phrase (turns up on roughly 1 in 50 pages).",
  "phrase-broad": "A common two-word phrase (turns up on roughly 1 in 10 pages).",
  phrase3: "A three-word phrase that only turns up on a small slice of pages (roughly 1 in 200).",
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
const divOrNull = (value, divisor = 1) => (value == null ? null : value / divisor);

// The headline rich-query row: broad keyword, all facet counts, warm page.
// Shared by the cross-corpus table and the cross-corpus latency chart.
function richP95Of(item) {
  return (warmOf(item)?.measurements ?? []).find(
    (r) => r.scenario === "keyword" && r.label === "broad" && r.facet_mode === "all",
  );
}

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
  // Any column with at least two comparable values is click-sortable — reruns
  // the same best/worst-highlighted values in a new row order, nothing else
  // changes, so the highlighting computed above stays correct after a sort.
  const head = `<tr>${headerCells
    .map((cell, index) => {
      if (index === 0 || !columnStats[index]) return `<th>${cell}</th>`;
      return `<th class="sortable" data-col="${index}" tabindex="0" role="button" aria-label="Sort by this column">${cell}<span class="sort-ind" aria-hidden="true"></span></th>`;
    })
    .join("")}</tr>`;
  const body = rows
    .map((row) => {
      const cells = row.cells
        .map((cell, index) => {
          const isObject = cell && typeof cell === "object";
          const text = isObject ? cell.text : cell;
          const classes = [];
          if (index === 0) classes.push("engine");
          const stats = columnStats[index];
          let dataAttr = "";
          if (isObject && stats && cell.value != null) {
            if (cell.value === stats.min) classes.push("best");
            else if (cell.value === stats.max) classes.push("worst");
            dataAttr = ` data-v="${cell.value}"`;
          }
          const attr = classes.length ? ` class="${classes.join(" ")}"` : "";
          return `<td${attr}${dataAttr}>${text}</td>`;
        })
        .join("");
      const rowClasses = [row.dredge && "row-dredge", row.caution && "row-caution"].filter(Boolean);
      return `<tr${rowClasses.length ? ` class="${rowClasses.join(" ")}"` : ""}>${cells}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

// Per-band column header: the label (with a tooltip carrying the band detail)
// plus the actual query text shown inline, so a reader never has to open a
// tooltip to see what was searched.
function bandHeader(band, query) {
  const base = BAND_BASE[band] ?? `${band} band.`;
  const detail = query
    ? ` In this test: “${query.query}”, matching ${query.document_frequency.toLocaleString()} page${query.document_frequency === 1 ? "" : "s"}.`
    : "";
  const queryText = query ? `<span class="qtext">${esc(query.query)}</span>` : "";
  return `${term(band, base + detail)}${queryText}`;
}

// A labeled banner separating build-machine metrics from in-browser metrics.
function banner(text, tip) {
  return `<div class="banner">${tip ? term(text, tip) : esc(text)}</div>`;
}

// Every table row shows an engine's ranking model as a small caption with its
// own tooltip, so the per-table ranking callouts this used to require aren't
// needed — the provenance travels with the row everywhere it appears.
function engineCellHtml(engine) {
  const model = rankingModelFor(engine);
  return `${esc(engine)}<span class="engine-ranking">${term(model.label, model.detail)}</span>`;
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
      dredge: engine === "dredge", caution: engine === "flexsearch",
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
      dredge: engine === "dredge", caution: engine === "flexsearch",
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
      dredge: engine === "dredge", caution: engine === "flexsearch",
      cells: [engineCellHtml(engine), ...workload.map((q) => cellHtml(slice[q.label]))],
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
      );
    return {
      dredge: engine === "dredge", caution: engine === "flexsearch",
      cells: [engineCellHtml(engine), cellHtml(at("none")), cellHtml(at("one")), cellHtml(at("all"))],
    };
  });
  const inventory = facetInventoryText(siteReport);
  const tip = inventory ? `${GLOSSARY.facet_scaling} This corpus has ${inventory}.` : GLOSSARY.facet_scaling;
  return `<h3>${term("Facet scaling — broad query", tip)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${tableHtml(headers, rows)}`;
}

function paginationSection(site, siteReport, engines) {
  const pageSizes = [10, 50, 100, 200];
  const tableFor = (mode) => {
    const headers = ["Engine", ...pageSizes.map((size) => `n=${size}`)];
    const rows = engines.map((engine) => {
      const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
      return {
        dredge: engine === "dredge", caution: engine === "flexsearch",
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
      dredge: engine === "dredge", caution: engine === "flexsearch",
      cells: [
        engineCellHtml(engine),
        ...offsets.map((offset) => {
          const m = measurements.find((row) => row.scenario === "deep" && row.offset === offset);
          return cellHtml(m);
        }),
      ],
    };
  });
  return `<h3>${term("Deep pagination — broad query", GLOSSARY.deep)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${tableHtml(headers, rows)}`;
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
    return { dredge: engine === "dredge", caution: engine === "flexsearch", cells: [engineCellHtml(engine), cellHtml(at("none")), cellHtml(at("all"))] };
  });
  return `<h3>${term("Sorted keyword — broad + alphabetical title", GLOSSARY.sorted_keyword)} <span class="sub">${term("warm p95 ms", GLOSSARY.p95)}</span></h3>${tableHtml(headers, rows)}`;
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
    return { dredge: engine === "dredge", caution: engine === "flexsearch", cells: [engineCellHtml(engine), cellHtml(at("none")), cellHtml(at("all"))] };
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
      dredge: engine === "dredge", caution: engine === "flexsearch",
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
      dredge: engine === "dredge", caution: engine === "flexsearch",
      cells: [engineCellHtml(engine), ...CORRECTNESS_COLUMNS.map(([key]) => mark(correctness[key]))],
    };
  });
  return `<h3>${term("Result correctness", "These checks validate totals, facets, filters, and explicit sorts; they do not evaluate relevance ordering or quality.")}</h3>${tableHtml(headers, rows)}`;
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
    if (!multitab?.pages?.length) {
      const single = warmOf(item)?.memory?.bytes;
      return { dredge: engine === "dredge", caution: engine === "flexsearch", cells: [engineCellHtml(engine), "–", miBCell(single), "–", "–"] };
    }
    const pages = multitab.pages;
    const mems = pages.map((page) => page.memory?.bytes).filter((v) => v != null);
    // "Single" is the heaviest tab in THIS SAME run — the one actually holding
    // the index (the leader, for engines that elect one) — not a separate
    // standalone single-tab measurement. Mixing the two would be dishonest:
    // Dredge's standalone tab and its multi-tab leader tab aren't guaranteed
    // to carry identical memory, so comparing "Total" against an unrelated
    // baseline could hide or fabricate the very multiplication this table
    // exists to show.
    const single = mems.length ? Math.max(...mems) : null;
    const total = mems.length ? mems.reduce((t, v) => t + v, 0) : null;
    const p95s = pages.map((page) => page?.measurements?.[0]?.p95_ms).filter((v) => v != null);
    const worstP95 = p95s.length ? Math.max(...p95s) : null;
    return {
      dredge: engine === "dredge", caution: engine === "flexsearch",
      cells: [
        engineCellHtml(engine),
        String(multitab.tabs),
        miBCell(single),
        miBCell(total),
        numCell(worstP95, fmtNum(worstP95)),
      ],
    };
  });
  return `<h3>${term("Multi-tab", "Several browser tabs open on the site at once. 'Total' adds up every tab's memory. Most engines load a full copy of the search index into every tab, so memory use multiplies with each tab a visitor opens — Dredge instead keeps one shared copy across all of a visitor's tabs. The p95 number is how slow the worst tab gets when every tab searches at the same time.")} memory &amp; latency</h3>${tableHtml(headers, rows)}`;
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

// dredge always draws in the accent color. The other engines get their own
// palette (not CHART_PALETTE — its first entry equals --accent, which would
// make a non-dredge line indistinguishable from dredge's) in the order they
// appear, so color stays stable across every chart.
const ENGINE_PALETTE = ["var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
function engineColor(engine, engines) {
  if (engine === "dredge") return "var(--accent)";
  const others = engines.filter((e) => e !== "dredge");
  const index = others.indexOf(engine);
  return ENGINE_PALETTE[index % ENGINE_PALETTE.length];
}

// Hoverable/clickable: hovering or tapping an engine's name dims every other
// engine's line across all charts sharing this legend (see the engine-line
// highlight script at the bottom of the page), so a reader can trace one
// engine through five overlapping lines without the others in the way.
function engineLegend(engines) {
  const items = engines
    .map(
      (engine) =>
        `<span class="lg" data-engine="${attr(engine)}" tabindex="0" role="button" aria-label="Highlight ${attr(engine)}"><i style="background:${engineColor(engine, engines)}"></i>${esc(engine)}</span>`,
    )
    .join("");
  return `<div class="legend engine-legend">${items}</div>`;
}

// Tick label for a power-of-ten value: 0.01, 1, 100, 1k, 10k...
function formatTick(v) {
  if (v >= 1000) return `${parseFloat((v / 1000).toFixed(1))}k`;
  if (v >= 1) return String(Math.round(v));
  return String(parseFloat(v.toFixed(2)));
}

// A one-sentence, plain-English readout of the chart's rightmost (largest)
// corpus: dredge's value against its closest non-dredge competitor there —
// not the weakest competitor, so the comparison stays honest even when it's
// unflattering. Returns "" if dredge or every competitor is missing a value.
function scalingTakeaway(sites, valueFor, unitWord, verbs) {
  if (!sites.length) return "";
  const [siteKey, lastSite] = sites[sites.length - 1];
  const dredgeValue = valueFor(lastSite.engines?.dredge);
  const others = Object.keys(lastSite.engines ?? {})
    .filter((engine) => engine !== "dredge")
    .map((engine) => ({ engine, value: valueFor(lastSite.engines[engine]) }))
    .filter((o) => o.value != null && o.value > 0);
  if (dredgeValue == null || dredgeValue <= 0 || !others.length) return "";
  const closest = others.reduce((a, b) => (b.value < a.value ? b : a));
  const pages = (lastSite.page_count ?? 0).toLocaleString();
  const siteLabel = esc(lastSite.label ?? siteKey);
  const ratio = dredgeValue < closest.value ? closest.value / dredgeValue : dredgeValue / closest.value;
  if (ratio < 1.05) {
    return `<p class="takeaway">At <strong>${siteLabel}</strong> (${pages} pages), dredge is about the same as its closest competitor here, ${esc(closest.engine)} (${dredgeValue.toFixed(2)} vs. ${closest.value.toFixed(2)} ${esc(unitWord)}).</p>`;
  }
  const verb = dredgeValue < closest.value ? verbs.smaller : verbs.larger;
  return `<p class="takeaway">At <strong>${siteLabel}</strong> (${pages} pages): dredge is <strong>${ratio.toFixed(1)}×</strong> ${verb} than its closest competitor here, ${esc(closest.engine)} (${dredgeValue.toFixed(2)} vs. ${closest.value.toFixed(2)} ${esc(unitWord)}).</p>`;
}

// A log-scale line chart, one line per engine, x-axis is the corpus (categorical,
// since there are only a handful of sites): the shape that best shows how a
// metric grows with corpus size across three-plus orders of magnitude — a bar
// chart per corpus cannot show that trend at all. Values <= 0 or missing break
// the line rather than being plotted at a false position.
function scalingLineChart(title, tip, unit, unitWord, sites, engines, valueFor, verbs = { smaller: "smaller", larger: "bigger" }) {
  const width = 980;
  const height = 300;
  const padLeft = 58;
  const padRight = 24;
  const padTop = 16;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const series = engines.map((engine) => ({
    engine,
    points: sites.map(([, sr]) => valueFor(sr.engines[engine])),
  }));
  const allValues = series.flatMap((s) => s.points).filter((v) => v != null && v > 0);
  if (allValues.length < 2) return "";

  const logMin = Math.floor(Math.log10(Math.min(...allValues)));
  const logMax = Math.ceil(Math.log10(Math.max(...allValues)));
  const span = Math.max(1, logMax - logMin);
  const xAt = (i) => (sites.length > 1 ? padLeft + (i / (sites.length - 1)) * plotW : padLeft + plotW / 2);
  const yAt = (v) => padTop + plotH * (1 - (Math.log10(v) - logMin) / span);

  const step = span > 6 ? 2 : 1;
  let grid = "";
  for (let p = logMin; p <= logMax; p += step) {
    const y = yAt(10 ** p);
    grid +=
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" class="gl"></line>` +
      `<text x="${padLeft - 6}" y="${y.toFixed(1)}" class="ga" text-anchor="end" dominant-baseline="middle">${formatTick(10 ** p)}</text>`;
  }
  const xLabels = sites
    .map(([, sr], i) => `<text x="${xAt(i).toFixed(1)}" y="${height - 10}" class="ga" text-anchor="middle">${esc(sr.label ?? "")}</text>`)
    .join("");

  const lines = series
    .map(({ engine, points }) => {
      const color = engineColor(engine, engines);
      const isDredge = engine === "dredge";
      let d = "";
      let drawing = false;
      let dots = "";
      points.forEach((value, i) => {
        if (value == null || value <= 0) {
          drawing = false;
          return;
        }
        const x = xAt(i);
        const y = yAt(value);
        d += `${drawing ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
        drawing = true;
        dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isDredge ? 5.5 : 4}" fill="${color}"><title>${esc(engine)} — ${esc(sites[i][1].label ?? sites[i][0])}: ${value.toFixed(2)}</title></circle>`;
      });
      return `<g class="engine-line" data-engine="${attr(engine)}"><path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="${isDredge ? 3.6 : 2.4}"></path>${dots}</g>`;
    })
    .join("");

  const takeaway = scalingTakeaway(sites, valueFor, unitWord, verbs);
  const logScaleTip =
    "Log scale: equal steps up the axis mean equal multiples, not equal amounts — needed here because the values span several orders of magnitude, and a regular axis would flatten every small-corpus difference to the bottom.";
  return `<div class="chart-card chart-card-wide"><h4 class="pane">${term(title, tip)} <span class="u">${esc(unit)} · ${term("log scale", logScaleTip)}</span></h4>${takeaway}<svg viewBox="0 0 ${width} ${height}" class="chart linechart" role="img" preserveAspectRatio="xMinYMin meet">${grid}${lines}${xLabels}</svg></div>`;
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

  const card = (title, tip, unit, body) =>
    `<div class="chart-card"><h4 class="pane">${term(title, tip)} <span class="u">${esc(unit)}</span></h4>${body}</div>`;

  return `<div class="chart-grid">
    ${card("Faceted query latency", GLOSSARY.lat_facet, "warm p95 ms · lower is better", svgBars(series(broadAll)))}
    ${card("Browser memory", GLOSSARY.warm_mem, "MiB · lower is better", svgBars(series((i) => mib(warmOf(i)?.memory?.bytes))))}
    ${card("Cold encoded response bytes", GLOSSARY.cold_bytes, "MiB · lower is better", svgBars(series((i) => mib(coldOf(i)?.network_bytes))))}
    ${card("Normalized index size (br q5)", GLOSSARY.normalized_brotli, "MiB · lower is better", svgBars(series((i) => mib(i?.artifact?.normalized_brotli_q5_bytes))))}
    ${card("Facet scaling", GLOSSARY.facet_scaling, "warm p95 ms", legend(["none", "one", "all"]) + svgGroupedBars(scalingGroups, ["none", "one", "all"]))}
    ${card("Pagination (all facets)", GLOSSARY.pagination, "warm p95 ms", legend(["10", "50", "100", "200"], "n=") + svgGroupedBars(pageGroups, ["10", "50", "100", "200"]))}
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
  const metricTable = (title, tip, unit, cellFor, { onlyEngines = engines } = {}) => {
    const rows = onlyEngines.map((engine) => ({
      dredge: engine === "dredge", caution: engine === "flexsearch",
      cells: [engineCellHtml(engine), ...sites.map(([, sr]) => cellFor(sr.engines[engine]))],
    }));
    return `<h3>${term(title, tip)} <span class="sub">${esc(unit)}</span></h3>${tableHtml(headers, rows)}`;
  };
  const richP95 = (item) => cellHtml(richP95Of(item));
  const bm25 = bm25Engines(engines);
  const chartGrid = `<div class="chart-grid scaling-charts">
    ${scalingLineChart("Rich query latency", GLOSSARY.lat_facet, "warm p95 ms", "ms", sites, engines, (item) => richP95Of(item)?.p95_ms ?? null, { smaller: "faster", larger: "slower" })}
    ${scalingLineChart("Cold response bytes", GLOSSARY.cold_bytes, "MiB", "MiB", sites, engines, (item) => divOrNull(coldOf(item)?.network_bytes, 1024 * 1024))}
    ${scalingLineChart("Shipped artifact size", GLOSSARY.shipped, "MiB", "MiB", sites, engines, (item) => divOrNull(item?.artifact?.shipped_bytes, 1024 * 1024))}
    ${scalingLineChart("Warm tab memory", GLOSSARY.warm_mem, "MiB", "MiB", sites, engines, (item) => divOrNull(warmOf(item)?.memory?.bytes, 1024 * 1024))}
  </div>`;
  return `
<section class="scaling tabpanel" id="scaling" data-tab="scaling">
  <h2>Cross-corpus scaling <span class="pages">engines × corpus size — lower is better</span></h2>
  ${engineLegend(engines)}
  ${chartGrid}
  ${metricTable("Index build time", GLOSSARY.build_s, "s", (item) => numCell(divOrNull(item?.build?.wall_ms, 1000), fmtNum(item?.build?.wall_ms, 1000)))}
  ${metricTable("Shipped artifact size", GLOSSARY.shipped, "MiB", (item) => miBCell(item?.artifact?.shipped_bytes))}
  ${metricTable("Cold response bytes", GLOSSARY.cold_bytes, "MiB", (item) => miBCell(coldOf(item)?.network_bytes))}
  ${metricTable("Cold initialization", GLOSSARY.cold_init, "ms", (item) => numCell(coldOf(item)?.init_ms, fmtNum(coldOf(item)?.init_ms)))}
  ${metricTable("Rich query p95 — broad, all facets", GLOSSARY.lat_facet, "warm p95 ms", richP95)}
  ${bm25.length ? metricTable("BM25-only rich query p95 — broad, all facets", GLOSSARY.lat_facet, "warm p95 ms", richP95, { onlyEngines: bm25 }) : ""}
  ${metricTable("Warm tab memory", GLOSSARY.warm_mem, "MiB", (item) => miBCell(warmOf(item)?.memory?.bytes))}
</section>`;
}

// Sticky in-page navigation: the scaling section plus one link per site.
// Doubles as a tab switcher (see the tab script at the bottom of the page):
// data-tab matches each panel's own data-tab, and href keeps plain anchor
// navigation working with JavaScript disabled.
function navHtml(report) {
  const links = [`<a href="#scaling" data-tab="scaling">Scaling</a>`];
  for (const [site, sr] of Object.entries(report.sites)) {
    links.push(`<a href="#site-${esc(site)}" data-tab="site-${esc(site)}">${esc(sr.label ?? site)}</a>`);
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
<section class="site tabpanel" id="site-${esc(site)}" data-tab="site-${esc(site)}">
  <h2>${esc(siteReport.label ?? site)} <span class="pages">${esc(pages)} pages</span></h2>
  ${exampleSection(site, siteReport, engines)}
  <div class="view tables">
    <details class="site-detail">
      <summary>Full tables — build, delivery, latency, correctness, multi-tab</summary>
      <div class="site-detail-inner">
        ${banner("Measured on the build machine", "Costs paid once when the site is built — not by a visitor. Index build time, indexer peak memory, and the deployable artifact size.")}
        ${buildMachineSection(site, siteReport, engines)}
        ${banner("Measured in the browser (Chromium, localhost)", "Costs a visitor pays: bytes over the wire, initialization, query latency, and tab memory. Localhost removes bandwidth, so latency is compute-bound and the Cold ↓ column is the network-cost proxy.")}
        ${deliveryInitSection(site, siteReport, engines)}
        ${latencySection("Rich query latency — exact total + all facet counts", GLOSSARY.lat_facet, site, siteReport, engines, { mode: "all", filtered: false })}
        ${bm25.length ? latencySection("BM25-only rich query latency — exact total + all facet counts", GLOSSARY.lat_facet, site, siteReport, bm25, { mode: "all", filtered: false }) : ""}
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
    </details>
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
  --bar: #b9c2e8; --chart-1: #3b5bdb; --chart-2: #12b886; --chart-3: #e8963b; --chart-4: #ae3ec9; --chart-5: #d6336c;
  --warn: #9a6700; --warn-soft: #fff6dc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a; --fg: #e8e8ea; --muted: #9a9aa2; --line: #2b2b31;
    --card: #1d1d22; --accent: #8aa0ff; --accent-soft: #23273a;
    --tip-bg: #f3f4f6; --tip-fg: #1f2937; --ok: #4ade80; --bad: #f87171;
    --bar: #3a4266; --chart-1: #8aa0ff; --chart-2: #38d9a9; --chart-3: #ffb454; --chart-4: #da77f2; --chart-5: #ff8fa3;
    --warn: #ffcc66; --warn-soft: #332a10;
  }
}
:root[data-theme="dark"] {
  --bg: #16161a; --fg: #e8e8ea; --muted: #9a9aa2; --line: #2b2b31;
  --card: #1d1d22; --accent: #8aa0ff; --accent-soft: #23273a;
  --tip-bg: #f3f4f6; --tip-fg: #1f2937; --ok: #4ade80; --bad: #f87171;
  --bar: #3a4266; --chart-1: #8aa0ff; --chart-2: #38d9a9; --chart-3: #ffb454; --chart-4: #da77f2; --chart-5: #ff8fa3;
  --warn: #ffcc66; --warn-soft: #332a10;
}
:root[data-theme="light"] {
  --bg: #ffffff; --fg: #1a1a1c; --muted: #6b6b72; --line: #e6e6ea;
  --card: #fafafb; --accent: #3b5bdb; --accent-soft: #eef2ff;
  --tip-bg: #1f2937; --tip-fg: #f3f4f6; --ok: #1f9d55; --bad: #d64545;
  --bar: #b9c2e8; --chart-1: #3b5bdb; --chart-2: #12b886; --chart-3: #e8963b; --chart-4: #ae3ec9; --chart-5: #d6336c;
  --warn: #9a6700; --warn-soft: #fff6dc;
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
details.site-detail { margin: 1rem 0 .4rem; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
details.site-detail > summary {
  cursor: pointer; padding: .65rem 1rem; font-weight: 600; font-size: .88rem; color: var(--fg);
  list-style: none;
}
details.site-detail > summary::-webkit-details-marker { display: none; }
details.site-detail > summary::before { content: "▸ "; color: var(--muted); }
details.site-detail[open] > summary::before { content: "▾ "; }
details.site-detail[open] > summary { border-bottom: 1px solid var(--line); }
.site-detail-inner { padding: .2rem 1rem 1rem; }
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
.engine-ranking { display: block; color: var(--muted); font-size: .7rem; font-weight: 400; }
.muted { color: var(--muted); }
.u { color: var(--muted); font-weight: 400; font-size: .74rem; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: .5rem .7rem; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
th { background: var(--card); font-weight: 600; font-size: .82rem; position: sticky; top: 0; }
th:first-child, td.engine { text-align: left; }
td.engine { font-weight: 600; }
tr:last-child td { border-bottom: none; }
th.sortable { cursor: pointer; user-select: none; outline: none; }
th.sortable:hover, th.sortable:focus { color: var(--accent); }
.sort-ind { display: inline-block; width: 1em; color: var(--accent); font-size: .7em; }
tr.row-dredge td { background: var(--accent-soft); }
tr.row-dredge td.engine { box-shadow: inset 3px 0 0 var(--accent); }
/* FlexSearch's rows: not a failure, but its numbers use a cheaper ranking
   model than the other engines, which is part of why it's often fastest —
   flagged so a reader doesn't read that speed as a fully apples-to-apples win. */
tr.row-caution td { background: var(--warn-soft); }
tr.row-caution td.engine { box-shadow: inset 3px 0 0 var(--warn); }
tr.row-caution .engine-ranking { color: var(--warn); font-weight: 600; }
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
svg.chart.linechart { overflow: visible; }
svg.chart.linechart .gl { stroke: var(--line); stroke-width: 1; }
svg.chart.linechart .ga { fill: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
/* Cross-corpus scaling charts: one full-width chart per row — the whole point
   is to see a trend line across corpora, which a cramped multi-column grid
   defeats. */
.scaling-charts { display: grid; grid-template-columns: 1fr; gap: 1.4rem; margin: .3rem 0 1.6rem; }
.chart-card-wide { padding: 1rem 1.3rem 1.4rem; }
.chart-card-wide h4.pane { font-size: .92rem; }
p.takeaway { margin: .1rem 0 .5rem; font-size: .88rem; color: var(--fg); }
p.takeaway strong { color: var(--accent); }
/* Engine-line highlighting: hovering/tapping a legend entry dims every other
   engine's line on every chart sharing that legend. */
.engine-line { transition: opacity .15s ease; }
.engine-legend .lg { cursor: pointer; transition: opacity .15s ease, color .15s ease; border-radius: 5px; outline: none; }
.engine-legend .lg:hover, .engine-legend .lg:focus { color: var(--fg); }
.engine-line.dim { opacity: .12; }
.engine-legend .lg.dim { opacity: .4; }
.engine-legend .lg.pinned { color: var(--fg); font-weight: 700; }
.legend { display: flex; flex-wrap: wrap; gap: .1rem .9rem; margin: .2rem 0 .1rem; }
.legend .lg { display: inline-flex; align-items: center; gap: .35rem; color: var(--muted); font-size: .82rem; }
.legend .lg i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
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
.sitenav a.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 600; }
/* Tab switching (progressive enhancement): a .tabpanel only disappears once
   JavaScript has run and marked it .tab-hidden, so a no-JS visitor still gets
   the original single scrolling page with every section visible. */
.tabpanel.tab-hidden { display: none; }
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

  // Engine-line highlighting: hover previews, click pins (independent of the
  // tooltip's own pin state above).
  var legendItems = document.querySelectorAll(".engine-legend .lg[data-engine]");
  var engineLines = document.querySelectorAll(".engine-line[data-engine]");
  var pinnedEngine = null;
  function highlight(engine) {
    engineLines.forEach(function (el) {
      el.classList.toggle("dim", !!engine && el.getAttribute("data-engine") !== engine);
    });
    legendItems.forEach(function (el) {
      var mine = el.getAttribute("data-engine") === engine;
      el.classList.toggle("dim", !!engine && !mine);
      el.classList.toggle("pinned", !!pinnedEngine && mine);
    });
  }
  legendItems.forEach(function (el) {
    el.addEventListener("mouseenter", function () { if (!pinnedEngine) highlight(el.getAttribute("data-engine")); });
    el.addEventListener("mouseleave", function () { if (!pinnedEngine) highlight(null); });
    el.addEventListener("focus", function () { if (!pinnedEngine) highlight(el.getAttribute("data-engine")); });
    el.addEventListener("blur", function () { if (!pinnedEngine) highlight(null); });
    el.addEventListener("click", function () {
      var engine = el.getAttribute("data-engine");
      pinnedEngine = pinnedEngine === engine ? null : engine;
      highlight(pinnedEngine);
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); }
    });
  });

  // Click-to-sort table columns: reorders rows by the clicked column's
  // underlying numeric value; the best/worst highlighting was computed
  // per-column at render time, so it stays correct after any reorder.
  document.querySelectorAll("table").forEach(function (table) {
    var headers = table.querySelectorAll("th.sortable");
    headers.forEach(function (th) {
      function sortBy() {
        var col = Number(th.getAttribute("data-col"));
        var asc = th.getAttribute("data-dir") !== "asc";
        headers.forEach(function (h) {
          h.removeAttribute("data-dir");
          h.querySelector(".sort-ind").textContent = "";
        });
        th.setAttribute("data-dir", asc ? "asc" : "desc");
        th.querySelector(".sort-ind").textContent = asc ? "▲" : "▼";
        var tbody = table.querySelector("tbody");
        var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
        rows.sort(function (a, b) {
          var av = a.children[col].getAttribute("data-v");
          var bv = b.children[col].getAttribute("data-v");
          if (av === null && bv === null) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          var diff = parseFloat(av) - parseFloat(bv);
          return asc ? diff : -diff;
        });
        rows.forEach(function (row) { tbody.appendChild(row); });
      }
      // Capture phase: the header text is wrapped in a .term span whose own
      // click handler calls stopPropagation (so pinning its tooltip doesn't
      // also dismiss itself via the document-level click listener below).
      // That would otherwise swallow every click before it reached a sort
      // handler bound in the normal bubble phase.
      th.addEventListener("click", sortBy, true);
      th.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(); }
      });
    });
  });

  // Tab switcher: the sitenav pills swap which section is visible instead of
  // just scrolling to it. Without JavaScript every panel stays visible and
  // the links fall back to plain in-page anchors.
  var tabLinks = document.querySelectorAll(".sitenav a[data-tab]");
  var panels = document.querySelectorAll(".tabpanel");
  function activateTab(tab) {
    panels.forEach(function (panel) {
      panel.classList.toggle("tab-hidden", panel.getAttribute("data-tab") !== tab);
    });
    tabLinks.forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-tab") === tab);
    });
  }
  tabLinks.forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      var tab = a.getAttribute("data-tab");
      activateTab(tab);
      var panel = document.querySelector('.tabpanel[data-tab="' + tab + '"]');
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", "#" + tab);
    });
  });
  var initialTab = (location.hash || "#scaling").slice(1);
  if (!document.querySelector('.tabpanel[data-tab="' + initialTab + '"]')) initialTab = "scaling";
  activateTab(initialTab);
})();
</script>
</body>
</html>
`;
}
