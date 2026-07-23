# Static-site search benchmark

This harness compares Dredge, Pagefind, Orama, FlexSearch, and Lunr over four
real static-site corpora:

| Size | Corpus | Built HTML | Expected pages |
| --- | --- | --- | ---: |
| Small | `~/repos/darth-website` | `dist/` | about 250 |
| Medium | `~/repos/tsumeb-1/tsumeb` | `dist/objects/` | about 840 |
| Large | `~/repos/amendments-project` | `amendments/static_site/amendments/` | about 22,800 |
| Extra large | `~/repos/giza` | `dist/**/full/` | about 159,000 |

The extra-large corpus uses the site key `xlarge`.

The source paths and extraction selectors are versioned in `sites.json`. The
harness extracts each corpus once, writes equivalent minimal HTML for the two
HTML-native indexers, and writes the same title/body records for the JavaScript
indexers. Corpus preparation is outside measured indexing time.

All generated sites, indexes, browser bundles, raw measurements, and reports go
under `benchmarks/dist/`. That directory is ignored by Git.

## Setup

Build each source site first if its existing `dist/` is stale or absent:

```sh
# Small
cd ~/repos/darth-website && npm run build

# Medium
cd ~/repos/tsumeb-1/tsumeb && npm run build

# Large
cd ~/repos/amendments-project && ./build_site.sh

# Extra large
cd ~/repos/giza && uv run poe static-build-production
```

Install the benchmark dependencies and Chromium:

```sh
cd benchmarks
pnpm install
pnpm exec playwright install chromium
```

## Run

Start with a 100-page smoke run. `--limit` changes the prepared corpus and is
intended only to validate the harness:

```sh
pnpm bench --site small --limit 100 --iterations 5
```

Run one complete site:

```sh
pnpm bench --site medium
```

Run all three sites and all five engines:

```sh
pnpm bench --site all
```

Engines can be selected when diagnosing a failure or rerunning an expensive
case:

```sh
pnpm bench --site large --engines dredge,pagefind,orama
```

The phases can also be run independently:

```sh
pnpm prepare:corpus --site small
pnpm build --site small
pnpm run:browser --site small --iterations 20
pnpm report --site small
```

Large browser matrices can raise the per-page timeout and resume one engine at
a time without rebuilding completed engines:

```sh
pnpm run:browser --site xlarge --engines pagefind --timeout-minutes 90
```

If an engine exceeds the timeout, the runner records that engine as failed and
continues. Its unavailable browser measurements appear as `-` in the report.
Every fetch, initialization, search, and memory sample also has a 60-second
timeout by default; override it with `--operation-timeout-seconds`.

The final machine-readable and Markdown reports are `dist/report.json` and
`dist/report.md`. The JSON report also captures the machine, Node version, exact
package versions, and Chromium version used for each browser run.

## Measurements

The build phase runs each indexer in an isolated process and records:

- Wall-clock indexing time.
- Peak RSS on Linux through GNU `time`.
- Number and raw bytes of deployable artifact files. Dredge's intermediate raw
  `.db` is excluded because the runtime fetches the `.db.br` artifact.
- The sum of each artifact file compressed independently with Brotli quality 5.

The browser phase runs in the full Chromium (`chromium` channel, new headless —
the default `chrome-headless-shell` does not expose the memory API below) and
uses a fresh context per engine. It records:

- Cold initialization in an empty browser context, and warm initialization in a
  second page in the same context (reusing the HTTP cache and, for Dredge, the
  OPFS database).
- p50, p95, and p99 latency after three unreported warmups, over a matrix of:
  - **page size** 10, 50, 100, and 200 (result-hydration cost);
  - **facet counts** on and off (`includeFacets`), unfiltered and filtered.
- **Bytes over the wire**, totalled at the HTTP server so it captures every
  request including fetches made *inside a worker* (Dredge downloads its database
  in the worker). Cold is the first-visit transfer; warm is the repeat visit.
- **Total tab memory** after querying via
  `performance.measureUserAgentSpecificMemory()`, which counts the main thread,
  workers, and WASM heap together — the only fair measure when an engine keeps
  its index in a worker's WASM heap rather than the JS heap. The API is
  deliberately rate-limited (a randomized delay up to ~20 s), so it is sampled
  once per page.
- **Multi-tab**: N tabs opened concurrently in one context. Each tab measures
  its own memory; the sum is the aggregate. Because the tabs share an origin,
  Dredge's Web-Locks leader election engages — one tab owns the database and the
  rest relay searches to it and download nothing — while the JavaScript engines
  load a full independent index per tab.

Queries are selected deterministically from document-frequency bands in each
corpus: rare, selective, moderate, and broad. The generated `workload.json`
records the chosen terms and their corpus document frequencies.

Every document also receives one of eight deterministic `benchmark_group`
values. Each text query is run a second time with one `benchmark_group` filter
active, and separately with facet counts requested. Dredge uses a Facet,
Pagefind uses a filter, Orama uses an enum `where` condition, FlexSearch uses a
document tag, and Lunr uses a required field clause. Facet counts are native for
Dredge, Pagefind, and Orama; FlexSearch and Lunr have no facet subsystem, so the
adapter enumerates the full match set and tallies the stored `benchmark_group`
value — the whole-set work that a top-k page normally lets them skip. The report
keeps unfiltered, filtered, and facet-count latency in separate tables, and a
correctness table flags engines that cannot report an exact total count
(FlexSearch caps at the page size) or usable facet counts.

## Interpretation limits

This is a static-site product benchmark, not a claim that the engines implement
identical retrieval models.

- Ranking scores are not comparable across engines.
- Dredge uses ANDed FTS prefix terms; Pagefind applies its own language and
  stemming behavior; Orama is configured without typo tolerance; FlexSearch
  uses forward tokenization; Lunr uses its English
  pipeline.
- Pagefind lazily fetches result fragments. Its measured query includes loading
  the first ten fragments.
- Lunr does not store result documents in its index, so its artifact includes a
  separate title/URL document map.
- Lunr has no independent structured-filter subsystem; its active-filter track
  uses a required query clause scoped to the `benchmark_group` field.
- Orama's default store includes indexed documents, including body text.
- Dredge's artifact includes its browser worker and WASM files. Pagefind's
  artifact includes its generated browser runtime and WASM. The JavaScript
  engines' shared benchmark runner is not included in their artifact sizes.
- The first browser navigation and benchmark adapter download occur before the
  initialization timer. Initialization measures loading the search artifact and
  making it queryable, not total page navigation time.
- Localhost timings remove internet bandwidth as a variable, so latency is
  compute-bound here. The bytes-over-the-wire columns are the network-cost proxy;
  they are served uncompressed over HTTP, so an engine shipping raw JSON is
  compared against its own on-disk artifact, while Dredge ships an
  already-compressed database.
- FlexSearch's non-facet queries use a top-k `limit`, so its reported total
  count is capped at the page size, not the true match count. This is flagged in
  the correctness table; it is also why its plain-query latency is unusually flat
  — it never enumerates the full match set until facet counts force it to.

The large corpus may exceed Lunr, FlexSearch, or Orama's practical memory limit.
Such a failed build is recorded and the remaining engines continue. JavaScript
builders receive a 16 GiB V8 heap ceiling; this is a harness ceiling, not a
minimum system-memory recommendation.
