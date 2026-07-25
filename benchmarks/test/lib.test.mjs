import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseOptions,
  percentile,
  selectedReportSites,
  selectedSites,
} from "../scripts/lib.mjs";

test("parses a scoped benchmark", () => {
  assert.deepEqual(parseOptions(["--site", "small", "--engines", "dredge,orama", "--iterations", "5"]), {
    site: "small",
    engines: ["dredge", "orama"],
    iterations: 5,
    sampleBudgetMs: 1500,
    limit: undefined,
    tabs: 4,
    operationTimeoutSeconds: 60,
    timeoutMinutes: 30,
    skipPrepare: false,
  });
});

test("parses --skip-prepare as a boolean flag", () => {
  assert.equal(parseOptions([]).skipPrepare, false);
  assert.equal(parseOptions(["--skip-prepare"]).skipPrepare, true);
});

test("parses a custom sample budget", () => {
  assert.equal(parseOptions(["--sample-budget-ms", "800"]).sampleBudgetMs, 800);
  assert.throws(() => parseOptions(["--sample-budget-ms", "0"]), /positive number/);
});

test("parses a custom browser page timeout", () => {
  assert.equal(parseOptions(["--timeout-minutes", "90"]).timeoutMinutes, 90);
  assert.throws(() => parseOptions(["--timeout-minutes", "0"]), /positive number/);
});

test("parses a custom browser operation timeout", () => {
  assert.equal(parseOptions(["--operation-timeout-seconds", "15"]).operationTimeoutSeconds, 15);
  assert.throws(
    () => parseOptions(["--operation-timeout-seconds", "0"]),
    /positive number/,
  );
});

test("selects all sites in size order", () => {
  assert.deepEqual(selectedSites("all"), ["small", "medium", "large", "xlarge"]);
});

test("reports prepared sites for all but keeps explicit site selection strict", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dredge-report-"));
  try {
    for (const site of ["small", "large"]) {
      await mkdir(resolve(root, site), { recursive: true });
      await writeFile(resolve(root, site, "workload.json"), "{}\n");
    }

    assert.deepEqual(await selectedReportSites("all", root), ["small", "large"]);
    assert.deepEqual(await selectedReportSites("xlarge", root), ["xlarge"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses nearest-rank percentiles", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});
