import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCorrectness, isErrorRow } from "../scripts/correctness.mjs";

// A healthy engine: exact totals, alphabetical browse and sorted pages, facet
// buckets that sum to the total, disjunctive filtered counts, and a filtered
// total that matches its own unfiltered bucket.
function healthyRows() {
  return [
    {
      scenario: "keyword",
      label: "broad",
      query: "against",
      filtered: false,
      facet_mode: "all",
      result_count: 10,
      count_exact: true,
      first_titles: ["gamma", "alpha"],
      facet_counts: {
        benchmark_group: { group0: 6, group1: 4 },
        kind: { kind0: 5, kind1: 5 },
      },
    },
    {
      scenario: "filtered",
      label: "broad",
      query: "against",
      filtered: true,
      filter: { field: "benchmark_group", value: "group0" },
      facet_mode: "all",
      result_count: 6,
      count_exact: true,
      first_titles: ["alpha", "beta"],
      // Disjunctive: the filtered dimension reproduces the unfiltered counts.
      facet_counts: {
        benchmark_group: { group0: 6, group1: 4 },
        kind: { kind0: 3, kind1: 3 },
      },
    },
    {
      scenario: "browse",
      label: "browse",
      query: "",
      filtered: false,
      facet_mode: "all",
      result_count: 10,
      count_exact: true,
      first_titles: ["apple", "banana", "cherry"],
      facet_counts: {
        benchmark_group: { group0: 6, group1: 4 },
        kind: { kind0: 5, kind1: 5 },
      },
    },
    {
      scenario: "sorted",
      label: "broad",
      query: "against",
      filtered: false,
      facet_mode: "none",
      result_count: 10,
      count_exact: true,
      first_titles: ["alpha", "beta", "gamma"],
    },
  ];
}

test("healthy rows pass every correctness check", () => {
  assert.deepEqual(evaluateCorrectness(healthyRows(), {}), {
    counted: true,
    sorted_browse: true,
    sortable_keyword: true,
    facet_integrity: true,
    disjunctive: true,
    filter_consistency: true,
  });
});

test("FlexSearch tag-defect (filtered count << unfiltered bucket) fails filter_consistency", () => {
  const rows = healthyRows();
  const filtered = rows.find((row) => row.filtered);
  // The native tag filter silently drops matches: the filtered total collapses
  // far below the engine's own unfiltered bucket for that value (6).
  filtered.result_count = 2;
  filtered.facet_counts.benchmark_group = { group0: 2 };
  const result = evaluateCorrectness(rows, {});
  assert.equal(result.filter_consistency, false, "filter_consistency must catch the dropped matches");
});

test("conjunctive filtered counts fail disjunctive but keep the total honest", () => {
  const rows = healthyRows();
  const filtered = rows.find((row) => row.filtered);
  // Total is correct (6 matches the unfiltered bucket), but the filtered facet
  // only reports the applied value — conjunctive, not skip-self.
  filtered.facet_counts.benchmark_group = { group0: 6 };
  const result = evaluateCorrectness(rows, {});
  assert.equal(result.disjunctive, false, "disjunctive must reject conjunctive counts");
  assert.equal(result.filter_consistency, true, "the total itself is still consistent");
});

test("a page-capped count fails Counted", () => {
  const rows = healthyRows();
  rows[0].count_exact = false;
  assert.equal(evaluateCorrectness(rows, {}).counted, false);
});

test("an out-of-order browse page fails Sorted-browse", () => {
  const rows = healthyRows();
  rows.find((row) => row.scenario === "browse").first_titles = ["cherry", "apple"];
  assert.equal(evaluateCorrectness(rows, {}).sorted_browse, false);
});

test("facet buckets that do not sum to the total fail Facet integrity", () => {
  const rows = healthyRows();
  rows[0].facet_counts.kind = { kind0: 5, kind1: 4 }; // sums to 9, total is 10
  assert.equal(evaluateCorrectness(rows, {}).facet_integrity, false);
});

test("checks needing an absent scenario are null, not false", () => {
  // Pre-redesign shape: no sorted scenario, no filtered rows.
  const rows = healthyRows().filter(
    (row) => row.scenario !== "sorted" && row.scenario !== "filtered",
  );
  const result = evaluateCorrectness(rows, {});
  assert.equal(result.sortable_keyword, null);
  assert.equal(result.disjunctive, null);
  assert.equal(result.filter_consistency, null);
  // The checks whose scenarios remain still evaluate.
  assert.equal(result.counted, true);
  assert.equal(result.sorted_browse, true);
  assert.equal(result.facet_integrity, true);
});

test("punctuation-only ordering differences are alphabetical, not code-unit", () => {
  const rows = healthyRows();
  // '1.' (U+002E) before '1)' (U+0029): out of order by code unit, correct by
  // locale collation. The check must accept it (real engines produce this).
  rows.find((row) => row.scenario === "browse").first_titles = [
    "1. Providing that Congress have sole power",
    "1) Authorizing congress to determine tenure",
  ];
  assert.equal(evaluateCorrectness(rows, {}).sorted_browse, true);
});

test("a code-point (SQLite NOCASE) ordering that ICU would reject still passes", () => {
  const rows = healthyRows();
  // '"' (0x22) < ''' (0x27) by code point, so this is Dredge's valid NOCASE
  // order; ICU ignores the leading quotes and would order "alpha" before "beta",
  // flagging it. The check must accept the engine's own valid collation.
  rows.find((row) => row.scenario === "browse").first_titles = ['"beta" report', "'alpha' report"];
  assert.equal(evaluateCorrectness(rows, {}).sorted_browse, true);
});

test("an all-facets row that drops a declared dimension fails Facet integrity", () => {
  const rows = healthyRows();
  const workload = {
    facets: [{ name: "benchmark_group" }, { name: "kind" }, { name: "topic" }],
  };
  // The fixture rows count benchmark_group and kind but never topic.
  assert.equal(evaluateCorrectness(rows, workload).facet_integrity, false);
});

test("a zero-result facet row with empty buckets passes Facet integrity", () => {
  const rows = [
    {
      scenario: "keyword",
      label: "phrase3",
      filtered: false,
      facet_mode: "all",
      result_count: 0,
      count_exact: true,
      facet_counts: { benchmark_group: {}, kind: {}, topic: {} },
    },
  ];
  const workload = {
    facets: [{ name: "benchmark_group" }, { name: "kind" }, { name: "topic" }],
  };
  assert.equal(evaluateCorrectness(rows, workload).facet_integrity, true);
});

test("empty measurements yield all-null", () => {
  assert.deepEqual(evaluateCorrectness([], {}), {
    counted: null,
    sorted_browse: null,
    sortable_keyword: null,
    facet_integrity: null,
    disjunctive: null,
    filter_consistency: null,
  });
});

test("error rows are excluded from every check", () => {
  const rows = healthyRows();
  rows.push({ scenario: "keyword", label: "rare", error: "boom", error_kind: "exception" });
  assert.ok(isErrorRow(rows.at(-1)));
  // The error row has no count_exact/facet fields; it must not flip any check.
  const result = evaluateCorrectness(rows, {});
  assert.equal(result.counted, true);
  assert.equal(result.facet_integrity, true);
});
