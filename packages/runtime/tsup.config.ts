import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// The runtime runs inside a sandbox with nothing installed, so every dependency is bundled in.
export default defineConfig({
  entry: {
    "selfbuilding-runtime": "src/runtime.ts",
    "selfbuilding-mcp": "src/mcp.ts",
    "ns-reap": "src/ns-reap.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  // Only core's wire constants are needed at run time. Core's built index also evaluates the agent schemas (and so
  // zod) on import, so the bundle takes the constants straight from the shared types module.
  esbuildOptions(options) {
    options.alias = {
      "@selfbuilding/core": fileURLToPath(new URL("../core/src/types/index.ts", import.meta.url)),
      "@selfbuilding/harnesses/claude-code/parser": fileURLToPath(
        new URL("../harnesses/src/claude-code/parser.ts", import.meta.url),
      ),
      "@selfbuilding/harnesses/codex/parser": fileURLToPath(
        new URL("../harnesses/src/codex/parser.ts", import.meta.url),
      ),
    };
  },
  dts: false,
  splitting: false,
  // The bin files are executed directly inside the sandbox.
  banner: { js: "#!/usr/bin/env node" },
  // Error classes derive `name` from the class; keep it stable through bundling.
  keepNames: true,
  // Keep tsc's declarations: a full clean deletes them while dist/.tsbuildinfo survives, so tsc -b skips the rebuild.
  clean: ["!**/*.d.ts", "!**/*.d.ts.map"],
  sourcemap: false,
});
