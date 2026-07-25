// The single source of truth for the benchmark's self-policing correctness
// checks. Both report renderers (Markdown and HTML) and the gate script consume
// this module, so the three artifacts can never disagree about whether an
// engine passed a check.
//
// Every check judges an engine against ITSELF — never against another engine.
// Cross-engine result counts legitimately differ (stemming, prefix expansion,
// tokenization), so the only fair question is internal consistency: does the
// engine's own total match its own facet buckets, do its filtered counts match
// its own unfiltered buckets, is its sorted output actually sorted.
//
// Each check returns `true` (passed), `false` (a real defect), or `null` (the
// scenario the check needs is absent from the data — e.g. pre-redesign results
// with no `sorted` rows). `null` renders as `–` and is never a gate failure.

// An error row (ticket 07) records a config that timed out, threw, or was
// skipped by the circuit breaker. It carries no latency/count fields, so it
// must be excluded from every check: an engine is judged on what it returned,
// and separately shown to have failed configs.
export function isErrorRow(row) {
  return row != null && typeof row.error_kind === "string";
}

function measuredRows(measurements) {
  return (measurements ?? []).filter((row) => row && !isErrorRow(row));
}

// Whether a list of titles is in non-decreasing case-insensitive order. Engines
// legitimately use different valid collations: FlexSearch/Lunr/Orama sort with
// localeCompare (ICU), while Dredge delegates to SQLite `COLLATE NOCASE`
// (ASCII-case-folded code-point order). The two disagree on punctuation, digits,
// and non-ASCII, so judging every engine by one collation would falsely flag the
// other's correctly ordered page. The check's real job is to catch a page that
// is NOT sorted at all (relevance/random order) — such a page is monotonic under
// neither collation — so a page counts as alphabetical if it is monotonic under
// EITHER. This keeps the check engine-neutral (judging each engine against its
// own ordering) while still catching gross mis-ordering.
const ICU = new Intl.Collator("en", { sensitivity: "base" });
function monotonic(titles, compare) {
  for (let index = 1; index < titles.length; index += 1) {
    if (compare(String(titles[index - 1]), String(titles[index])) > 0) return false;
  }
  return true;
}
function codePoint(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}
function isAlphabetical(titles) {
  return monotonic(titles, (a, b) => ICU.compare(a, b)) || monotonic(titles, codePoint);
}

// Numeric equality of two facet-count maps ({value: count}) regardless of key
// order. Used for the disjunctive check, where the filtered dimension's counts
// must exactly reproduce the same query's unfiltered counts for that dimension.
function sameCounts(left, right) {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (Number(left[key]) !== Number(right[key])) return false;
  }
  return true;
}

function sumBuckets(buckets) {
  return Object.values(buckets ?? {}).reduce((total, count) => total + Number(count), 0);
}

// Find the unfiltered, all-facets row for a given query label — the reference
// the disjunctive and filter-consistency checks compare filtered rows against.
function unfilteredAllFor(rows, label) {
  return rows.find(
    (row) => !row.filtered && row.facet_mode === "all" && row.label === label && row.facet_counts,
  );
}

// The six checks, computed from one engine's warm measurement rows. `workload`
// is accepted for symmetry and future checks; the current checks are derived
// entirely from the rows the engine actually returned.
export function evaluateCorrectness(measurements, workload) {
  const rows = measuredRows(measurements);
  const declaredFacets = (workload?.facets ?? []).map((facet) => facet.name);

  // Counted: every measured row reports the true total, never a page-capped one.
  const counted = rows.length ? rows.every((row) => row.count_exact !== false) : null;

  // Sorted-browse: the no-keyword browse page comes back alphabetically.
  const browseRows = rows.filter((row) => row.scenario === "browse" && Array.isArray(row.first_titles));
  const sorted_browse = browseRows.length
    ? browseRows.every((row) => isAlphabetical(row.first_titles))
    : null;

  // Sortable-keyword: the explicit alphabetical-sort keyword scenario is sorted.
  const sortedRows = rows.filter((row) => row.scenario === "sorted" && Array.isArray(row.first_titles));
  const sortable_keyword = sortedRows.length
    ? sortedRows.every((row) => isAlphabetical(row.first_titles))
    : null;

  // Facet integrity: on every unfiltered facet row, each dimension's buckets
  // partition the match set, so they must sum to the engine's own total.
  const facetRows = rows.filter(
    (row) => row.facet_mode && row.facet_mode !== "none" && !row.filtered && row.facet_counts,
  );
  const facet_integrity = facetRows.length
    ? facetRows.every((row) => {
        const counts = row.facet_counts ?? {};
        // Completeness: an "all facets" row must count every declared dimension —
        // silently dropping a whole dimension is a facet defect. ("one facet"
        // rows legitimately carry a single dimension.)
        if (
          row.facet_mode === "all" &&
          declaredFacets.length &&
          !declaredFacets.every((name) => name in counts)
        ) {
          return false;
        }
        const dimensions = Object.values(counts);
        if (!dimensions.length) return false;
        return dimensions.every((buckets) => {
          const nonEmpty = Object.keys(buckets ?? {}).length > 0;
          // A zero-result set legitimately has empty buckets that sum to 0.
          return (nonEmpty || row.result_count === 0) && sumBuckets(buckets) === row.result_count;
        });
      })
    : null;

  // Disjunctive: with a filter active on field F, the engine's counts for F must
  // reproduce the same query's UNFILTERED counts for F (skip-self), so a user can
  // switch values within that facet. Compared numerically against the engine's
  // own unfiltered facet counts.
  const filteredAll = rows.filter(
    (row) => row.filtered && row.facet_mode === "all" && row.filter && row.facet_counts,
  );
  let disjunctive = null;
  {
    const comparable = filteredAll
      .map((row) => ({ row, reference: unfilteredAllFor(rows, row.label) }))
      .filter((pair) => pair.reference);
    if (comparable.length) {
      disjunctive = comparable.every(({ row, reference }) =>
        sameCounts(
          row.facet_counts?.[row.filter.field],
          reference.facet_counts?.[row.filter.field],
        ),
      );
    }
  }

  // Filter consistency: a filtered query's total must equal that value's bucket
  // in the same engine's unfiltered facet counts. This is the check that catches
  // FlexSearch-class defects where a native filter silently drops matches.
  const filteredRows = rows.filter(
    (row) => row.filtered && row.filter && typeof row.result_count === "number",
  );
  let filter_consistency = null;
  {
    const comparable = filteredRows
      .map((row) => ({ row, reference: unfilteredAllFor(rows, row.label) }))
      .filter((pair) => pair.reference);
    if (comparable.length) {
      filter_consistency = comparable.every(({ row, reference }) => {
        // An absent bucket means zero matches for that value (engines drop empty
        // buckets), so treat it as 0 rather than letting NaN false-alarm a
        // consistent zero-result filtered query.
        const bucket = reference.facet_counts?.[row.filter.field]?.[row.filter.value] ?? 0;
        return Number(bucket) === Number(row.result_count);
      });
    }
  }

  return {
    counted,
    sorted_browse,
    sortable_keyword,
    facet_integrity,
    disjunctive,
    filter_consistency,
  };
}

// Ordered check keys with human labels, so renderers show the same columns in
// the same order and the gate names checks consistently.
export const CHECKS = [
  ["counted", "Counted"],
  ["sorted_browse", "Sorted-browse"],
  ["sortable_keyword", "Sortable-keyword"],
  ["facet_integrity", "Facet integrity"],
  ["disjunctive", "Disjunctive"],
  ["filter_consistency", "Filter consistency"],
];
