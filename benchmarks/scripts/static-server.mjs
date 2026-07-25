import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createBrotliCompress, constants } from "node:zlib";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".br": "application/octet-stream",
};

const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".svg", ".txt", ".wasm", ".xml"]);

export function acceptsBrotli(value) {
  let wildcard;
  let brotli;
  for (const entry of String(value ?? "").split(",")) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    if (!name) continue;
    const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
    const accepted = Number.isFinite(quality) && quality > 0;
    if (name === "br") brotli = accepted;
    if (name === "*") wildcard = accepted;
  }
  return brotli ?? wildcard ?? false;
}

function byteCounter(state) {
  return new Transform({
    transform(chunk, encoding, callback) {
      state.bytesServed += chunk.length;
      callback(null, chunk);
    },
  });
}

async function collectCompressibleFiles(paths) {
  const files = [];
  const visit = async (path) => {
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isFile()) {
      if (compressibleExtensions.has(extname(path))) files.push({ path, bytes: metadata.size });
      return;
    }
    if (!metadata.isDirectory()) return;
    for (const entry of await readdir(path)) await visit(join(path, entry));
  };
  for (const path of paths) await visit(path);
  return files;
}

async function prepareBrotli(paths, quality) {
  const compressedPaths = new Map();
  if (!paths.length) return { compressedPaths, cacheRoot: undefined };
  const files = await collectCompressibleFiles(paths);
  const cacheRoot = await mkdtemp(join(tmpdir(), "dredge-benchmark-http-br-"));
  let nextFile = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      while (nextFile < files.length) {
        const index = nextFile++;
        const file = files[index];
        const output = join(cacheRoot, String(index));
        await pipeline(
          createReadStream(file.path),
          createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: quality } }),
          createWriteStream(output),
        );
        if ((await stat(output)).size < file.bytes) compressedPaths.set(file.path, output);
        else {
          compressedPaths.set(file.path, null);
          await rm(output);
        }
      }
    }),
  );
  return { compressedPaths, cacheRoot };
}

export async function startStaticServer(
  root,
  { brotliQuality = 5, precompressPaths = [] } = {},
) {
  const { compressedPaths, cacheRoot } = await prepareBrotli(precompressPaths, brotliQuality);
  const state = { bytesServed: 0, dynamicCompressions: 0 };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!relative || relative === "runner") relative = "runner/index.html";
      if (relative.endsWith("/")) relative += "index.html";
      const path = resolve(root, relative);
      if (!path.startsWith(`${root}${sep}`)) throw new Error("invalid path");
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("not a file");

      const extension = extname(path);
      let compress =
        extension !== ".br" &&
        compressibleExtensions.has(extension) &&
        acceptsBrotli(request.headers["accept-encoding"]);
      if (compress && precompressPaths.length && !compressedPaths.has(path)) {
        throw new Error(`missing prepared Brotli representation for ${path}`);
      }
      if (compressedPaths.has(path) && compressedPaths.get(path) === null) compress = false;
      const headers = {
        "content-type": mimeTypes[extension] ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      };
      if (compressibleExtensions.has(extension)) headers.vary = "Accept-Encoding";
      if (compress) headers["content-encoding"] = "br";
      else headers["content-length"] = metadata.size;
      response.writeHead(200, headers);

      const preparedPath = compressedPaths.get(path);
      const streams = [createReadStream(compress && preparedPath ? preparedPath : path)];
      if (compress && !preparedPath) {
        state.dynamicCompressions += 1;
        streams.push(
          createBrotliCompress({
            params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality },
          }),
        );
      }
      streams.push(byteCounter(state), response);
      await pipeline(streams);
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(404).end("not found");
    }
  });
  if (cacheRoot) server.once("close", () => void rm(cacheRoot, { recursive: true, force: true }));
  return new Promise((resolveStarted) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStarted({ server, origin: `http://127.0.0.1:${address.port}`, state });
    });
  });
}
