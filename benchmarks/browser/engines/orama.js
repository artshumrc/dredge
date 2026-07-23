import { create, load, search } from "@orama/orama";

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
  return async (term, { filter, limit = 10, offset = 0, facets = [], sort } = {}) => {
    const result = await search(database, {
      // An empty term returns every document, which is the browse case.
      term,
      properties: ["title", "body"],
      boost: { title: 10 },
      limit,
      offset,
      tolerance: 0,
      where: filter ? { [filter.field]: { eq: filter.value } } : undefined,
      // Explicit alphabetical order for browse; relevance (bm25) otherwise.
      sortBy: sort ? { property: sort.field, order: sort.direction === "desc" ? "DESC" : "ASC" } : undefined,
      // Orama counts facet values over the whole match set in one pass.
      facets: facets.length ? Object.fromEntries(facets.map((name) => [name, {}])) : undefined,
    });
    return {
      count: result.count,
      countExact: true,
      checksum: result.hits.map((hit) => hit.id).join(","),
      titles: result.hits.map((hit) => hit.document?.title),
      facets: facets.length
        ? Object.fromEntries(facets.map((name) => [name, result.facets?.[name]?.values ?? {}]))
        : null,
    };
  };
}
