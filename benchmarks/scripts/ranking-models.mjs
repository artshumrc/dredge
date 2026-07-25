// Ranking is part of the work measured by keyword-query benchmarks, but the
// engines do not implement equivalent relevance models. Keep this metadata in
// one place so every report renderer discloses the same comparison boundary.
export const RANKING_MODELS = {
  dredge: {
    label: "BM25",
    detail: "SQLite FTS5 BM25 with the benchmark's title weighting.",
    bm25: true,
  },
  pagefind: {
    label: "custom relevance",
    detail: "Pagefind's term-frequency, weighted-count, page-length, saturation, and term-similarity model; not BM25.",
    bm25: false,
  },
  orama: {
    label: "BM25",
    detail: "Orama's BM25 scores, summed across the per-token searches used to enforce AND, with a title boost.",
    bm25: true,
  },
  flexsearch: {
    label: "positional scoring",
    detail: "FlexSearch's document-position scoring slots (default resolution 9); not BM25 term-frequency/IDF scoring.",
    bm25: false,
  },
  lunr: {
    label: "BM25",
    detail: "Lunr's BM25 relevance scoring with the benchmark's title boost.",
    bm25: true,
  },
};

export function rankingModelFor(engine) {
  return RANKING_MODELS[engine] ?? {
    label: "undeclared",
    detail: "This engine has no declared ranking model in the benchmark.",
    bm25: false,
  };
}

export function bm25Engines(engines) {
  return engines.filter((engine) => rankingModelFor(engine).bm25);
}
