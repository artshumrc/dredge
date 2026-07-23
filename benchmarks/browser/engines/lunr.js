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
    let records;
    if (term && term.trim()) {
      const query = filter ? `+${term} +${filter.field}:${filter.value}` : term;
      // lunr always returns the full scored result set, so the count is exact and
      // the enumeration cost is already paid.
      records = index.search(query).map((hit) => documents[hit.ref]);
    } else {
      // Browse: lunr has no match-all, so enumerate every stored document.
      records = filter ? allDocuments.filter((doc) => doc[filter.field] === filter.value) : allDocuments;
    }
    if (sort) records = [...records].sort(byField(sort.field, sort.direction));
    let facetCounts = null;
    if (facets.length) {
      facetCounts = Object.fromEntries(facets.map((name) => [name, {}]));
      for (const record of records) {
        for (const name of facets) {
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
