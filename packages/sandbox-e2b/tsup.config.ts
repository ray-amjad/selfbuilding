import { defineConfig } from "tsup";

// Declarations come from `tsc -b` (project references), so tsup only emits JavaScript.
export default defineConfig({
  // `adapter` is the shared E2B-shape adapter without the `e2b` SDK, for other vendors' bindings.
  entry: { index: "src/index.ts", adapter: "src/shared.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  // Error classes derive `name` from the class; keep it stable through bundling.
  keepNames: true,
  // Keep the tsc declarations: wiping them leaves dist/.tsbuildinfo behind, and the next `tsc -b` skips them.
  clean: ["!**/*.d.ts", "!**/*.d.ts.map"],
  sourcemap: true,
});
