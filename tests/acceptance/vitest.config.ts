import { defineConfig } from "vitest/config";

// Every case drives the real runtime inside tmpdir boxes, so cases take seconds, not milliseconds.
export default defineConfig({
  test: {
    name: "acceptance",
    include: ["**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
