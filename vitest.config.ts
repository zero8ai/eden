/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Pure unit tests over in-memory fakes — no shared state, so files run in parallel.
    testTimeout: 20_000,
  },
});
