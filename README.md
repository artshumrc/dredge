# Dredge

Dredge is client-side search for very large static websites: the Compiler turns rendered HTML into a SQLite FTS5 database artifact, and the Runtime queries that artifact entirely in the browser through a SQLite-WASM worker and thin client.

## Architecture

The Compiler reads a `dredge.config.json`, extracts pages from `source_dir`, builds a SQLite search database, compresses it with Brotli, writes `search-manifest.json`, and can generate a typed TypeScript client. The Manifest describes the database artifact so the Runtime can fetch the right file, verify its metadata, and open it in the worker.

The Runtime lives in the browser. Its worker owns SQLite-WASM and the database handle; the generated or hand-written client sends search requests to that worker and receives hits, counts, and optional Facet buckets.

Schema v2 will split shipped data into a Hot Tier and a Full Tier. The Hot Tier is the small first database for cold visits, while the Full Tier is the complete database that warm visitors use from OPFS. Until schema v2 lands, Dredge ships one Full Tier-style database artifact.

## Configuration

A minimal current config looks like this:

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
    "meta[data-pagefind-meta='catalog_id[content]']@content"
  ],
  "facets": {
    "category": {
      "type": "string",
      "source": "data-dredge-category",
      "required": true
    }
  },
  "result_fields": ["title", "url", "description", "category"],
  "composite_indices": [["category", "year"]],
  "client": {
    "out": "src/dredge-client.ts",
    "worker_url": "/search/dredge-worker.js"
  }
}
```

Current keys:

- `source_dir`: directory containing rendered HTML.
- `output_dir`: directory where Dredge writes the database, compressed database, Manifest, and optional client.
- `base_url`: URL prefix used when turning HTML paths into result URLs.
- `include` and `exclude`: glob lists selecting HTML files under `source_dir`.
- `selectors`: extraction selectors for built-in `title`, `body`, and `description` fields.
- `search_fields`: extra selector strings indexed for full-text search.
- `facets`: named fields extracted per page, indexed, filterable, and countable at query time. Supported types are `string`, `string_array`, `integer`, `number`, `boolean`, and `date`.
- `result_fields`: fields returned with each hit. Today these may include built-ins and Facets.
- `composite_indices`: optional Facet combinations to index together for common filters.
- `client`: optional generated TypeScript client destination and worker URL.
- `allow_output_in_source`: set to `true` only when `output_dir` must live inside `source_dir`.

As of upcoming schema v2, fields have explicit roles. A Facet remains indexed, filterable, and countable. A Store Field is carried into search results but never indexed, filtered, or counted. Facets and Store Fields share one namespace, and `result_fields` may reference both roles.

Schema v2 config shape:

```json
{
  "facets": {
    "category": {
      "type": "string",
      "source": "data-dredge-category"
    }
  },
  "store_fields": {
    "image": {
      "type": "string",
      "source": "meta[property='og:image']@content"
    }
  },
  "search_fields": [
    "meta[name='keywords']@content",
    { "source": "meta[data-pagefind-meta='catalog_id[content]']@content", "hot": true }
  ],
  "result_fields": ["title", "url", "description", "category", "image"]
}
```

Schema v2 notes:

- `store_fields` is upcoming and is not accepted by the current schema v1 compiler.
- Store Fields are scalar only; `string_array` stays Facet-only.
- `search_fields` entries may be either selector strings or `{ "source": string, "hot": boolean }` objects. `hot: true` opts that field into the Hot Tier. Title is always hot.

## CLI

Validate a config without writing artifacts:

```sh
uv run dredge validate --config dredge.config.json
```

Compile a site into the search artifact and Manifest:

```sh
uv run dredge compile --config dredge.config.json
```

Compile with optional metrics and Brotli quality controls:

```sh
uv run dredge compile --config dredge.config.json --metrics-json metrics.json --brotli-quality 5
```

Generate only the configured TypeScript client:

```sh
uv run dredge codegen --config dredge.config.json
```

Generate a deterministic synthetic site for stress testing:

```sh
uv run dredge synth /tmp/dredge-synthetic --count 1000 --seed 1 --shard-size 1000
```

## Vocabulary

Project vocabulary is defined in `CONTEXT.md`. Use those terms when discussing Dredge internals: Facet, Store Field, Field, Field Role, Hot Tier, Full Tier, Tier Swap, Manifest, Runtime, and Compiler.
