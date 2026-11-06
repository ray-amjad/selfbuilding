import { defineConfig } from "vitest/config";

// Real models and cloud sandboxes: a case can take many minutes, and one file at a time keeps spend predictable.
export default defineConfig({
  test: {
    name: "live",
    include: ["**/*.test.ts"],
    testTimeout: 45 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
  },
});
