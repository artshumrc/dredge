# Dredge

Dredge is client-side search for very large static websites: the Compiler turns rendered HTML into a SQLite FTS5 database artifact, and the Runtime queries that artifact entirely in the browser through a SQLite-WASM worker and thin client.

## Architecture

The Compiler reads a `dredge.config.json`, extracts pages from `source_dir`, builds a SQLite search database, compresses it with Brotli, writes `search-manifest.json`, and can generate a typed TypeScript client. The Manifest describes the database artifact so the Runtime can fetch the right file, verify its metadata, and open it in the worker.

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
    { "source": "meta[data-pagefind-meta='catalog_id[content]']@content" }
  ],
  "facets": {
    "category": {
      "type": "string",
      "source": "data-dredge-category",
      "required": true
    }
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
- `search_fields`: extra fields indexed for full-text search. Each entry is either a selector string or a `{ "source": string }` object; its text is folded into the body full-text index alongside the `body` selector.
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

Every asset is minified, and content-hashed names make them safe to serve immutable.

Compression is left to the host, because a browser only decompresses a response its server marked `Content-Encoding`. Hosts that compress on the fly — GitHub Pages, Netlify, Cloudflare, Vercel — need nothing from Dredge; GitHub Pages gzips these assets including the `.wasm`. On a host configured to serve precompressed files from disk (nginx `brotli_static`/`gzip_static`, Caddy `precompressed`), `--precompress` writes a `.br` (Brotli quality 11) and `.gz` beside each asset, which takes the 1,277 kB of Runtime from 551 kB gzipped on the fly down to 454 kB. Hosts without that mechanism never request the sidecars, so leave them off.

Every installed file is named `dredge-*`. That is what lets a reinstall retire the previous version's content-hashed payloads instead of leaving them to accumulate; nothing else in `output_dir` — the `search.*` database artifacts included — is ever touched.

Pass `--no-runtime-assets` to leave the Runtime out entirely and install it yourself. To refresh the Runtime after upgrading Dredge without recompiling the site, install it on its own:

```sh
dredge install --config dredge.config.json
```

The assets are built from `runtime/` and vendored into the Python package, which is what lets the wheel ship them. After changing anything under `runtime/src/`, rebuild them:

```sh
cd runtime
pnpm install
pnpm run vendor
```

## Vocabulary

Project vocabulary is defined in `CONTEXT.md`. Use those terms when discussing Dredge internals: Facet, Store Field, Field, Field Role, Database Artifact, Boot, Manifest, Runtime, and Compiler.
