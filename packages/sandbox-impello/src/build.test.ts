import { describe, expect, it } from "vitest";
import { impello, impelloImageBuilder, type impelloTemplateApi } from "./index.js";

// Impello sizes per template, at most 4 vCPU (docs/spec/demo-path.md §1.3, §2).

const MEDIUM = { name: "medium", vcpu: 4, memoryMiB: 8192 };
const LARGE = { name: "large", vcpu: 8, memoryMiB: 16384 };

function fakeTemplate() {
  const steps: unknown[] = [];
  const builds: unknown[] = [];
  const tags: unknown[] = [];
  const chain: Record<string, (arg: unknown) => unknown> = {};
  for (const op of ["fromImage", "setUser", "setWorkdir", "runCmd"]) {
    chain[op] = (arg) => {
      steps.push([op, arg]);
      return chain;
    };
  }
  const T = Object.assign(() => chain, {
    build: async (_t: unknown, name: string, o: unknown) => {
      builds.push([name, o]);
      return {};
    },
    assignTags: async (target: string, t: string[], o: unknown) => {
      tags.push([target, t, o]);
      return {};
    },
  });
  return { steps, builds, tags, T: T as unknown as Parameters<typeof impelloTemplateApi>[1] };
}

describe("impello sizing", () => {
  it("is a template provider capped at 4 vCPU, small only by default", () => {
    const provider = impello({ apiKey: "imp_x", template: "selfbuilding-codex" });
    expect(provider.sizing).toMatchObject({
      kind: "template",
      forkSize: "inherit",
      available: ["small"],
      limits: { maxVcpu: 4 },
    });
    expect(provider.sizing?.limits.overLimitFix).toMatch(/^Impello has no 8 vCPU pool yet\./);
    const sized = impello({ apiKey: "imp_x", template: "selfbuilding-codex", sizes: ["small", "medium"] });
    expect(sized.sizing?.kind === "template" && sized.sizing.available).toEqual(["small", "medium"]);
  });

  it("refuses large before any vendor call", async () => {
    const provider = impello({ apiKey: "imp_x", template: "selfbuilding-codex", sizes: ["large"] });
    const k = { runId: "r", scope: "s", deployment: "d" };
    await expect(
      provider.openOrCreate(k, {
        image: { name: "selfbuilding-codex", ref: "selfbuilding/codex:1", version: "1" },
        env: {},
        lifetimeMs: 60_000,
        onExpire: "pause",
        labels: {},
        size: LARGE,
      }),
    ).rejects.toMatchObject({ code: "size_unavailable", reason: "over-limit" });
  });
});

describe("impelloImageBuilder", () => {
  it("builds through @impello/sdk/template with explicit credentials and the size", async () => {
    const fake = fakeTemplate();
    const builder = impelloImageBuilder({ apiKey: "imp_key_123", template: fake.T, registry: "ghcr.io/acme" });
    expect(builder.provider).toBe("impello");
    expect(builder.nameFor("codex", "medium")).toBe("selfbuilding-codex-medium");
    const result = await builder.build({
      harness: "codex",
      size: MEDIUM,
      version: "3.0.0",
      name: "selfbuilding-codex-medium",
    });
    expect(result).toMatchObject({ ok: true, provider: "impello", size: "medium" });
    expect(fake.steps[0]).toEqual(["fromImage", "ghcr.io/acme/selfbuilding/codex:3.0.0"]);
    expect(fake.builds[0]).toEqual([
      "selfbuilding-codex-medium",
      expect.objectContaining({
        apiKey: "imp_key_123",
        domain: "sandbox.impello.ai",
        apiUrl: "https://api.sandbox.impello.ai",
        cpuCount: 4,
        memoryMB: 8192,
      }),
    ]);
    expect(fake.builds[0]).not.toEqual([
      expect.anything(),
      expect.objectContaining({ minFreeDiskMb: expect.anything() }),
    ]);
    expect(fake.tags[0]).toEqual(["selfbuilding-codex-medium:3.0.0", ["default"], expect.anything()]);
  });

  it("refuses large (no 8 vCPU pool) and disk sizes without building", async () => {
    const fake = fakeTemplate();
    const builder = impelloImageBuilder({ apiKey: "imp_key_123", template: fake.T });
    const large = await builder.build({
      harness: "codex",
      size: LARGE,
      version: "1",
      name: "selfbuilding-codex-large",
    });
    expect(large).toMatchObject({ ok: false, error: { code: "size_unavailable" } });
    expect(large.ok ? "" : large.error.message).toMatch(/Impello has no 8 vCPU pool yet/);
    const disk = await builder.build({
      harness: "codex",
      size: { name: "big-disk", vcpu: 2, memoryMiB: 4096, diskGiB: 40 },
      version: "1",
      name: "selfbuilding-codex-big-disk",
    });
    expect(disk).toMatchObject({ ok: false, error: { code: "size_unavailable" } });
    expect(fake.builds).toEqual([]);
  });
});
