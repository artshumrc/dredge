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

**Hot Tier**:
The small database fetched first on a cold visit (title + hot-flagged search fields, all result fields). Lives only in WASM memory; never persisted. Searches answered from it are tagged `tier: "hot"`.
_Avoid_: hot shard, tier 1, mini index

**Full Tier**:
The complete database (body FTS included). Persisted in OPFS; the only tier a warm visitor ever touches.
_Avoid_: tier 2, main DB

**Tier Swap**:
The background transition from hot to full within a session: download, verify, import to OPFS, atomically switch the worker's handle, emit `ready`. Apps decide how to react.

**Manifest**:
`search-manifest.json` — the small, always-fetched JSON describing the current database artifact (file name, sha256, sizes, schema version).

**Runtime**:
The browser-side library: worker (SQLite WASM + OPFS) plus the thin client that owns it.

**Compiler**:
The Python CLI (`dredge compile`) that extracts, ingests, indexes, and packages a site into the database artifact.
