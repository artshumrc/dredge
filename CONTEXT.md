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
