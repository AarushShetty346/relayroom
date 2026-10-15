import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each server test file boots its own database; keep files isolated.
    pool: "forks",
  },
});
