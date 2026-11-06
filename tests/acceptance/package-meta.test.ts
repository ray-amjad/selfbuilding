// Publish metadata (docs/spec/release-prep.md §6.3, §6.4): every package under packages/ carries the npm metadata a
// public release needs, ships `dist`, and lists in `files` every path it reads at run time, so a published tarball
// is never missing a skill folder, a manifest or a runtime bundle. Also runs the two release scripts, which vitest
// does not otherwise see.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = "https://github.com/ray-amjad/selfbuilding";

interface PackageJson {
  name: string;
  private?: boolean;
  keywords?: unknown;
  homepage?: unknown;
  bugs?: unknown;
  repository?: unknown;
  publishConfig?: unknown;
  engines?: { node?: string };
  files?: string[];
  exports?: unknown;
  bin?: string | Record<string, string>;
  main?: string;
  types?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const dirs = readdirSync(path.join(ROOT, "packages"))
  .filter((d) => existsSync(path.join(ROOT, "packages", d, "package.json")))
  .sort();
const pkgs = dirs.map((dir) => ({
  dir,
  json: JSON.parse(readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf8")) as PackageJson,
}));

/**
 * Paths each package opens at run time that a source scan cannot see (they are found by name, not by a relative
 * URL). Add a row when a package starts reading a new file of its own.
 */
const RUNTIME_READS: Record<string, string[]> = {
  agents: ["skills"],
  "channel-slack": ["slack-app-manifest.json"],
  // core locates these through @selfbuilding/runtime/package.json and reads them into each sandbox.
  runtime: ["dist/selfbuilding-runtime.mjs", "dist/selfbuilding-mcp.mjs", "dist/ns-reap.mjs"],
  testing: ["dist/scripted-player.mjs"],
};

const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/$/, "");

/** True when `files` ships `target` (npm always ships package.json). */
function shipped(files: string[], target: string): boolean {
  const t = norm(target);
  if (t === "package.json") return true;
  return files.map(norm).some((f) => t === f || t.startsWith(`${f}/`));
}

/** Every file path named by `exports`, `bin`, `main` and `types`; a `*` pattern contributes its fixed prefix. */
function entryTargets(json: PackageJson): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const star = v.indexOf("*");
      out.push(star === -1 ? v : v.slice(0, star).replace(/\/[^/]*$/, "") || ".");
    } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(json.exports);
  walk(json.bin);
  walk(json.main);
  walk(json.types);
  return out;
}

/** Package-root folders a top-level source file reaches with `new URL("../<name>/…", import.meta.url)`. */
function relativeUrlReads(dir: string): string[] {
  const src = path.join(ROOT, "packages", dir, "src");
  if (!existsSync(src)) return [];
  const reads = new Set<string>();
  for (const name of readdirSync(src)) {
    if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
    const text = readFileSync(path.join(src, name), "utf8");
    for (const m of text.matchAll(/new URL\(\s*[`"']\.\.\/([A-Za-z0-9._-]+)/g)) if (m[1]) reads.add(m[1]);
  }
  return [...reads];
}

describe("package metadata", () => {
  it("finds every package", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(18);
    expect(pkgs.map((p) => p.json.name)).toContain("selfbuilding");
  });

  for (const { dir, json } of pkgs) {
    describe(json.name, () => {
      it("carries repository, homepage, bugs, publishConfig and keywords", () => {
        expect(json.repository).toEqual({ type: "git", url: `git+${REPO}.git`, directory: `packages/${dir}` });
        expect(json.homepage).toBe(`${REPO}/tree/main/packages/${dir}#readme`);
        expect(json.bugs).toBe(`${REPO}/issues`);
        expect(json.publishConfig).toEqual({ access: "public", provenance: true });
        expect(Array.isArray(json.keywords)).toBe(true);
        const keywords = json.keywords as unknown[];
        expect(keywords.length).toBeGreaterThan(1);
        expect(keywords.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
        expect(new Set(keywords).size).toBe(keywords.length);
        expect(json.engines?.node).toBe(">=22.12");
      });

      it("ships dist, and every entry point is inside files", () => {
        const files = json.files ?? [];
        expect(files).toContain("dist");
        for (const target of entryTargets(json)) expect(shipped(files, target), `${target} is not in files`).toBe(true);
      });

      it("ships every path it reads at run time", () => {
        const files = json.files ?? [];
        const reads = [...(RUNTIME_READS[dir] ?? []), ...relativeUrlReads(dir)];
        for (const read of reads) {
          expect(shipped(files, read), `${read} is read at run time but not in files`).toBe(true);
          // Built output appears only after `pnpm build`; everything else must be in the tree.
          if (!read.startsWith("dist/")) expect(existsSync(path.join(ROOT, "packages", dir, read)), read).toBe(true);
        }
      });

      it("lists only files that exist (dist aside)", () => {
        for (const f of json.files ?? []) {
          if (norm(f) === "dist" || norm(f).startsWith("dist/")) continue;
          expect(existsSync(path.join(ROOT, "packages", dir, norm(f))), `${f} is in files but missing`).toBe(true);
        }
      });

      it("has a README", () => {
        expect(existsSync(path.join(ROOT, "packages", dir, "README.md"))).toBe(true);
      });
    });
  }

  it("the changesets config publishes publicly", () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, ".changeset/config.json"), "utf8")) as { access: string };
    expect(config.access).toBe("public");
  });
});

describe("release scripts", () => {
  it("publish-order prints every package after the workspace packages it depends on", () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/publish-order.mjs"), "--json"], {
      encoding: "utf8",
    });
    const order = JSON.parse(out) as string[];
    expect([...order].sort()).toEqual(pkgs.map((p) => p.json.name).sort());
    const names = new Set(order);
    for (const { json } of pkgs) {
      const deps = { ...json.dependencies, ...json.peerDependencies, ...json.optionalDependencies };
      for (const dep of Object.keys(deps).filter((d) => names.has(d))) {
        expect(order.indexOf(dep), `${dep} must come before ${json.name}`).toBeLessThan(order.indexOf(json.name));
      }
    }
    expect(order.indexOf("@selfbuilding/skills")).toBeLessThan(order.indexOf("@selfbuilding/core"));
    expect(order.at(-1)).toBe("selfbuilding");
  });

  it("check-public passes its own self-test", () => {
    // Throws (and fails the case) on a non-zero exit.
    execFileSync(process.execPath, [path.join(ROOT, "scripts/check-public.mjs"), "--self-test"], { stdio: "pipe" });
  });
});
