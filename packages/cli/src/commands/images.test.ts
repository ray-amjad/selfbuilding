import { PassThrough } from "node:stream";
import type { ImageBuilder, ImageBuildRequest, ProviderSizing } from "@selfbuilding/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, jsonLines, makeProject, type TestProject } from "../../test/helpers.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { defaultContext } from "../main.js";
import { type BuilderRequest, IMAGES_HELP, runImagesCommand } from "./images.js";

// `selfbuilding images build` against fake builders (docs/spec/demo-path.md §2).

let project: TestProject;
beforeEach(() => {
  project = makeProject();
});
afterEach(() => project.cleanup());

const LIMITS: Record<string, ProviderSizing> = {
  e2b: {
    kind: "template",
    forkSize: "inherit",
    resize: false,
    available: [],
    limits: { maxVcpu: 8, maxMemoryMiB: 8192, overLimitFix: "E2B Hobby allows 8 vCPU and 8 GiB per sandbox." },
    templateFor: (b, s) => (s === "small" ? b : `${b}-${s}`),
  },
  impello: {
    kind: "template",
    forkSize: "inherit",
    resize: false,
    available: [],
    limits: { maxVcpu: 4, overLimitFix: "Impello has no 8 vCPU pool yet." },
    templateFor: (b, s) => (s === "small" ? b : `${b}-${s}`),
  },
  docker: { kind: "create", forkSize: "override", resize: false, limits: {} },
};

function fakes(fail: string[] = []) {
  const requests: Array<BuilderRequest & { builds: ImageBuildRequest[] }> = [];
  return {
    requests,
    deps: {
      async builder(req: BuilderRequest): Promise<ImageBuilder> {
        const entry = { ...req, builds: [] as ImageBuildRequest[] };
        requests.push(entry);
        const sizing = LIMITS[req.provider] as ProviderSizing;
        return {
          provider: req.provider,
          sizing: req.sizeLimits ? { ...sizing, limits: req.sizeLimits } : sizing,
          nameFor: (harness, size) =>
            sizing.kind === "template"
              ? `selfbuilding-${harness}${size === "small" ? "" : `-${size}`}`
              : `selfbuilding/${harness}`,
          async build(b) {
            entry.builds.push(b);
            if (fail.includes(b.name)) {
              return {
                ok: false,
                provider: req.provider,
                harness: b.harness,
                size: b.size.name,
                name: b.name,
                error: {
                  name: "ImageUnavailableError",
                  code: "image_unavailable",
                  kind: "agent",
                  retryable: false,
                  message: "boom",
                },
              };
            }
            return {
              ok: true,
              provider: req.provider,
              harness: b.harness,
              size: b.size.name,
              name: b.name,
              durationMs: 5_000,
            };
          },
        };
      },
    },
  };
}

async function images(argv: string[], env: Record<string, string> = {}, fail: string[] = []) {
  let stdout = "";
  let stderr = "";
  const ctx: CliContext = defaultContext({
    cwd: project.root,
    env: { ...env },
    stdin: new PassThrough(),
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    isTTY: false,
  });
  const f = fakes(fail);
  const code = await runImagesCommand(ctx, ["build", ...argv], f.deps).catch((e: unknown) => e);
  return { code, stdout, stderr, requests: f.requests };
}

describe("selfbuilding images build", () => {
  it("builds every harness at small by default, with the key from the environment and the default tag", async () => {
    const r = await images(["--provider", "e2b"], { E2B_API_KEY: "e2b_test_key" });
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ provider: "e2b", apiKey: "e2b_test_key" });
    expect(r.requests[0]?.builds.map((b) => `${b.harness}@${b.size.name}:${b.version}`)).toEqual([
      "claude-code@small:0.1.0",
      "codex@small:0.1.0",
    ]);
    expect(r.stdout).toContain("ok   e2b      codex        small   selfbuilding-codex         2 vCPU 4096 MiB  5s");
    expect(r.stdout + r.stderr).not.toContain("e2b_test_key");
  });

  it("refuses sizes over the plan's limit with the fix, builds the rest and exits 1", async () => {
    const r = await images(["--provider", "impello,e2b", "--harness", "codex", "--sizes", "medium,large", "--json"], {
      E2B_API_KEY: "k1",
      IMPELLO_API_KEY: "k2",
    });
    expect(r.code).toBe(EXIT.failed);
    const results = jsonLines(r.stdout) as Array<{
      ok: boolean;
      provider: string;
      size: string;
      error?: { message: string };
    }>;
    expect(results.map((x) => `${x.provider}/${x.size}/${x.ok}`)).toEqual([
      "impello/medium/true",
      "impello/large/false",
      "e2b/medium/true",
      "e2b/large/false",
    ]);
    expect(results[1]?.error?.message).toMatch(/Impello has no 8 vCPU pool yet\.$/);
    expect(results[3]?.error?.message).toMatch(/E2B Hobby allows 8 vCPU and 8 GiB per sandbox\.$/);
    expect(r.requests.flatMap((q) => q.builds.map((b) => b.name))).toEqual([
      "selfbuilding-codex-medium",
      "selfbuilding-codex-medium",
    ]);
    expect(r.stderr).toContain('Add "medium" to impello({ sizes }).');
    expect(r.stderr).toContain('Add "medium" to e2b({ sizes }).');
  });

  it("fails a provider whose key is missing, naming the variable, and still builds the others", async () => {
    const r = await images(["--provider", "e2b", "--provider", "docker", "--harness", "codex"]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stdout).toMatch(/^fail e2b .*secret_missing: E2B_API_KEY/m);
    expect(r.requests.find((q) => q.provider === "e2b")?.builds).toEqual([]);
    expect(r.requests.find((q) => q.provider === "docker")?.builds).toHaveLength(1);
    expect(r.stderr).toContain("docker sizes at create; built once");
  });

  it("builds docker once per harness whatever the sizes", async () => {
    const r = await images(["--provider", "docker", "--size", "all", "--tag", "1.2.3"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests[0]?.builds.map((b) => `${b.name}:${b.version}`)).toEqual([
      "selfbuilding/claude-code:1.2.3",
      "selfbuilding/codex:1.2.3",
    ]);
  });

  it("dry-runs without credentials and builds nothing", async () => {
    const r = await images(["--provider", "e2b", "--size", "medium", "--dry-run"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests[0]?.builds).toEqual([]);
    expect(r.stdout).toMatch(
      /^dry {2}e2b {6}codex {8}medium {2}selfbuilding-codex-medium {2}4 vCPU 8192 MiB {2}would build$/m,
    );
  });

  it("takes custom sizes and the provider's limits from the config", async () => {
    project.write(
      "selfbuilding.config.ts",
      `import { defineConfig } from "@selfbuilding/core";
const e2bLike = {
  id: "e2b",
  stability: "stable",
  limits: { maxLifetimeMs: 1, lifetimeGuaranteed: true, expireKeeps: "memory" },
  sizing: { kind: "template", forkSize: "inherit", resize: false, available: ["small"], limits: { maxVcpu: 16 }, templateFor: (b, s) => b + "-" + s },
  list: async function* () {},
  kill: async () => ({ path: "already-gone" }),
};
export const providers = [e2bLike];
export default defineConfig({ deployment: "test-cli", sizes: { xlarge: { vcpu: 16, memoryMiB: 32768 } } });
`,
    );
    const r = await images(["--provider", "e2b", "--harness", "codex", "--size", "xlarge"], { E2B_API_KEY: "k" });
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests[0]?.sizeLimits).toEqual({ maxVcpu: 16 });
    expect(r.requests[0]?.builds[0]).toMatchObject({ name: "selfbuilding-codex-xlarge", size: { vcpu: 16 } });
  });

  it("passes the image registry from the environment", async () => {
    const r = await images(["--provider", "e2b", "--dry-run"], { SELFBUILDING_IMAGE_REGISTRY: "ghcr.io/acme" });
    expect(r.requests[0]?.registry).toBe("ghcr.io/acme");
  });
});

// Registry-free template builds and the combined template (docs/spec/release-prep.md §4.2, §4.3).
describe("selfbuilding images build without a registry", () => {
  it("builds templates with no registry set and says each one came from a Dockerfile", async () => {
    const r = await images(["--provider", "e2b,impello", "--harness", "codex"], {
      E2B_API_KEY: "k1",
      IMPELLO_API_KEY: "k2",
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests.map((q) => q.registry)).toEqual([undefined, undefined]);
    expect(r.stderr).toContain("[e2b codex small] from Dockerfile\n");
    expect(r.stderr).toContain("[impello codex small] from Dockerfile\n");
  });

  it("says the build came from the registry when one is set", async () => {
    const r = await images(["--provider", "e2b,docker", "--harness", "codex", "--tag", "1.2.3"], {
      E2B_API_KEY: "k1",
      SELFBUILDING_IMAGE_REGISTRY: "ghcr.io/acme/",
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("[e2b codex small] from ghcr.io/acme/selfbuilding/codex:1.2.3\n");
    // Docker always builds the images itself.
    expect(r.stderr).toContain("[docker codex small] from Dockerfile\n");
  });

  it("prints the path line once per triple built, not for refused sizes", async () => {
    const r = await images(["--provider", "impello", "--harness", "codex", "--sizes", "medium,large"], {
      IMPELLO_API_KEY: "k2",
    });
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr.match(/from Dockerfile/g)).toHaveLength(1);
    expect(r.stderr).toContain("[impello codex medium] from Dockerfile\n");
  });

  it("--all-harnesses builds only the combined template and names it in the hint", async () => {
    const r = await images(["--provider", "e2b", "--all-harnesses", "--sizes", "small,medium"], { E2B_API_KEY: "k1" });
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests[0]?.builds.map((b) => b.name)).toEqual([
      "selfbuilding-all-harnesses",
      "selfbuilding-all-harnesses-medium",
    ]);
    expect(r.stderr).toContain("[e2b all-harnesses medium] from Dockerfile\n");
    expect(r.stderr).toContain('Add "medium" to e2b({ sizes }) and use template: "selfbuilding-all-harnesses".');
  });

  it("--harness all-harnesses is the same as --all-harnesses", async () => {
    const r = await images(["--provider", "e2b", "--harness", "all-harnesses"], { E2B_API_KEY: "k1" });
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests[0]?.builds.map((b) => b.harness)).toEqual(["all-harnesses"]);
    expect(r.stderr).toContain('Use template: "selfbuilding-all-harnesses" in e2b({ template }).');
  });

  it("--all-harnesses with --harness builds both, and --harness all stays each harness separately", async () => {
    const both = await images(["--provider", "e2b", "--harness", "codex", "--all-harnesses"], { E2B_API_KEY: "k1" });
    expect(both.requests[0]?.builds.map((b) => b.harness)).toEqual(["codex", "all-harnesses"]);
    const all = await images(["--provider", "e2b", "--harness", "all", "--all-harnesses"], { E2B_API_KEY: "k1" });
    expect(all.requests[0]?.builds.map((b) => b.harness)).toEqual(["claude-code", "codex", "all-harnesses"]);
    const each = await images(["--provider", "e2b", "--harness", "all"], { E2B_API_KEY: "k1" });
    expect(each.requests[0]?.builds.map((b) => b.harness)).toEqual(["claude-code", "codex"]);
  });

  it("builds docker's combined image once whatever the sizes", async () => {
    const r = await images(["--provider", "docker", "--all-harnesses", "--sizes", "small,medium"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.requests[0]?.builds.map((b) => b.name)).toEqual(["selfbuilding/all-harnesses"]);
  });

  it("documents the new flags and the optional registry in the help", () => {
    expect(IMAGES_HELP).toContain("--all-harnesses");
    expect(IMAGES_HELP).toContain("all-harnesses");
    expect(IMAGES_HELP).toContain("from Dockerfile");
    expect(IMAGES_HELP).toMatch(/SELFBUILDING_IMAGE_REGISTRY\s+Optional/);
  });
});

describe("usage errors exit 2", () => {
  it.each([
    [["images", "build"], /needs --provider/],
    [["images", "build", "--provider", "modal"], /Unknown provider "modal"/],
    [["images", "build", "--provider", "e2b", "--harness", "opencode"], /Unknown harness "opencode"/],
    [["images", "build", "--provider", "e2b", "--harness", "both"], /Use claude-code, codex, all or all-harnesses/],
    [["images", "build", "--provider", "e2b", "--size", "huge", "--dry-run"], /Size "huge" is not defined/],
    [["images", "push", "--provider", "e2b"], /one subcommand, build/],
  ])("%j", async (argv, message) => {
    const r = await cli(argv, { cwd: project.root });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toMatch(message);
  });

  it("prints help", async () => {
    const r = await cli(["images", "--help"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("selfbuilding images build");
  });
});
