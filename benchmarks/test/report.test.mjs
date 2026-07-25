import assert from "node:assert/strict";
import test from "node:test";

import { renderHtml } from "../scripts/report-html.mjs";
import { renderMarkdown } from "../scripts/report-md.mjs";
import { bm25Engines, rankingModelFor } from "../scripts/ranking-models.mjs";

// A compact fixture report object exercising: a measured cell, an error cell
// (timeout), and an absent cell (not measured) — so both renderers can be
// checked for section order, banner presence, and ✗-vs-– distinctness without a
// browser run.
function fixtureReport() {
  const query = { label: "broad", type: "token", query: "against", document_frequency: 10 };
  const filtered = {
    ...query,
    filter: { field: "benchmark_group", value: "group0" },
    filtered_document_frequency: 5,
  };
  const measured = (extra) => ({
    scenario: "keyword",
    label: "broad",
    query: "against",
    filtered: false,
    page_size: 10,
    offset: 0,
    facet_mode: "all",
    result_count: 10,
    count_exact: true,
    first_titles: ["a", "b"],
    facet_counts: { benchmark_group: { group0: 10 } },
    sample_count: 20,
    p50_ms: 4,
    p95_ms: 5,
    p99_ms: 6,
    ...extra,
  });
  return {
    generated_at: "2026-07-23T00:00:00.000Z",
    environment: { engine_versions: {} },
    sites: {
      small: {
        label: "small",
        page_count: 100,
        queries: [query],
        filtered_queries: [filtered],
        facets: [{ name: "benchmark_group", values: 8 }],
        engines: {
          dredge: {
            build: { wall_ms: 1000, max_rss_bytes: 1 << 20 },
            artifact: { shipped_bytes: 2 << 20, normalized_brotli_q5_bytes: 1 << 20 },
            browser: {
              cold: { network_bytes: 1 << 20, init_ms: 10 },
              warm: {
                network_bytes: 0,
                init_ms: 5,
                memory: { available: true, bytes: 8 << 20 },
                // Rich (all) and plain (none) rows so both tables have a value.
                measurements: [
                  measured({ facet_mode: "all" }),
                  measured({ facet_mode: "none", p95_ms: 3, facet_counts: undefined }),
                ],
              },
              multitab: { tabs: 4, pages: [] },
            },
            correctness: {
              counted: true,
              sorted_browse: true,
              sortable_keyword: true,
              facet_integrity: true,
              disjunctive: true,
              filter_consistency: true,
            },
          },
          flexsearch: {
            build: { wall_ms: 500, max_rss_bytes: 1 << 20 },
            artifact: { shipped_bytes: 3 << 20, normalized_brotli_q5_bytes: 2 << 20 },
            browser: {
              cold: { network_bytes: 2 << 20, init_ms: 20 },
              warm: {
                network_bytes: 0,
                init_ms: 8,
                memory: { available: true, bytes: 16 << 20 },
                // Rich row failed (timeout → ✗); plain row absent (→ –).
                measurements: [
                  {
                    scenario: "keyword",
                    label: "broad",
                    query: "against",
                    filtered: false,
                    facet_mode: "all",
                    page_size: 10,
                    offset: 0,
                    error: "keyword/broad/all warmup exceeded 60000ms",
                    error_kind: "timeout",
                  },
                ],
              },
              multitab: { tabs: 4, pages: [] },
            },
            correctness: {
              counted: null,
              sorted_browse: null,
              sortable_keyword: null,
              facet_integrity: null,
              disjunctive: null,
              filter_consistency: null,
            },
          },
        },
      },
    },
  };
}

const ENGINES = ["dredge", "flexsearch"];

test("ranking capability classification covers every benchmark engine", () => {
  const all = ["dredge", "pagefind", "orama", "flexsearch", "lunr"];
  assert.deepEqual(bm25Engines(all), ["dredge", "orama", "lunr"]);
  assert.equal(rankingModelFor("pagefind").label, "custom relevance");
  assert.equal(rankingModelFor("flexsearch").label, "positional scoring");
  assert.match(rankingModelFor("flexsearch").detail, /not BM25/);
});

test("HTML report has both banners and rich-before-plain ordering", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  assert.match(html, /Measured on the build machine/);
  assert.match(html, /Measured in the browser/);
  const rich = html.indexOf("Rich query latency");
  const plain = html.indexOf("Plain query latency");
  assert.ok(rich > -1 && plain > -1, "both latency sections present");
  assert.ok(rich < plain, "rich query section precedes the diagnostic plain query section");
});

test("HTML renders a failed cell distinct from an unmeasured cell", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  // flexsearch's rich row failed → a .fail span with the reason in its tooltip.
  assert.match(html, /class="fail"[^>]*>✗/);
  assert.match(html, /exceeded 60000ms/);
  // Its plain row is absent → a plain "–" (en dash), not a ✗.
  assert.match(html, /–/);
});

test("HTML latency headers show the actual query text", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  assert.match(html, /class="qtext">against/);
  assert.doesNotMatch(html, /data-tip="undefined"/);
});

test("Markdown report has both banners and rich-before-plain ordering", () => {
  const md = renderMarkdown(fixtureReport(), ENGINES);
  assert.match(md, /### Measured on the build machine/);
  assert.match(md, /### Measured in the browser/);
  const rich = md.indexOf("Rich query latency");
  const plain = md.indexOf("Plain query latency");
  assert.ok(rich > -1 && plain > -1 && rich < plain, "rich precedes plain");
});

test("Markdown renders ✗ for a failed cell and – for an absent one", () => {
  const md = renderMarkdown(fixtureReport(), ENGINES);
  // The rich table's flexsearch cell is a timeout ✗ (60000ms → >60s).
  assert.match(md, /✗ >60s/);
  // The plain table's flexsearch cell is absent → "-".
  assert.match(md, /\| flexsearch \(positional scoring\) \| - \|/);
});

test("HTML puts scaling before per-site sections, with sticky nav", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  const scaling = html.indexOf('id="scaling"');
  const firstSite = html.indexOf('id="site-');
  assert.ok(scaling > -1, "scaling section present");
  assert.ok(firstSite > -1 && scaling < firstSite, "scaling precedes the per-site sections");
  assert.match(html, /Cold response bytes/);
  assert.match(html, /Rich query p95/);
  assert.match(html, /class="sitenav"/, "sticky nav present");
});

test("both reports disclose ranking models wherever benchmark results are shown", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  const md = renderMarkdown(fixtureReport(), ENGINES);

  assert.match(html, /FlexSearch's document-position scoring slots/);
  assert.match(md, /flexsearch \| positional scoring:/);
  assert.match(md, /not BM25 term-frequency\/IDF scoring/);

  // Engine labels retain ranking provenance even in build/delivery tables — in
  // HTML as a per-row caption (with its own tooltip); Markdown has no tooltips,
  // so it still repeats a local callout in every query-bearing section instead.
  assert.match(html, /dredge<span class="engine-ranking">/);
  assert.match(md, /\| dredge \(BM25\) \| 1\.00 \|/);
  assert.ok((md.match(/\*\*Ranking in this timing:\*\*/g) ?? []).length >= 5);

  assert.match(md, /Order in this timing:\*\* alphabetical title/);
  assert.match(html, /they do not evaluate relevance ordering or quality/);
  assert.match(md, /Ranking is not evaluated by these checks/);
});

test("FlexSearch rows are flagged as a ranking-model caution, not just tooltipped", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  // There is no separate "which engines use BM25" overview table anymore —
  // instead every row FlexSearch appears in is visually flagged, since its
  // cheaper ranking model is part of why it's often the fastest.
  assert.doesNotMatch(html, /Ranking models/);
  assert.match(html, /class="row-caution"/);
  assert.match(html, /why FlexSearch runs fastest in these timings/);
  // Dredge (BM25, no caveat) never gets the caution treatment.
  assert.doesNotMatch(html, /class="row-dredge row-caution"/);
  assert.doesNotMatch(html, /class="row-caution row-dredge"/);
});

test("pagefind gets a plain note (not a caution) for its non-BM25 ranking", () => {
  // Pagefind ranks well despite not being BM25, unlike FlexSearch's simpler
  // model — it should read as a disclosure, not a warning.
  assert.match(rankingModelFor("pagefind").detail, /isn't a shortcut behind its timings/);
  assert.equal(rankingModelFor("pagefind").bm25, false);
});

test("BM25-only rich-query views exclude non-BM25 engines without marking failure", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  const md = renderMarkdown(fixtureReport(), ENGINES);

  const htmlTable = html.match(/BM25-only rich query p95[\s\S]*?<table>([\s\S]*?)<\/table>/)?.[1];
  assert.ok(htmlTable, "HTML BM25-only scaling table present");
  assert.match(htmlTable, /dredge/);
  assert.doesNotMatch(htmlTable, /flexsearch/);

  const mdSection = md.match(/#### BM25-only rich query latency[\s\S]*?(?=\n#### )/)?.[0];
  assert.ok(mdSection, "Markdown BM25-only table present");
  assert.match(mdSection, /dredge \(BM25\)/);
  assert.doesNotMatch(mdSection, /flexsearch/);
  assert.match(html, /capability boundary, not a failure/);
  assert.match(md, /capability boundary, not a failure/);
});

test("reports distinguish shipped artifacts from normalized compression", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  const md = renderMarkdown(fixtureReport(), ENGINES);
  assert.match(html, /Shipped/);
  assert.match(html, /Normalized br q5/);
  assert.match(md, /Shipped MiB/);
  assert.match(md, /Normalized br q5 MiB/);
});

test("HTML marks best and worst per numeric column", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  // The normalized Brotli column has two comparable values (dredge 1 MiB,
  // flexsearch 2 MiB), so one cell is .best and one .worst.
  assert.match(html, /class="[^"]*\bbest\b[^"]*"/);
  assert.match(html, /class="[^"]*\bworst\b[^"]*"/);
});

test("both renderers present the same section set in the same order", () => {
  const html = renderHtml(fixtureReport(), ENGINES);
  const md = renderMarkdown(fixtureReport(), ENGINES);
  // Full heading strings (unique to their section in both renderers) so the
  // order check isn't fooled by a bare word appearing in earlier prose.
  const sections = [
    "Rich query latency",
    "Facet scaling — broad query",
    "Sorted keyword — broad",
    "Browse — no keyword, alphabetical",
    "Pagination — broad query",
    "Plain query latency",
    "Result correctness",
    "Multi-tab",
  ];
  const positions = (text) => sections.map((s) => text.indexOf(s));
  for (const [renderer, text] of [["html", html], ["md", md]]) {
    const pos = positions(text);
    assert.ok(pos.every((p) => p > -1), `${renderer} has every section`);
    const sorted = [...pos].sort((a, b) => a - b);
    assert.deepEqual(pos, sorted, `${renderer} sections are in the contract order`);
  }
});
