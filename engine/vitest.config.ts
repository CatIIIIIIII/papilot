import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/ts/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // Each file runs in a process of its own, with its own temporary folders
    // and TeX pool, so files run side by side; the TeX runs dominate.
    fileParallelism: true,
  },
});
