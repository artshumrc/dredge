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
    let hits;
    if (term && term.trim()) {
      // Multi-token queries intersect (AND) natively. The active filter is
      // applied in JavaScript over the enumerated match set rather than with
      // FlexSearch's own `tag` option: the tag intersection verifiably drops
      // matches (a 400-doc/50-expected test returns 25), so its counts and
      // facet tallies would be wrong.
      const result = await index.search(term, { limit: ENUMERATE_LIMIT, merge: true, enrich: true });
      const rows = Array.isArray(result) ? result : result.result ?? [];
      hits = rows.map((hit) => hit.doc ?? hit);
      if (filter) hits = hits.filter((doc) => doc?.[filter.field] === filter.value);
    } else {
      // Browse: no keyword, so start from every document and apply the filter.
      hits = filter ? documents.filter((doc) => doc[filter.field] === filter.value) : documents;
    }
    if (sort) hits = [...hits].sort(byField(sort.field, sort.direction));
    let facetCounts = null;
    if (facets.length) {
      facetCounts = Object.fromEntries(facets.map((name) => [name, {}]));
      for (const hit of hits) {
        for (const name of facets) {
          const value = hit?.[name];
          if (value != null) facetCounts[name][value] = (facetCounts[name][value] ?? 0) + 1;
        }
      }
    }
    const page = hits.slice(offset, offset + limit);
    return {
      count: hits.length,
      countExact: true,
      checksum: page.map((hit) => hit.id).join(","),
      titles: page.map((hit) => hit.title),
      facets: facetCounts,
    };
  };
}
