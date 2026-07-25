// The benchmark's self-test gate. Reads the machine-readable report and exits
// non-zero unless every engine passes every applicable correctness check and the
// workload has the expected shape. Prints one line per failure so CI (and a
// human) can see exactly which site/engine/check regressed.
//
// This is the seam that catches FlexSearch-class defects mechanically: the
// Filter-consistency check flags a native filter that silently drops matches,
// with no browser re-run required.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CHECKS, isErrorRow } from "./correctness.mjs";
import { distRoot, sites as ALL_SITES } from "./lib.mjs";

// The warm matrix must exercise every scenario (each produces measurements or,
// if it failed, explicit error rows — so the scenario tag is present either way).
const EXPECTED_SCENARIOS = [
  "keyword",
  "scaling",
  "filtered",
  "pagination",
  "deep",
  "sorted",
  "browse",
];

function parse(argv) {
  const options = { site: "all", reportPath: resolve(distRoot, "report.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--site") options.site = argv[++index];
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.site !== "all" && !ALL_SITES.includes(options.site)) {
    throw new Error(`--site must be one of all, ${ALL_SITES.join(", ")}`);
  }
  return options;
}

// Expected workload shape after the phrase-workload redesign (ticket 04): two
// single-token band endpoints and four mined phrase queries, each with a
// filtered variant. Tolerated (with a clear failure) on pre-redesign data.
const EXPECTED_LABELS = [
  "rare",
  "broad",
  "phrase-selective",
  "phrase-moderate",
  "phrase-broad",
  "phrase3",
];

function checkWorkload(site, siteReport, failures) {
  const queries = siteReport.queries ?? [];
  const filtered = siteReport.filtered_queries ?? [];
  const tokens = queries.filter((q) => q.type === "token").length;
  const phrases = queries.filter((q) => q.type === "phrase").length;
  const labels = new Set(queries.map((q) => q.label));
  const missing = EXPECTED_LABELS.filter((label) => !labels.has(label));

  if (tokens !== 2 || phrases !== 4) {
    failures.push(
      `${site}/workload_shape: expected 2 token + 4 phrase queries, got ${tokens} token + ${phrases} phrase`,
    );
  }
  if (missing.length) {
    failures.push(`${site}/workload_shape: missing query labels ${missing.join(", ")}`);
  }
  if (filtered.length !== 6) {
    failures.push(
      `${site}/workload_shape: expected 6 filtered variants, got ${filtered.length}`,
    );
  }
}

function checkCorrectness(site, siteReport, failures) {
  const engines = Object.keys(siteReport.engines ?? {});
  if (!engines.length) {
    failures.push(`${site}: no engines in report`);
    return;
  }
  for (const engine of engines) {
    const correctness = siteReport.engines[engine]?.correctness;
    if (!correctness) {
      failures.push(`${site}/${engine}: no correctness block in report`);
      continue;
    }
    for (const [key] of CHECKS) {
      const value = correctness[key];
      // null/undefined = the scenario the check needs is absent; not a failure.
      if (value === false) failures.push(`${site}/${engine}/${key}`);
    }
  }
}

// Structural assertions on the warm matrix: every scenario present, and every
// measured (non-error) row carrying a sample count. Only applies to engines that
// produced browser measurements (a build/load failure is surfaced elsewhere).
function checkStructure(site, siteReport, failures) {
  for (const engine of Object.keys(siteReport.engines ?? {})) {
    const measurements = siteReport.engines[engine]?.browser?.warm?.measurements;
    if (!Array.isArray(measurements) || measurements.length === 0) continue;
    const scenarios = new Set(measurements.map((row) => row.scenario));
    const missing = EXPECTED_SCENARIOS.filter((scenario) => !scenarios.has(scenario));
    if (missing.length) {
      failures.push(`${site}/${engine}: missing warm scenarios ${missing.join(", ")}`);
    }
    const missingSampleCount = measurements.some(
      (row) => !isErrorRow(row) && !Number.isInteger(row.sample_count),
    );
    if (missingSampleCount) {
      failures.push(`${site}/${engine}: a measured warm row is missing sample_count`);
    }
  }
}

const options = parse(process.argv.slice(2));
let report;
try {
  report = JSON.parse(await readFile(options.reportPath, "utf8"));
} catch (error) {
  console.error(`Cannot read report at ${options.reportPath}: ${error.message}`);
  process.exit(2);
}

const reportSites = Object.keys(report.sites ?? {});
const targetSites = options.site === "all" ? reportSites : [options.site];
const failures = [];

// An empty report under --site all must not pass vacuously: a failed report
// generation would otherwise greenlight the gate with nothing checked.
if (options.site === "all" && reportSites.length === 0) {
  failures.push("report contains no sites (nothing to check)");
}

for (const site of targetSites) {
  const siteReport = report.sites?.[site];
  if (!siteReport) {
    failures.push(`${site}: not present in report`);
    continue;
  }
  checkWorkload(site, siteReport, failures);
  checkCorrectness(site, siteReport, failures);
  checkStructure(site, siteReport, failures);
}

if (failures.length) {
  console.error(`check-report: ${failures.length} failure(s) for site=${options.site}`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}

console.log(`check-report: all checks passed for site=${options.site} (${targetSites.join(", ")})`);
