import {
  ConfigError,
  ImageUnavailableError,
  MissingCredentialError,
  type ProviderLimits,
  type ProviderSandbox,
  SANDBOX_PATHS,
  SandboxAuthError,
  SandboxCommandTimeoutError,
  SandboxGuestGoneError,
  type SandboxKey,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxQuotaError,
  type SandboxRef,
  type SandboxSpec,
  SandboxUnavailableError,
  SandboxUnsupportedError,
  SELFBUILDING_LABELS,
  SecretInEnvError,
} from "@selfbuilding/core";
import { openTestBox, runHarnessTurn, scripted, scriptedHarness } from "@selfbuilding/testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FAST, FakeE2b, type FakeE2bOptions } from "../test/fake-e2b.js";
import type { E2bShapeClient } from "./client.js";
import { createE2bShapeProvider, ENV_FILE, e2b, e2bClient, e2bTemplate } from "./index.js";

const LIMITS: ProviderLimits = {
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  lifetimeGuaranteed: true,
  expireKeeps: "memory",
};

const fakes: FakeE2b[] = [];
afterAll(async () => {
  await Promise.all(fakes.map((f) => f.close()));
});

function setup(
  o: {
    fake?: FakeE2bOptions;
    limits?: Partial<ProviderLimits>;
    client?: (base: E2bShapeClient) => E2bShapeClient;
    apiKey?: string | (() => Promise<string>);
    timeout?: `${number}m`;
    timings?: Partial<typeof FAST>;
  } = {},
) {
  const fake = new FakeE2b(o.fake);
  fakes.push(fake);
  const base = e2bClient(fake.client as unknown as Parameters<typeof e2bClient>[0]);
  const provider = createE2bShapeProvider({
    id: "e2b",
    client: o.client ? o.client(base) : base,
    template: "selfbuilding-claude-code",
    apiKey: o.apiKey ?? "e2b_unit",
    domain: "fake.local",
    limits: { ...LIMITS, ...o.limits },
    connection: { retries: 0 },
    timings: { ...FAST, ...o.timings },
    ...(o.timeout ? { timeout: o.timeout } : {}),
  });
  return { fake, provider };
}

let n = 0;
function key(scope = `s${++n}`): SandboxKey {
  return { runId: "run-unit", scope, deployment: "unit" };
}
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
      [SELFBUILDING_LABELS.step]: "step-1",
      ...over.labels,
    },
  };
}
async function box(provider: SandboxProvider, k = key(), over: Partial<SandboxSpec> = {}): Promise<ProviderSandbox> {
  return (await provider.openOrCreate(k, spec(k, over))).handle;
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("bindings: credentials and templates arrive explicitly", () => {
  it("passes every connection field explicitly and resolves a Secret function per call", async () => {
    let resolved = 0;
    const { fake, provider } = setup({
      apiKey: async () => {
        resolved += 1;
        return "e2b_from_fn";
      },
    });
    const handle = await box(provider);
    await provider.kill(handle.ref);
    expect(fake.callsTo("kill")[0]?.opts).toMatchObject({
      apiKey: "e2b_from_fn",
      domain: "fake.local",
      apiUrl: "https://api.fake.local",
      debug: false,
      retries: 0,
      requestTimeoutMs: expect.any(Number),
    });
    expect(resolved).toBeGreaterThanOrEqual(2);
  });

  it("an empty key is a MissingCredentialError, before any request", async () => {
    const { fake, provider } = setup({ apiKey: "" });
    await expect(provider.find(key())).rejects.toBeInstanceOf(MissingCredentialError);
    expect(fake.calls).toEqual([]);
  });

  it("refuses vendor stock templates and bad timeouts with ConfigError", () => {
    expect(() => e2b({ apiKey: "e2b_x", template: "claude" })).toThrow(ConfigError);
    expect(() => e2b({ apiKey: "e2b_x", template: "claude-code" })).toThrow(/selfbuilding-claude-code/);
    expect(() => e2b({ apiKey: "e2b_x", template: "" })).toThrow(ConfigError);
    expect(() => e2b({ apiKey: "e2b_x", template: "selfbuilding-codex", timeout: "soon" as "1m" })).toThrow(
      ConfigError,
    );
  });

  it("e2b() limits follow the tier, hobby by default", () => {
    expect(e2b({ apiKey: "e2b_x", template: "selfbuilding-codex" }).limits.maxLifetimeMs).toBe(60 * 60 * 1000);
    const pro = e2b({ apiKey: "e2b_x", template: "selfbuilding-codex", tier: "pro", limits: { maxConcurrent: 7 } });
    expect(pro.limits).toMatchObject({ maxLifetimeMs: 24 * 60 * 60 * 1000, maxConcurrent: 7, expireKeeps: "memory" });
    expect(pro.id).toBe("e2b");
    expect(typeof pro.snapshot).toBe("function");
    expect(typeof pro.fork).toBe("function");
  });
});

describe("create: every vendor default that could kill an agent is set (invariant 14)", () => {
  it("passes timeoutMs, lifecycle.onTimeout, labels and the template; no env in the request", async () => {
    const { fake, provider } = setup();
    const k = key();
    const handle = await box(provider, k, { env: { MODE: "ci" }, onExpire: "pause" });
    const create = fake.callsTo("create")[0]?.opts as Record<string, unknown>;
    expect(create.template).toBe("selfbuilding-claude-code");
    expect(create.timeoutMs).toBe(30 * 60 * 1000);
    expect(create.lifecycle).toEqual({ onTimeout: "pause" });
    expect(create.envs).toBeUndefined();
    expect(create.metadata).toMatchObject({
      "selfbuilding.deployment": "unit",
      "selfbuilding.run": "run-unit",
      "selfbuilding.name": `ns-${k.scope}`,
      "selfbuilding.step": "step-1",
      "sbx.scope": k.scope,
    });
    // The env survives a resume because it lives in the box, not in create-time env.
    expect(text(await handle.readFile(ENV_FILE))).toBe(JSON.stringify({ MODE: "ci" }));
    expect(handle.ref.labels).not.toHaveProperty("sbx.scope");
    expect(handle.ref.key).toEqual(k);
    expect(handle.ref.meta?.scope).toBe(k.scope);
  });

  it("onExpire kill is passed through; a lifetime floor and the plan maximum clamp the request", async () => {
    const { fake, provider } = setup({ timeout: "45m", limits: { maxLifetimeMs: 60 * 60 * 1000 } });
    await box(provider, key(), { onExpire: "kill", lifetimeMs: 60_000 });
    await box(provider, key(), { lifetimeMs: 10 * 60 * 60 * 1000 });
    const [short, long] = fake.callsTo("create").map((c) => c.opts as Record<string, unknown>);
    expect(short).toMatchObject({ timeoutMs: 45 * 60 * 1000, lifecycle: { onTimeout: "kill" } });
    expect(long?.timeoutMs).toBe(60 * 60 * 1000);
  });

  it("an expired box with onExpire pause is paused by the vendor, not killed", async () => {
    const { fake, provider } = setup();
    const k = key();
    const handle = await box(provider, k);
    fake.expire(handle.ref.id);
    expect((await provider.find(k))?.state).toBe("paused");
  });

  it("uses a template alias or snapshot id from the image, and the provider template for OCI refs", async () => {
    const { fake, provider } = setup();
    await box(provider, key(), { image: { name: "selfbuilding-codex", ref: "selfbuilding-codex", version: "1" } });
    const templates = fake.callsTo("create").map((c) => (c.opts as { template: string }).template);
    expect(templates).toEqual(["selfbuilding-codex"]);
  });

  it("a missing template is ImageUnavailableError and leaves no box", async () => {
    const { fake, provider } = setup({ fake: { missingTemplates: ["selfbuilding-nope"] } });
    const k = key();
    await expect(
      box(provider, k, { image: { name: "selfbuilding-nope", ref: "selfbuilding-nope", version: "1" } }),
    ).rejects.toBeInstanceOf(ImageUnavailableError);
    expect(fake.ids()).toEqual([]);
  });

  it("setup failing after create kills that box before anything else (invariant 9)", async () => {
    const { fake, provider } = setup();
    fake.inject("503", "files.write");
    const k = key();
    const handle = await box(provider, k, { env: { MODE: "x" } });
    const [first, second] = fake.callsTo("create");
    expect(first && second).toBeTruthy();
    const killed = fake.callsTo("kill").map((c) => c.id);
    expect(killed).toHaveLength(1);
    expect(killed[0]).not.toBe(handle.ref.id);
    expect(fake.ids()).toEqual([handle.ref.id]);
  });

  it("rejects secret names in create env and secret values already delivered as files (invariant 18)", async () => {
    const { provider } = setup();
    const k = key();
    await expect(provider.openOrCreate(k, spec(k, { env: { GH_TOKEN: "x" } }))).rejects.toBeInstanceOf(
      SecretInEnvError,
    );
    const handle = await box(provider);
    await handle.writeFiles([{ path: `${SANDBOX_PATHS.secrets}/MODEL_KEY`, data: "sk-very-secret-value" }]);
    await expect(handle.exec("true", { env: { HARMLESS_NAME: "sk-very-secret-value" } })).rejects.toBeInstanceOf(
      SecretInEnvError,
    );
  });

  it("maps egress policies onto the vendor's network options, and refuses header injection", async () => {
    const { fake, provider } = setup();
    await box(provider, key(), { network: "deny-all" });
    await box(provider, key(), { network: { allow: ["github.com"] } });
    const [deny, allow] = fake.callsTo("create").map((c) => c.opts as Record<string, unknown>);
    expect(deny?.allowInternetAccess).toBe(false);
    expect(allow?.network).toEqual({ allowOut: ["github.com"], denyOut: ["0.0.0.0/0"] });
    const k = key();
    await expect(
      provider.openOrCreate(
        k,
        spec(k, { network: { allow: ["a.com"], inject: [{ host: "a.com", headers: { x: "y" } }] } }),
      ),
    ).rejects.toThrow(/header injection/);
  });
});

describe("lookups never wake anything (invariant 1) and scope to one deployment (invariant 20)", () => {
  it("find and list after a pause make no connect call and leave the box paused", async () => {
    const { fake, provider } = setup();
    const k = key();
    const handle = await box(provider, k);
    expect(await provider.pause(handle.ref)).toEqual({ confirmed: true, kept: "memory" });
    const connects = fake.callsTo("connect").length;
    expect((await provider.find(k))?.state).toBe("paused");
    for await (const _ of provider.list({ deployment: "unit" })) {
      // drain
    }
    expect(fake.callsTo("connect").length).toBe(connects);
    expect(fake.record(handle.ref.id)?.state).toBe("paused");
  });

  it("list walks every page, and a failed page throws instead of ending early", async () => {
    let pagesServed = 0;
    let failSecondPage = false;
    const { provider } = setup({
      fake: { pageSize: 2 },
      client: (base) => ({
        ...base,
        list: (opts) => {
          const pages = base.list(opts);
          return {
            get hasNext() {
              return pages.hasNext;
            },
            nextItems: async () => {
              pagesServed += 1;
              if (failSecondPage && pagesServed === 2)
                throw Object.assign(new Error("503: busy"), { name: "SandboxError" });
              return pages.nextItems();
            },
          };
        },
      }),
    });
    const run = `run-pages-${n++}`;
    for (const i of [0, 1, 2, 3, 4]) {
      const k = { runId: run, scope: `p${i}`, deployment: "unit" };
      await provider.openOrCreate(k, spec(k));
    }
    const refs: SandboxRef[] = [];
    for await (const ref of provider.list({ deployment: "unit", runId: run })) refs.push(ref);
    expect(refs.map((r) => r.key.scope).sort()).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    pagesServed = 0;
    failSecondPage = true;
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const ref of provider.list({ deployment: "unit", runId: run })) seen.push(ref.id);
      })(),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(seen).toEqual([]);
  });

  it("a state filter the vendor cannot hold yields nothing without a request", async () => {
    const { fake, provider } = setup();
    for await (const _ of provider.list({ deployment: "unit", states: ["stopped"] })) expect.unreachable();
    expect(fake.callsTo("list")).toEqual([]);
  });

  it("filters in memory too, so a vendor that ignores the metadata query cannot leak another deployment", async () => {
    const { provider } = setup({
      client: (base) => ({ ...base, list: (opts) => base.list({ ...opts, query: { ...opts.query, metadata: {} } }) }),
    });
    const mine = await box(provider);
    const other = { runId: "other-run", scope: "x", deployment: "someone-else" };
    await provider.openOrCreate(other, spec(other));
    const refs: string[] = [];
    for await (const ref of provider.list({ deployment: "unit" })) refs.push(ref.deployment);
    expect(refs).toContain("unit");
    expect(refs).not.toContain("someone-else");
    expect((await provider.find({ ...mine.ref.key, deployment: "someone-else" })) ?? null).toBeNull();
  });
});

describe("open: connect with a lifetime, probe the guest, deliver secrets again", () => {
  it("every connect passes timeoutMs (without it the lifetime resets to 300 s)", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    await provider.open(handle.ref, { lifetimeMs: 20 * 60 * 1000 });
    expect(fake.callsTo("connect").at(-1)?.opts?.timeoutMs).toBe(20 * 60 * 1000);
  });

  it("a silent guest is SandboxGuestGoneError only after the full open deadline", async () => {
    const { fake, provider } = setup({ timings: { openDeadlineMs: 400 } });
    const handle = await box(provider);
    await fake.ghost(handle.ref.id, "guest-gone");
    const started = Date.now();
    const error = await provider.open(handle.ref, { lifetimeMs: 60_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxGuestGoneError);
    expect(error).toBeInstanceOf(SandboxUnavailableError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
  });

  it("waits out a 409 while the box is still pausing, then connects", async () => {
    let conflicts = 2;
    const { provider } = setup({
      client: (base) => ({
        ...base,
        connect: async (id, opts) => {
          if (conflicts-- > 0) throw Object.assign(new Error(`409: Sandbox "${id}" is being paused`), { status: 409 });
          return base.connect(id, opts);
        },
      }),
    });
    const handle = await box(provider);
    await provider.pause(handle.ref);
    const reopened = await provider.open(handle.ref, { lifetimeMs: 60_000 });
    expect(reopened.ref.id).toBe(handle.ref.id);
    expect(conflicts).toBeLessThan(0);
  });

  it("a pause whose request times out on our side still waits for the vendor to report it paused", async () => {
    // Found live: an 8 GB box took longer to pause than the request timeout, and the run failed as "unknown".
    let asked: number | undefined;
    const { provider } = setup({
      client: (base) => ({
        ...base,
        pause: async (id, opts) => {
          asked = (opts as { requestTimeoutMs?: number }).requestTimeoutMs;
          await base.pause(id, opts);
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        },
      }),
    });
    const handle = await box(provider);
    await expect(provider.pause(handle.ref)).resolves.toMatchObject({ confirmed: true });
    expect(asked).toBe(600_000);
  });

  it("a positive 404 on open is SandboxNotFoundError", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    await fake.ghost(handle.ref.id, "not-found");
    await expect(provider.open(handle.ref, { lifetimeMs: 60_000 })).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  it("silent-guest ghosts converge: one rebuild, then the new box, with the ghost never preferred again", async () => {
    const { fake, provider } = setup({ timings: { ghostProbeMs: 100, openDeadlineMs: 200 } });
    const k = key();
    const first = await box(provider, k);
    await fake.ghost(first.ref.id, "guest-gone");
    const rebuilt = await provider.openOrCreate(k, spec(k));
    expect(rebuilt).toMatchObject({ created: true, rebuilt: true });
    const started = Date.now();
    const again = await provider.openOrCreate(k, spec(k));
    expect(again).toMatchObject({ created: false, rebuilt: false });
    expect(again.handle.ref.id).toBe(rebuilt.handle.ref.id);
    // The known ghost ranks last, so the live box opens without waiting out the ghost's budget first.
    expect(Date.now() - started).toBeLessThan(100);
    expect((await provider.find(k))?.id).toBe(rebuilt.handle.ref.id);
  });

  it("never hands the secrets directory to the agent user", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    await handle.writeFiles([{ path: `${SANDBOX_PATHS.secrets}/TOKEN_X`, data: "value", owner: "root" }]);
    const scripts = fake.callsTo("commands.run").map((c) => String(c.opts?.cmd));
    const handedOver = scripts.filter((cmd) =>
      new RegExp(`chown agent:agent[^&|]*'?${SANDBOX_PATHS.secrets}'?(\\s|$)`).test(cmd),
    );
    expect(handedOver).toEqual([]);
    expect(scripts.some((cmd) => cmd.includes(`chown root:root '${SANDBOX_PATHS.secrets}'`))).toBe(true);
  });

  it("files under /run/selfbuilding are delivered again after every connect, as 0600 secrets", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    const secret = `${SANDBOX_PATHS.secrets}/ANTHROPIC_API_KEY`;
    await handle.writeFiles([{ path: secret, data: "sk-ant-test-secret" }]);
    expect((await handle.exec(`stat -c %a ${secret}`)).stdoutTail.trim()).toBe("600");
    expect((await handle.exec(`stat -c %a ${SANDBOX_PATHS.secrets}`)).stdoutTail.trim()).toBe("700");
    // A resume can lose tmpfs; simulate it, then reopen.
    await handle.exec(`rm -rf ${SANDBOX_PATHS.run}`, { user: "root" });
    await provider.pause(handle.ref);
    const reopened = await provider.open(handle.ref, { lifetimeMs: 60_000 });
    expect(text(await reopened.readFile(secret))).toBe("sk-ant-test-secret");
    // The value never travelled as env, at create or per command.
    const leaked = fake.calls.filter((c) => JSON.stringify(c.opts ?? {}).includes("sk-ant-test-secret"));
    expect(leaked).toEqual([]);
  });

  it("a forced mode on a secret is clamped to 0600", async () => {
    const { provider } = setup();
    const handle = await box(provider);
    await handle.writeFiles([{ path: `${SANDBOX_PATHS.secrets}/X`, data: "value", mode: 0o644 }]);
    expect((await handle.exec(`stat -c %a ${SANDBOX_PATHS.secrets}/X`)).stdoutTail.trim()).toBe("600");
  });
});

describe("pause confirms, and a refusal is a typed outcome (invariant 4, spec §9.9)", () => {
  it("polls through a slow pause until the vendor reports it paused", async () => {
    const { fake, provider } = setup({ fake: { pauseLag: 3 } });
    const handle = await box(provider);
    expect(await provider.pause(handle.ref)).toEqual({ confirmed: true, kept: "memory" });
    expect(fake.callsTo("getInfo").length).toBeGreaterThanOrEqual(4);
  });

  it("a 404 while a pause is in flight is not read as gone (invariant 5)", async () => {
    const { provider } = setup({ fake: { pauseLag: 2, pauseLag404: true } });
    const handle = await box(provider);
    expect(await provider.pause(handle.ref)).toMatchObject({ confirmed: true });
  });

  it.each([
    ["408 (the server did pause)", "408"],
    ["409 (already pausing)", "409"],
  ] as const)("%s is confirmed after polling", async (_label, kind) => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    // The vendor answers the status but the box does pause (the fake applies it on the poll below).
    await fake.client.pause(handle.ref.id, { apiKey: "x" });
    fake.inject(kind, "pause");
    expect(await provider.pause(handle.ref)).toEqual({ confirmed: true, kept: "memory" });
  });

  it("404 is gone; 400 is refused with its status; 401 and 429 are fleet errors; 503 throws", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    fake.inject("404", "pause");
    expect(await provider.pause(handle.ref)).toMatchObject({ confirmed: false, reason: "gone", status: 404 });
    fake.inject("refuse", "pause");
    expect(await provider.pause(handle.ref)).toMatchObject({ confirmed: false, reason: "refused", status: 400 });
    fake.inject("401", "pause");
    await expect(provider.pause(handle.ref)).rejects.toBeInstanceOf(SandboxAuthError);
    fake.inject("429", "pause");
    await expect(provider.pause(handle.ref)).rejects.toBeInstanceOf(SandboxQuotaError);
    fake.inject("503", "pause");
    await expect(provider.pause(handle.ref)).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(fake.record(handle.ref.id)?.state).toBe("running");
  });

  it("a pause the vendor accepts but never completes is unknown, not confirmed", async () => {
    const { provider } = setup({ fake: { pauseLag: 1_000 }, timings: { pauseDeadlineMs: 200 } });
    const handle = await box(provider);
    await expect(provider.pause(handle.ref)).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("pause goes by id: it works with a ref read back from JSON and no handle", async () => {
    const { fake, provider } = setup();
    const k = key();
    await box(provider, k);
    const ref = JSON.parse(JSON.stringify(await provider.find(k))) as SandboxRef;
    const connects = fake.callsTo("connect").length;
    expect((await provider.pause(ref)).confirmed).toBe(true);
    expect(fake.callsTo("connect").length).toBe(connects);
  });
});

describe("exec, spawn and attach", () => {
  it("always passes a command timeout, the agent user and an explicit HOME", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    await handle.exec("true");
    await handle.exec("true", { user: "root", timeoutMs: 5_000 });
    const runs = fake
      .callsTo("commands.run")
      .slice(-2)
      .map((c) => c.opts as Record<string, unknown>);
    expect(runs[0]).toMatchObject({ user: "agent", envs: expect.objectContaining({ HOME: SANDBOX_PATHS.home }) });
    expect(runs[0]?.timeoutMs).toBeGreaterThan(120_000);
    expect(runs[1]).toMatchObject({ user: "root", envs: expect.objectContaining({ HOME: "/root" }) });
  });

  it("a timeout kills the command, so it is not still running", async () => {
    const { provider } = setup();
    const handle = await box(provider);
    const error = await handle.exec("sleep 20", { timeoutMs: 200, idempotent: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxCommandTimeoutError);
    expect(error).toMatchObject({ mayStillBeRunning: false, retryable: true, cmd: "sleep 20" });
  });

  it("spawn starts in the background with no vendor timeout and records the process group", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    const proc = await handle.spawn("sleep 0.2; echo done");
    const start = fake.callsTo("commands.run").find((c) => String(c.opts?.cmd).includes("setsid"));
    expect(start?.opts?.timeoutMs).toBe(0);
    expect(proc.pgid).toBeGreaterThan(0);
    expect(proc.logPath).toBe(`${SANDBOX_PATHS.proc}/${proc.id}.log`);
    expect(await handle.attach(proc, { fromOffset: 0 })).toMatchObject({ state: "exited", exitCode: 0 });
  });

  it("a group-wide SIGINT still records exit 130; a SIGKILL'd group reads as exited without a code", async () => {
    const { provider } = setup();
    const handle = await box(provider);
    const interrupted = await handle.spawn("sleep 30");
    await handle.exec(`kill -INT -${interrupted.pgid}`);
    expect(await handle.attach(interrupted, { fromOffset: 0 })).toMatchObject({ state: "exited", exitCode: 130 });
    const killed = await handle.spawn("sleep 30");
    await handle.exec(`kill -KILL -${killed.pgid}`);
    const result = await handle.attach(killed, { fromOffset: 0 });
    expect(result.state).toBe("exited");
    expect(result.exitCode).toBeUndefined();
  });

  it("spawn reads stdin from a file and reattaches from another provider instance", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    await handle.writeFiles([{ path: `${SANDBOX_PATHS.in}/prompt.md`, data: "line one\nline two\n" }]);
    const proc = await handle.spawn("wc -l", { stdinFile: `${SANDBOX_PATHS.in}/prompt.md` });
    // A second orchestrator process: a new provider value over the same vendor account.
    const other = createE2bShapeProvider({
      id: "e2b",
      client: e2bClient(fake.client as unknown as Parameters<typeof e2bClient>[0]),
      template: "selfbuilding-claude-code",
      apiKey: "e2b_unit",
      domain: "fake.local",
      limits: LIMITS,
      timings: FAST,
    });
    const reopened = await other.open(JSON.parse(JSON.stringify(handle.ref)) as SandboxRef, { lifetimeMs: 60_000 });
    const lines: string[] = [];
    const done = await reopened.attach(JSON.parse(JSON.stringify(proc)), {
      fromOffset: 0,
      onLine: (_s, line) => lines.push(line),
    });
    expect(done).toMatchObject({ state: "exited", exitCode: 0 });
    expect(lines.map((l) => l.trim())).toEqual(["2"]);
  });

  it("previewUrl names the vendor host for the port", async () => {
    const { provider } = setup();
    const handle = await box(provider);
    expect(await handle.previewUrl?.(3000)).toEqual({ url: `https://3000-${handle.ref.id}.fake.local`, headers: {} });
  });
});

describe("lifetime (invariant 15)", () => {
  it("extendLifetime converts the absolute target to the vendor's relative verb and clamps to the plan", async () => {
    const { fake, provider } = setup({ limits: { maxLifetimeMs: 60 * 60 * 1000 } });
    const handle = await box(provider, key(), { lifetimeMs: 5 * 60 * 1000 });
    const target = Date.now() + 10 * 60 * 1000;
    const near = await handle.extendLifetime(target);
    expect(near.clamped).toBe(false);
    expect(Math.abs(near.untilMs - target)).toBeLessThan(1_000);
    const sent = fake.callsTo("setTimeout").at(-1)?.opts?.timeoutMs as number;
    expect(sent).toBeGreaterThan(9 * 60 * 1000);
    expect(sent).toBeLessThanOrEqual(10 * 60 * 1000);
    const far = await handle.extendLifetime(Date.now() + 5 * 60 * 60 * 1000);
    expect(far.clamped).toBe(true);
    expect(far.untilMs).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it("extendLifetime never moves a later deadline earlier", async () => {
    const { fake, provider } = setup({ limits: { maxLifetimeMs: 60 * 60 * 1000 } });
    const handle = await box(provider, key(), { lifetimeMs: 40 * 60 * 1000 });
    const before = fake.callsTo("setTimeout").length;
    const shorter = await handle.extendLifetime(Date.now() + 15 * 60 * 1000);
    expect(shorter.untilMs).toBeGreaterThan(Date.now() + 35 * 60 * 1000);
    expect(fake.callsTo("setTimeout")).toHaveLength(before);
  });

  it("a gone box on extendLifetime is SandboxNotFoundError", async () => {
    const { provider } = setup();
    const handle = await box(provider);
    await provider.kill(handle.ref);
    await expect(handle.extendLifetime(Date.now() + 60_000)).rejects.toBeInstanceOf(SandboxNotFoundError);
  });
});

describe("snapshot and fork", () => {
  it("fork children carry their own identity, so the parent's key still finds the parent", async () => {
    const { provider } = setup();
    const k = key();
    const parent = await box(provider, k);
    const children = await provider.fork?.(parent.ref, {
      children: [0, 1].map((i) => ({
        name: `${parent.ref.name}-f${i}`,
        labels: { "selfbuilding.step": `review-${i}` },
      })),
      lifetimeMs: 60_000,
    });
    expect(children).toHaveLength(2);
    const [a, b] = children as ProviderSandbox[];
    expect(a?.ref).toMatchObject({
      name: `${parent.ref.name}-f0`,
      key: { ...k, scope: `${k.scope}/fork[0]` },
      labels: expect.objectContaining({ "selfbuilding.parent": parent.ref.id, "selfbuilding.step": "review-0" }),
    });
    expect(a?.ref.meta?.forkSnapshot).toMatch(/^snap-/);
    expect((await provider.find(k))?.id).toBe(parent.ref.id);
    expect((await provider.find({ ...k, scope: `${k.scope}/fork[1]` }))?.id).toBe(b?.ref.id);
  });

  it("fork children keep the parent's egress policy and a replayed fork adopts its children", async () => {
    const { fake, provider } = setup();
    const k = key();
    const parent = await box(provider, k, { network: "deny-all" });
    const childKey = { ...k, scope: `${k.scope}/fork[3]` };
    const request = { children: [{ name: "child-3", labels: {}, key: childKey }], lifetimeMs: 60_000 };
    const fork = provider.fork?.bind(provider);
    if (!fork) throw new Error("the e2b provider forks natively");
    const [first] = (await fork(parent.ref, request)) as ProviderSandbox[];
    const creates = fake.callsTo("create");
    expect(creates.at(-1)?.opts).toMatchObject({ allowInternetAccess: false });
    expect(first?.ref.key).toEqual(childKey);
    const [again] = (await fork(parent.ref, request)) as ProviderSandbox[];
    expect(again?.ref.id).toBe(first?.ref.id);
    expect(fake.callsTo("create")).toHaveLength(creates.length);
  });

  it("asks for a snapshot with the long snapshot timeout, not the 60 s control-plane one", async () => {
    // Found live: a memory snapshot of a 4 vCPU / 8 GB box with a browser took longer than a minute.
    const { fake, provider } = setup();
    const parent = await box(provider);
    await provider.snapshot?.(parent.ref);
    expect(fake.callsTo("createSnapshot").at(-1)?.opts).toMatchObject({ requestTimeoutMs: 600_000 });
  });

  it("a failed source snapshot fails every child as an item", async () => {
    const { fake, provider } = setup();
    const parent = await box(provider);
    fake.inject("503", "createSnapshot");
    const children = await provider.fork?.(parent.ref, {
      children: [
        { name: "a", labels: {} },
        { name: "b", labels: {} },
      ],
      lifetimeMs: 60_000,
    });
    expect(children?.every((c) => c instanceof SandboxUnavailableError)).toBe(true);
  });

  it("a vendor without snapshots offers neither snapshot nor fork", () => {
    const { provider } = setup({
      client: (base) => {
        const { createSnapshot: _omit, ...rest } = base;
        return rest;
      },
    });
    expect(provider.snapshot).toBeUndefined();
    expect(provider.fork).toBeUndefined();
  });

  it("a 501 on snapshot is SandboxUnsupportedError, cached so the vendor is not asked again", async () => {
    const { fake, provider } = setup();
    const handle = await box(provider);
    fake.inject("500", "createSnapshot");
    await expect(provider.snapshot?.(handle.ref)).rejects.toBeInstanceOf(SandboxUnavailableError);
    fake.inject("501", "createSnapshot");
    await expect(provider.snapshot?.(handle.ref)).rejects.toBeInstanceOf(SandboxUnsupportedError);
    const asked = fake.callsTo("createSnapshot").length;
    await expect(provider.snapshot?.(handle.ref)).rejects.toBeInstanceOf(SandboxUnsupportedError);
    expect(fake.callsTo("createSnapshot").length).toBe(asked);
  });
});

describe("a harness turn on an E2B-shape box", () => {
  const MCP_SERVER = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "0" } } });
    if (msg.method === "tools/call") send({ id: msg.id, result: { content: [{ type: "text", text: "Accepted." }] } });
  }
});`;
  let fake: FakeE2b | undefined;
  afterEach(() => fake?.reset());

  it("plays a scripted Claude Code turn: shell steps run in the box and the result is submitted", async () => {
    const env = setup();
    fake = env.fake;
    const handle = await openTestBox(env.provider);
    await handle.writeFiles([{ path: `${SANDBOX_PATHS.bin}/mcp.mjs`, data: MCP_SERVER }]);
    const harness = scriptedHarness([
      scripted.say("Working."),
      scripted.sh("echo hello > note.txt"),
      scripted.submit({ status: "done" }),
    ]);
    const turn = await runHarnessTurn(handle, harness, {
      mcpServers: [{ name: "selfbuilding", type: "stdio", command: "node", args: [`${SANDBOX_PATHS.bin}/mcp.mjs`] }],
    });
    expect(turn.exitCode, turn.stderr).toBe(0);
    expect(text(await handle.readFile(`${SANDBOX_PATHS.workdir}/note.txt`))).toBe("hello\n");
    expect(turn.events.some((e) => e.type === "tool.completed")).toBe(true);
    expect(turn.events.at(-1)).toMatchObject({ type: "turn.ended" });
  });
});

describe("templates", () => {
  it("defines selfbuilding-claude-code and selfbuilding-codex from the published images", () => {
    const claude = e2bTemplate("selfbuilding-claude-code", { version: "1.2.3", date: "2026-11-01" });
    expect(claude).toMatchObject({
      alias: "selfbuilding-claude-code",
      fromImage: "selfbuilding/claude-code:1.2.3",
      user: "agent",
      binaries: ["/usr/local/bin/claude"],
      tags: ["1.2.3", "2026-11-01", "default"],
    });
    expect(claude.verify).toContain("/usr/local/bin/claude --version");
    expect(e2bTemplate("selfbuilding-codex", { version: "1.2.3" })).toMatchObject({
      fromImage: "selfbuilding/codex:1.2.3",
      binaries: ["/usr/local/bin/codex"],
    });
  });
});
