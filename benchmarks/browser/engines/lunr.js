import lunr from "lunr";

function byField(field, direction) {
  const sign = direction === "desc" ? -1 : 1;
  return (a, b) =>
    sign * String(a?.[field] ?? "").toLowerCase().localeCompare(String(b?.[field] ?? "").toLowerCase());
}

export async function initialize({ artifactBase }) {
  const [serialized, documents] = await Promise.all([
    fetch(`${artifactBase}/index.json`).then((response) => response.json()),
    fetch(`${artifactBase}/documents.json`).then((response) => response.json()),
  ]);
  const index = lunr.Index.load(serialized);
  const allDocuments = Object.values(documents);
  return async (term, { filter, limit = 10, offset = 0, facets = [], sort } = {}) => {
    // Enumerate the full UNFILTERED match set first. lunr has no top-k, so it
    // always returns the whole scored set — the enumeration cost is already paid.
    // lunr *can* filter with a required `+benchmark_group:groupN` clause (validated
    // in test/adapters.test.mjs), but the adapter filters in JS instead so the
    // unfiltered set stays in memory for disjunctive (skip-self) facet counts:
    // that makes disjunctive a second *tally*, not a second query.
    let unfiltered;
    if (term && term.trim()) {
      // AND semantics: lunr is OR by default, so every whitespace token becomes a
      // required (`+`) clause.
      const clauses = term.trim().split(/\s+/).map((token) => `+${token}`);
      unfiltered = index.search(clauses.join(" ")).map((hit) => documents[hit.ref]);
    } else {
      // Browse: lunr has no match-all, so enumerate every stored document.
      unfiltered = allDocuments;
    }
    const filtered = filter
      ? unfiltered.filter((doc) => doc?.[filter.field] === filter.value)
      : unfiltered;
    let records = filtered;
    if (sort) records = [...records].sort(byField(sort.field, sort.direction));
    let facetCounts = null;
    if (facets.length) {
      facetCounts = Object.fromEntries(facets.map((name) => [name, {}]));
      for (const name of facets) {
        // Disjunctive/skip-self: the actively-filtered dimension is tallied over
        // the unfiltered set (so its other values still show); every other
        // dimension over the filtered set.
        const source = filter && name === filter.field ? unfiltered : filtered;
        for (const record of source) {
          const value = record?.[name];
          if (value != null) facetCounts[name][value] = (facetCounts[name][value] ?? 0) + 1;
        }
      }
    }
    const page = records.slice(offset, offset + limit);
    return {
      count: records.length,
      countExact: true,
      checksum: page.map((record) => record.id).join(","),
      titles: page.map((record) => record.title),
      facets: facetCounts,
    };
  };
}
