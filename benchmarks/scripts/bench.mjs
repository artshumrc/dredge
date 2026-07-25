import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { benchmarkRoot, distRoot, parseOptions, selectedSites } from "./lib.mjs";

const argv = process.argv.slice(2);
const options = parseOptions(argv);

async function run(program, args) {
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(program, args, { cwd: benchmarkRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (value) => resolveExit(value ?? 1));
  });
  if (code !== 0) throw new Error(`${program} ${args.join(" ")} failed with exit code ${code}`);
}

const common = ["--site", options.site, "--engines", options.engines.join(",")];

if (options.skipPrepare) {
  // Reuse existing prepared corpora/workloads (so iterating on measurement code
  // does not re-extract 159k HTML pages). This is a HARD error — never a silent
  // re-prepare — if any selected site is missing its prepared artifacts.
  for (const site of selectedSites(options.site)) {
    for (const file of ["corpus.ndjson", "workload.json"]) {
      const path = resolve(distRoot, site, file);
      try {
        await access(path);
      } catch {
        throw new Error(
          `--skip-prepare: missing ${path}. Run without --skip-prepare to prepare ${site} first.`,
        );
      }
    }
  }
  console.log("Skipping corpus preparation (--skip-prepare); reusing prepared corpora.");
} else {
  const prepareArgs = ["run", "--project", "..", "python", "scripts/prepare.py", "--site", options.site];
  if (options.limit !== undefined) prepareArgs.push("--limit", String(options.limit));
  await run("uv", prepareArgs);
}
await run(process.execPath, ["scripts/build.mjs", ...common]);
await run(process.execPath, [
  "scripts/run-browser.mjs",
  ...common,
  "--iterations",
  String(options.iterations),
  "--sample-budget-ms",
  String(options.sampleBudgetMs),
  "--timeout-minutes",
  String(options.timeoutMinutes),
  "--operation-timeout-seconds",
  String(options.operationTimeoutSeconds),
]);
await run(process.execPath, ["scripts/report.mjs", ...common]);
