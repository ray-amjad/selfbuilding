import {
  EgressPolicyUnsupportedError,
  type ProviderLimits,
  type SandboxKey,
  type SandboxProvider,
  type SandboxSpec,
  SandboxUnavailableError,
  SELFBUILDING_LABELS,
} from "@selfbuilding/core";
import { afterAll, describe, expect, it } from "vitest";
import { FAST, FakeE2b, type FakeE2bOptions } from "../test/fake-e2b.js";
import type { E2bCommandOpts, E2bSandbox, E2bShapeClient } from "./client.js";
import { createE2bShapeProvider, e2bClient } from "./index.js";
import { EGRESS_PROBE_RETRIES, egressProbeTarget } from "./provider.js";

// release-prep §7.1 #3 and #4: a probe that could not run is not a leak, and the probe target is chosen by what
// the allowlist covers, not by substring.

const LIMITS: ProviderLimits = { maxLifetimeMs: 24 * 60 * 60 * 1000, lifetimeGuaranteed: true, expireKeeps: "memory" };

const fakes: FakeE2b[] = [];
afterAll(async () => {
  await Promise.all(fakes.map((f) => f.close()));
});

const isProbe = (cmd: string) => cmd.includes(".connect(443,");

/** Wraps every box the client hands out so its probe command goes through `probe` instead. */
function withProbe(
  c: E2bShapeClient,
  probe: (
    cmd: string,
    opts: E2bCommandOpts,
    run: E2bSandbox["commands"]["run"],
  ) => ReturnType<E2bSandbox["commands"]["run"]>,
): E2bShapeClient {
  const wrap = (sb: E2bSandbox): E2bSandbox => {
    const run: E2bSandbox["commands"]["run"] = (cmd, opts) => sb.commands.run(cmd, opts);
    return Object.assign(Object.create(sb) as E2bSandbox, {
      commands: { run: (cmd: string, opts: E2bCommandOpts) => (isProbe(cmd) ? probe(cmd, opts, run) : run(cmd, opts)) },
    });
  };
  return {
    ...c,
    create: async (template, opts) => wrap(await c.create(template, opts)),
    connect: async (id, opts) => wrap(await c.connect(id, opts)),
  };
}

function setup(o: { fake?: FakeE2bOptions; client?: (c: E2bShapeClient) => E2bShapeClient }) {
  const fake = new FakeE2b(o.fake);
  fakes.push(fake);
  const base = e2bClient(fake.client as unknown as Parameters<typeof e2bClient>[0]);
  const provider = createE2bShapeProvider({
    id: "e2b",
    client: o.client ? o.client(base) : base,
    template: "selfbuilding-claude-code",
    apiKey: "e2b_unit",
    domain: "fake.local",
    limits: LIMITS,
    connection: { retries: 0 },
    timings: FAST,
    verifyEgress: true,
  });
  return { fake, provider };
}

let n = 0;
const key = (scope = `ep${++n}`): SandboxKey => ({ runId: "run-egress-probe", scope, deployment: "unit" });
function spec(k: SandboxKey, over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: { name: "selfbuilding-claude-code", ref: "selfbuilding/claude-code:1.0.0", version: "1.0.0" },
    env: {},
    lifetimeMs: 30 * 60 * 1000,
    onExpire: "pause",
    network: "deny-all",
    ...over,
    labels: {
      [SELFBUILDING_LABELS.deployment]: k.deployment,
      [SELFBUILDING_LABELS.run]: k.runId,
      [SELFBUILDING_LABELS.name]: `ns-${k.scope}`,
      ...over.labels,
    },
  };
}
const rateLimit = () => Object.assign(new Error("Rate limit exceeded - injected"), { name: "RateLimitError" });

async function liveIds(provider: SandboxProvider, k: SandboxKey): Promise<string[]> {
  const ids: string[] = [];
  for await (const ref of provider.list({ deployment: k.deployment, runId: k.runId })) {
    if (ref.key.scope === k.scope) ids.push(ref.id);
  }
  return ids;
}

describe("egressProbeTarget: coverage, not substrings", () => {
  it("an entry that only contains a probe address as a substring does not cover it", () => {
    expect(egressProbeTarget(["1.1.1.1/32", "8.8.8.80"])).toBe("8.8.8.8");
    expect(egressProbeTarget(["11.1.1.1", "1.1.1.10"])).toBe("1.1.1.1");
  });

  it("exact IPs, IPs with a port and CIDR ranges cover; hostnames cover only an equal host", () => {
    expect(egressProbeTarget(["1.1.1.1"])).toBe("8.8.8.8");
    expect(egressProbeTarget(["1.1.1.1:443"])).toBe("8.8.8.8");
    expect(egressProbeTarget(["1.0.0.0/8"])).toBe("8.8.8.8");
    expect(egressProbeTarget(["1.1.1.0/24", "8.8.0.0/16"])).toBeUndefined();
    expect(egressProbeTarget(["1.1.1.2/31"])).toBe("1.1.1.1");
    expect(egressProbeTarget(["one.one.one.one", "github.com"])).toBe("1.1.1.1");
    expect(egressProbeTarget(["0.0.0.0/0"])).toBeUndefined();
    expect(egressProbeTarget([])).toBe("1.1.1.1");
  });
});

describe("verifyEgress: a probe that could not run", () => {
  it("is retried with backoff and passes once it runs", async () => {
    let probes = 0;
    const { fake, provider } = setup({
      client: (c) =>
        withProbe(c, async (cmd, opts, run) => {
          if (++probes <= 2) throw rateLimit();
          return run(cmd, opts);
        }),
    });
    const k = key();
    const { handle, created } = await provider.openOrCreate(k, spec(k));
    expect(created).toBe(true);
    expect(probes).toBe(3);
    expect(fake.callsTo("kill")).toHaveLength(0);
    expect(await liveIds(provider, k)).toEqual([handle.ref.id]);
  });

  it("after the retries fails the create with a retryable SandboxUnavailableError and kills only its own box", async () => {
    for (const fault of ["429", "exit"] as const) {
      let probes = 0;
      const { fake, provider } = setup({
        // The vendor ignores egress: a probe that ran would report a leak. It never runs.
        fake: { ignoreEgress: true },
        client: (c) =>
          withProbe(c, async (_cmd, opts, run) => {
            probes++;
            if (fault === "429") throw rateLimit();
            return run("echo 'node: not found' >&2; exit 127", opts);
          }),
      });
      const k = key();
      const error = await provider.openOrCreate(k, spec(k)).catch((e: unknown) => e);
      expect(error, fault).toBeInstanceOf(SandboxUnavailableError);
      expect(error, fault).not.toBeInstanceOf(EgressPolicyUnsupportedError);
      expect((error as SandboxUnavailableError).retryable, fault).toBe(true);
      expect(String((error as Error).cause), fault).toMatch(/could not run/);
      expect(probes, fault).toBe(EGRESS_PROBE_RETRIES + 1);
      expect(fake.callsTo("create"), fault).toHaveLength(1);
      expect(fake.callsTo("kill"), fault).toHaveLength(1);
      expect(await liveIds(provider, k), fault).toEqual([]);
    }
  });

  it("a box openOrCreate converged onto is neither probed nor killed", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let probes = 0;
    const { provider } = setup({
      client: (c) =>
        withProbe(
          {
            ...c,
            create: async (template, opts) => {
              if (calls++ === 0) await gate;
              return c.create(template, opts);
            },
          },
          async (cmd, opts, run) => {
            probes++;
            return run(cmd, opts);
          },
        ),
    });
    const k = key();
    const slow = provider.openOrCreate(k, spec(k));
    while (calls === 0) await new Promise((r) => setTimeout(r, 5));
    const fast = await provider.openOrCreate(k, spec(k));
    expect(probes).toBe(1);
    release();
    const late = await slow;
    expect(late.created).toBe(false);
    expect(late.handle.ref.id).toBe(fast.handle.ref.id);
    expect(probes).toBe(1);
    expect(await liveIds(provider, k)).toEqual([fast.handle.ref.id]);
  });
});
