import {
  ConfigError,
  type ProviderLimits,
  type ResolvedSize,
  type SandboxKey,
  type SandboxSpec,
  SELFBUILDING_LABELS,
  SizeUnavailableError,
} from "@selfbuilding/core";
import { afterAll, describe, expect, it } from "vitest";
import { FAST, FakeE2b } from "../test/fake-e2b.js";
import { templateImageBuilder } from "./build.js";
import {
  createE2bShapeProvider,
  E2B_SIZE_LIMITS,
  e2b,
  e2bClient,
  e2bImageBuilder,
  e2bTemplate,
  type e2bTemplateApi,
  guardTemplateSizes,
  templateNameFor,
  templateSizing,
} from "./index.js";

// Template sizing for E2B-shape providers (docs/spec/demo-path.md §1.3, §1.4, §2).

const SMALL: ResolvedSize = { name: "small", vcpu: 2, memoryMiB: 4096 };
const MEDIUM: ResolvedSize = { name: "medium", vcpu: 4, memoryMiB: 8192 };
const LARGE: ResolvedSize = { name: "large", vcpu: 8, memoryMiB: 16384 };
const LIMITS: ProviderLimits = { maxLifetimeMs: 3_600_000, lifetimeGuaranteed: true, expireKeeps: "memory" };

const fakes: FakeE2b[] = [];
afterAll(async () => {
  await Promise.all(fakes.map((f) => f.close()));
});

function setup(available: string[]) {
  const fake = new FakeE2b();
  fakes.push(fake);
  const provider = guardTemplateSizes(
    createE2bShapeProvider({
      id: "e2b",
      client: e2bClient(fake.client as unknown as Parameters<typeof e2bClient>[0]),
      template: "selfbuilding-codex",
      apiKey: "e2b_unit",
      domain: "fake.local",
      limits: LIMITS,
      connection: { retries: 0 },
      timings: FAST,
      sizing: templateSizing({ available, limits: E2B_SIZE_LIMITS.hobby }),
    }),
  );
  return { fake, provider };
}

let n = 0;
function key(): SandboxKey {
  return { runId: "run-sizes", scope: `s${++n}`, deployment: "unit" };
}
function spec(k: SandboxKey, size?: ResolvedSize): SandboxSpec {
  return {
    image: { name: "selfbuilding-codex", ref: "selfbuilding/codex:1.0.0", version: "1.0.0" },
    env: {},
    lifetimeMs: 60_000,
    onExpire: "pause",
    labels: {
      [SELFBUILDING_LABELS.deployment]: k.deployment,
      [SELFBUILDING_LABELS.run]: k.runId,
      [SELFBUILDING_LABELS.name]: `ns-${k.scope}`,
      ...(size ? { [SELFBUILDING_LABELS.size]: size.name } : {}),
    },
    ...(size ? { size, resources: { vcpu: size.vcpu, memoryMiB: size.memoryMiB } } : {}),
  };
}

describe("template naming", () => {
  it("keeps small on the unsuffixed template and suffixes every other size", () => {
    expect(templateNameFor("selfbuilding-codex", "small")).toBe("selfbuilding-codex");
    expect(templateNameFor("selfbuilding-codex", "medium")).toBe("selfbuilding-codex-medium");
    expect(templateNameFor("selfbuilding-claude-code", "large")).toBe("selfbuilding-claude-code-large");
    expect(templateNameFor("selfbuilding-codex", "xlarge")).toBe("selfbuilding-codex-xlarge");
  });

  it("defines a sized template with the size's cpu, memory and disk", () => {
    const def = e2bTemplate("selfbuilding-codex", {
      version: "1.2.3",
      size: { name: "big-disk", vcpu: 4, memoryMiB: 8192, diskGiB: 100 },
      registry: "ghcr.io/acme/",
    });
    expect(def).toMatchObject({
      alias: "selfbuilding-codex-big-disk",
      fromImage: "ghcr.io/acme/selfbuilding/codex:1.2.3",
      cpuCount: 4,
      memoryMB: 8192,
      minFreeDiskMb: 102400,
      size: "big-disk",
    });
    expect(e2bTemplate("selfbuilding-codex", { version: "1" })).not.toHaveProperty("minFreeDiskMb");
  });
});

describe("templateSizing and provider options", () => {
  it("defaults to small only, inherits on fork and never resizes", () => {
    const sizing = templateSizing({ limits: {} });
    expect(sizing).toMatchObject({ kind: "template", forkSize: "inherit", resize: false, available: ["small"] });
    expect(sizing.templateFor("selfbuilding-codex", "medium")).toBe("selfbuilding-codex-medium");
  });

  it("rejects a malformed size name at construction", () => {
    expect(() => templateSizing({ available: ["Medium!"], limits: {} })).toThrow(ConfigError);
  });

  it("e2b() carries the plan's limits and the built sizes", () => {
    const hobby = e2b({ apiKey: "k", template: "selfbuilding-codex", sizes: ["small", "medium"] });
    expect(hobby.sizing).toMatchObject({
      kind: "template",
      available: ["small", "medium"],
      limits: { maxVcpu: 8, maxMemoryMiB: 8192 },
    });
    const pro = e2b({ apiKey: "k", template: "selfbuilding-codex", plan: "pro" });
    expect(pro.sizing?.limits.maxVcpu).toBe(8);
    expect(pro.sizing?.limits.maxMemoryMiB).toBeUndefined();
    expect(pro.limits.maxLifetimeMs).toBe(24 * 60 * 60 * 1000);
    const custom = e2b({ apiKey: "k", template: "selfbuilding-codex", sizeLimits: { maxVcpu: 16 } });
    expect(custom.sizing?.limits.maxVcpu).toBe(16);
  });
});

describe("provider guard (defence in depth)", () => {
  it("creates a sized box from the size's template", async () => {
    const { fake, provider } = setup(["small", "medium"]);
    const k = key();
    const { handle } = await provider.openOrCreate(k, spec(k, MEDIUM));
    expect(fake.callsTo("create")[0]?.opts).toMatchObject({ template: "selfbuilding-codex-medium" });
    expect(handle.ref.size).toBe("medium");
    const found = await provider.find(k);
    expect(found?.size).toBe("medium");
    await provider.kill(handle.ref);
  });

  it("uses the unsuffixed template for small and for no size", async () => {
    const { fake, provider } = setup(["small"]);
    for (const size of [SMALL, undefined]) {
      const k = key();
      const { handle } = await provider.openOrCreate(k, spec(k, size));
      await provider.kill(handle.ref);
    }
    expect(fake.callsTo("create").map((c) => c.opts?.template)).toEqual(["selfbuilding-codex", "selfbuilding-codex"]);
  });

  it("refuses a size whose template was not built, naming the build command, before any vendor call", async () => {
    const { fake, provider } = setup(["small"]);
    const k = key();
    const error = await provider.openOrCreate(k, spec(k, MEDIUM)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SizeUnavailableError);
    expect(error).toMatchObject({ reason: "not-built", size: "medium" });
    expect((error as Error).message).toContain(
      'Build it: selfbuilding images build --provider e2b --harness all --size medium, then add "medium" to e2b({ sizes }).',
    );
    expect(fake.calls).toEqual([]);
  });

  it("refuses large on Hobby with the plan's fix even when listed as built", async () => {
    const { provider } = setup(["small", "large"]);
    const k = key();
    await expect(provider.openOrCreate(k, spec(k, LARGE))).rejects.toThrow(
      /E2B Hobby allows 8 vCPU and 8 GiB per sandbox/,
    );
  });

  it("refuses a fork that asks for a size other than the parent's", async () => {
    const { provider } = setup(["small", "medium"]);
    const ref = {
      provider: "e2b",
      id: "x",
      name: "n",
      key: key(),
      deployment: "unit",
      state: "running" as const,
      createdAt: new Date().toISOString(),
      labels: {},
      size: "small",
    };
    await expect(provider.fork?.(ref, { children: [], lifetimeMs: 60_000, size: MEDIUM })).rejects.toMatchObject({
      reason: "fork-inherits",
    });
  });
});

describe("template image builder", () => {
  function fakeApi() {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    return {
      calls,
      api: {
        async build(def: unknown, o: { tags: string[]; onLog?: (l: string) => void }) {
          calls.push({ op: "build", args: [def, o.tags] });
          o.onLog?.("pulling with key e2b_secret_value");
        },
        async assignTags(target: string, tags: string[]) {
          calls.push({ op: "assignTags", args: [target, tags] });
        },
      },
    };
  }
  const now = () => new Date("2026-11-02T10:00:00Z");

  it("builds the size's template, then moves default only after success", async () => {
    const { calls, api } = fakeApi();
    const builder = templateImageBuilder({
      provider: "e2b",
      sizing: templateSizing({ available: [], limits: E2B_SIZE_LIMITS.hobby }),
      api: () => api,
      disk: true,
      redact: ["e2b_secret_value"],
      now,
    });
    expect(builder.nameFor("codex", "medium")).toBe("selfbuilding-codex-medium");
    const logs: string[] = [];
    const result = await builder.build({
      harness: "codex",
      size: MEDIUM,
      version: "1.2.3",
      name: "selfbuilding-codex-medium",
      onLog: (l) => logs.push(l),
    });
    expect(result).toMatchObject({ ok: true, provider: "e2b", size: "medium", name: "selfbuilding-codex-medium" });
    expect(calls.map((c) => c.op)).toEqual(["build", "assignTags"]);
    expect(calls[0]?.args[0]).toMatchObject({ alias: "selfbuilding-codex-medium", cpuCount: 4, memoryMB: 8192 });
    expect(calls[0]?.args[1]).toEqual(["1.2.3", "2026-11-02"]);
    expect(calls[1]?.args).toEqual(["selfbuilding-codex-medium:1.2.3", ["default"]]);
    expect(logs).toEqual(["pulling with key [redacted]"]);
  });

  it("refuses an over-limit size without loading the SDK", async () => {
    let loaded = false;
    const builder = templateImageBuilder({
      provider: "e2b",
      sizing: templateSizing({ available: [], limits: E2B_SIZE_LIMITS.hobby }),
      api: () => {
        loaded = true;
        return fakeApi().api;
      },
      disk: true,
    });
    const result = await builder.build({
      harness: "codex",
      size: LARGE,
      version: "1",
      name: "selfbuilding-codex-large",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "size_unavailable" } });
    expect(loaded).toBe(false);
  });

  it("refuses a disk size on a vendor that takes none", async () => {
    const builder = templateImageBuilder({
      provider: "impello",
      sizing: templateSizing({ available: [], limits: {} }),
      api: () => fakeApi().api,
      disk: false,
    });
    const result = await builder.build({
      harness: "codex",
      size: { name: "big-disk", vcpu: 2, memoryMiB: 4096, diskGiB: 50 },
      version: "1",
      name: "selfbuilding-codex-big-disk",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "size_unavailable", details: { reason: "invalid-shape" } },
    });
  });

  it("wraps a vendor failure as image_unavailable, scrubbed, and never moves default", async () => {
    const { calls, api } = fakeApi();
    api.build = async () => {
      throw new Error("401 for key e2b_secret_value");
    };
    const builder = templateImageBuilder({
      provider: "e2b",
      sizing: templateSizing({ available: [], limits: {} }),
      api: () => api,
      disk: true,
      redact: ["e2b_secret_value"],
    });
    const result = await builder.build({ harness: "codex", size: SMALL, version: "1", name: "selfbuilding-codex" });
    expect(result).toMatchObject({ ok: false, error: { code: "image_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("e2b_secret_value");
    expect(calls).toEqual([]);
  });

  it("refuses a name that breaks the naming rule", async () => {
    const builder = templateImageBuilder({
      provider: "e2b",
      sizing: templateSizing({ available: [], limits: {} }),
      api: () => fakeApi().api,
      disk: true,
    });
    const result = await builder.build({ harness: "codex", size: MEDIUM, version: "1", name: "selfbuilding-codex" });
    expect(result).toMatchObject({ ok: false, error: { code: "config" } });
  });
});

describe("e2b SDK binding", () => {
  it("drives Template from the registry image with explicit credentials, the size and the tags", async () => {
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
    const builder = e2bImageBuilder({
      apiKey: "e2b_key_123",
      registry: "ghcr.io/acme",
      template: T as unknown as Parameters<typeof e2bTemplateApi>[1],
    });
    const result = await builder.build({
      harness: "claude-code",
      size: { name: "big-disk", vcpu: 4, memoryMiB: 8192, diskGiB: 20 },
      version: "2.0.0",
      name: "selfbuilding-claude-code-big-disk",
    });
    expect(result.ok).toBe(true);
    expect(steps).toEqual([
      ["fromImage", "ghcr.io/acme/selfbuilding/claude-code:2.0.0"],
      ["setUser", "agent"],
      ["setWorkdir", "/selfbuilding/work"],
      ["runCmd", ["/usr/local/bin/claude --version", "test -f /opt/selfbuilding/image-manifest.json"]],
    ]);
    expect(builds[0]).toEqual([
      "selfbuilding-claude-code-big-disk",
      expect.objectContaining({
        apiKey: "e2b_key_123",
        domain: "e2b.app",
        cpuCount: 4,
        memoryMB: 8192,
        minFreeDiskMb: 20480,
      }),
    ]);
    expect(tags[0]).toEqual([
      "selfbuilding-claude-code-big-disk:2.0.0",
      ["default"],
      expect.objectContaining({ apiKey: "e2b_key_123" }),
    ]);
  });
});
