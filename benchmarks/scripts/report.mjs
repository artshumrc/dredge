import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";

import {
  benchmarkRoot,
  distRoot,
  parseOptions,
  readJson,
  selectedReportSites,
  selectedSites,
  siteLabel,
} from "./lib.mjs";
import { artifactMetrics } from "./artifact-metrics.mjs";
import { renderHtml } from "./report-html.mjs";
import { renderMarkdown } from "./report-md.mjs";
import { evaluateCorrectness } from "./correctness.mjs";

const options = parseOptions(process.argv.slice(2));

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
      // Correctness is evaluated once, here, and stored verbatim in report.json.
      // Both renderers read this block; neither re-derives a check.
      const correctness = evaluateCorrectness(browser?.warm?.measurements, workload);
      siteReport.engines[engine] = { build, artifact, browser, correctness };
    } catch (error) {
      siteReport.engines[engine] = { error: error.message };
    }
  }
  report.sites[site] = siteReport;
}

await mkdir(distRoot, { recursive: true });
await writeFile(resolve(distRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");

// Both reports are generated from the same report object and the shared
// correctness block, so they present identical sections in identical order.
const markdown = renderMarkdown(report, options.engines);
await writeFile(resolve(distRoot, "report.md"), markdown);
await writeFile(resolve(distRoot, "report.html"), renderHtml(report, options.engines));

console.log(markdown);
console.log(`\nWrote ${resolve(distRoot, "report.html")}`);
