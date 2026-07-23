import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { createBrotliCompress, constants } from "node:zlib";

import {
  benchmarkRoot,
  distRoot,
  parseOptions,
  readJson,
  selectedReportSites,
  selectedSites,
  siteLabel,
  walkFiles,
} from "./lib.mjs";
import { renderHtml } from "./report-html.mjs";

const options = parseOptions(process.argv.slice(2));

async function compressedSize(path) {
  return new Promise((resolveSize, reject) => {
    let bytes = 0;
    const compressor = createBrotliCompress({
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    createReadStream(path)
      .on("error", reject)
      .pipe(compressor)
      .on("data", (chunk) => {
        bytes += chunk.length;
      })
      .on("error", reject)
      .on("end", () => resolveSize(bytes));
  });
}

async function artifactMetrics(path, engine) {
  const files = (await walkFiles(path)).filter(
    ({ path: file }) =>
      !file.endsWith(".time.txt") && !(engine === "dredge" && file.endsWith(".db")),
  );
  let nextFile = 0;
  const subtotals = await Promise.all(
    Array.from({ length: Math.min(16, files.length) }, async () => {
      let subtotal = 0;
      while (nextFile < files.length) {
        const file = files[nextFile++];
        subtotal += await compressedSize(file.path);
      }
      return subtotal;
    }),
  );
  const brotliBytes = subtotals.reduce((total, subtotal) => total + subtotal, 0);
  return {
    files: files.length,
    raw_bytes: files.reduce((total, file) => total + file.bytes, 0),
    brotli_q5_bytes: brotliBytes,
  };
}

const packageJson = await readJson(resolve(benchmarkRoot, "package.json"));
const report = {
  generated_at: new Date().toISOString(),
  environment: {
    platform: platform(),
    release: release(),
    architecture: process.arch,
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    total_memory_bytes: totalmem(),
    free_memory_bytes_at_report: freemem(),
    node: process.version,
    engine_versions: packageJson.dependencies,
  },
  sites: {},
};
const reportSites = await selectedReportSites(options.site);
if (options.site === "all") {
  const skippedSites = selectedSites("all").filter((site) => !reportSites.includes(site));
  if (skippedSites.length > 0) {
    console.warn(`Skipping unprepared sites: ${skippedSites.join(", ")}`);
  }
}
for (const site of reportSites) {
  const siteRoot = resolve(distRoot, site);
  const workload = await readJson(resolve(siteRoot, "workload.json"));
  const siteReport = {
    label: siteLabel(site),
    page_count: workload.page_count,
    queries: workload.queries,
    filtered_queries: workload.filtered_queries,
    facets: workload.facets ?? [],
    engines: {},
  };
  for (const engine of options.engines) {
    try {
      const build = await readJson(resolve(siteRoot, "results", `${engine}-build.json`));
      const artifact = build.exit_code === 0
        ? await artifactMetrics(resolve(siteRoot, "artifacts", engine), engine)
        : undefined;
      const browser = await readJson(resolve(siteRoot, "results", `${engine}-browser.json`)).catch(
        () => undefined,
      );
      siteReport.engines[engine] = { build, artifact, browser };
    } catch (error) {
      siteReport.engines[engine] = { error: error.message };
    }
  }
  report.sites[site] = siteReport;
}

await mkdir(distRoot, { recursive: true });
await writeFile(resolve(distRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");

// --- Markdown rendering ------------------------------------------------------

const mib = (bytes) => (bytes === undefined || bytes === null ? "-" : (bytes / 1024 / 1024).toFixed(2));
const number = (value, divisor = 1) =>
  value === undefined || value === null ? "-" : (value / divisor).toFixed(2);

const warmOf = (item) => item?.browser?.warm;
const coldOf = (item) => item?.browser?.cold;

// Warm measurements matching a (facet_mode, filtered, page_size) slice, keyed by label.
function sliceByLabel(item, { mode, filtered, pageSize = 10 }) {
  const measurements = warmOf(item)?.measurements ?? [];
  const out = {};
  for (const m of measurements) {
    if (m.facet_mode === mode && m.filtered === filtered && m.page_size === pageSize) {
      out[m.label] = m;
    }
  }
  return out;
}

function facetInventory(siteReport) {
  const facets = siteReport.facets ?? [];
  if (!facets.length) return "";
  return (
    `${facets.length} facet ${facets.length === 1 ? "dimension" : "dimensions"}: ` +
    facets.map((facet) => `${facet.name} (${facet.values} values)`).join(", ")
  );
}

const lines = [
  "# Static search benchmark",
  "",
  `Generated: ${report.generated_at}`,
  "",
  "Sizes: `Raw`/`Brotli` are the artifact on disk; `Cold MiB` is bytes actually",
  "transferred over the wire on a first visit; `Warm mem` is total tab memory",
  "(main thread + worker + WASM) after querying, via measureUserAgentSpecificMemory.",
  "",
  "| Site | Pages | Engine | Build s | Build RSS MiB | Raw MiB | Brotli MiB | Cold MiB | Warm MiB | Cold init ms | Warm init ms | Warm mem MiB |",
  "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
];
for (const [site, siteReport] of Object.entries(report.sites)) {
  for (const engine of options.engines) {
    const item = siteReport.engines[engine];
    const cold = coldOf(item);
    const warm = warmOf(item);
    lines.push(
      `| ${siteReport.label} | ${siteReport.page_count} | ${engine} | ${number(item?.build?.wall_ms, 1000)} | ` +
        `${mib(item?.build?.max_rss_bytes)} | ${mib(item?.artifact?.raw_bytes)} | ${mib(item?.artifact?.brotli_q5_bytes)} | ` +
        `${mib(cold?.network_bytes)} | ${mib(warm?.network_bytes)} | ` +
        `${number(cold?.init_ms)} | ${number(warm?.init_ms)} | ${mib(warm?.memory?.bytes)} |`,
    );
  }
}

// Latency tables keyed by workload label.
function appendLatencyTable(site, title, labels, item2slice) {
  lines.push("", `## ${report.sites[site].label} ${title} (warm p95 ms)`, "");
  lines.push("| Engine | " + labels.join(" | ") + " |");
  lines.push("| --- | " + labels.map(() => "---:").join(" | ") + " |");
  for (const engine of options.engines) {
    const byLabel = item2slice(report.sites[site].engines[engine]);
    lines.push(
      `| ${engine} | ${labels.map((label) => number(byLabel[label]?.p95_ms)).join(" | ")} |`,
    );
  }
}

// A single-scenario table with a "no facets" and "all facets" p95 column,
// used for the no-keyword browse case.
function appendScenarioTable(site, title, scenario) {
  lines.push("", `## ${report.sites[site].label} ${title} (warm p95 ms)`, "");
  lines.push("| Engine | no facets | all facets |");
  lines.push("| --- | ---: | ---: |");
  for (const engine of options.engines) {
    const measurements = warmOf(report.sites[site].engines[engine])?.measurements ?? [];
    const at = (mode) =>
      measurements.find((row) => row.scenario === scenario && row.facet_mode === mode)?.p95_ms;
    lines.push(`| ${engine} | ${number(at("none"))} | ${number(at("all"))} |`);
  }
}

for (const [site, siteReport] of Object.entries(report.sites)) {
  const labels = siteReport.queries.map((query) => query.label);
  const filteredLabels = siteReport.filtered_queries.map((query) => query.label);
  appendLatencyTable(site, "query latency", labels, (item) =>
    sliceByLabel(item, { mode: "none", filtered: false }),
  );
  appendLatencyTable(site, "query latency with active filter", filteredLabels, (item) =>
    sliceByLabel(item, { mode: "none", filtered: true }),
  );
  // Computing counts for all facet dimensions forces whole-match-set work.
  appendLatencyTable(site, "facet-count latency (all facets)", labels, (item) =>
    sliceByLabel(item, { mode: "all", filtered: false }),
  );

  // How facet cost scales with the number of dimensions counted, on the broad
  // query (the widest match set).
  const inventory = facetInventory(siteReport);
  lines.push("", `## ${siteReport.label} facet scaling — broad query (warm p95 ms)`, "");
  if (inventory) lines.push(inventory, "");
  lines.push("| Engine | none | one facet | all facets |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const engine of options.engines) {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    const at = (mode) =>
      measurements.find(
        (row) =>
          row.label === "broad" && row.facet_mode === mode && !row.filtered && row.page_size === 10,
      )?.p95_ms;
    lines.push(
      `| ${engine} | ${number(at("none"))} | ${number(at("one"))} | ${number(at("all"))} |`,
    );
  }

  // Gap 1: pagination sweep on the broad query, both without and with facet
  // counting, so page-size cost and facet cost can be read together.
  const pageSizes = [10, 50, 100, 200];
  for (const mode of ["none", "all"]) {
    const facetLabel = mode === "none" ? "no facets" : "all facets";
    lines.push("", `## ${siteReport.label} pagination latency — broad query, ${facetLabel} (warm p95 ms)`, "");
    lines.push("| Engine | " + pageSizes.map((size) => `n=${size}`).join(" | ") + " |");
    lines.push("| --- | " + pageSizes.map(() => "---:").join(" | ") + " |");
    for (const engine of options.engines) {
      const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
      const cells = pageSizes.map((size) => {
        const m = measurements.find(
          (row) =>
            row.scenario === "pagination" && row.facet_mode === mode && row.page_size === size,
        );
        return number(m?.p95_ms);
      });
      lines.push(`| ${engine} | ${cells.join(" | ")} |`);
    }
  }

  // Gap 2: deep pagination — same page size at increasing offsets on the broad
  // query. The measured offsets are shared across engines, so read them once.
  const deepRows = warmOf(siteReport.engines[options.engines[0]])?.measurements ?? [];
  const offsets = [...new Set(deepRows.filter((r) => r.scenario === "deep").map((r) => r.offset))].sort(
    (a, b) => a - b,
  );
  if (offsets.length) {
    lines.push("", `## ${siteReport.label} deep pagination — broad query, all facets (warm p95 ms)`, "");
    lines.push("| Engine | " + offsets.map((o) => `offset ${o}`).join(" | ") + " |");
    lines.push("| --- | " + offsets.map(() => "---:").join(" | ") + " |");
    for (const engine of options.engines) {
      const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
      const cells = offsets.map((offset) => {
        const m = measurements.find((row) => row.scenario === "deep" && row.offset === offset);
        return number(m?.p95_ms);
      });
      lines.push(`| ${engine} | ${cells.join(" | ")} |`);
    }
  }

  // No-keyword browse (alphabetical) and facet counts under an active filter.
  appendScenarioTable(site, "browse latency — no keyword, alphabetical", "browse");
  appendLatencyTable(site, "facet-count latency with active filter (all facets)", filteredLabels, (item) =>
    sliceByLabel(item, { mode: "all", filtered: true }),
  );
}

// --- Result-count & facet correctness ---------------------------------------

lines.push("", "## Result correctness", "");
lines.push(
  "Counted = every run returns the true total match count, never a page-capped one",
  "(no lazy top-k). Sorted = the no-keyword browse page comes back in alphabetical",
  "title order. Facet integrity = each facet dimension's own per-value counts sum to",
  "the engine's own total on unfiltered facet queries. Disjunctive = when a filter is",
  "active on a facet, the engine still counts that facet's *other* values (so a user",
  "can switch values within it); ✗ here means conjunctive counts (only the applied",
  "value survives). Cross-engine totals differ by design — stemming rules vary — so",
  "these check each engine against itself.",
  "",
);
lines.push("| Site | Engine | Counted | Sorted | Facet integrity | Disjunctive |");
lines.push("| --- | --- | :---: | :---: | :---: | :---: |");
for (const [site, siteReport] of Object.entries(report.sites)) {
  for (const engine of options.engines) {
    const measurements = warmOf(siteReport.engines[engine])?.measurements ?? [];
    const counted = measurements.length ? measurements.every((m) => m.count_exact !== false) : null;

    // Browse pages must come back alphabetically by title.
    const browseRows = measurements.filter((m) => m.scenario === "browse" && m.first_titles);
    const sorted = browseRows.length
      ? browseRows.every((m) =>
          (m.first_titles ?? []).every(
            (title, i, all) =>
              i === 0 || String(all[i - 1]).toLowerCase() <= String(title).toLowerCase(),
          ),
        )
      : null;

    // Each facet dimension partitions the unfiltered match set, so its buckets
    // must sum to the engine's own total.
    const facetRows = measurements.filter(
      (m) => m.facet_mode && m.facet_mode !== "none" && !m.filtered,
    );
    let integrity = null;
    if (facetRows.length) {
      integrity = facetRows.every((m) => {
        const fields = Object.values(m.facet_counts ?? {});
        if (!fields.length) return false;
        return fields.every((buckets) => {
          const sum = Object.values(buckets ?? {}).reduce((total, n) => total + Number(n), 0);
          return Object.keys(buckets ?? {}).length > 0 && sum === m.result_count;
        });
      });
    }

    // When a filter is active, does the actively-filtered facet still report its
    // other values? More than one bucket on that field means disjunctive counts.
    const filteredAll = measurements.filter(
      (m) => m.scenario === "filtered" && m.facet_mode === "all" && m.filter,
    );
    const disjunctive = filteredAll.length
      ? filteredAll.some((m) => Object.keys(m.facet_counts?.[m.filter.field] ?? {}).length > 1)
      : null;

    const mark = (value) => (value === null ? "-" : value ? "✓" : "✗");
    lines.push(
      `| ${siteReport.label} | ${engine} | ${mark(counted)} | ${mark(sorted)} | ${mark(integrity)} | ${mark(disjunctive)} |`,
    );
  }
}

// --- Multi-tab ---------------------------------------------------------------

lines.push("", "## Multi-tab memory", "");
lines.push(
  "N tabs open on the same origin. `All-tabs MiB` sums each tab's own memory.",
  "`vs N×` is that total divided by (tabs × leader memory), i.e. against N full",
  "independent instances: ~1.0 means every tab pays full price; well under 1.0 means",
  "tabs share one index. `Leader`/`Follower` p95 is the moderate-query latency for the",
  "DB-owning tab vs a relaying tab (only Dredge coordinates; others show near-equal",
  "tabs).",
  "",
);
lines.push(
  "| Site | Engine | Tabs | Single MiB | All-tabs MiB | Leader MiB | Follower MiB | vs N× | Leader p95 ms | Follower p95 ms |",
);
lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const [site, siteReport] of Object.entries(report.sites)) {
  for (const engine of options.engines) {
    const item = siteReport.engines[engine];
    const multitab = item?.browser?.multitab;
    const single = warmOf(item)?.memory?.bytes;
    if (!multitab?.pages?.length) {
      lines.push(`| ${siteReport.label} | ${engine} | - | ${mib(single)} | - | - | - | - | - | - |`);
      continue;
    }
    const pages = multitab.pages;
    const mems = pages.map((page) => page.memory?.bytes).filter((v) => v != null);
    const total = mems.reduce((t, v) => t + v, 0);
    const leaderMem = mems.length ? Math.max(...mems) : null;
    const followerMem = mems.length ? Math.min(...mems) : null;
    // The tab with the most memory owns the database (leader); the least, a
    // follower. Light-mode pages carry exactly one measurement.
    const p95Of = (page) => page?.measurements?.[0]?.p95_ms ?? null;
    const byMem = [...pages].sort(
      (a, b) => (b.memory?.bytes ?? 0) - (a.memory?.bytes ?? 0),
    );
    const leaderP95 = p95Of(byMem[0]);
    const followerP95 = p95Of(byMem[byMem.length - 1]);
    // Compare the aggregate to `tabs × one full instance`. The leader (the tab
    // holding the whole index) is that full instance, so this isolates sharing
    // from the single-tab page's heavier (full-matrix) workload.
    const ratio =
      leaderMem && mems.length ? (total / (multitab.tabs * leaderMem)).toFixed(2) : "-";
    lines.push(
      `| ${siteReport.label} | ${engine} | ${multitab.tabs} | ${mib(single)} | ${mib(total)} | ` +
        `${mib(leaderMem)} | ${mib(followerMem)} | ${ratio} | ` +
        `${number(leaderP95)} | ${number(followerP95)} |`,
    );
  }
}

lines.push("");
await writeFile(resolve(distRoot, "report.md"), lines.join("\n"));

await writeFile(resolve(distRoot, "report.html"), renderHtml(report, options.engines));

console.log(lines.join("\n"));
console.log(`\nWrote ${resolve(distRoot, "report.html")}`);
