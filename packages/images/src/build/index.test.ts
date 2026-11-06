import {
  type ImageBuilder,
  type ImageBuildRequest,
  MissingSecretError,
  type ProviderSizing,
  SizeUnknownError,
} from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import {
  buildSizeTable,
  checkBuildSize,
  formatBuildLine,
  planImageBuilds,
  resolveBuildSizes,
  runImageBuilds,
  sizesHint,
} from "./index.js";

const table = buildSizeTable({ xlarge: { vcpu: 16, memoryMiB: 32768 } });
const [small, medium, large, xlarge] = resolveBuildSizes(table, ["small", "medium", "large", "xlarge"]) as [
  ReturnType<typeof resolveBuildSizes>[number],
  ReturnType<typeof resolveBuildSizes>[number],
  ReturnType<typeof resolveBuildSizes>[number],
  ReturnType<typeof resolveBuildSizes>[number],
];

function fakeBuilder(provider: string, sizing: ProviderSizing): ImageBuilder & { requests: ImageBuildRequest[] } {
  const requests: ImageBuildRequest[] = [];
  return {
    provider,
    sizing,
    requests,
    nameFor: (harness, size) =>
      sizing.kind === "template"
        ? `selfbuilding-${harness}${size === "small" ? "" : `-${size}`}`
        : `selfbuilding/${harness}`,
    async build(req) {
      requests.push(req);
      req.onLog?.("step");
      return { ok: true, provider, harness: req.harness, size: req.size.name, name: req.name, durationMs: 312_000 };
    },
  };
}

const template = (limits: ProviderSizing["limits"]): ProviderSizing => ({
  kind: "template",
  forkSize: "inherit",
  resize: false,
  available: [],
  limits,
  templateFor: (b, s) => (s === "small" ? b : `${b}-${s}`),
});

describe("sizes for a build", () => {
  it("merges the config's names with the built-ins and expands all", () => {
    expect(Object.keys(table)).toEqual(["small", "medium", "large", "xlarge"]);
    expect(resolveBuildSizes(table, ["all"]).map((s) => s.name)).toEqual(["small", "medium", "large", "xlarge"]);
    expect(medium).toEqual({ name: "medium", vcpu: 4, memoryMiB: 8192 });
  });

  it("throws SizeUnknownError naming the known sizes", () => {
    expect(() => resolveBuildSizes(table, ["huge"])).toThrow(SizeUnknownError);
    expect(() => resolveBuildSizes(table, ["huge"])).toThrow(/small, medium, large, xlarge/);
  });
});

describe("checkBuildSize", () => {
  it("ignores availability and refuses over-limit sizes with the provider's fix", () => {
    const e2b = fakeBuilder("e2b", template({ maxVcpu: 8, maxMemoryMiB: 8192, overLimitFix: "E2B Hobby allows …" }));
    expect(checkBuildSize(e2b, medium)).toEqual({ ok: true });
    expect(checkBuildSize(e2b, large)).toEqual({ ok: false, reason: "over-limit", fix: "E2B Hobby allows …" });
  });

  it("refuses shapes the provider does not offer", () => {
    const vercelLike = fakeBuilder("vercel", {
      kind: "create",
      forkSize: "override",
      resize: false,
      limits: { vcpuChoices: [2, 4, 8], memoryPerVcpuMiB: 2048 },
    });
    expect(checkBuildSize(vercelLike, medium)).toEqual({ ok: true });
    expect(checkBuildSize(vercelLike, xlarge)).toMatchObject({ ok: false, reason: "invalid-shape" });
    expect(checkBuildSize(vercelLike, xlarge)).toMatchObject({
      fix: `"vercel" offers 2, 4, 8 vCPU with 2048 MiB per vCPU. Define a size with one of them in the config's sizes table.`,
    });
  });
});

describe("planImageBuilds and runImageBuilds", () => {
  it("plans every template triple, refuses over-limit ones, and builds docker once per harness", async () => {
    const impello = fakeBuilder("impello", template({ maxVcpu: 4, overLimitFix: "Impello has no 8 vCPU pool yet." }));
    const docker = fakeBuilder("docker", { kind: "create", forkSize: "override", resize: false, limits: {} });
    const plan = planImageBuilds([impello, docker], ["codex"], [small, medium, large]);
    expect(plan.map((p) => `${p.builder.provider}/${p.size.name}/${p.refusal ? "refused" : p.name}`)).toEqual([
      "impello/small/selfbuilding-codex",
      "impello/medium/selfbuilding-codex-medium",
      "impello/large/refused",
      "docker/small/selfbuilding/codex",
    ]);

    const lines: string[] = [];
    const logs: string[] = [];
    const results = await runImageBuilds({
      plan,
      version: "1.0.0",
      onResult: (r, p) => lines.push(formatBuildLine(r, p.size)),
      onLog: (p, line) => logs.push(`${p.builder.provider}:${line}`),
    });
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true]);
    expect(impello.requests.map((r) => r.name)).toEqual(["selfbuilding-codex", "selfbuilding-codex-medium"]);
    expect(impello.requests[0]?.version).toBe("1.0.0");
    expect(docker.requests).toHaveLength(1);
    expect(lines[1]).toBe("ok   impello  codex        medium  selfbuilding-codex-medium  4 vCPU 8192 MiB  312s");
    expect(lines[2]).toMatch(
      /^fail impello {2}codex {8}large {3}selfbuilding-codex-large {3}size_unavailable: .*Impello has no 8 vCPU pool yet\.$/,
    );
    expect(logs).toContain("impello:step");
    expect(sizesHint("impello", results)).toBe('Add "medium" to impello({ sizes }).');
    expect(sizesHint("docker", [])).toBeNull();
  });

  it("dry-runs without building and fails every triple of a provider with no credentials", async () => {
    const e2b = fakeBuilder("e2b", template({}));
    const dry = await runImageBuilds({
      plan: planImageBuilds([e2b], ["codex"], [small, xlarge]),
      version: "1",
      dryRun: true,
    });
    expect(dry.every((r) => r.ok)).toBe(true);
    expect(e2b.requests).toEqual([]);
    expect(formatBuildLine(dry[1] as (typeof dry)[number], xlarge, { dryRun: true })).toMatch(
      /^dry {2}e2b .* 16 vCPU 32768 MiB {2}would build$/,
    );

    const missing = await runImageBuilds({
      plan: planImageBuilds([e2b], ["codex", "claude-code"], [small]),
      version: "1",
      unavailable: new Map([["e2b", new MissingSecretError({ secret: "E2B_API_KEY" })]]),
    });
    expect(missing.map((r) => (r.ok ? "ok" : r.error.code))).toEqual(["secret_missing", "secret_missing"]);
    expect(e2b.requests).toEqual([]);
  });
});
