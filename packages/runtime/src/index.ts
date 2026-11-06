import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// The host-side handle on the bundled files: what to upload to /selfbuilding/bin and the stamp to write last.

export interface RuntimeBundles {
  /** selfbuilding-runtime.mjs, for /selfbuilding/bin/selfbuilding-runtime.mjs. */
  runtime: string;
  /** selfbuilding-mcp.mjs, for /selfbuilding/bin/selfbuilding-mcp.mjs. */
  mcp: string;
  /** The ns-reap script, for /selfbuilding/bin/ns-reap (mode 0755). */
  nsReap: string;
  /** SHA-256 of `runtime`, for /selfbuilding/runtime-version, written after the files. */
  sha256: string;
}

/** Absolute paths of the bundled files in this package's dist directory. */
export function runtimeBundlePaths(): { runtime: string; mcp: string; nsReap: string } {
  const at = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
  return { runtime: at("selfbuilding-runtime.mjs"), mcp: at("selfbuilding-mcp.mjs"), nsReap: at("ns-reap.mjs") };
}

let cached: RuntimeBundles | undefined;

/** Reads the bundles once. An ENOENT naming a dist file means the package was not built (`pnpm -r build`). */
export function readRuntimeBundles(): RuntimeBundles {
  if (cached) return cached;
  const paths = runtimeBundlePaths();
  const read = (file: string) => fs.readFileSync(file, "utf8");
  const runtime = read(paths.runtime);
  cached = {
    runtime,
    mcp: read(paths.mcp),
    nsReap: read(paths.nsReap),
    sha256: createHash("sha256").update(runtime).digest("hex"),
  };
  return cached;
}
