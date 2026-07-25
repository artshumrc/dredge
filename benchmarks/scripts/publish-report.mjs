import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { benchmarkRoot, distRoot } from "./lib.mjs";

const reportRoot = resolve(benchmarkRoot, "report");
const source = resolve(distRoot, "report.html");
const destination = resolve(reportRoot, "index.html");

await mkdir(reportRoot, { recursive: true });
await copyFile(source, destination);

console.log(`Copied ${source} -> ${destination}`);
console.log("Commit benchmarks/report/index.html and push to publish it to GitHub Pages.");
