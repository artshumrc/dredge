import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

import { benchmarkRoot, distRoot, parseOptions, selectedSites } from "./lib.mjs";

const options = parseOptions(process.argv.slice(2));
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".br": "application/octet-stream",
};

async function buildBrowser() {
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ["scripts/build-browser.mjs"], {
      cwd: benchmarkRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (value) => resolveExit(value ?? 1));
  });
  if (code !== 0) throw new Error("browser runner build failed");
}

// The server totals the bytes it sends. Counting here (rather than via a CDP
// Network domain bound to the page) is what makes the byte measurement correct:
// dredge downloads its database *inside the worker*, and page-scoped CDP misses
// worker traffic entirely. Every fetch — main thread or worker — hits this
// server, and the browser's HTTP cache means a warm repeat visit re-requests
// only what it must, which is exactly the transfer we want to measure.
function startServer() {
  const state = { bytesServed: 0 };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!relative || relative === "runner") relative = "runner/index.html";
      if (relative.endsWith("/")) relative += "index.html";
      const path = resolve(distRoot, relative);
      if (!path.startsWith(`${distRoot}${sep}`)) throw new Error("invalid path");
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("not a file");
      state.bytesServed += metadata.size;
      response.writeHead(200, {
        "content-type": mimeTypes[extname(path)] ?? "application/octet-stream",
        "content-length": metadata.size,
        "cache-control": "public, max-age=3600",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((resolveStarted) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStarted({ server, origin: `http://127.0.0.1:${address.port}`, state });
    });
  });
}

function runnerUrl(origin, engine, site, { cold, light, mem }) {
  const url = new URL("/runner/", origin);
  url.searchParams.set("engine", engine);
  url.searchParams.set("site", site);
  url.searchParams.set("cold", cold ? "1" : "0");
  url.searchParams.set("iterations", String(options.iterations));
  url.searchParams.set("operation_timeout_ms", String(options.operationTimeoutSeconds * 1_000));
  if (light) url.searchParams.set("light", "1");
  // The single-tab cold page skips the (slow) memory sample; warm + every
  // multi-tab page measure it.
  if (mem === false) url.searchParams.set("mem", "0");
  return url.href;
}

// Load the runner in one page, wait for it to finish, and return its result
// plus the bytes the server sent while it ran.
async function runPage(state, page, origin, engine, site, mode) {
  const before = state.bytesServed;
  await page.goto(runnerUrl(origin, engine, site, mode), { waitUntil: "load" });
  await page.waitForFunction(() => window.__benchmark?.done, undefined, {
    timeout: options.timeoutMinutes * 60_000,
  });
  const outcome = await page.evaluate(() => window.__benchmark);
  if (outcome.error) throw new Error(outcome.error);
  return { ...outcome.result, network_bytes: state.bytesServed - before };
}

// Single-tab run: a fresh context (empty OPFS + HTTP cache), cold page then warm
// page. Cold measures first-visit cost; warm measures a repeat visit.
async function runSingleTab(browser, origin, state, engine, site) {
  const context = await browser.newContext();
  try {
    const coldPage = await context.newPage();
    const cold = await runPage(state, coldPage, origin, engine, site, { cold: true, mem: false });
    await coldPage.close();
    const warmPage = await context.newPage();
    const warm = await runPage(state, warmPage, origin, engine, site, { cold: false, mem: true });
    await warmPage.close();
    return { cold, warm };
  } finally {
    await context.close();
  }
}

// Multi-tab run: N pages in ONE context (same origin → shared Web Locks +
// BroadcastChannel), all opened and driven concurrently so they coexist while
// each measures its own memory. For dredge, one tab wins leadership and owns the
// database while the rest relay and download nothing; the JS engines have no
// such sharing, so every tab loads the whole index into its own heap.
async function runMultiTab(browser, origin, state, engine, site, tabs) {
  const context = await browser.newContext();
  try {
    const pages = await Promise.all(Array.from({ length: tabs }, () => context.newPage()));
    const results = await Promise.all(
      pages.map((page) =>
        runPage(state, page, origin, engine, site, { cold: true, light: true, mem: true }),
      ),
    );
    for (const page of pages) await page.close();
    return { tabs, pages: results };
  } finally {
    await context.close();
  }
}

await buildBrowser();
const { server, origin, state } = await startServer();
// The full Chromium ("chromium" channel, new headless) is required for
// performance.measureUserAgentSpecificMemory(); the default chrome-headless-shell
// does not expose it.
const browser = await chromium.launch({ channel: "chromium" });
try {
  for (const site of selectedSites(options.site)) {
    for (const engine of options.engines) {
      const artifact = resolve(distRoot, site, "artifacts", engine);
      const buildResultPath = resolve(distRoot, site, "results", `${engine}-build.json`);
      const browserResultPath = resolve(distRoot, site, "results", `${engine}-browser.json`);
      const buildResult = JSON.parse(await readFile(buildResultPath, "utf8"));
      if (buildResult.exit_code !== 0) {
        console.warn(`Skipping ${engine}/${site}: build failed`);
        continue;
      }
      try {
        await access(artifact);
        console.log(`Running ${engine}/${site} in Chromium (single-tab)`);
        const { cold, warm } = await runSingleTab(browser, origin, state, engine, site);
        console.log(`Running ${engine}/${site} in Chromium (${options.tabs} tabs)`);
        const multitab = await runMultiTab(browser, origin, state, engine, site, options.tabs);
        await writeFile(
          browserResultPath,
          JSON.stringify({ browser_version: browser.version(), cold, warm, multitab }, null, 2) + "\n",
        );
      } catch (error) {
        const message = error?.stack ?? String(error);
        console.error(`Failed ${engine}/${site}: ${message}`);
        await writeFile(
          browserResultPath,
          JSON.stringify({ browser_version: browser.version(), error: message }, null, 2) + "\n",
        );
      }
    }
  }
} finally {
  await browser.close();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}
