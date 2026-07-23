function bucketsToMap(buckets) {
  const map = {};
  for (const { value, count } of buckets ?? []) map[value] = count;
  return map;
}

export async function initialize({ artifactBase, cold }) {
  const { DredgeSearchClient } = await import(`${artifactBase}/dredge-client.js`);
  const client = new DredgeSearchClient({
    workerUrl: `${artifactBase}/dredge-worker.js`,
    manifestUrl: `${artifactBase}/search-manifest.json`,
    reset: cold,
  });
  await client.init();
  return async (query, { filter, limit = 10, offset = 0, facets = [], sort } = {}) => {
    const filters = filter ? { [filter.field]: filter.value } : undefined;
    const result = await client.search({
      query,
      filters,
      limit,
      offset,
      // An empty query is a match-all browse; the explicit sort then orders it.
      // With a keyword and no sort, dredge orders by bm25 relevance.
      sort: sort ? { field: sort.field, direction: sort.direction } : undefined,
      // Every requested facet is one GROUP BY over the single-pass FTS temp
      // table the count and hits page already read from — so one, three, or all
      // facets still cost one round trip. When a filter is active, dredge counts
      // each facet with its own constraint skipped (disjunctive/skip-self), the
      // counts a faceted UI needs to let the user switch values within a facet.
      includeFacets: facets.length ? facets : undefined,
    });
    return {
      // dredge always returns the true total, never a page-capped count.
      count: result.total,
      countExact: true,
      checksum: result.hits.map((hit) => hit.url).join(","),
      titles: result.hits.map((hit) => hit.title),
      facets: facets.length
        ? Object.fromEntries(facets.map((name) => [name, bucketsToMap(result.facets?.[name])]))
        : null,
    };
  };
}
