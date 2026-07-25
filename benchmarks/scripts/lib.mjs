import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(benchmarkRoot, "..");
export const distRoot = resolve(benchmarkRoot, "dist");
export const engines = ["dredge", "pagefind", "orama", "flexsearch", "lunr"];
export const sites = ["small", "medium", "large", "xlarge"];

// Human-readable corpus labels for report output. Keys not listed fall back to
// the raw site key.
const SITE_LABELS = { xlarge: "extra large" };
export function siteLabel(site) {
  return SITE_LABELS[site] ?? site;
}

export function parseOptions(argv) {
  const options = {
    site: "all",
    engines: [...engines],
    iterations: 20,
    sampleBudgetMs: 1500,
    limit: undefined,
    tabs: 4,
    operationTimeoutSeconds: 60,
    timeoutMinutes: 30,
    skipPrepare: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--site") options.site = argv[++index];
    else if (argument === "--engines") options.engines = argv[++index].split(",");
    else if (argument === "--iterations") options.iterations = Number(argv[++index]);
    else if (argument === "--sample-budget-ms") options.sampleBudgetMs = Number(argv[++index]);
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument === "--tabs") options.tabs = Number(argv[++index]);
    else if (argument === "--operation-timeout-seconds") {
      options.operationTimeoutSeconds = Number(argv[++index]);
    }
    else if (argument === "--timeout-minutes") options.timeoutMinutes = Number(argv[++index]);
    else if (argument === "--skip-prepare") options.skipPrepare = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.site !== "all" && !sites.includes(options.site)) {
    throw new Error(`--site must be one of all, ${sites.join(", ")}`);
  }
  for (const engine of options.engines) {
    if (!engines.includes(engine)) throw new Error(`unknown engine: ${engine}`);
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!Number.isFinite(options.sampleBudgetMs) || options.sampleBudgetMs <= 0) {
    throw new Error("--sample-budget-ms must be a positive number");
  }
  if (!Number.isInteger(options.tabs) || options.tabs < 2) {
    throw new Error("--tabs must be an integer >= 2");
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes must be a positive number");
  }
  if (!Number.isFinite(options.operationTimeoutSeconds) || options.operationTimeoutSeconds <= 0) {
    throw new Error("--operation-timeout-seconds must be a positive number");
  }
  return options;
}

export function selectedSites(site) {
  return site === "all" ? sites : [site];
}

export async function selectedReportSites(site, root = distRoot) {
  if (site !== "all") return [site];

  const prepared = [];
  for (const candidate of sites) {
    try {
      await access(resolve(root, candidate, "workload.json"));
      prepared.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return prepared;
}

export async function* readCorpus(site) {
  const input = createReadStream(resolve(distRoot, site, "corpus.ndjson"), "utf8");
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) yield JSON.parse(line);
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

export async function walkFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      for (const file of await walkFiles(path)) output.push(file);
    }
    else if (entry.isFile()) output.push({ path, bytes: (await stat(path)).size });
  }
  return output;
}
