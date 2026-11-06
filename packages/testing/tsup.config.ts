import { copyFile } from "node:fs/promises";
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
  // Keep tsc's declarations: a full clean deletes them while dist/.tsbuildinfo survives, so tsc -b skips the rebuild.
  clean: ["!**/*.d.ts", "!**/*.d.ts.map"],
  sourcemap: true,
  // The scripted-harness player is shipped into sandboxes verbatim, so it is copied rather than bundled.
  async onSuccess() {
    await copyFile("src/scripted/player.mjs", "dist/scripted-player.mjs");
  },
});
