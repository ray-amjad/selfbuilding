import { defineConfig } from "tsup";

// Declarations come from `tsc -b` (project references), so tsup only emits JavaScript.
export default defineConfig({
  entry: {
    "claude-code/index": "src/claude-code/index.ts",
    "codex/index": "src/codex/index.ts",
    // Parser-only entries: the runtime bundles these without pulling in the adapters.
    "claude-code/parser": "src/claude-code/parser.ts",
    "codex/parser": "src/codex/parser.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  // Error classes derive `name` from the class; keep it stable through bundling.
  keepNames: true,
  // Keep tsc's declarations: a full clean deletes them while dist/.tsbuildinfo survives, so tsc -b skips the rebuild.
  clean: ["!**/*.d.ts", "!**/*.d.ts.map"],
  sourcemap: true,
});
