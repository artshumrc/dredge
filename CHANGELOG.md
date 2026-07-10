# Changelog

All notable changes to Dredge are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the Compiler
(`dredge`) and Runtime (`dredge-runtime`) share this file and version line.

## Unreleased

### Removed the Hot Tier — Dredge now ships a single database (breaking)

The Hot Tier (a small title-plus-opted-in-fields database served first on a cold
visit while the full database streamed in behind it) has been removed. Dredge now
compiles and serves exactly one database artifact. The hot tier was a poor fit
for most consumers, and a single tier is simpler to compile, ship, and consume.

There is no in-session "provisional then final" behavior anymore: on a cold visit
the Runtime downloads, verifies, persists, and opens the one database, then
serves searches; a warm visit reopens the OPFS copy directly.

#### Breaking changes

**Config (`dredge.config.json`)**

- `search_fields` entries no longer accept a `hot` key. A `hot` key is now a
  `CONFIG_INVALID` error.
  - Before: `{ "source": "meta[...]@content", "hot": true }`
  - After:  `{ "source": "meta[...]@content" }` (or the bare string form)
  - The field's text is still indexed for full-text search — it is folded into
    the body FTS index alongside the `body` selector, exactly as a non-hot
    search field always was.

**Manifest (`search-manifest.json`)**

- Removed keys: `hot_db_file`, `hot_db_sha256`, `hot_db_bytes`,
  `hot_db_compressed_bytes`.
- The `search-hot.<sha256>.db.br` artifact is no longer produced. Delete any
  stale hot artifacts from your output/deploy directories.
- `db_file`, `db_sha256`, and the full database bytes are unchanged, so a
  database already cached in a visitor's OPFS stays valid across the upgrade —
  warm visitors are not forced to re-download.

**Generated / shipped client API (`dredge-client.js`, generated client, `DredgeSearchClient`)**

- Removed the `DredgeTier` type (`"hot" | "full"`).
- Removed `DredgeSearchResponse.tier`. Every response is now just
  `{ total, hits, facets?, elapsedMs }`.
- Removed the `"ready_hot"` value from `DredgeStatus`. The boot status
  progression is now `checking_support → fetching_manifest → downloading_db →
  decompressing_db → writing_opfs → opening_db → ready` on a cold visit, or
  straight to `ready` on a warm visit.
- The worker `ready` message no longer carries a `tier`.
- `search()` (and `init()`) now resolves only once the single database is open.
  Previously, on a cold visit they resolved early against the hot tier and later
  responses were tagged `"full"`. There are no more provisional results to
  supersede.

**Python API (`dredge.compiler`)**

- `SearchFieldConfig` no longer has a `hot` field.
- `CompileResult` no longer has `hot_db_path` or `hot_compressed_db_path`.

#### Migration

1. **Configs:** remove `"hot": true` from every `search_fields` entry.
2. **Consumer code:**
   - Delete any read of `response.tier` and any branching on `"hot"` / `"full"`.
   - Remove `"ready_hot"` handling; treat `"ready"` as the single ready state.
     If you re-ran the visible query when the status advanced from `ready_hot`
     to `ready`, that re-run is no longer needed.
3. **Rebuild:** re-run `dredge compile` and `dredge codegen` to regenerate the
   artifact, manifest, and typed client.
4. **Deploy:** delete stale `search-hot.*` files from the deployed `/search/`
   directory.
