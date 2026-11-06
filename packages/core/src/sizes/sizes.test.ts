import { describe, expect, it } from "vitest";
import { defineConfig, validateConfig } from "../config/index.js";
import { ConfigError, SizeUnavailableError, SizeUnknownError } from "../errors/classes.js";
import type { SandboxProvider } from "../types/sandbox.js";
import { BUILT_IN_SIZES, type ProviderSizing, type SizeLimits } from "../types/sizes.js";
import { checkSize, resolveSize, sizeForSpec, sizeTable } from "./index.js";

function provider(id: string, sizing?: ProviderSizing): SandboxProvider {
  return { id, ...(sizing ? { sizing } : {}) } as unknown as SandboxProvider;
}

function template(available: string[], limits: SizeLimits): ProviderSizing {
  return {
    kind: "template",
    forkSize: "inherit",
    resize: false,
    available,
    limits,
    templateFor: (base, size) => (size === "small" ? base : `${base}-${size}`),
  };
}

const create = (limits: SizeLimits = {}, forkSize: "inherit" | "override" = "override"): ProviderSizing => ({
  kind: "create",
  forkSize,
  resize: false,
  limits,
});

describe("sizeTable", () => {
  it("holds the three built-ins with the owner's numbers", () => {
    const table = sizeTable({});
    expect(table).toEqual({
      small: { vcpu: 2, memoryMiB: 4096 },
      medium: { vcpu: 4, memoryMiB: 8192 },
      large: { vcpu: 8, memoryMiB: 16384 },
    });
    expect(Object.isFrozen(table)).toBe(true);
  });

  it("adds custom names on top of the built-ins", () => {
    const table = sizeTable({
      sizes: { xlarge: { vcpu: 16, memoryMiB: 32768 }, "big-disk": { vcpu: 4, memoryMiB: 8192, diskGiB: 100 } },
    });
    expect(Object.keys(table)).toEqual(["small", "medium", "large", "xlarge", "big-disk"]);
    expect(table["big-disk"]).toEqual({ vcpu: 4, memoryMiB: 8192, diskGiB: 100 });
  });

  it("allows a built-in repeated with identical numbers and refuses one redefined", () => {
    expect(sizeTable({ sizes: { medium: { vcpu: 4, memoryMiB: 8192 } } }).medium).toEqual(BUILT_IN_SIZES.medium);
    expect(() => sizeTable({ sizes: { medium: { vcpu: 6, memoryMiB: 8192 } } })).toThrow(ConfigError);
    expect(() => sizeTable({ sizes: { large: { vcpu: 8, memoryMiB: 8192 } } })).toThrow(/redefines a built-in/);
  });

  it.each([
    ["Bad", { vcpu: 2, memoryMiB: 4096 }, /must match/],
    ["1x", { vcpu: 2, memoryMiB: 4096 }, /must match/],
    ["a".repeat(25), { vcpu: 2, memoryMiB: 4096 }, /must match/],
    ["half", { vcpu: 0.5, memoryMiB: 4096 }, /vcpu must be a positive integer/],
    ["zero", { vcpu: 2, memoryMiB: 0 }, /memoryMiB must be a positive integer/],
    ["disk", { vcpu: 2, memoryMiB: 4096, diskGiB: -1 }, /diskGiB must be a positive integer/],
  ])("refuses %s", (name, size, message) => {
    expect(() => sizeTable({ sizes: { [name]: size } })).toThrow(message);
  });
});

describe("config validation of sizes", () => {
  it("fails at defineConfig and at validateConfig", () => {
    const bad = { sizes: { small: { vcpu: 4, memoryMiB: 4096 } } };
    expect(() => defineConfig(bad)).toThrow(ConfigError);
    expect(() => validateConfig(bad)).toThrow(/config\.sizes\.small redefines/);
    expect(defineConfig({ sizes: { xlarge: { vcpu: 16, memoryMiB: 32768 } } }).sizes).toBeDefined();
  });
});

describe("resolveSize", () => {
  it("resolves built-in and custom names", () => {
    expect(resolveSize({}, "medium")).toEqual({ name: "medium", vcpu: 4, memoryMiB: 8192 });
    expect(resolveSize({ sizes: { xl: { vcpu: 16, memoryMiB: 32768, diskGiB: 50 } } }, "xl")).toEqual({
      name: "xl",
      vcpu: 16,
      memoryMiB: 32768,
      diskGiB: 50,
    });
  });

  it("throws SizeUnknownError naming the known sizes", () => {
    const error = (() => {
      try {
        resolveSize({}, "huge");
      } catch (e) {
        return e;
      }
    })() as SizeUnknownError;
    expect(error).toBeInstanceOf(SizeUnknownError);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe("size_unknown");
    expect(error.known).toEqual(["small", "medium", "large"]);
    expect(() => resolveSize({}, "toString")).toThrow(SizeUnknownError);
  });
});

describe("checkSize", () => {
  const medium = resolveSize({}, "medium");
  const large = resolveSize({}, "large");
  const small = resolveSize({}, "small");

  it("refuses every size on a provider that takes none", () => {
    expect(checkSize(provider("plain"), small)).toEqual({
      ok: false,
      reason: "not-sizable",
      fix: 'Provider "plain" takes no sizes. Drop the size option, or run this call on a provider that sizes boxes (docker, e2b, impello).',
    });
  });

  it("refuses a fork child whose size differs on a provider whose forks inherit", () => {
    const e2b = provider("e2b", template(["small", "medium"], { maxVcpu: 8, maxMemoryMiB: 8192 }));
    expect(checkSize(e2b, medium, { fork: { parentSize: "medium" } })).toEqual({ ok: true });
    expect(checkSize(e2b, medium, { fork: { parentSize: "small" } })).toEqual({
      ok: false,
      reason: "fork-inherits",
      fix: 'Forks on "e2b" keep the parent\'s size (small). Create the parent at "medium", or run this call on a fresh box.',
    });
    // The unsuffixed template is small, so a parent created with no size counts as small.
    expect(checkSize(e2b, small, { fork: {} }).ok).toBe(true);
    expect(checkSize(e2b, medium, { fork: {} }).ok).toBe(false);
    // Override providers take any child size.
    expect(checkSize(provider("docker", create()), large, { fork: { parentSize: "small" } }).ok).toBe(true);
  });

  it("refuses sizes over the limit with the provider's fix", () => {
    const hobby = provider("e2b", template(["small", "medium", "large"], { maxVcpu: 8, maxMemoryMiB: 8192 }));
    expect(checkSize(hobby, large)).toEqual({
      ok: false,
      reason: "over-limit",
      fix: 'E2B Hobby allows 8 vCPU and 8 GiB per sandbox. Use medium, upgrade the plan and pass e2b({ plan: "pro" }), or run this size on Docker.',
    });
    const impello = provider("impello", template(["small", "medium", "large"], { maxVcpu: 4 }));
    expect(checkSize(impello, large)).toEqual({
      ok: false,
      reason: "over-limit",
      fix: "Impello has no 8 vCPU pool yet. Use medium, or run this size on Docker or E2B.",
    });
    const docker = provider("docker", create({ maxVcpu: 4, maxMemoryMiB: 8192 }));
    const refused = checkSize(docker, large);
    expect(refused.ok === false && refused.reason).toBe("over-limit");
    expect(refused.ok === false && refused.fix).toMatch(
      /^Docker host limit set in docker\(\{ maxVcpu, maxMemoryMiB \}\)/,
    );
    const disk = provider("x", create({ maxDiskGiB: 10 }));
    expect(checkSize(disk, { name: "d", vcpu: 2, memoryMiB: 4096, diskGiB: 20 }).ok).toBe(false);
  });

  it("refuses a shape the provider does not offer", () => {
    const vercel = provider("vercel", create({ memoryPerVcpuMiB: 2048, vcpuChoices: [2, 4, 8] }));
    expect(checkSize(vercel, { name: "v", vcpu: 4, memoryMiB: 8192 })).toEqual({ ok: true });
    expect(checkSize(vercel, medium)).toEqual({ ok: true });
    expect(checkSize(vercel, { name: "odd", vcpu: 3, memoryMiB: 6144 })).toEqual({
      ok: false,
      reason: "invalid-shape",
      fix: '"vercel" offers 2, 4, 8 vCPU with 2048 MiB per vCPU. Define a size with one of them in the config\'s sizes table.',
    });
    expect(checkSize(vercel, { name: "fat", vcpu: 2, memoryMiB: 8192 }).ok).toBe(false);
  });

  it("refuses a template size that was never built, and names the template of one that was", () => {
    const e2b = provider("e2b", template(["small"], { maxVcpu: 8, maxMemoryMiB: 8192 }));
    expect(checkSize(e2b, medium, { harness: "codex" })).toEqual({
      ok: false,
      reason: "not-built",
      fix: 'Build it: selfbuilding images build --provider e2b --harness codex --size medium, then add "medium" to e2b({ sizes }).',
    });
    expect(checkSize(e2b, small, { baseTemplate: "selfbuilding-codex" })).toEqual({
      ok: true,
      template: "selfbuilding-codex",
    });
    const both = provider("e2b", template(["small", "medium"], { maxVcpu: 8, maxMemoryMiB: 8192 }));
    expect(checkSize(both, medium, { baseTemplate: "selfbuilding-codex" })).toEqual({
      ok: true,
      template: "selfbuilding-codex-medium",
    });
  });

  it("checks rules in the documented order: fork before limit before build", () => {
    const e2b = provider("e2b", template(["small"], { maxVcpu: 4 }));
    const fork = checkSize(e2b, large, { fork: { parentSize: "small" } });
    expect(fork.ok === false && fork.reason).toBe("fork-inherits");
    const limit = checkSize(e2b, large);
    expect(limit.ok === false && limit.reason).toBe("over-limit");
  });
});

describe("sizeForSpec", () => {
  it("is undefined when nothing asked for a size", () => {
    expect(sizeForSpec({}, provider("plain"), undefined)).toBeUndefined();
  });

  it("resolves and checks, throwing typed errors whose message ends with the fix", () => {
    const docker = provider("docker", create());
    expect(sizeForSpec({}, docker, "large")).toEqual({ name: "large", vcpu: 8, memoryMiB: 16384 });
    expect(() => sizeForSpec({}, docker, "nope")).toThrow(SizeUnknownError);
    try {
      sizeForSpec({}, provider("plain"), "small");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SizeUnavailableError);
      const e = error as SizeUnavailableError;
      expect(e.code).toBe("size_unavailable");
      expect(e.retryable).toBe(false);
      expect({ provider: e.provider, size: e.size, vcpu: e.vcpu, memoryMiB: e.memoryMiB, reason: e.reason }).toEqual({
        provider: "plain",
        size: "small",
        vcpu: 2,
        memoryMiB: 4096,
        reason: "not-sizable",
      });
      expect(e.message.endsWith(e.fix)).toBe(true);
    }
  });
});
