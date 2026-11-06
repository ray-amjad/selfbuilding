import {
  EgressPolicyUnsupportedError,
  type ProviderLimits,
  type ProviderSandbox,
  type SandboxKey,
  type SandboxProvider,
  SandboxQuotaError,
  type SandboxSpec,
  SELFBUILDING_LABELS,
} from "@selfbuilding/core";
import { describeSandboxProvider, limitConcurrency } from "@selfbuilding/sandbox-conformance";
import { afterAll, describe, expect, it } from "vitest";
import { FAST, FakeE2b, type FakeE2bOptions } from "../test/fake-e2b.js";
import type { E2bPaginator, E2bSandboxInfo, E2bShapeClient } from "./client.js";
import { classify, retryAfterOf } from "./errors.js";
import { createE2bShapeProvider, e2bClient } from "./index.js";
import { EGRESS_PROBE_TARGETS, egressProbeCommand } from "./provider.js";

// Regressions from the first live run on Impello and E2B: deny-all accepted but not enforced, 429s during the
// conformance suite, a race that left two boxes for one key, and a fork that failed on a rate limit.

const LIMITS: ProviderLimits = { maxLifetimeMs: 24 * 60 * 60 * 1000, lifetimeGuaranteed: true, expireKeeps: "memory" };

const fakes: FakeE2b[] = [];
afterAll(async () => {
  await Promise.all(fakes.map((f) => f.close()));
});

function setup(o: { fake?: FakeE2bOptions; verifyEgress?: boolean; client?: (c: E2bShapeClient) => E2bShapeClient }) {
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
    ...(o.verifyEgress === undefined ? {} : { verifyEgress: o.verifyEgress }),
  });
  return { fake, provider };
}

let n = 0;
const key = (scope = `lf${++n}`): SandboxKey => ({ runId: "run-live-fixes", scope, deployment: "unit" });
function spec(k: SandboxKey, over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: { name: "selfbuilding-claude-code", ref: "selfbuilding/claude-code:1.0.0", version: "1.0.0" },
    env: {},
    lifetimeMs: 30 * 60 * 1000,
    onExpire: "pause",
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

describe("egress: a policy the vendor accepts but does not enforce", () => {
  it("the probe command connects with node and reports by exit code, to a public address", () => {
    expect(egressProbeCommand("1.1.1.1")).toMatch(/^node -e '.*connect\(443,"1\.1\.1\.1"\)/);
    expect(EGRESS_PROBE_TARGETS[0]).toBe("1.1.1.1");
  });

  it("probeEgress reports the leak; by default the box is still handed out", async () => {
    const { provider } = setup({ fake: { ignoreEgress: true } });
    const k = key();
    const { handle } = await provider.openOrCreate(k, spec(k, { network: "deny-all" }));
    const verdict = await provider.probeEgress?.(handle, "deny-all");
    expect(verdict).toMatchObject({ enforced: false });
    expect(verdict?.detail).toMatch(/connected to 1\.1\.1\.1:443/);
  });

  it("with verifyEgress the create is refused with EgressPolicyUnsupportedError and the leaky box is killed", async () => {
    const { fake, provider } = setup({ fake: { ignoreEgress: true }, verifyEgress: true });
    const k = key();
    const error = await provider.openOrCreate(k, spec(k, { network: "deny-all" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressPolicyUnsupportedError);
    expect(error).toMatchObject({ provider: "e2b", requested: "deny-all" });
    expect(fake.callsTo("create")).toHaveLength(1);
    expect(fake.callsTo("kill")).toHaveLength(1);
    expect(await liveIds(provider, k)).toEqual([]);
  });

  it("with verifyEgress an enforcing vendor's box passes, and open boxes are never probed", async () => {
    const { fake, provider } = setup({ verifyEgress: true });
    const k = key();
    const { handle } = await provider.openOrCreate(k, spec(k, { network: "deny-all" }));
    expect(await provider.probeEgress?.(handle, "deny-all")).toMatchObject({ enforced: true });
    const before = fake.callsTo("commands.run").length;
    const open = key();
    await provider.openOrCreate(open, spec(open, { network: "open" }));
    const probes = fake.callsTo("commands.run").slice(before);
    expect(probes.some((c) => JSON.stringify(c.opts ?? {}).includes("1.1.1.1"))).toBe(false);
  });

  it("an allowlist is probed at an address outside it", async () => {
    const { provider } = setup({ fake: { ignoreEgress: true } });
    const k = key();
    const { handle } = await provider.openOrCreate(k, spec(k, { network: { allow: ["1.1.1.1/32"] } }));
    const verdict = await provider.probeEgress?.(handle, { allow: ["1.1.1.1/32"] });
    expect(verdict?.detail).toMatch(/8\.8\.8\.8/);
    expect(await provider.probeEgress?.(handle, "open")).toMatchObject({ enforced: true });
  });
});

describe("rate limits (HTTP 429) on every create path", () => {
  it("Retry-After is read from the vendor error, in seconds or as a date", () => {
    expect(retryAfterOf({ retryAfter: 3 })).toBe(3000);
    expect(retryAfterOf({ headers: new Headers({ "retry-after": "2" }) })).toBe(2000);
    expect(retryAfterOf({ response: { headers: { "retry-after": "Thu, 01 Jan 1970 00:00:10 GMT" } } }, 4000)).toBe(
      6000,
    );
    expect(retryAfterOf(new Error("x"))).toBeUndefined();
    const quota = classify(Object.assign(rateLimit(), { retryAfter: 1 }), { provider: "e2b", op: "create" });
    expect(quota).toBeInstanceOf(SandboxQuotaError);
    expect((quota as SandboxQuotaError).retryAfterMs).toBe(1000);
  });

  it("openOrCreate waits at least the vendor's Retry-After before it creates again", async () => {
    let refused = false;
    let refusedAt = 0;
    let retriedAt = 0;
    const { provider } = setup({
      client: (c) => ({
        ...c,
        create: async (template, opts) => {
          if (!refused) {
            refused = true;
            refusedAt = Date.now();
            throw Object.assign(rateLimit(), { retryAfter: 0.3 });
          }
          retriedAt = Date.now();
          return c.create(template, opts);
        },
      }),
    });
    const k = key();
    await provider.openOrCreate(k, spec(k));
    expect(retriedAt - refusedAt).toBeGreaterThanOrEqual(290);
    expect(await liveIds(provider, k)).toHaveLength(1);
  });

  it("a fork whose child create and snapshot are rate-limited still makes exactly one child each", async () => {
    const { fake, provider } = setup({});
    const parent = (await provider.openOrCreate(key(), spec(key()))).handle;
    fake.inject("429", "createSnapshot");
    const before = fake.callsTo("create").length;
    fake.inject("429", "create", { times: 2 });
    const children = (await provider.fork?.(parent.ref, {
      children: [
        { name: "a", labels: {} },
        { name: "b", labels: {} },
      ],
      lifetimeMs: 60_000,
    })) as ProviderSandbox[];
    expect(children.every((c) => "ref" in c)).toBe(true);
    expect(new Set(children.map((c) => c.ref.id)).size).toBe(2);
    // Two refused creates and two that took effect.
    expect(fake.callsTo("create").length - before).toBe(4);
  });

  it("concurrent openOrCreate calls converge on one box when the converge listing is rate-limited", async () => {
    let creates = 0;
    let listFailures = 0;
    const { provider } = setup({
      client: (c) => ({
        ...c,
        create: async (template, opts) => {
          creates++;
          return c.create(template, opts);
        },
        // Once boxes exist, the next several listings answer 429: exactly when racing calls check who won.
        list: (opts) => {
          if (creates > 0 && listFailures < 4) {
            listFailures++;
            return {
              hasNext: true,
              nextItems: async () => {
                throw rateLimit();
              },
            };
          }
          return c.list(opts);
        },
      }),
    });
    const k = key();
    const results = await Promise.all([0, 1, 2].map(() => provider.openOrCreate(k, spec(k))));
    expect(listFailures).toBeGreaterThan(0);
    expect(new Set(results.map((r) => r.handle.ref.id)).size).toBe(1);
    expect(await liveIds(provider, k)).toHaveLength(1);
  });

  it("a create that started first but landed second yields to the box the vendor started first", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { provider } = setup({
      client: (c) => ({
        ...c,
        create: async (template, opts) => {
          // The first call's create request is slow: the vendor starts its box after the second call's.
          if (calls++ === 0) await gate;
          return c.create(template, opts);
        },
      }),
    });
    const k = key();
    const slow = provider.openOrCreate(k, spec(k));
    while (calls === 0) await new Promise((r) => setTimeout(r, 5));
    const fast = await provider.openOrCreate(k, spec(k));
    release();
    const late = await slow;
    expect(late.handle.ref.id).toBe(fast.handle.ref.id);
    expect(late.created).toBe(false);
    expect(await liveIds(provider, k)).toEqual([fast.handle.ref.id]);
  });
});

/**
 * A vendor listing that trails its own writes, as E2B's does under load: while frozen, `list` answers from the rows it
 * held at `freeze()`, so new boxes are missing, killed ones remain and states are old. `getInfo` stays current.
 */
function laggingListing() {
  let base: E2bShapeClient | undefined;
  let frozen: E2bSandboxInfo[] | undefined;
  const wrap = (c: E2bShapeClient): E2bShapeClient => {
    base = c;
    return {
      ...c,
      list: (opts): E2bPaginator => {
        if (frozen === undefined) return c.list(opts);
        const rows = frozen.filter(
          (r) =>
            Object.entries(opts.query.metadata).every(([k, v]) => r.metadata?.[k] === v) &&
            opts.query.state.includes(r.state as "running" | "paused"),
        );
        let done = false;
        return {
          get hasNext() {
            return !done;
          },
          nextItems: async () => {
            done = true;
            return rows;
          },
        };
      },
    };
  };
  const freeze = async () => {
    const pages = (base as E2bShapeClient).list({
      apiKey: "e2b_unit",
      query: { metadata: { [SELFBUILDING_LABELS.deployment]: "unit" }, state: ["running", "paused"] },
    });
    const rows: E2bSandboxInfo[] = [];
    while (pages.hasNext) rows.push(...(await pages.nextItems()));
    frozen = rows;
  };
  const thaw = () => {
    frozen = undefined;
  };
  return { wrap, freeze, thaw };
}

const boxesOf = (fake: FakeE2b, k: SandboxKey) =>
  fake.ids().filter((id) => fake.record(id)?.metadata["sbx.scope"] === k.scope);

describe("a vendor listing that trails the adapter's own writes", () => {
  it("find sees a box this process just created before the listing does", async () => {
    const lag = laggingListing();
    const { provider } = setup({ client: lag.wrap });
    await lag.freeze();
    const k = key();
    const { handle } = await provider.openOrCreate(k, spec(k));
    const ref = await provider.find(k);
    expect(ref?.id).toBe(handle.ref.id);
    expect(ref?.state).toBe("running");
    expect(await liveIds(provider, k)).toEqual([handle.ref.id]);
  });

  it("find reports a confirmed pause, a resume and a kill although the listing still shows the old state", async () => {
    const lag = laggingListing();
    const { provider } = setup({ client: lag.wrap });
    const k = key();
    const { handle } = await provider.openOrCreate(k, spec(k));
    await lag.freeze();
    expect((await provider.pause(handle.ref)).confirmed).toBe(true);
    expect((await provider.find(k))?.state).toBe("paused");
    lag.thaw();
    const paused = await provider.find(k);
    if (!paused) throw new Error("the paused box was not found");
    await lag.freeze();
    await provider.open(paused, { lifetimeMs: 60_000 });
    expect((await provider.find(k))?.state).toBe("running");
    await provider.kill(handle.ref);
    expect(await provider.find(k)).toBeNull();
    expect(await liveIds(provider, k)).toEqual([]);
  });

  it("concurrent openOrCreate calls converge on one box while the listing misses the new boxes", async () => {
    const lag = laggingListing();
    const { fake, provider } = setup({ client: lag.wrap });
    await lag.freeze();
    const k = key();
    const results = await Promise.all([0, 1, 2].map(() => provider.openOrCreate(k, spec(k))));
    expect(new Set(results.map((r) => r.handle.ref.id)).size).toBe(1);
    expect(boxesOf(fake, k)).toHaveLength(1);
    lag.thaw();
    expect(await liveIds(provider, k)).toHaveLength(1);
  });

  it("the losing box of a race is killed even when the first kills are rate-limited", async () => {
    let refusedKills = 0;
    const { fake, provider } = setup({
      client: (c) => ({
        ...c,
        kill: async (id, opts) => {
          if (refusedKills < 2) {
            refusedKills++;
            throw rateLimit();
          }
          return c.kill(id, opts);
        },
      }),
    });
    const k = key();
    const results = await Promise.all([0, 1].map(() => provider.openOrCreate(k, spec(k))));
    expect(new Set(results.map((r) => r.handle.ref.id)).size).toBe(1);
    expect(refusedKills).toBe(2);
    expect(boxesOf(fake, k)).toHaveLength(1);
    expect(await liveIds(provider, k)).toHaveLength(1);
  });
});

describe("the conformance suite under a create limit", () => {
  it("limitConcurrency keeps create-path calls to the limit and passes everything else through", async () => {
    const { provider } = setup({});
    let active = 0;
    let peak = 0;
    const counting = new Proxy(provider, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "openOrCreate" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          active++;
          peak = Math.max(peak, active);
          try {
            return await value.apply(target, args);
          } finally {
            active--;
          }
        };
      },
    }) as SandboxProvider;
    const limited = limitConcurrency(counting, 2);
    expect(typeof limited.fork).toBe("function");
    expect(typeof limited.probeEgress).toBe("function");
    const k = key();
    const results = await Promise.all([0, 1, 2, 3].map(() => limited.openOrCreate(k, spec(k))));
    expect(peak).toBe(2);
    expect(new Set(results.map((r) => r.handle.ref.id)).size).toBe(1);
    expect(() => limitConcurrency(provider, 0)).toThrow(RangeError);
  });
});

// The full suite against a plan that refuses a create past 10 running boxes, like E2B's Hobby plan at 20: it passes
// only because each case's boxes are killed when the case ends instead of when the suite does.
const capped = new FakeE2b();
fakes.push(capped);
const RUNNING_CAP = 10;
const cappedClient = e2bClient(capped.client as unknown as Parameters<typeof e2bClient>[0]);
describeSandboxProvider(
  "e2b-shape under a 10-running-box plan limit",
  () =>
    createE2bShapeProvider({
      id: "e2b",
      client: {
        ...cappedClient,
        create: async (template, opts) => {
          const running = capped.ids().filter((id) => capped.record(id)?.state === "running").length;
          if (running >= RUNNING_CAP) {
            throw Object.assign(
              new Error(
                `Rate limit exceeded - you have reached the maximum number of concurrent sandboxes (${RUNNING_CAP})`,
              ),
              { name: "RateLimitError" },
            );
          }
          return cappedClient.create(template, opts);
        },
      },
      template: "selfbuilding-claude-code",
      apiKey: "e2b_unit",
      domain: "fake.local",
      limits: LIMITS,
      connection: { retries: 0 },
      timings: { ...FAST, createDeadlineMs: 1_000 },
    }),
  { timeoutMs: 30_000, concurrency: 2 },
);

// The full suite against a vendor that ignores egress: the network case passes only through detection.
const leaky = new FakeE2b({ ignoreEgress: true });
fakes.push(leaky);
const leakyProvider = (verifyEgress: boolean) =>
  createE2bShapeProvider({
    id: "e2b",
    client: e2bClient(leaky.client as unknown as Parameters<typeof e2bClient>[0]),
    template: "selfbuilding-claude-code",
    apiKey: "e2b_unit",
    domain: "fake.local",
    limits: LIMITS,
    connection: { retries: 0 },
    timings: FAST,
    verifyEgress,
  });
describeSandboxProvider("e2b-shape, vendor ignores egress, verifyEgress on", () => leakyProvider(true), {
  timeoutMs: 30_000,
  concurrency: 2,
});
