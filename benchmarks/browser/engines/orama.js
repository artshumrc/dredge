import { create, load, search } from "@orama/orama";

// Orama has no page cap, but the adapter must materialize the full match set for
// exact counts, facet tallies, sorting, browse, and — critically — correct
// multi-token AND, so the underlying searches use an enumerate limit.
const ENUMERATE_LIMIT = 1_000_000;

function byField(field, direction) {
  const sign = direction === "desc" ? -1 : 1;
  return (a, b) =>
    sign * String(a?.[field] ?? "").toLowerCase().localeCompare(String(b?.[field] ?? "").toLowerCase());
}

export async function initialize({ artifactBase, facetNames = [] }) {
  const serialized = await fetch(`${artifactBase}/index.json`).then((response) => response.json());
  const database = create({
    schema: {
      id: "string",
      url: "string",
      title: "string",
      body: "string",
      ...Object.fromEntries(facetNames.map((name) => [name, "enum"])),
    },
  });
  load(database, serialized);

  // One search per query token, returning that token's full result set.
  // `threshold: 0` does NOT enforce AND in @orama/orama 3.1.18: prefix expansion
  // lets a single query token that expands to several indexed words satisfy the
  // multi-token gate, so a naive multi-word search returns documents missing some
  // terms (partial OR). AND is therefore enforced in adapter JS by intersecting
  // each token's own Orama result set — the honest cost of matching product
  // behaviour, and the same AND-of-terms every other engine answers.
  async function tokenHits(token) {
    const result = await search(database, {
      term: token,
      properties: ["title", "body"],
      boost: { title: 10 },
      tolerance: 0,
      limit: ENUMERATE_LIMIT,
    });
    return result.hits;
  }

  return async (term, { filter, limit = 10, offset = 0, facets = [], sort } = {}) => {
    const trimmed = (term ?? "").trim();
    let matchSet; // [{ document, score }] over the whole (unfiltered) match set
    if (trimmed) {
      const tokens = trimmed.split(/\s+/);
      const maps = (await Promise.all(tokens.map(tokenHits))).map(
        (hits) => new Map(hits.map((hit) => [hit.id, hit])),
      );
      const [first, ...rest] = maps;
      matchSet = [];
      for (const [id, hit] of first ?? []) {
        if (rest.every((map) => map.has(id))) {
          // Summed per-token relevance — a legitimate ranking; relevance quality
          // is documented as unmeasured, so exact BM25 parity is not required.
          const score = maps.reduce((sum, map) => sum + (map.get(id)?.score ?? 0), 0);
          matchSet.push({ document: hit.document, score });
        }
      }
    } else {
      // Browse: an empty term matches every document.
      const all = await search(database, { term: "", limit: ENUMERATE_LIMIT });
      matchSet = all.hits.map((hit) => ({ document: hit.document, score: 0 }));
    }
    const filtered = filter
      ? matchSet.filter((entry) => entry.document?.[filter.field] === filter.value)
      : matchSet;
    // Explicit alphabetical title sort when requested; summed-score relevance
    // otherwise.
    const ordered = sort
      ? [...filtered].sort((a, b) => byField(sort.field, sort.direction)(a.document, b.document))
      : [...filtered].sort((a, b) => b.score - a.score);
    let facetCounts = null;
    if (facets.length) {
      facetCounts = Object.fromEntries(facets.map((name) => [name, {}]));
      for (const name of facets) {
        // Disjunctive/skip-self: the actively-filtered dimension is tallied over
        // the unfiltered match set; every other dimension over the filtered set.
        const source = filter && name === filter.field ? matchSet : filtered;
        for (const { document } of source) {
          const value = document?.[name];
          if (value != null) facetCounts[name][value] = (facetCounts[name][value] ?? 0) + 1;
        }
      }
    }
    const page = ordered.slice(offset, offset + limit);
    return {
      count: filtered.length,
      countExact: true,
      checksum: page.map((entry) => entry.document?.id).join(","),
      titles: page.map((entry) => entry.document?.title),
      facets: facetCounts,
    };
  };
}
