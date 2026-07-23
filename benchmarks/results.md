# Static search benchmark

Generated: 2026-07-22T19:23:57.754Z

| Site | Pages | Engine | Build s | Peak RSS MiB | Raw MiB | Brotli q5 MiB | Cold init ms | Warm init ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 100 | dredge | 0.29 | 39.80 | 2.31 | 0.98 | 214.49 | 138.28 |
| small | 100 | pagefind | 0.59 | 101.02 | 0.78 | 0.40 | 12.31 | 11.62 |
| small | 100 | orama | 0.23 | 91.30 | 1.09 | 0.16 | 55.46 | 51.29 |
| small | 100 | flexsearch | 0.26 | 99.26 | 1.31 | 0.08 | 52.00 | 43.88 |
| small | 100 | lunr | 0.24 | 89.66 | 0.46 | 0.07 | 47.25 | 32.98 |

## small query latency (warm p95 ms)

| Engine | rare | selective | moderate | broad |
| --- | ---: | ---: | ---: | ---: |
| dredge | 6.20 | 6.62 | 8.73 | 6.35 |
| pagefind | 2.37 | 1.85 | 1.22 | 2.89 |
| orama | 0.41 | 0.07 | 0.05 | 0.05 |
| flexsearch | 0.06 | 0.01 | 0.01 | 0.02 |
| lunr | 0.11 | 0.07 | 0.03 | 0.11 |

## small query latency with active filter (warm p95 ms)

| Engine | rare | selective | moderate | broad |
| --- | ---: | ---: | ---: | ---: |
| dredge | 7.25 | 5.05 | 7.08 | 5.95 |
| pagefind | 1.57 | 0.83 | 0.89 | 1.36 |
| orama | 0.08 | 0.02 | 0.02 | 0.04 |
| flexsearch | 0.02 | 0.01 | 0.01 | 0.01 |
| lunr | 0.17 | 0.11 | 0.21 | 0.14 |