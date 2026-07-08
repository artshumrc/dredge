import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Initialize the decode-only brotli wasm from disk before tests so boot
    // tests can exercise the in-worker decode path in Node (see setup file).
    setupFiles: ["test/setup-brotli.ts"],
  },
});
