# Changelog

All notable changes to Dredge are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the Compiler
(`dredge`) and Runtime (`dredge-runtime`) share this file and version line.

## Unreleased

## 0.3.0 — 2026-09-04

### A search finds the corpus's own other words for it

Searching `photographs` no longer misses the pages that write `photograph` or
`photographed`. The Compiler derives **Term Variant** groups from the finished
index's own terms and ships them in `dredge_term_variants`; the Runtime widens
each bare query term across its group before matching.

- Groups are keyed on the surface form, so no stemmer ships to the browser and
  widening is one indexed probe per term. On a 159k-page corpus the table is
  9,101 rows — 71.3 KiB compressed inside a 15.5 MiB artifact.
- Exact matches lead. Documents matching what the reader actually typed sort
  ahead of documents that matched only through a variant, with bm25 ordering
  within each band. Each hit carries its `band` (0 exact, 1 variant-only) so a
  consumer can reproduce the order.
- Banding is ordering only: the total and every Facet count are identical with
  and without it, and an explicit `sort` suppresses both.
- Quoted phrases, `field:` scopes, `near()` operands and catalogue identifiers
  are never widened, so precision tools stay precise.
- The table is optional at query time. An artifact without one searches exactly
  as it did before.
- `variant_generation`, `synonym_groups` and `suppressed_variants` turn
  generation off, add a project's own equivalences (`khufu`/`cheops`), and
  remove an over-eager pairing (`statue`/`status`). A suppression removes that
  one pairing, not the whole group.
- `dredge compile --variants-json PATH` writes the pairings a build produced, so
  a maintainer can audit search before publishing it.

### A maintainer shapes relevance beyond the text

Some pages matter more than their prose says, and a site can now declare it. A
`boosts` entry multiplies the relevance ordering of the pages it names, so a
collection record outranks a blog post and a current record outranks a
superseded one.

- Two shapes, both optional: `values` gives a multiplier per value of a scalar
  Facet, and `recency` curves a `date` Facet — `max` at today, halving every
  `half_life_days`.
- Boosts are **multiplicative**, because FTS5's bm25 returns negative values
  ordered ascending. A multiplier above 1 moves a page toward the front.
- Boosting is ordering only. The total and every Facet count are identical with
  and without a boost, and each hit's `score` stays its own bm25 rank.
- Exact matches still lead: a boost orders pages *within* a band and can never
  lift a variant-only match above an exact one.
- An explicit `sort` suppresses relevance ordering, and boosts with it.
- The declarations ship in the artifact's `dredge_boosts` table. Boosting a
  Store Field, an array Facet, or an unknown field is a build error
  (`CONFIG_INVALID`), never a silent runtime one.

### A site says which of its fields matter

Fields named for full-text search stop being concatenated into one indexed body
and become **Search Columns** of the index, each with its own bm25 weight. A
catalogue identifier can now outrank the same string buried in a paragraph.

- A `search_fields` entry with a `name` becomes a Search Column; one without a
  name is still folded into `body`, exactly as before.
- `search_weights` sets the bm25 weight of any Search Column, `title` and `body`
  included. Defaults are `title` 10.0, `body` 1.0, and 1.0 for a named column,
  so a config that names nothing new compiles to the two-column index and the
  bytes it compiled to before.
- The weights ship in the artifact's `dredge_search_columns` table and the
  runtime reads them there; no ranking constant is left in the runtime.
- `field:` resolves the maintainer's own names, so `identifier:G7510` scopes to
  their `identifier` column. An unknown name is a reader error and degrades,
  never a build error.
- The payload report prices each Search Column. An extra column costs roughly
  16–20 bytes per document, because FTS5 restarts a position list at each column
  boundary — which is why Search Columns are opt-in per site.
- bm25's `k1` and `b` stay fixed: FTS5 exposes neither.

### A query language instead of a bag of words

Reader input is parsed into a Query AST and emitted as an FTS5 match expression
in two separable stages, so quoted phrases, `-` exclusion, `OR`, `field:` scoping,
`near(a b, N)` and parentheses all work end to end. Nothing else builds a match
expression, and no reader text reaches `MATCH` unparsed.

- Anything the parser rejects — an unbalanced quote, a stray parenthesis, an
  unknown field — degrades to the all-terms reading of the raw input. A reader
  never sees a syntax error.
- Typeahead is unchanged: only the last term typed is prefix-expanded, never
  inside a quoted phrase, and a single-character final term stays exact.
  Catalogue-identifier handling and diacritic folding are untouched.
- `field:` scopes to the index's Search Columns — `title` and `body`, plus
  whatever the config names.
- The compiler's duplicate `dredge.query` builder is gone;
  `tests/fixtures/query-vectors.json` is now the Runtime's golden file alone.

### A hit shows why it matched

Every hit carries `marks`: the spans of its `title` and `description` that the
query matched, ready to wrap in `<mark>`. `snippet()` and `highlight()` return
`NULL` against a contentless index, so this is computed over what the response
already holds.

- Marks cover the variants that actually matched, not just the literal input, so
  highlighting never disagrees with the result set.
- Offsets are UTF-16 indices into the field string as returned, and the fold is
  offset-preserving: `Café` folded to `cafe` still marks all four characters.
- Marks are absent rather than empty — read them as
  `hit.marks?.[field] ?? []`.

### A typo gets a correction, a half-typed word gets completions

A new `suggest` operation reads the index's own term dictionary through an FTS5
vocabulary view, which occupies no bytes of its own, so nothing suggested can
land a reader on zero results.

- One request shape: `{ term, kind: "correction" | "completion", limit? }`.
  Corrections rank by edit distance computed in the Runtime, since SQLite offers
  none; completions extend the prefix.
- Candidates are prefiltered in SQL by leading character, length window, and a
  document-frequency floor before any distance is computed.
- Suggestions travel the same worker and multi-tab coordination path as search.

### The generated client reaches everything the engine does

The generated client's request type is level with the engine's: `sort`, the
query-language surface, `marks`, `band`, and `suggest` are all reachable from a
typed client without hand-writing around it. `DredgeSortField` names exactly the
columns that can be sorted — built-ins and scalar Facets — so a Store Field or
an array Facet is a type error rather than a runtime one.

- The standalone client bundle (`dredge-client.js`) reaches suggestions too:
  `DredgeSearchClient.suggest()` and the `DredgeSuggest*` types are exported
  there as well, so a site that never runs `dredge codegen` is not shut out. A
  suggestion is never superseded by a later search, unlike a search.

### Measured and rejected

Recorded so the next person does not re-run the experiments:

- **A `prefix='2 3'` index.** Takes the 159k-page index from 10.69 to 25.10 MiB
  brotli — 2.4× the download — to save about 3 ms on two-letter prefixes.
- **Switching the index tokenizer to `porter`.** Stemming the index means
  stemming the query, and a half-typed word does not stem to a prefix of the
  finished word's stem: `running` matches at `run` but returns nothing at
  `runni`. It also makes every conflation permanent and invisible, where a
  Term Variant table is inspectable and correctable.
- **Stored-text snippets.** `snippet()` and `highlight()` need the text in the
  index; storing it is the artifact's whole download budget, and marking the
  title and description the response already carries costs nothing.
- **Normalizing the Term Variant table** into group id and member tables: the
  index on the group id costs more than the redundancy it removes.

### The Database Artifact's schema version moved (breaking)

Term Variants, Search Columns and boosts all change the artifact's shape, so
`db_schema_version` is now 3. An artifact built by an older Compiler is refused
at Boot with `SCHEMA_VERSION_MISMATCH` rather than served — a stale deployment
fails loudly instead of silently mis-serving.

#### Upgrading

Every consumer must recompile and redeploy; there is no in-place migration.

```sh
dredge compile --config dredge.config.json
```

If a site installs the Runtime separately from its artifacts, refresh it too, so
the browser code matches the schema the artifact now declares:

```sh
dredge install --config dredge.config.json
```

A config that names none of the new keys compiles to the index it compiled to
before and behaves as it did; upgrading is not a re-tuning project.

## 0.2.0 — 2026-09-03

### Bumping the version in `pyproject.toml` cuts the release

`pyproject.toml` is the only place a release version is written by hand.
`dredge.__version__` reads it back from the installed package metadata, the
private `runtime/` workspace no longer carries a version field of its own, and
pushing a bump to `main` is what cuts a release: CI runs the full suite, retitles
the `## Unreleased` section, tags the commit, and publishes a GitHub Release with
those notes and the built wheel and sdist.

- `runtime_min_version` in the Manifest is a hand-maintained constant rather than
  the compiler's own version, so a release no longer declares every deployed
  Runtime out of date. It moves only when a format change actually breaks one.
- `runtime/package.json` pins `packageManager`, which `pnpm/action-setup`
  needs to pick a pnpm version; without it every CI run failed before it
  reached a test.
- `scripts/changelog.py` reads and stamps `CHANGELOG.md`. Tests cover the file's
  shape, the version agreeing between `pyproject.toml` and the package, and
  `runtime/src/db.ts` declaring the same Manifest and schema versions as
  `dredge.compiler`.

### The CLI now ships the Runtime

`pip install dredge` carries the browser Runtime — the client and worker bundles
plus the SQLite and Brotli WASM payloads — inside the wheel, and `dredge compile`
installs them into `output_dir` next to the database and Manifest. Indexing a
site now produces everything that site serves under `/search/`; cloning the
repository and running a Node build to collect the assets is no longer part of
setup.

- The assets are minified and stored Brotli-compressed inside the wheel (1.25 MB
  of assets in 454 kB). `--precompress` writes `.br`/`.gz` sidecars beside each
  installed asset for hosts that serve precompressed files from disk (nginx
  `brotli_static`, Caddy); it is off by default because the common static hosts
  compress on the fly and ignore sidecars. `--no-runtime-assets` skips the
  Runtime entirely.
- The worker bundle no longer pulls in `@sqlite.org/sqlite-wasm`'s worker1
  promiser, which had been dragging an unused second copy of `sqlite3.wasm` and
  its ~196 kB loader into every site: 2.3 MB of installed assets down to 1.25 MB.
- `dredge codegen` reads its client template from the package instead of from a
  sibling `runtime/` checkout, so it works from an installed wheel.
- New `dredge install`, which installs the Runtime into `output_dir` on its own
  so upgrading Dredge does not mean recompiling the site.
- Installed assets are all named `dredge-*`, and installing retires `dredge-*`
  files it did not write. Content-hashed payloads from a previous version no
  longer accumulate in a site, and sidecars are cleared when `--precompress` is
  turned off. Nothing else in `output_dir` is touched.
- `pnpm run vendor` records the runtime sources it built from in
  `src/dredge/vendor/sources.json`, and a test fails when the vendored assets
  are stale for the checkout — so an edit under `runtime/src/` cannot silently
  ship a mismatched Runtime.
- `runtime/scripts/install-into-site.mjs` is gone; `pnpm run vendor` rebuilds the
  assets and vendors them into the Python package.
- Added a test workflow (`.github/workflows/ci.yml`) running the compiler and
  runtime suites plus a wheel build; the repository previously had CI only for
  the benchmark report deploy.

#### Upgrading

A site that installed the Runtime by hand from a Dredge checkout has assets
under the old, unprefixed names (`sqlite3-*.wasm`, `brotli_dec_wasm*`, an
`assets/` subdirectory). Retirement only sweeps `dredge-*`, so clear the search
directory once before recompiling:

```sh
rm -rf <output_dir> && dredge compile --config dredge.config.json
```

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
