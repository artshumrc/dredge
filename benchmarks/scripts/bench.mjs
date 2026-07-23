import { spawn } from "node:child_process";

import { benchmarkRoot, parseOptions } from "./lib.mjs";

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

const prepareArgs = ["run", "--project", "..", "python", "scripts/prepare.py", "--site", options.site];
if (options.limit !== undefined) prepareArgs.push("--limit", String(options.limit));
const common = ["--site", options.site, "--engines", options.engines.join(",")];
await run("uv", prepareArgs);
await run(process.execPath, ["scripts/build.mjs", ...common]);
await run(process.execPath, [
  "scripts/run-browser.mjs",
  ...common,
  "--iterations",
  String(options.iterations),
  "--timeout-minutes",
  String(options.timeoutMinutes),
  "--operation-timeout-seconds",
  String(options.operationTimeoutSeconds),
]);
await run(process.execPath, ["scripts/report.mjs", ...common]);
