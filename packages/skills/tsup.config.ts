import { defineConfig } from "tsup";

// Declarations come from `tsc -b` (project references), so tsup only emits JavaScript.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  // Error classes derive `name` from the class; keep it stable through bundling.
  keepNames: true,
  clean: ["!**/*.d.ts", "!**/*.d.ts.map"],
  sourcemap: true,
});
