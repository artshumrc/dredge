import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "..");
const fixtureRoot = resolve(runtimeRoot, "test-fixtures");
const configPath = resolve(fixtureRoot, "dredge.config.json");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

await rm(fixtureRoot, { recursive: true, force: true });
run("uv", ["run", "dredge", "synth", fixtureRoot, "--count", "50", "--seed", "7"]);
run("uv", [
  "run",
  "dredge",
  "compile",
  "--config",
  configPath,
  "--brotli-quality",
  "1",
]);

console.log(`fixture: ${fixtureRoot}`);
