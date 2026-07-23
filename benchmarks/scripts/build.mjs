import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  benchmarkRoot,
  distRoot,
  parseOptions,
  readJson,
  repoRoot,
  selectedSites,
} from "./lib.mjs";

const options = parseOptions(process.argv.slice(2));

async function command(program, args, cwd) {
  const timeFile = resolve(
    tmpdir(),
    `dredge-benchmark-time-${process.pid}-${Math.random().toString(16).slice(2)}.txt`,
  );
  const hasGnuTime = process.platform === "linux";
  const executable = hasGnuTime ? "/usr/bin/time" : program;
  const commandArgs = hasGnuTime
    ? ["-f", "%e\t%M", "-o", timeFile, program, ...args]
    : args;
  const started = performance.now();
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(executable, commandArgs, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  const result = { exit_code: exitCode, wall_ms: performance.now() - started };
  if (hasGnuTime) {
    const { readFile } = await import("node:fs/promises");
    const [seconds, maxRssKb] = (await readFile(timeFile, "utf8")).trim().split("\t");
    result.wall_ms = Number(seconds) * 1000;
    result.max_rss_bytes = Number(maxRssKb) * 1024;
    await rm(timeFile, { force: true });
  }
  return result;
}

async function buildRuntime() {
  if (!options.engines.includes("dredge")) return undefined;
  const output = resolve(repoRoot, "runtime", "dist-prod", "search");
  const result = await command("pnpm", ["build:lib"], resolve(repoRoot, "runtime"));
  if (result.exit_code !== 0) throw new Error("Dredge runtime build failed");
  return output;
}

const runtime = await buildRuntime();
for (const site of selectedSites(options.site)) {
  const siteRoot = resolve(distRoot, site);
  const workload = await readJson(resolve(siteRoot, "workload.json")).catch(() => undefined);
  if (!workload) throw new Error(`prepare ${site} before building`);
  const results = resolve(siteRoot, "results");
  await mkdir(results, { recursive: true });

  for (const engine of options.engines) {
    const artifact = resolve(siteRoot, "artifacts", engine);
    await rm(resolve(results, `${engine}-browser.json`), { force: true });
    await mkdir(artifact, { recursive: true });
    console.log(`\nBuilding ${engine} for ${site} (${workload.page_count.toLocaleString()} pages)`);
    let result;
    if (engine === "dredge") {
      await rm(artifact, { recursive: true, force: true });
      await mkdir(artifact, { recursive: true });
      result = await command(
        "uv",
        [
          "run",
          "dredge",
          "compile",
          "--config",
          resolve(siteRoot, "dredge.config.json"),
          "--metrics-json",
          resolve(results, "dredge-compiler.json"),
          "--jobs",
          "1",
          "--brotli-quality",
          "5",
        ],
        repoRoot,
      );
      if (result.exit_code === 0 && runtime) await cp(runtime, artifact, { recursive: true });
    } else if (engine === "pagefind") {
      await rm(artifact, { recursive: true, force: true });
      await mkdir(artifact, { recursive: true });
      result = await command(
        "pnpm",
        ["exec", "pagefind", "--site", resolve(siteRoot, "site"), "--output-path", artifact],
        benchmarkRoot,
      );
    } else {
      result = await command(
        process.execPath,
        ["--max-old-space-size=16384", "scripts/build-js-engine.mjs", engine, site],
        benchmarkRoot,
      );
    }
    result.engine = engine;
    result.site = site;
    result.page_count = workload.page_count;
    await writeFile(resolve(results, `${engine}-build.json`), JSON.stringify(result, null, 2) + "\n");
    if (result.exit_code !== 0) console.error(`${engine}/${site} failed; continuing`);
  }
}
