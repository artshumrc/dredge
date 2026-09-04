# Dredge

Dredge is client-side search for very large static websites: the Compiler turns rendered HTML into a SQLite FTS5 database artifact, and the Runtime queries that artifact entirely in the browser through a SQLite-WASM worker and thin client.

## Architecture

The Compiler reads a `dredge.config.json`, extracts pages from `source_dir`, builds a SQLite search database, compresses it with Brotli, writes `search-manifest.json`, and can generate a typed TypeScript client. The Manifest describes the database artifact so the Runtime can fetch the right file, verify its metadata, and open it in the worker. It also declares the artifact's schema version, and a Runtime opens only the schema it was built for: anything else is refused at boot with `SCHEMA_VERSION_MISMATCH`.

The Runtime lives in the browser. Its worker owns SQLite-WASM and the database handle; the generated or hand-written client sends search requests to that worker and receives hits, counts, and optional Facet buckets.

Dredge ships a single database artifact. On a cold visit the Runtime downloads it, verifies its integrity, persists it to OPFS, and opens it; warm visitors reopen the OPFS copy directly without re-downloading.

## Installation

The wheel carries the Runtime assets (worker, client, and the SQLite/Brotli WASM payloads), so an install is all a site needs — there is no separate Node toolchain step:

```sh
pip install git+https://github.com/artshumrc/dredge
```

Working inside this repository, run the CLI through `uv run dredge` instead.

## Quick start

Indexing a static site and wiring search into its pages is three steps:

1. **Compile the artifact.** From a `dredge.config.json` (see [Configuration](#configuration)), extract pages and write the database, compressed database, Manifest, and the Runtime assets into `output_dir`:

   ```sh
   dredge compile --config dredge.config.json
   ```

2. **Generate the typed client.** This writes the TypeScript client to the `client.out` path in your config:

   ```sh
   dredge codegen --config dredge.config.json
   ```

3. **Use the client on the page.** Import the generated client, call `search`, and render the hits:

   ```ts
   import { DredgeSearchClient } from "./dredge-client";

   const client = new DredgeSearchClient();

   const response = await client.search({
     query: "hello world",
     filters: { category: "guides" },
     includeFacets: true,
     limit: 20,
   });

   console.log(response.total, response.hits, response.facets);
   ```

The first `search` call lazily boots the worker; there is no separate setup step. Subscribe with `client.onStatus(listener)` to observe boot progress (`downloading_db` → `opening_db` → `ready`); searches resolve once the status reaches `ready`. Rapid consecutive `search` calls coalesce latest-wins, so intermediate keystrokes never reach the worker.

## Configuration

A config declares where the HTML lives, how to extract fields from it, and what the search results carry:

```json
{
  "source_dir": "site",
  "output_dir": "search",
  "base_url": "/",
  "include": ["**/*.html"],
  "exclude": [],
  "selectors": {
    "title": "title, h1",
    "body": "main",
    "description": "meta[name='description']@content"
  },
  "search_fields": [
    "meta[name='keywords']@content",
    {
      "source": "meta[data-pagefind-meta='catalog_id[content]']@content",
      "name": "catalog_id"
    }
  ],
  "search_weights": { "title": 10.0, "catalog_id": 25.0 },
  "boosts": {
    "category": { "values": { "collection": 2.0 } },
    "published": { "recency": { "max": 1.5, "half_life_days": 730 } }
  },
  "facets": {
    "category": {
      "type": "string",
      "source": "data-dredge-category",
      "required": true
    },
    "year": { "type": "integer", "source": "data-dredge-year" },
    "published": { "type": "date", "source": "data-dredge-published" }
  },
  "store_fields": {
    "image": {
      "type": "string",
      "source": "meta[property='og:image']@content"
    }
  },
  "result_fields": ["title", "url", "description", "category", "image"],
  "composite_indices": [["category", "year"]],
  "client": {
    "out": "src/dredge-client.ts",
    "worker_url": "/search/dredge-worker.js"
  }
}
```

Keys:

- `source_dir`: directory containing rendered HTML.
- `output_dir`: directory where Dredge writes the database, compressed database, Manifest, and optional client.
- `base_url`: URL prefix used when turning HTML paths into result URLs.
- `include` and `exclude`: glob lists selecting HTML files under `source_dir`.
- `selectors`: extraction selectors for the built-in `title`, `body`, and `description` fields.
- `search_fields`: extra fields indexed for full-text search. Each entry is either a selector string or a `{ "source": string, "name"?: string }` object. Without a `name` its text is folded into the body full-text index alongside the `body` selector. With one it becomes a **Search Column** of its own — separately weighted for ranking, and addressable as `name:term` in a reader's query.
- `search_weights`: bm25 weight per Search Column. Keys are `title`, `body`, or any name declared in `search_fields`; values are finite non-negative numbers. Defaults are `title` 10.0, `body` 1.0, and 1.0 for a named Search Column. Every extra Search Column costs roughly 16–20 bytes per document in the shipped index, which the payload report prices per column.
- `boosts`: optional relevance multipliers per scalar Facet. Each entry declares exactly one shape: `values`, mapping Facet values to multipliers, or `recency`, a curve over a `date` Facet (`max`, the lift a page dated today receives, default 2.0; `half_life_days`, how fast that lift halves, default 730). Multipliers are finite and positive, and multiply rather than add — bm25 ranks are negative, so above 1 moves a page toward the front. Boosting is **ordering only**: the total, every Facet count, and each hit's `score` are unaffected, exact matches still lead their variants, and an explicit `sort` ignores boosts entirely. Boosting a Store Field, an array Facet, or an unknown field fails the build (`CONFIG_INVALID`).
- `facets`: named fields extracted per page, indexed, filterable, and countable at query time. Supported types are `string`, `string_array`, `integer`, `number`, `boolean`, and `date`.
- `store_fields`: named fields carried into search results but never indexed, filtered, or counted. Scalar types only — `string_array` must stay a Facet.
- `result_fields`: fields returned with each hit. May reference built-ins, Facets, and Store Fields.
- `composite_indices`: optional Facet combinations to index together for common filters.
- `client`: optional generated TypeScript client destination and worker URL.
- `allow_output_in_source`: set to `true` only when `output_dir` must live inside `source_dir`.
- `variant_generation`: set to `false` to stop deriving Term Variants from the corpus's own terms. Defaults to `true`; turn it off for a corpus in a language the English stemmer does not serve.
- `synonym_groups`: arrays of terms declared equivalent, merged into the generated groups. Members need not share a stem, so `["khufu", "cheops"]` works.
- `suppressed_variants`: term pairs removed from the merged result, so an over-eager stem like `["statue", "status"]` never ships.

Every field has an explicit **role**. A Facet is indexed, filterable, and countable. A Store Field is carried into results but never indexed, filtered, or counted — use it for display-only data (image URLs, thumbnails) so it stops costing index bytes. Facets and Store Fields share one namespace; a name may not be both, and `result_fields` may reference either role. Filtering or counting on a Store Field fails loudly (`FILTER_INVALID`) rather than scanning the whole table.

## Query language

Whatever a reader types is parsed into a **Query AST** and emitted as one FTS5 match
expression. This is the whole grammar; document it for your own readers as a search-tips page
in your own words.

| Reader types | Meaning |
| --- | --- |
| `carving` | A term. Matches pages holding `carving`, and pages holding the other forms in its Variant Group (`carvings`, `carved`). |
| `golden coffin` | Two terms. Both must appear on the page, anywhere. |
| `"golden coffin"` | A phrase: those words, adjacent, in that order. Never widened to variants. |
| `-tomb` | Exclusion: drop pages holding `tomb`. Needs at least one ordinary term to exclude from. |
| `khufu OR cheops` | Alternatives — either term. `OR` must be capitalised; a lowercase `or` is just a word. |
| `title:carving` | Scoped to one Search Column: `title`, `body`, or any name the config declares. Never widened. |
| `near(khufu pyramid, 5)` | Both terms within 5 terms of one another, in either order. The distance is optional and defaults to 10. Never widened. |
| `(khufu OR cheops) pyramid` | Grouping, so an alternation can sit inside a longer query. |
| `G 7510` | A catalogue identifier. Compact, spaced, and split spellings (`G7510`, `G 7510`, `G-7510`) all find the same record, and an identifier is never widened. |

Operators combine: `title:pyramid (khufu OR cheops) -"old kingdom"` is one query.

Three rules a reader will otherwise trip on:

- **Only the last word is treated as a prefix.** It is the word still being typed, so results
  appear on every keystroke; every earlier term must match in full. A final term of a single
  character stays exact, because expanding it would scan the whole term dictionary.
- **Quotation marks opt out of variant widening.** A bare term also finds its Variant Group's
  other forms; a quoted phrase matches only what was typed. `field:` scopes and `near()`
  operands are exact for the same reason. Quotation marks are the reader's precision tool.
- **A word the index does not hold is widened to its nearest terms.** A misspelling finds the
  pages holding the dictionary terms closest to it, so a typo is not a dead end. It fires only
  for such words: a term the index holds is searched for as typed and never widened this way.
  Everything that opts out of variant widening opts out of correction too — quoted phrases,
  `field:` scopes, `near()` operands, and catalogue identifiers — and so does an excluded term,
  because a guess must never remove pages the reader wanted. The word still being typed is
  corrected only when no term in the dictionary extends it, so `cartou` is a half-typed word
  while `cartouchr` is a misspelling. A term appearing on a single page is never offered as a
  correction, so the corpus's own typos are not handed back.

Nothing a reader types is an error. Anything the parser cannot read — an unbalanced quote, a
stray parenthesis, a `field:` name the index does not have — falls back to treating the whole
input as a list of terms, all of which must appear on the page.

Diacritics fold on both sides, so `café` and `cafe` are one search. Each hit reports which
spans of its title and description matched, variants included, in `hit.marks`.

Widening never displaces the reader's own words: pages matching what they typed sort ahead of
pages that matched only through a Variant Group, which in turn sort ahead of pages reached only
through a correction. Each hit carries the band it landed in as `hit.band` — 0 exact, 1
variant-only, 2 correction-only — so a consumer can reproduce the ordering. Banding is ordering
only, leaving the total and every Facet count untouched, and an explicit `sort` replaces
relevance ordering and the banding with it.

Where a word was corrected, the response says so rather than substituting silently: a
`corrections` array names each corrected word and the terms it became, so a page can tell the
reader "showing results for *cartouche*". It is present only when something was corrected.

```ts
const response = await client.search({ query: "cartouchr limestone" });

for (const { term, to } of response.corrections ?? []) {
  console.log(`${term} → ${to.join(", ")}`);
}
```

A term can also be asked about rather than searched for. `client.suggest({ term, kind })`
answers `"correction"` with the nearest terms by edit distance and `"completion"` with the
terms extending it, each `{ term, documentFrequency, distance }` and each drawn from the
index's own dictionary — so accepting a suggestion cannot land the reader on zero results.

Pass `context: { query, filters }` — the rest of what the reader has typed, without the word
being suggested against, and whatever filters are active — and every suggestion returned is
verified to co-occur with it, so accepting one cannot land the reader on zero results *in
combination* with the rest of their query. `documentFrequency` then reports the in-context
count rather than the corpus-wide one, and completions come back ordered by it. A request
without `context` behaves exactly as it always has.

```ts
const { suggestions } = await client.suggest({
  term: "pyr",
  kind: "completion",
  context: { query: "khufu", filters: { category: "collection" } },
});
```

**Suggesting whole pages** needs no separate feature: it is plain search with a small limit.
Ask for a few hits and render each one's `title` and `url` as a dropdown row.

```ts
const { hits } = await client.search({ query, limit: 5 });

dropdown.replaceChildren(
  ...hits.map((hit) => {
    const link = document.createElement("a");
    link.href = hit.url;
    link.textContent = hit.title;
    return link;
  }),
);
```

## CLI

Validate a config without writing artifacts:

```sh
dredge validate --config dredge.config.json
```

Compile a site into the search artifact and Manifest:

```sh
dredge compile --config dredge.config.json
```

Compile with optional metrics and Brotli quality controls:

```sh
dredge compile --config dredge.config.json --metrics-json metrics.json --brotli-quality 5
```

Audit the Term Variant pairings a build produced:

```sh
dredge compile --config dredge.config.json --variants-json variants.json
```

Generate only the configured TypeScript client:

```sh
dredge codegen --config dredge.config.json
```

Install the browser Runtime into `output_dir` without recompiling:

```sh
dredge install --config dredge.config.json
```

Generate a deterministic synthetic site for stress testing:

```sh
dredge synth /tmp/dredge-synthetic --count 1000 --seed 1 --shard-size 1000
```

## Runtime assets

`dredge compile` installs the Runtime into `output_dir` alongside the database and Manifest, so the compiled directory is the whole of what a site serves under `/search/`:

- `dredge-client.js` — the ESM client bundle the page imports (the generated TypeScript client wraps this API).
- `dredge-worker.js` — the search Worker, plus its content-hashed SQLite and Brotli WASM payloads and the OPFS proxy chunk.

Every asset is minified. The WASM and proxy payloads carry content-hashed names and are safe
to serve immutable; `dredge-client.js` and `dredge-worker.js` keep fixed names, so give those a
short max-age — a returning visitor holding a cached Runtime alongside a freshly compiled
artifact is the one way to meet `SCHEMA_VERSION_MISMATCH` on a correct deploy.

Compression is left to the host, because a browser only decompresses a response its server marked `Content-Encoding`. Hosts that compress on the fly — GitHub Pages, Netlify, Cloudflare, Vercel — need nothing from Dredge; GitHub Pages gzips these assets including the `.wasm`. On a host configured to serve precompressed files from disk (nginx `brotli_static`/`gzip_static`, Caddy `precompressed`), `--precompress` writes a `.br` (Brotli quality 11) and `.gz` beside each asset, which takes the 1,277 kB of Runtime from 551 kB gzipped on the fly down to 454 kB. Hosts without that mechanism never request the sidecars, so leave them off.

Every installed file is named `dredge-*`. That is what lets a reinstall retire the previous version's content-hashed payloads instead of leaving them to accumulate; nothing else in `output_dir` — the `search.*` database artifacts included — is ever touched.

Pass `--no-runtime-assets` to leave the Runtime out entirely, and install it as its own step:

```sh
dredge install --config dredge.config.json
```

The Runtime and the artifact it opens must come from the same Dredge version, so installing the
Runtime on its own belongs to a build that compiled the artifact from that same version.
Upgrading Dredge means recompiling the site, not reinstalling the Runtime beside a database
built by an older one.

The assets are built from `runtime/` and vendored into the Python package, which is what lets the wheel ship them. After changing anything under `runtime/src/`, rebuild them:

```sh
cd runtime
pnpm install
pnpm run vendor
```

## Vocabulary

Project vocabulary is defined in `CONTEXT.md`. Use those terms when discussing Dredge internals: Facet, Store Field, Field, Field Role, Database Artifact, Boot, Manifest, Runtime, Compiler, Search Column, Boost, Term Variant (and Variant Group), Query AST, Correction, and Suggestion Context.
