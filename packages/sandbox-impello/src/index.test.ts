import { ConfigError, SANDBOX_PATHS, SandboxNotFoundError, SandboxUnavailableError } from "@selfbuilding/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { FakeE2b } from "../../sandbox-e2b/test/fake-e2b.js";

// The Impello SDK is replaced by the offline vendor double in its own error flavour ("<status>: " prefixes, no
// statusCode). The stock E2B client must never load for Impello: importing it fails this file.
vi.mock("@impello/sdk", async () => {
  const { FakeE2b } = await import("../../sandbox-e2b/test/fake-e2b.js");
  const fake = new FakeE2b({ flavor: "impello" });
  return { Sandbox: fake.client, fake };
});
vi.mock("e2b", () => {
  throw new Error("the stock e2b SDK was loaded by the Impello provider");
});

const sdk = (await import("@impello/sdk")) as unknown as { fake: FakeE2b };
const { impello } = await import("./index.js");
afterAll(() => sdk.fake.close());

const key = (scope: string) => ({ runId: "run-imp", scope, deployment: "unit" });
const spec = (scope: string) => ({
  image: { name: "selfbuilding-claude-code", ref: "selfbuilding/claude-code:1.0.0", version: "1.0.0" },
  env: {},
  lifetimeMs: 30 * 60 * 1000,
  onExpire: "pause" as const,
  labels: { "selfbuilding.name": `ns-${scope}` },
});

describe("impello()", () => {
  it("drives @impello/sdk with the key it was given, on Impello's domain, never the e2b client", async () => {
    const provider = impello({ apiKey: "imp_test_key", template: "selfbuilding-claude-code" });
    expect(provider.id).toBe("impello");
    const { handle, created } = await provider.openOrCreate(key("a"), spec("a"));
    expect(created).toBe(true);
    expect((await handle.exec("echo hi")).stdoutTail).toBe("hi\n");
    const kill = await provider.kill(handle.ref);
    expect(kill.path).toBe("killed");
    expect(sdk.fake.callsTo("kill").at(-1)?.opts).toMatchObject({
      apiKey: "imp_test_key",
      domain: "sandbox.impello.ai",
      apiUrl: "https://api.sandbox.impello.ai",
      debug: false,
    });
    const create = sdk.fake.callsTo("create").at(-1)?.opts as Record<string, unknown>;
    expect(create).toMatchObject({
      template: "selfbuilding-claude-code",
      timeoutMs: 30 * 60 * 1000,
      lifecycle: { onTimeout: "pause" },
    });
  });

  it("classifies Impello-flavoured errors: a 503 prefix is an outage, a not-found is a confirmed miss", async () => {
    const provider = impello({ apiKey: "imp_test_key", template: "selfbuilding-codex", domain: "impello.test" });
    const { handle } = await provider.openOrCreate(key("b"), spec("b"));
    sdk.fake.inject("503", "connect");
    await expect(provider.open(handle.ref, { lifetimeMs: 60_000 })).rejects.toBeInstanceOf(SandboxUnavailableError);
    await provider.kill(handle.ref);
    await expect(provider.open(handle.ref, { lifetimeMs: 60_000 })).rejects.toBeInstanceOf(SandboxNotFoundError);
    expect(sdk.fake.callsTo("connect").at(-1)?.opts).toMatchObject({ apiUrl: "https://api.impello.test" });
  });

  it("delivers secrets as 0600 files, never as env", async () => {
    const provider = impello({ apiKey: "imp_test_key", template: "selfbuilding-claude-code" });
    const { handle } = await provider.openOrCreate(key("c"), spec("c"));
    await handle.writeFiles([{ path: `${SANDBOX_PATHS.secrets}/CLAUDE_CODE_OAUTH_TOKEN`, data: "oauth-secret-123" }]);
    expect((await handle.exec(`stat -c %a ${SANDBOX_PATHS.secrets}/CLAUDE_CODE_OAUTH_TOKEN`)).stdoutTail.trim()).toBe(
      "600",
    );
    expect(sdk.fake.calls.some((c) => JSON.stringify(c.opts ?? {}).includes("oauth-secret-123"))).toBe(false);
  });

  it("takes limits from the plan tier, strictest by default", () => {
    const trial = impello({ apiKey: "imp_x", template: "selfbuilding-claude-code" });
    expect(trial.limits).toEqual({
      maxLifetimeMs: 60 * 60 * 1000,
      maxConcurrent: 2,
      createsPerMinute: 5,
      lifetimeGuaranteed: true,
      expireKeeps: "memory",
    });
    const big = impello({ apiKey: "imp_x", template: "selfbuilding-claude-code", tier: "plan500" });
    expect(big.limits).toMatchObject({ maxLifetimeMs: 24 * 60 * 60 * 1000, maxConcurrent: 300, createsPerMinute: 65 });
    const custom = impello({
      apiKey: "imp_x",
      template: "selfbuilding-claude-code",
      tier: "plan20",
      limits: { maxConcurrent: 4 },
    });
    expect(custom.limits).toMatchObject({ maxLifetimeMs: 12 * 60 * 60 * 1000, maxConcurrent: 4 });
  });

  it("refuses Impello's stock templates, naming the selfbuilding one", () => {
    expect(() => impello({ apiKey: "imp_x", template: "claude" })).toThrow(ConfigError);
    expect(() => impello({ apiKey: "imp_x", template: "codex" })).toThrow(/selfbuilding-codex/);
  });

  it("offers snapshot and fork through the SDK's createSnapshot", () => {
    const provider = impello({ apiKey: "imp_x", template: "selfbuilding-claude-code" });
    expect(typeof provider.snapshot).toBe("function");
    expect(typeof provider.fork).toBe("function");
  });
});
