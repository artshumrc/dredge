export async function initialize({ artifactBase }) {
  const pagefind = await import(`${artifactBase}/pagefind.js`);
  await pagefind.options({ basePath: `${artifactBase}/` });
  await pagefind.init();
  // pagefind lazily loads filter data; without this preload the per-search
  // `filters` counts come back empty. Loading it once at init is the intended
  // usage and is part of pagefind's steady-state cost.
  await pagefind.filters().catch(() => {});
  return async (term, { filter, limit = 10, offset = 0, facets = [], sort } = {}) => {
    const options = {};
    if (filter) options.filters = { [filter.field]: filter.value };
    // Alphabetical browse uses the indexed `title` sort key; a keyword search
    // uses pagefind's relevance order (no sort option).
    if (sort) options.sort = { [sort.field]: sort.direction };
    // Native AND: pagefind requires every query term by default, so a multi-word
    // phrase runs as AND-of-terms with no query rewriting. A null query is
    // pagefind's match-all browse.
    const query = term && term.trim() ? term : null;
    const result = await pagefind.search(query, Object.keys(options).length ? options : undefined);
    const slice = result.results.slice(offset, offset + limit);
    const hits = await Promise.all(slice.map((hit) => hit.data()));
    return {
      // pagefind returns pointers to every matching page, so length is the true
      // total; hydrating a page of them is the pagination cost.
      count: result.results.length,
      countExact: true,
      checksum: hits.map((hit) => hit.url).join(","),
      titles: hits.map((hit) => hit.meta?.title),
      // pagefind computes per-value counts for *all* filters on every search, so
      // requesting one facet or all of them costs the same — and both `filters`
      // and `totalFilters` come back with no extra query.
      //
      // Disjunctive/skip-self (verified empirically against pagefind 1.5.2 on the
      // small site): under an active filter, `result.filters[field]` is
      // conjunctive (only the applied value keeps a non-zero count), while
      // `result.totalFilters[field]` gives counts as if that filter were not
      // applied — the same numbers as the unfiltered search's `filters[field]`.
      // So the actively-filtered dimension reads from `totalFilters` (skip-self);
      // every other dimension reads from `filters` (counted over the filtered
      // set). No second search is needed.
      facets: facets.length
        ? Object.fromEntries(
            facets.map((name) => {
              const source = filter && name === filter.field ? result.totalFilters : result.filters;
              return [name, source?.[name] ?? {}];
            }),
          )
        : null,
    };
  };
}
