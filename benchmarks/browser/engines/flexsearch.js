import FlexSearch from "flexsearch";

// FlexSearch has no native count, facet aggregation, or match-all browse. To
// behave like a real faceted search it must materialize the *entire* match set
// (not just the top page), count it, tally each facet value, and sort — the
// full-set work its top-k `limit` normally lets it skip.
const ENUMERATE_LIMIT = 1_000_000;

function byField(field, direction) {
  const sign = direction === "desc" ? -1 : 1;
  return (a, b) =>
    sign * String(a?.[field] ?? "").toLowerCase().localeCompare(String(b?.[field] ?? "").toLowerCase());
}

export async function initialize({ artifactBase }) {
  const [configuration, parts, documents] = await Promise.all([
    fetch(`${artifactBase}/config.json`).then((response) => response.json()),
    fetch(`${artifactBase}/index.json`).then((response) => response.json()),
    // Full document list, used for no-keyword browse (FlexSearch cannot enumerate
    // its own index) and for stable facet/count work.
    fetch(`${artifactBase}/documents.json`).then((response) => response.json()),
  ]);
  const index = new FlexSearch.Document(configuration);
  for (const [key, value] of Object.entries(parts)) await index.import(key, value);
  return async (term, { filter, limit = 10, offset = 0, facets = [], sort } = {}) => {
    // Enumerate the full UNFILTERED match set first, then apply the active filter
    // in JavaScript. Filtering in JS (rather than with FlexSearch's own `tag`
    // option) is required for two reasons: the tag intersection verifiably drops
    // matches (a 400-doc/50-expected test returns 25), so its counts would be
    // wrong; and keeping the unfiltered set lets us compute disjunctive facet
    // counts as a second tally rather than a second query.
    let unfiltered;
    if (term && term.trim()) {
      // Multi-token queries intersect (AND) natively.
      const result = await index.search(term, { limit: ENUMERATE_LIMIT, merge: true, enrich: true });
      const rows = Array.isArray(result) ? result : result.result ?? [];
      unfiltered = rows.map((hit) => hit.doc ?? hit);
    } else {
      // Browse: no keyword, so start from every document.
      unfiltered = documents;
    }
    const filtered = filter
      ? unfiltered.filter((doc) => doc?.[filter.field] === filter.value)
      : unfiltered;
    let hits = filtered;
    if (sort) hits = [...hits].sort(byField(sort.field, sort.direction));
    let facetCounts = null;
    if (facets.length) {
      facetCounts = Object.fromEntries(facets.map((name) => [name, {}]));
      for (const name of facets) {
        // Disjunctive/skip-self: the actively-filtered dimension is tallied over
        // the unfiltered set (so its other values still show); every other
        // dimension over the filtered set.
        const source = filter && name === filter.field ? unfiltered : filtered;
        for (const hit of source) {
          const value = hit?.[name];
          if (value != null) facetCounts[name][value] = (facetCounts[name][value] ?? 0) + 1;
        }
      }
    }
    const page = hits.slice(offset, offset + limit);
    return {
      count: filtered.length,
      countExact: true,
      checksum: page.map((hit) => hit.id).join(","),
      titles: page.map((hit) => hit.title),
      facets: facetCounts,
    };
  };
}
