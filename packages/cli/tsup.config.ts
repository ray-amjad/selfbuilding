import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Declarations come from `tsc -b` (project references), so tsup only emits JavaScript.
export default defineConfig({
  // `launcher` is the public `selfbuilding/launcher` entry; the bin stays `cli`.
  entry: { cli: "src/cli.ts", launcher: "src/launcher-entry.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  // Error classes derive `name` from the class; keep it stable through bundling.
  keepNames: true,
  // Keep tsc's declarations: a full clean leaves dist/.tsbuildinfo behind, so `tsc -b` would skip re-emitting them.
  clean: ["!**/*.d.ts", "!**/*.d.ts.map"],
  sourcemap: true,
  define: { __SELFBUILDING_VERSION__: JSON.stringify(version) },
});
