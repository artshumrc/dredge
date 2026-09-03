// Renders the benchmark `report` object into the Markdown report. Kept as a pure
// function (report object in, string out) so both renderers can be smoke-tested
// against a fixture, and so it presents the SAME sections in the SAME order as
// the HTML renderer (report-html.mjs) — the two artifacts must never disagree.

import { CHECKS } from "./correctness.mjs";
import { bm25Engines, rankingModelFor } from "./ranking-models.mjs";

const mib = (bytes) => (bytes === undefined || bytes === null ? "-" : (bytes / 1024 / 1024).toFixed(2));
const number = (value, divisor = 1) =>
  value === undefined || value === null ? "-" : (value / divisor).toFixed(2);

function timeoutSeconds(row) {
  const match = /exceeded (\d+)ms/.exec(row?.error ?? "");
  return match ? Math.round(Number(match[1]) / 1000) : null;
}

// A latency cell: p95 for a measured row (a `*n` marker flags a thin sample of
// n < 10), a distinct ✗ + reason for an error row, and "-" when the row is
// absent (not measured). Failed scenarios stay legible, never blank.
function cell(row) {
  if (!row) return "-";
  if (row.error_kind === "skipped") return "✗ skipped";
  if (row.error_kind === "timeout") {
    const seconds = timeoutSeconds(row);
    return seconds ? `✗ >${seconds}s` : "✗ timeout";
  }
  if (row.error_kind) return "✗ error";
  if (row.p95_ms === undefined || row.p95_ms === null) return "-";
  const mark = row.sample_count !== undefined && row.sample_count < 10 ? `*${row.sample_count}` : "";
  return `${number(row.p95_ms)}${mark}`;
}

const warmOf = (item) => item?.browser?.warm;
const coldOf = (item) => item?.browser?.cold;

// Warm measurements matching a (facet_mode, filtered, page_size) slice, keyed by label.
function sliceByLabel(item, { mode, filtered, pageSize = 10 }) {
  const out = {};
  for (const m of warmOf(item)?.measurements ?? []) {
    if (m.facet_mode === mode && m.filtered === filtered && m.page_size === pageSize) {
      out[m.label] = m;
    }
  }
  return out;
}

function facetInventory(siteReport) {
  const facets = siteReport.facets ?? [];
  if (!facets.length) return "";
  return (
    `${facets.length} facet ${facets.length === 1 ? "dimension" : "dimensions"}: ` +
    facets.map((facet) => `${facet.name} (${facet.values} values)`).join(", ")
  );
}

const rightAligns = (n) => Array.from({ length: n }, () => "---:");

const NOTE =
  "Memory is measured with a single tab open. Engines that load the whole index into the page hold a full independent copy in every tab a visitor opens, so their memory cost multiplies with tab count; Dredge elects one leader tab to own the SQLite database and the others relay to it, so the index is held once no matter how many tabs are open.";

export function renderMarkdown(report, engines) {
  const rankingSummary = (selected = engines) =>
    selected.map((engine) => `${engine}: ${rankingModelFor(engine).label}`).join("; ");
  const rankingNote = (selected = engines) =>
    `**Ranking in this timing:** ${rankingSummary(selected)}. Relevance quality is not measured.`;
  const engineLabel = (engine) => `${engine} (${rankingModelFor(engine).label})`;
  const bm25 = bm25Engines(engines);
  const lines = [
    "# Static search benchmark",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "Every engine is measured delivering the same rich faceted-search experience: an",
    "exact total count, per-value facet counts over the whole match set, disjunctive",
    "(skip-self) counts under an active filter, and a sortable result set. Each site is",
    "split into what is **measured on the build machine** and what is **measured in the",
    "browser**. Latency cells are warm p95 in ms; a `*n` suffix flags a p95 taken over",
    "only *n* samples (< 10). `✗` is a failed scenario (timeout/error/skipped); `–` means",
    "not measured. Multi-word phrase queries are sent unquoted and run as AND-of-terms.",
    "`Shipped` is the product-default deployable artifact. `Normalized br q5` compresses",
    "each logical artifact at quality 5; for Dredge it substitutes the raw database for",
    "the shipped quality-11 `.db.br`. Cold/warm MiB are encoded response-body bytes;",
    "HTTP headers and transport framing are excluded.",
    "",
    NOTE,
    "",
    "## Ranking models",
    "",
    "Keyword timings include each engine's native relevance work. Raw timings compare",
    "complete product behaviour, not equivalent relevance quality.",
    "",
  ];

  const table = (header, aligns, rows) => {
    lines.push("| " + header.join(" | ") + " |");
    lines.push("| " + aligns.join(" | ") + " |");
    for (const row of rows) lines.push("| " + row.join(" | ") + " |");
  };
  const latencyTable = (siteReport, labels, slice) => {
    const rows = engines.map((engine) => {
      const byLabel = slice(siteReport.engines[engine]);
      return [engineLabel(engine), ...labels.map((label) => cell(byLabel[label]))];
    });
    table(["Engine", ...labels], ["---", ...rightAligns(labels.length)], rows);
  };
  const scenarioTable = (siteReport, scenario) => {
    const rows = engines.map((engine) => {
      const ms = warmOf(siteReport.engines[engine])?.measurements ?? [];
      const at = (mode) => ms.find((row) => row.scenario === scenario && row.facet_mode === mode);
      return [engineLabel(engine), cell(at("none")), cell(at("all"))];
    });
    table(["Engine", "no facets", "all facets"], ["---", "---:", "---:"], rows);
  };

  table(
    ["Engine", "Keyword ranking model", "BM25-only view"],
    ["---", "---", ":---:"],
    engines.map((engine) => {
      const model = rankingModelFor(engine);
      return [engine, `${model.label}: ${model.detail}`, model.bm25 ? "eligible" : "not eligible"];
    }),
  );

  for (const [, siteReport] of Object.entries(report.sites)) {
    const labels = siteReport.queries.map((query) => query.label);
    const filteredLabels = siteReport.filtered_queries.map((query) => query.label);
    lines.push("", `## ${siteReport.label} — ${siteReport.page_count.toLocaleString()} pages`, "");

    // 1) Build machine.
    lines.push("### Measured on the build machine", "");
    table(
      ["Engine", "Build s", "Build RSS MiB", "Shipped MiB", "Normalized br q5 MiB"],
      ["---", "---:", "---:", "---:", "---:"],
      engines.map((engine) => {
        const item = siteReport.engines[engine];
        return [
          engineLabel(engine),
          number(item?.build?.wall_ms, 1000),
          mib(item?.build?.max_rss_bytes),
          mib(item?.artifact?.shipped_bytes),
          mib(item?.artifact?.normalized_brotli_q5_bytes),
        ];
      }),
    );

    // 2) Browser — delivery & initialization.
    lines.push("", "### Measured in the browser (Chromium, localhost)", "", "#### Delivery & initialization", "");
    table(
      ["Engine", "Cold ↓ MiB", "Warm ↓ MiB", "Cold init ms", "Warm init ms", "Warm mem MiB"],
      ["---", "---:", "---:", "---:", "---:", "---:"],
      engines.map((engine) => {
        const item = siteReport.engines[engine];
        const cold = coldOf(item);
        const warm = warmOf(item);
        return [
          engineLabel(engine),
          mib(cold?.network_bytes),
          mib(warm?.network_bytes),
          number(cold?.init_ms),
          number(warm?.init_ms),
          mib(warm?.memory?.bytes),
        ];
      }),
    );

    // Queries legend so the label columns below carry their actual query text.
    lines.push("", "#### Queries", "");
    for (const query of siteReport.queries) {
      const band = query.type === "phrase" ? "phrase, adjacency df" : "token, df";
      lines.push(`- **${query.label}** (${band} ≈ ${query.document_frequency}): \`${query.query}\``);
    }

    // 3) Rich query latency (headline).
    lines.push("", "#### Rich query latency — exact total + all facet counts (headline)", "");
    lines.push(rankingNote(), "");
    latencyTable(siteReport, labels, (item) => sliceByLabel(item, { mode: "all", filtered: false }));
    if (bm25.length) {
      lines.push("", "#### BM25-only rich query latency — exact total + all facet counts", "");
      lines.push(
        `**BM25-only view:** ${bm25.join(", ")}. Non-BM25 engines are not eligible here; that is a capability boundary, not a failure.`,
        "",
      );
      const rows = bm25.map((engine) => {
        const byLabel = sliceByLabel(siteReport.engines[engine], { mode: "all", filtered: false });
        return [engineLabel(engine), ...labels.map((label) => cell(byLabel[label]))];
      });
      table(["Engine", ...labels], ["---", ...rightAligns(labels.length)], rows);
    }

    // 4) Filtered + disjunctive counts.
    lines.push("", "#### Filtered query latency + disjunctive counts — all facets", "");
    lines.push(rankingNote(), "");
    latencyTable(siteReport, filteredLabels, (item) => sliceByLabel(item, { mode: "all", filtered: true }));
    lines.push("", "#### Filtered query latency — no facet counts", "");
    lines.push(rankingNote(), "");
    latencyTable(siteReport, filteredLabels, (item) => sliceByLabel(item, { mode: "none", filtered: true }));

    // 5) Facet scaling on the broad query.
    const inventory = facetInventory(siteReport);
    lines.push("", "#### Facet scaling — broad query", "");
    lines.push(rankingNote(), "");
    if (inventory) lines.push(inventory, "");
    table(
      ["Engine", "none", "one facet", "all facets"],
      ["---", "---:", "---:", "---:"],
      engines.map((engine) => {
        const ms = warmOf(siteReport.engines[engine])?.measurements ?? [];
        const at = (mode) =>
          ms.find((row) => row.label === "broad" && row.facet_mode === mode && !row.filtered && row.page_size === 10);
        return [engineLabel(engine), cell(at("none")), cell(at("one")), cell(at("all"))];
      }),
    );

    // 6) Sorted keyword and browse.
    lines.push("", "#### Sorted keyword — broad + alphabetical title", "");
    lines.push("**Order in this timing:** alphabetical title. Native relevance ranking is replaced by the requested sort.", "");
    scenarioTable(siteReport, "sorted");
    lines.push("", "#### Browse — no keyword, alphabetical", "");
    lines.push("**Order in this timing:** alphabetical title. Native relevance ranking is not used.", "");
    scenarioTable(siteReport, "browse");

    // 7) Pagination and deep offsets.
    const pageSizes = [10, 50, 100, 200];
    for (const mode of ["none", "all"]) {
      lines.push("", `#### Pagination — broad query, ${mode === "none" ? "no facets" : "all facets"}`, "");
      lines.push(rankingNote(), "");
      table(
        ["Engine", ...pageSizes.map((size) => `n=${size}`)],
        ["---", ...rightAligns(pageSizes.length)],
        engines.map((engine) => {
          const ms = warmOf(siteReport.engines[engine])?.measurements ?? [];
          return [
            engineLabel(engine),
            ...pageSizes.map((size) =>
              cell(ms.find((row) => row.scenario === "pagination" && row.facet_mode === mode && row.page_size === size)),
            ),
          ];
        }),
      );
    }
    const deepRows = warmOf(siteReport.engines[engines[0]])?.measurements ?? [];
    const offsets = [...new Set(deepRows.filter((r) => r.scenario === "deep").map((r) => r.offset))].sort(
      (a, b) => a - b,
    );
    if (offsets.length) {
      lines.push("", "#### Deep pagination — broad query, all facets", "");
      lines.push(rankingNote(), "");
      table(
        ["Engine", ...offsets.map((o) => `offset ${o}`)],
        ["---", ...rightAligns(offsets.length)],
        engines.map((engine) => {
          const ms = warmOf(siteReport.engines[engine])?.measurements ?? [];
          return [engineLabel(engine), ...offsets.map((offset) => cell(ms.find((row) => row.scenario === "deep" && row.offset === offset)))];
        }),
      );
    }

    // 8) Plain query latency — diagnostic.
    lines.push("", "#### Plain query latency — no facet counts (diagnostic)", "");
    lines.push("The cost of the query alone; compare against the rich query table above to see what facet counting adds.", "");
    lines.push(rankingNote(), "");
    latencyTable(siteReport, labels, (item) => sliceByLabel(item, { mode: "none", filtered: false }));

    // 9) Correctness (this site's engines against themselves).
    lines.push("", "#### Result correctness", "");
    lines.push(
      "Each engine checked against itself (cross-engine totals differ by design). ✓ pass · ✗ defect · – scenario absent.",
      "Ranking is not evaluated by these checks; they validate totals, facets, filters, and explicit sorts.",
      "",
    );
    table(
      ["Engine", ...CHECKS.map(([, label]) => label)],
      ["---", ...CHECKS.map(() => ":---:")],
      engines.map((engine) => {
        const correctness = siteReport.engines[engine]?.correctness ?? {};
        const mark = (value) => (value === null || value === undefined ? "–" : value ? "✓" : "✗");
        return [engineLabel(engine), ...CHECKS.map(([key]) => mark(correctness[key]))];
      }),
    );

  }

  lines.push("");
  return lines.join("\n");
}
