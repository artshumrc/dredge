# Dredge

Client-side search for very large static websites: a Python compiler turns rendered HTML into a SQLite FTS5 database shipped as a static asset, queried entirely in the browser by a SQLite-WASM worker.

## Language

**Facet**:
A field extracted per page that is indexed, filterable, and countable at query time. Every facet costs index bytes in the shipped database.
_Avoid_: filter field, metadata

**Store Field**:
A field extracted per page that is carried into search results but never indexed, filtered, or counted. Scalars only.
_Avoid_: result-only facet, display field

**Field**:
The umbrella for facets and store fields. All fields share one namespace; a name collision between `facets` and `store_fields` is a config error.

**Field Role**:
Whether a field is a `facet` or a `store` field, recorded in the shipped database's `dredge_fields` table so the runtime enforces it.

**Database Artifact**:
The single SQLite database Dredge ships (body FTS included). A cold visitor downloads, verifies, and persists it to OPFS; a warm visitor reopens the OPFS copy directly. When OPFS is unavailable or over quota it opens in WASM memory for that session instead.
_Avoid_: hot tier, full tier, shard

**Boot**:
The worker bringing the database up on `init`: fetch the Manifest, then either open the cached OPFS copy (warm) or download → decompress → verify → persist → open (cold), emitting status up to `ready`.

**Manifest**:
`search-manifest.json` — the small, always-fetched JSON describing the current database artifact (file name, sha256, sizes, schema version).

**Runtime**:
The browser-side library: worker (SQLite WASM + OPFS) plus the thin client that owns it.

**Compiler**:
The Python CLI (`dredge compile`) that extracts, ingests, indexes, and packages a site into the database artifact.

**Search Column**:
A named, independently weighted full-text column of the Database Artifact's index. `title` and `body` always exist; naming a `search_fields` entry adds another, lifting its text out of the shared body. The columns and their bm25 weights live in the artifact's `dredge_search_columns` table, so the runtime holds no ranking constants of its own.
_Avoid_: search field, FTS field.

**Boost**:
A multiplier a site declares over one of its scalar Facets, applied to the relevance ordering of the pages that Facet's value names. Two shapes: a multiplier per value, or a recency curve over a `date` Facet. Boosts multiply rather than add — bm25 ranks are negative — and order pages within a band, never across one: a page reached only through a Term Variant is never lifted above a page holding the reader's own word. They ship in the artifact's `dredge_boosts` table.
_Avoid_: score, ranking factor — a boost changes order, not what a hit reports as its `score`.

**Term Variant**:
A compiled equivalence between two surface forms in the corpus, so that a query for one matches the other. A **Variant Group** is the full set a term belongs to. Groups are derived at build time from the index's own terms and written to `dredge_term_variants`, keyed on the surface form so no stemmer ships to the browser.
_Avoid_: stem, synonym — both are *sources* of term variants, not the thing itself.

**Query AST**:
The parsed representation of what a reader typed, owned by the Runtime and the only thing permitted to emit an FTS5 match expression. Anything the parser rejects degrades to the all-terms reading of the raw input, so a reader never sees a syntax error.
_Avoid_: match expression, query string — the first is what the AST emits, the second is what it parses.
