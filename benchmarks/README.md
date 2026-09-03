# Static-site search benchmark

This harness compares Dredge, Pagefind, Orama, FlexSearch, and Lunr over four
real static-site corpora, measuring every engine delivering the **same rich
faceted-search experience**: an exact total count at any page, per-value facet
counts over the whole match set, disjunctive (skip-self) counts under an active
filter, relevance ordering with an optional alphabetical re-sort, and a
no-keyword faceted browse. Where an engine lacks a capability, the adapter
implements it in plain JavaScript — the honest cost of matching product
behaviour, so a fast number can never come from silently skipped work.

| Size | Corpus | Built HTML | Expected pages |
| --- | --- | --- | ---: |
| Small | `~/repos/darth-website` | `dist/` | about 300 |
| Medium | `~/repos/tsumeb/tsumeb` | `dist/objects/` | about 950 |
| Large | `~/repos/amendments-project` | `build/site/amendments/` | about 22,800 |
| Extra large | `~/repos/giza` | `dist/**/full/` | about 159,000 |

The extra-large corpus uses the site key `xlarge`. Source paths and extraction
selectors are versioned in `sites.json`. All generated sites, indexes, browser
bundles, raw measurements, and reports go under `benchmarks/dist/`, which is
ignored by Git.

## Setup

Build each source site first if its existing `dist/` is stale or absent:

```sh
cd ~/repos/darth-website && npm install && npm run build  # Small
cd ~/repos/tsumeb/tsumeb && npm run build                # Medium
cd ~/repos/amendments-project && poe build               # Large
cd ~/repos/giza && uv run poe static-build-production    # Extra large
```

Install the benchmark dependencies and Chromium:

```sh
cd benchmarks
pnpm install
pnpm exec playwright install chromium
```

## Run

Start with a 100-page smoke run (`--limit` changes the prepared corpus and is
intended only to validate the harness):

```sh
pnpm bench --site small --limit 100
```

Then a full site, all sites, or a subset of engines:

```sh
pnpm bench --site medium
pnpm bench --site all
pnpm bench --site large --engines dredge,pagefind,orama
```

`pnpm bench` runs four phases — prepare → build → run in browser → report — which
can also be run independently:

```sh
pnpm prepare:corpus --site small
pnpm build --site small
pnpm run:browser --site small
pnpm report --site small
```

**The first run after this redesign must re-prepare all corpora** (the workload
schema changed). Afterwards, `--skip-prepare` reuses the prepared
`corpus.ndjson`/`workload.json` so iterating on measurement code does not
re-extract 159k HTML pages; it is a hard error (never a silent re-prepare) if a
selected site's prepared artifacts are missing:

```sh
pnpm bench --site small --limit 100 --skip-prepare
```

Useful flags:

- `--iterations <n>` — the **maximum** warm samples per config (default 20).
- `--sample-budget-ms <ms>` — the warm per-config time budget (default 1500).
- `--operation-timeout-seconds <s>` — per-search timeout (default 60); a search
  that exceeds it is recorded as a failed cell, not a crash.
- `--timeout-minutes <m>` — page-level backstop (default 30).

### Self-test gate

The report polices its own fairness. After a run, the gate reads
`dist/report.json` and exits non-zero unless every engine passes every
applicable correctness check and the workload has the expected shape:

```sh
node scripts/check-report.mjs --site small   # exit 0 = all green
```

It is what catches FlexSearch-class defects mechanically (see below). The final
artifacts are `dist/report.json` (machine-readable, with a structured
`correctness` block per engine), `dist/report.md`, and `dist/report.html`. To
keep a durable snapshot, deliberately copy `dist/report.md` to a dated file;
there is no floating results file in the repo.

### Publishing the report

`dist/` is gitignored and can't be regenerated in CI — the corpora it depends
on live in sibling repos, not in this one. To publish a run's `report.html` to
GitHub Pages, copy it into the tracked snapshot and push:

```sh
pnpm report:publish   # copies dist/report.html -> benchmarks/report/index.html
git add benchmarks/report/index.html
git commit -m "Update benchmark report"
git push
```

Pushing to `main` with a change under `benchmarks/report/` triggers
`.github/workflows/pages.yml`, which deploys that directory to GitHub Pages
(published at `https://artshumrc.github.io/dredge/`).

## Measurements

### On the build machine

Each indexer runs in an isolated process; the report records wall-clock build
time, peak RSS on Linux (via GNU `time`), and shipped artifact size. Artifact
formats and packaging retain product defaults, although the harness fixes
Dredge extraction at `--jobs 1` for deterministic build-resource comparison.
Dredge builds its `.db.br` at its default Brotli quality 11, and that compression
cost is included in its build time. Its intermediate raw `.db` is excluded from
shipped size because the runtime never fetches it.

The secondary **Normalized br q5** column compares format compressibility under
one compressor setting. Every logical artifact file is compressed independently
at Brotli quality 5; for Dredge this uses the raw `.db` instead of recompressing
its quality-11 `.db.br`. Required runtime files, including Dredge's Brotli
decoder, are included in both measurements.

### In the browser

The browser phase runs in full Chromium (`chromium` channel, new headless — the
default `chrome-headless-shell` lacks the memory API) with a fresh context per
engine.

- **Cold page** (empty cache/OPFS): every config runs **exactly once, no
  warmups** (`sample_count: 1`). Its job is cold initialization and first-visit
  encoded response bytes (lazy per-search fetches included), not the warm
  latency matrix.
- **Warm page**: per config, one warmup; a second only if the first finished
  under budget; then sample until at least 3 samples **and** (cumulative sample
  time ≥ budget **or** the max-sample cap is hit). A slow operation whose first
  warmup already exceeds the budget takes exactly two samples. Every row records
  its `sample_count`; the report annotates any p95 taken over fewer than 10
  samples. The sampling policy is a pure, unit-tested module
  (`browser/sampling.js`).
- **Encoded response-body bytes** are totalled at the HTTP server, so they
  capture fetches made inside a worker (Dredge downloads its database in the
  worker). HTTP headers and transport framing are not included.
  The server models a production CDN: it negotiates Brotli quality 5 for ordinary
  compressible HTML, CSS, JavaScript, JSON, SVG, text, XML, and WASM responses,
  while intrinsic precompressed artifacts such as Dredge's quality-11 `.db.br`
  are served unchanged rather than compressed twice. These HTTP representations
  are prepared before Chromium starts, so compression CPU time is not charged to
  cold initialization.
- **Total tab memory** after querying via
  `performance.measureUserAgentSpecificMemory()` (main thread + workers + WASM),
  sampled once per page. The sample resolves only after every agent in the tab
  performs a garbage collection, which Chromium schedules on a live dedicated
  worker at up to ~60s, so it races its own deadline (2× the operation timeout,
  minimum 120s, identical for every engine); a sample that exceeds it is
  recorded as unavailable rather than failing the run.
- **Tabs**: memory is measured with a single tab open. Engines that load the
  whole index into the page hold an independent copy per tab, so their memory
  multiplies with tab count; Dredge elects one leader tab to own the database
  and the rest relay to it, holding the index once. The report states this
  rather than measuring it.
- **Failure handling**: a per-config timeout or thrown error becomes an error row
  (rendered `✗` with its reason, distinct from `–` = not measured) and the run
  continues. Three consecutive config failures trip a circuit breaker that marks
  the remaining configs skipped, so a pathological engine/site cannot consume
  unbounded wall-clock. Adapter-load or initialization failure remains fatal for
  that page.

### The workload

Six queries are generated deterministically per corpus at preparation time:

| label | form | band (document frequency) |
| --- | --- | --- |
| `rare` | single token | ~1 page |
| `broad` | single token | ~10% of pages |
| `phrase-selective` | two words | ~0.1% |
| `phrase-moderate` | two words | ~2% |
| `phrase-broad` | two words | ~10% |
| `phrase3` | three words | ~0.5% |

Phrases are adjacent token sequences mined from real corpus text (title + body),
banded by adjacency document frequency and sent **unquoted** — every engine runs
them as AND-of-terms (no engine here exposes true quoted-phrase adjacency
queries), so the band is a documented floor and each engine's own `result_count`
shows the divergence. Single-token candidates pass a prefix-expansion guard so
"rare" stays rare on prefix/stemming engines. Each query also has a filtered
variant targeting the `benchmark_group` value it most co-occurs with. Facet
dimensions are `benchmark_group` (8 values), `kind` (4), and `topic` (12),
assigned deterministically.

### The adapter contract

Every adapter returns, for every search: `{ count, countExact, checksum, titles,
facets }` — `count` is the engine's own true total (never page-capped) and
`facets` maps every requested dimension to `{value: count}` over the whole match
set.

- **AND semantics everywhere.** Lunr builds a required (`+`) clause per token;
  Dredge, Pagefind, and FlexSearch AND natively. Orama's `threshold: 0` does
  **not** enforce AND in the pinned version (prefix expansion lets one token
  satisfy the multi-token gate), so the Orama adapter enforces AND by
  intersecting per-token result sets in JavaScript.
- **Missing capabilities are implemented in adapter JS**, never skipped.
  FlexSearch, Lunr, and Orama enumerate the whole match set and tally facets in
  JavaScript. FlexSearch's active filter is applied in JavaScript because its
  native `tag` search verifiably drops matches (a 400-doc/50-expected probe
  returned 25), so its native filtered counts would be wrong.
- **Disjunctive (skip-self) counts** under an active filter, per engine: Dredge
  natively in one round trip; FlexSearch, Lunr, and Orama as a second tally over
  the already-enumerated unfiltered set; Pagefind from `result.totalFilters`
  (empirically verified to equal the unfiltered search's counts).

### Reports & correctness

Each report splits per-site metrics under a **"Measured on the build machine"**
banner and a **"Measured in the browser"** banner, and leads (HTML) with a
cross-corpus **scaling** section — engines as rows, corpora as columns by page
count — for index size, cold init, rich-query p95, and warm memory. The rich
query (exact total + all facet counts) is the headline latency table; the plain
query (no facet counts) is labeled diagnostic. The HTML report is a
self-contained file with best-in-column highlighting, an accented Dredge row,
sticky navigation, and a non-default charts toggle.

Ranking provenance is never inferred from latency. Every engine label in both
reports carries its keyword ranking model, and every query-bearing latency table
or chart repeats a local callout because that work contributes directly to the
measurement. Explicit alphabetical-sort and no-keyword browse tables instead say
that native relevance ranking is replaced or unused. The models in this harness
are:

| Engine | Keyword ranking model | BM25-only view |
| --- | --- | :---: |
| Dredge | SQLite FTS5 BM25 with title weighting | eligible |
| Pagefind | custom term-frequency, weighted-count, page-length, saturation, and term-similarity relevance | not eligible |
| Orama | BM25 summed across per-token searches used to enforce AND, with a title boost | eligible |
| FlexSearch | positional scoring slots (default resolution 9), not BM25 term-frequency/IDF scoring | not eligible |
| Lunr | BM25 with a title boost | eligible |

Raw tables retain every engine and every measured value. Separate BM25-only rich
query tables compare Dredge, Orama, and Lunr and apply best-in-column highlighting
only within that capability class. Exclusion from that view is not a correctness
failure, and no synthetic latency penalty is added.

The correctness section checks each engine **against itself** (cross-engine
totals differ by design): Counted (every total exact), Sorted-browse,
Sortable-keyword, Facet integrity (buckets sum to the total, unfiltered),
Disjunctive (skip-self counts verified numerically), and Filter consistency (a
filtered total equals that value's bucket in the engine's own unfiltered facet
counts — the check that catches a native filter silently dropping matches). The
shared evaluator (`scripts/correctness.mjs`) backs both renderers and the gate,
so they can never disagree.

## Interpretation limits

This is a static-site product benchmark, not a claim that the engines implement
identical retrieval models.

- **Relevance quality is not measured or compared.** The reports disclose each
  model beside the measurements and provide a BM25-only view, but neither raw
  speed nor BM25 eligibility establishes result quality. FlexSearch's positional
  ordering in particular is not BM25, which is part of why some operations are
  cheap.
- **Warm samples of a repeated identical config partly measure Dredge's session
  cache.** Dredge memoizes within a session what cannot change (the database is
  immutable, content-hash named): the FTS match set, the count and facet
  aggregates, and whole responses. So repeated identical warm samples — the same
  query, the same pagination offset — legitimately
  hit that cache, and the warm p95 reflects it. This is deliberate: it is real
  product behaviour (users do paginate and re-run the search they just ran),
  available to every engine in the harness — the others simply do not implement
  it — not skipped work. Every cached value is still verified: the correctness
  checks re-derive each total, facet bucket, and disjunctive count, so a cache
  that drifted from the engine would fail the gate, not post a fast number.
- Match sets legitimately differ (stemming, prefix expansion, tokenization), so
  two engines can return different totals for the same query — hence every
  correctness check is engine-against-itself.
- Latency is measured on localhost, so it is compute-bound; the cold/warm bytes
  columns are the network-cost proxy under the shared production-like HTTP
  compression policy described above.
- Orama's default store includes indexed document bodies (inherent to the
  engine; it inflates Orama's artifact and memory).
- Lunr stores no result documents, so its artifact includes a separate title/URL
  map.
- The large and extra-large corpora may exceed an engine's practical memory
  limit; a failed build is recorded and the remaining engines continue.
  JavaScript builders receive a 16 GiB V8 heap ceiling — a harness ceiling, not a
  minimum system requirement.
