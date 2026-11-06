import { createHash } from "node:crypto";
import {
  EgressPolicyUnsupportedError,
  type OnLine,
  type ProviderSandbox,
  SANDBOX_PATHS,
  SandboxAuthError,
  SandboxCommandTimeoutError,
  SandboxFileNotFoundError,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxQuotaError,
  type SandboxRef,
  SandboxUnavailableError,
  SecretInEnvError,
} from "@selfbuilding/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type ConformanceOptions, Fixture, limitConcurrency, rejectsWith, sh } from "./support.js";

/** `it`, or a skipped `it` whose title carries the reason, so a skip is printed and never counts as a pass. */
function caseIf(condition: boolean, reason: string) {
  return (title: string, fn: () => Promise<void>, timeout?: number) =>
    condition ? it(title, fn, timeout) : it.skip(`${title} [skipped: ${reason}]`, fn);
}

/** Exit 0 when the box can open a TCP connection to a public address. */
const DIRECT_EGRESS_PROBE = `node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(3000,()=>process.exit(1))"`;

/** Scopes whose box several cases reuse; they live until the suite ends instead of being killed after each case. */
const SHARED_SCOPES: ReadonlySet<string> = new Set(["exec", "files", "spawn", "runtime"]);

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * Registers the provider conformance suite (spec §5.4, §10.3 L2) with vitest. Each case names the invariant it
 * checks. Cases for optional operations (`snapshot`, `fork`) and for fault injection are skipped, with the reason
 * printed, when the provider or the options do not offer them.
 */
export function describeSandboxProvider(
  name: string,
  makeProvider: () => SandboxProvider | Promise<SandboxProvider>,
  opts: ConformanceOptions = {},
): void {
  describe(`sandbox provider conformance: ${name}`, () => {
    if (opts.skip) {
      it.skip(`all cases [skipped: ${opts.skip}]`, () => undefined);
      return;
    }
    const timeout = opts.timeoutMs ?? 60_000;
    const fx = new Fixture(opts);
    let provider: SandboxProvider;
    // Capabilities are read once the provider exists; vitest collects titles first, so optional cases check inside.
    let hasSnapshot = false;
    let hasFork = false;

    beforeAll(async () => {
      const made = await makeProvider();
      provider = opts.concurrency === undefined ? made : limitConcurrency(made, opts.concurrency);
      hasSnapshot = typeof provider.snapshot === "function";
      hasFork = typeof provider.fork === "function";
    }, timeout);
    afterEach(async () => {
      opts.faults?.reset();
      // Each case's boxes go when it ends: kept to the end, a suite holds ~30 boxes, and a cloud plan's
      // concurrent-box limit (20 on some) refuses the late cases' creates with SandboxQuotaError.
      if (provider) await fx.cleanup(provider, { keep: SHARED_SCOPES });
    }, timeout);
    afterAll(async () => {
      opts.faults?.reset();
      if (provider) await fx.cleanup(provider);
    }, timeout);

    const withFaults = caseIf(opts.faults !== undefined, "no fault injection (pass opts.faults)");
    const faults = () => opts.faults as NonNullable<ConformanceOptions["faults"]>;

    describe("lifecycle", () => {
      it(
        "openOrCreate creates a running box and is idempotent per key [inv 7]",
        async () => {
          const first = await provider.openOrCreate(fx.key("idem"), fx.spec("idem"));
          expect(first.created).toBe(true);
          expect(first.rebuilt).toBe(false);
          expect(first.handle.ref.provider).toBe(provider.id);
          expect(first.handle.ref.deployment).toBe(fx.deployment);
          const second = await provider.openOrCreate(fx.key("idem"), fx.spec("idem"));
          expect(second.created).toBe(false);
          expect(second.handle.ref.id).toBe(first.handle.ref.id);
        },
        timeout,
      );

      it(
        "concurrent openOrCreate calls for one key converge on one box [inv 7]",
        async () => {
          const results = await Promise.all(
            [0, 1, 2].map(() => provider.openOrCreate(fx.key("race"), fx.spec("race"))),
          );
          expect(new Set(results.map((r) => r.handle.ref.id)).size).toBe(1);
          expect((await fx.boxes(provider, "race")).length).toBe(1);
        },
        timeout,
      );

      it(
        "find returns the ref with its labels, scoped to the deployment [inv 20]",
        async () => {
          const box = await fx.box(provider, "find");
          const ref = await provider.find(fx.key("find"));
          expect(ref?.id).toBe(box.ref.id);
          expect(ref?.labels["selfbuilding.deployment"]).toBe(fx.deployment);
          expect(ref?.labels["selfbuilding.run"]).toBe(fx.runId);
          expect(ref?.labels["selfbuilding.name"]).toBe(ref?.name);
          expect(await provider.find({ ...fx.key("find"), deployment: `${fx.deployment}-other` })).toBeNull();
        },
        timeout,
      );

      it(
        "find returns null only for a confirmed miss [inv 2]",
        async () => {
          expect(await provider.find(fx.key("never-created"))).toBeNull();
        },
        timeout,
      );

      it(
        "list yields this deployment's boxes, filtered by run and state [inv 20]",
        async () => {
          const box = await fx.box(provider, "list");
          const mine: SandboxRef[] = [];
          for await (const ref of provider.list({ deployment: fx.deployment, runId: fx.runId, states: ["running"] })) {
            mine.push(ref);
          }
          expect(mine.map((r) => r.id)).toContain(box.ref.id);
          for await (const ref of provider.list({ deployment: `${fx.deployment}-other` })) {
            expect(ref.deployment).toBe(`${fx.deployment}-other`);
          }
          for await (const ref of provider.list({ deployment: fx.deployment, runId: `${fx.runId}-other` })) {
            expect.unreachable(`list leaked ${ref.id} from another run`);
          }
        },
        timeout,
      );

      it(
        "pause confirms, is idempotent, and find/list never wake the box [inv 1, 4]",
        async () => {
          const box = await fx.box(provider, "pause");
          const outcome = await provider.pause(box.ref);
          expect(outcome.confirmed).toBe(true);
          const again = await provider.pause(box.ref);
          expect(again.confirmed).toBe(true);
          expect((await provider.find(fx.key("pause")))?.state).toBe("paused");
          const paused: string[] = [];
          for await (const ref of provider.list({ deployment: fx.deployment, states: ["paused"] })) paused.push(ref.id);
          expect(paused).toContain(box.ref.id);
          // Still paused after both lookups.
          expect((await provider.find(fx.key("pause")))?.state).toBe("paused");
        },
        timeout,
      );

      it(
        "open returns a running box whose guest answers [inv 3]",
        async () => {
          const box = await fx.box(provider, "open");
          await sh(box, `echo kept > ${SANDBOX_PATHS.workdir}/kept.txt`);
          await provider.pause(box.ref);
          const ref = (await provider.find(fx.key("open"))) as SandboxRef;
          const reopened = await provider.open(ref, { lifetimeMs: fx.lifetimeMs });
          expect((await reopened.exec("true")).exitCode).toBe(0);
          expect(await sh(reopened, `cat ${SANDBOX_PATHS.workdir}/kept.txt`)).toBe("kept");
          expect((await provider.find(fx.key("open")))?.state).toBe("running");
          // A JSON round trip stands in for reopening by ref from another process.
          const fromJson = await provider.open(JSON.parse(JSON.stringify(ref)) as SandboxRef, {
            lifetimeMs: fx.lifetimeMs,
          });
          expect(fromJson.ref.id).toBe(ref.id);
        },
        timeout,
      );

      it(
        "kill is idempotent; a killed box is a confirmed miss [inv 2, 5]",
        async () => {
          const box = await fx.box(provider, "kill");
          expect((await provider.kill(box.ref)).path).toBe("killed");
          expect((await provider.kill(box.ref)).path).toBe("already-gone");
          expect(await provider.find(fx.key("kill"))).toBeNull();
          await rejectsWith(provider.open(box.ref, { lifetimeMs: fx.lifetimeMs }), SandboxNotFoundError);
          const pause = await provider.pause(box.ref);
          expect(pause).toMatchObject({ confirmed: false, reason: "gone" });
        },
        timeout,
      );

      it(
        "a secret-looking variable in SandboxSpec.env throws SecretInEnvError [inv 18]",
        async () => {
          await rejectsWith(
            provider.openOrCreate(fx.key("secret"), fx.spec("secret", { env: { GITHUB_TOKEN: "x" } })),
            SecretInEnvError,
          );
          expect(await provider.find(fx.key("secret"))).toBeNull();
        },
        timeout,
      );

      it(
        "extendLifetime takes an absolute target and clamps to limits [inv 15]",
        async () => {
          const box = await fx.box(provider, "lifetime");
          const target = Date.now() + 60 * 60 * 1000;
          const extended = await box.extendLifetime(target);
          expect(extended.untilMs).toBeLessThanOrEqual(target);
          expect(extended.clamped).toBe(extended.untilMs < target);
          const far = await box.extendLifetime(Date.now() + provider.limits.maxLifetimeMs * 10);
          expect(far.clamped).toBe(true);
          expect(far.untilMs).toBeLessThanOrEqual(Date.now() + provider.limits.maxLifetimeMs);
        },
        timeout,
      );

      it(
        "five parallel creates make five boxes",
        async () => {
          const boxes = await Promise.all([0, 1, 2, 3, 4].map((i) => fx.box(provider, `load-${i}`)));
          expect(new Set(boxes.map((b) => b.ref.id)).size).toBe(5);
        },
        timeout,
      );

      caseIf(opts.ghost !== undefined, "no ghost hook (pass opts.ghost)")(
        "ghost refs converge: openOrCreate rebuilds once, then sticks to the new box [inv 6]",
        async () => {
          const first = await fx.box(provider, "ghost");
          await opts.ghost?.(first.ref);
          const rebuilt = await provider.openOrCreate(fx.key("ghost"), fx.spec("ghost"));
          expect(rebuilt.rebuilt).toBe(true);
          expect(rebuilt.handle.ref.id).not.toBe(first.ref.id);
          const again = await provider.openOrCreate(fx.key("ghost"), fx.spec("ghost"));
          expect(again.handle.ref.id).toBe(rebuilt.handle.ref.id);
          expect(again.rebuilt).toBe(false);
        },
        timeout,
      );
    });

    describe("outages and quotas", () => {
      withFaults(
        "find during an outage throws SandboxUnavailableError, never null [inv 2]",
        async () => {
          await fx.box(provider, "outage-find");
          for (const kind of ["503", "network"] as const) {
            faults().inject(kind, "find");
            await rejectsWith(provider.find(fx.key("outage-find")), SandboxUnavailableError);
          }
          expect(await provider.find(fx.key("outage-find"))).not.toBeNull();
        },
        timeout,
      );

      withFaults(
        "list during an outage throws instead of yielding nothing [inv 2]",
        async () => {
          await fx.box(provider, "outage-list");
          faults().inject("503", "list");
          const drain = async () => {
            for await (const _ref of provider.list({ deployment: fx.deployment })) {
              // drain
            }
          };
          await rejectsWith(drain(), SandboxUnavailableError);
        },
        timeout,
      );

      withFaults(
        "open during an outage throws SandboxUnavailableError, not SandboxNotFoundError [inv 2]",
        async () => {
          const box = await fx.box(provider, "outage-open");
          faults().inject("503", "open");
          await rejectsWith(provider.open(box.ref, { lifetimeMs: fx.lifetimeMs }), SandboxUnavailableError);
        },
        timeout,
      );

      withFaults(
        "pause during an outage throws; it is never reported as gone [inv 4, 5]",
        async () => {
          const box = await fx.box(provider, "outage-pause");
          faults().inject("503", "pause");
          await rejectsWith(provider.pause(box.ref), SandboxUnavailableError);
          expect(await provider.find(fx.key("outage-pause"))).not.toBeNull();
        },
        timeout,
      );

      withFaults(
        "a refused pause is a typed outcome, not a throw [inv 4]",
        async () => {
          const box = await fx.box(provider, "refuse-pause");
          faults().inject("refuse", "pause");
          expect(await provider.pause(box.ref)).toMatchObject({ confirmed: false, reason: "refused" });
        },
        timeout,
      );

      withFaults(
        "kill during an outage leaves the box in place [inv 5]",
        async () => {
          const box = await fx.box(provider, "outage-kill");
          faults().inject("503", "kill");
          await rejectsWith(provider.kill(box.ref), SandboxUnavailableError);
          expect((await provider.find(fx.key("outage-kill")))?.id).toBe(box.ref.id);
        },
        timeout,
      );

      withFaults(
        "a create whose response was lost converges on one box [inv 8]",
        async () => {
          faults().inject("timeout", "create");
          const result = await provider
            .openOrCreate(fx.key("lost-create"), fx.spec("lost-create"))
            .catch((error: unknown) => {
              if (error instanceof SandboxUnavailableError) return undefined;
              throw error;
            });
          const again = await provider.openOrCreate(fx.key("lost-create"), fx.spec("lost-create"));
          if (result) expect(again.handle.ref.id).toBe(result.handle.ref.id);
          expect((await fx.boxes(provider, "lost-create")).length).toBe(1);
        },
        timeout,
      );

      withFaults(
        "a 429 on create is retried within the deadline or raised as SandboxQuotaError",
        async () => {
          faults().inject("429", "create");
          try {
            const { handle } = await provider.openOrCreate(fx.key("quota"), fx.spec("quota"));
            expect((await handle.exec("true")).exitCode).toBe(0);
          } catch (error) {
            expect(error).toBeInstanceOf(SandboxQuotaError);
          }
        },
        timeout,
      );

      withFaults(
        "exec is never retried on a transient error",
        async () => {
          const box = await fx.box(provider, "no-retry");
          faults().inject("503", "exec");
          await rejectsWith(box.exec(`echo ran >> ${SANDBOX_PATHS.workdir}/ran.txt`), SandboxUnavailableError);
          const count = await sh(box, `cat ${SANDBOX_PATHS.workdir}/ran.txt 2>/dev/null | wc -l`);
          expect(Number(count)).toBe(0);
        },
        timeout,
      );

      withFaults(
        "a 401 is a fleet-wide SandboxAuthError",
        async () => {
          faults().inject("401", "find");
          await rejectsWith(provider.find(fx.key("auth")), SandboxAuthError);
        },
        timeout,
      );
    });

    describe("exec", () => {
      it(
        "a non-zero exit is returned, not thrown",
        async () => {
          const box = await fx.box(provider, "exec");
          const result = await box.exec("echo out; echo err >&2; exit 3");
          expect(result).toMatchObject({ exitCode: 3, truncated: false });
          expect(result.stdoutTail).toBe("out\n");
          expect(result.stderrTail).toBe("err\n");
        },
        timeout,
      );

      it(
        "streams line by line, unbuffered, split on \\n only [inv 10]",
        async () => {
          const box = await fx.box(provider, "exec");
          const lines: { stream: string; line: string; at: number }[] = [];
          const onLine: OnLine = (stream, line) => lines.push({ stream, line, at: Date.now() });
          await box.exec("printf 'first\\n'; sleep 1; printf 'a\\342\\200\\250b\\n'; echo err >&2; printf tail", {
            onLine,
          });
          const stdout = lines.filter((l) => l.stream === "stdout").map((l) => l.line);
          expect(stdout).toEqual(["first", "a b", "tail"]);
          expect(lines.find((l) => l.stream === "stderr")?.line).toBe("err");
          const [first, second] = lines;
          expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThan(500);
        },
        timeout,
      );

      it(
        "pipes stdin over 128 KiB, then closes it [inv 11]",
        async () => {
          const box = await fx.box(provider, "exec");
          const input = "x".repeat(200 * 1024);
          expect(await sh(box, "wc -c")).toBe("0");
          const result = await box.exec("wc -c", { stdin: input });
          expect(result.stdoutTail.trim()).toBe(String(input.length));
        },
        timeout,
      );

      it(
        "a timeout raises SandboxCommandTimeoutError with mayStillBeRunning",
        async () => {
          const box = await fx.box(provider, "exec");
          const error = await rejectsWith(box.exec("sleep 30", { timeoutMs: 500 }), SandboxCommandTimeoutError);
          expect(typeof error.mayStillBeRunning).toBe("boolean");
          expect(error.cmd).toBe("sleep 30");
        },
        timeout,
      );

      it(
        "keeps only a bounded tail [inv 10]",
        async () => {
          const box = await fx.box(provider, "exec");
          const result = await box.exec("head -c 300000 /dev/zero | tr '\\0' 'y'; echo; echo END", {
            maxTailBytes: 1024,
          });
          expect(result.truncated).toBe(true);
          expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(1024);
          expect(result.stdoutTail.endsWith("END\n")).toBe(true);
        },
        timeout,
      );

      it(
        "env: declared variables pass through; undeclared host variables never appear [inv 18]",
        async () => {
          const canary = `SELFBUILDING_CANARY_${Date.now()}`;
          process.env[canary] = "leaked";
          try {
            const box = await fx.box(provider, "env", { env: { DECLARED_AT_CREATE: "yes" } });
            const out = await sh(box, "env");
            expect(out).toContain("DECLARED_AT_CREATE=yes");
            expect(out).not.toContain(canary);
            expect(await sh(box, 'echo "$PER_EXEC"', {})).toBe("");
            const perExec = await box.exec('echo "$PER_EXEC"', { env: { PER_EXEC: "set" } });
            expect(perExec.stdoutTail.trim()).toBe("set");
            await rejectsWith(box.exec("true", { env: { ANTHROPIC_API_KEY: "x" } }), SecretInEnvError);
          } finally {
            delete process.env[canary];
          }
        },
        timeout,
      );

      it(
        "spawn survives the caller and attach resumes by byte offset from a fresh ref [inv 12]",
        async () => {
          const box = await fx.box(provider, "spawn");
          const proc = await box.spawn("echo one; sleep 0.3; echo two; exit 4");
          // Refs are plain JSON; reattach as another process would.
          const ref = JSON.parse(JSON.stringify(proc)) as typeof proc;
          const reopened = await provider.open(JSON.parse(JSON.stringify(box.ref)) as SandboxRef, {
            lifetimeMs: fx.lifetimeMs,
          });
          const seen: string[] = [];
          const done = await reopened.attach(ref, { fromOffset: 0, onLine: (_s, line) => seen.push(line) });
          expect(done).toMatchObject({ state: "exited", exitCode: 4 });
          expect(seen).toEqual(["one", "two"]);
          const tail: string[] = [];
          const replay = await reopened.attach(ref, { fromOffset: done.offset, onLine: (_s, line) => tail.push(line) });
          expect(tail).toEqual([]);
          expect(replay.offset).toBe(done.offset);
          const partial: string[] = [];
          await reopened.attach(ref, { fromOffset: 4, onLine: (_s, line) => partial.push(line) });
          expect(partial).toEqual(["two"]);
        },
        timeout,
      );

      it(
        "attach returns while the process still runs when its signal aborts",
        async () => {
          const box = await fx.box(provider, "spawn");
          const proc = await box.spawn("echo started; sleep 30");
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 700);
          const seen: string[] = [];
          const result = await box.attach(proc, {
            fromOffset: 0,
            signal: controller.signal,
            onLine: (_s, line) => seen.push(line),
          });
          expect(result.state).toBe("running");
          expect(seen).toEqual(["started"]);
          if (proc.pgid !== undefined) await box.exec(`kill -KILL -${proc.pgid} 2>/dev/null; true`);
        },
        timeout,
      );
    });

    describe("files", () => {
      it(
        "binary data round-trips exactly",
        async () => {
          const box = await fx.box(provider, "files");
          const bytes = new Uint8Array(256 * 4).map((_, i) => i % 256);
          await box.writeFiles([{ path: `${SANDBOX_PATHS.workdir}/bin/all-bytes.bin`, data: bytes }]);
          expect(sha256(await box.readFile(`${SANDBOX_PATHS.workdir}/bin/all-bytes.bin`))).toBe(sha256(bytes));
          expect(await sh(box, `wc -c < ${SANDBOX_PATHS.workdir}/bin/all-bytes.bin`)).toBe("1024");
        },
        timeout,
      );

      it(
        "a 10 MB file round-trips",
        async () => {
          const box = await fx.box(provider, "files");
          const big = new Uint8Array(10 * 1024 * 1024);
          for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251;
          await box.writeFiles([{ path: "/tmp/big.bin", data: big }]);
          expect(sha256(await box.readFile("/tmp/big.bin"))).toBe(sha256(big));
        },
        timeout,
      );

      it(
        "file modes are honoured (secrets are 0600)",
        async () => {
          const box = await fx.box(provider, "files");
          await box.writeFiles([{ path: `${SANDBOX_PATHS.secrets}/EXAMPLE`, data: "value", mode: 0o600 }]);
          // The secrets folder is root-only by design, so only root can stat inside it.
          const mode = await sh(
            box,
            `stat -c %a ${SANDBOX_PATHS.secrets}/EXAMPLE 2>/dev/null || stat -f %Lp ${SANDBOX_PATHS.secrets}/EXAMPLE`,
            { user: "root" },
          );
          expect(mode).toBe("600");
        },
        timeout,
      );

      it(
        "a missing file raises SandboxFileNotFoundError, never SandboxNotFoundError",
        async () => {
          const box = await fx.box(provider, "files");
          const error = await rejectsWith(box.readFile("/selfbuilding/out/missing.json"), SandboxFileNotFoundError);
          expect(error).not.toBeInstanceOf(SandboxNotFoundError);
          expect(error.path).toBe("/selfbuilding/out/missing.json");
        },
        timeout,
      );
    });

    describe("network", () => {
      // docs/decisions/0001-egress-enforcement.md: a vendor may accept a policy it does not enforce. That is a vendor
      // fact the adapter cannot fix, so the contract is that it is never silent: the box blocks, or the provider
      // refuses the policy, or its egress probe reports the leak.
      it(
        "a deny-all policy is enforced, refused with EgressPolicyUnsupportedError, or detected by probeEgress",
        async () => {
          let created: Awaited<ReturnType<SandboxProvider["openOrCreate"]>>;
          try {
            created = await provider.openOrCreate(fx.key("egress"), fx.spec("egress", { network: "deny-all" }));
          } catch (error) {
            expect(error).toBeInstanceOf(EgressPolicyUnsupportedError);
            return;
          }
          const probe = await created.handle.exec(DIRECT_EGRESS_PROBE);
          if (probe.exitCode !== 0) return;
          // The box reached the internet: the provider must be able to say so.
          expect(provider.probeEgress, "the policy leaks and the provider has no probeEgress").toBeTypeOf("function");
          const verdict = await provider.probeEgress?.(created.handle, "deny-all");
          expect(verdict?.enforced).toBe(false);
        },
        timeout,
      );

      it(
        "probeEgress, when offered, agrees with a direct connection attempt",
        async (ctx) => {
          if (typeof provider.probeEgress !== "function") ctx.skip("the provider has no probeEgress()");
          let box: ProviderSandbox;
          try {
            box = await fx.box(provider, "egress-agree", { network: "deny-all" });
          } catch (error) {
            expect(error).toBeInstanceOf(EgressPolicyUnsupportedError);
            return;
          }
          const direct = await box.exec(DIRECT_EGRESS_PROBE);
          const verdict = await provider.probeEgress?.(box, "deny-all");
          expect(verdict?.enforced).toBe(direct.exitCode !== 0);
          expect((await provider.probeEgress?.(box, "open"))?.enforced).toBe(true);
        },
        timeout,
      );
    });

    describe("state", () => {
      it(
        "snapshot reports fidelity and sourceState; a box made from it has the files, later writes do not leak",
        async (ctx) => {
          if (!hasSnapshot) ctx.skip("the provider has no snapshot()");
          const source = await fx.box(provider, "snap-source");
          await sh(source, `echo v1 > ${SANDBOX_PATHS.workdir}/state.txt`);
          const snap = await provider.snapshot?.(source.ref, { name: "conformance" });
          if (!snap) throw new Error("snapshot returned nothing");
          expect(["memory", "filesystem"]).toContain(snap.fidelity);
          expect(["running", "paused", "stopped"]).toContain(snap.sourceState);
          await sh(source, `echo v2 > ${SANDBOX_PATHS.workdir}/state.txt`);
          const image = (opts.snapshotImage ?? ((s, base) => ({ ...base, ref: s.snapshotId })))(snap, fx.image);
          const restored = await fx.box(provider, "snap-restored", { image });
          expect(await sh(restored, `cat ${SANDBOX_PATHS.workdir}/state.txt`)).toBe("v1");
        },
        timeout,
      );

      it(
        "fork gives every child the parent's files, a new identity and independent state",
        async (ctx) => {
          if (!hasFork) ctx.skip("the provider has no fork()");
          const parent = await fx.box(provider, "fork-parent");
          await sh(parent, `echo base > ${SANDBOX_PATHS.workdir}/shared.txt`);
          const children = await provider.fork?.(parent.ref, {
            children: [0, 1].map((i) => ({
              name: `${parent.ref.name}-f${i}`,
              labels: {
                "selfbuilding.deployment": fx.deployment,
                "selfbuilding.run": fx.runId,
                "selfbuilding.name": `${parent.ref.name}-f${i}`,
              },
            })),
            lifetimeMs: fx.lifetimeMs,
          });
          expect(children).toHaveLength(2);
          for (const child of children ?? []) expect(child).not.toBeInstanceOf(Error);
          const [a, b] = children as [ProviderSandbox, ProviderSandbox];
          for (const child of [a, b]) {
            expect(child.ref.id).not.toBe(parent.ref.id);
            expect(await sh(child, `cat ${SANDBOX_PATHS.workdir}/shared.txt`)).toBe("base");
          }
          expect(a.ref.id).not.toBe(b.ref.id);
          await sh(a, `echo from-a > ${SANDBOX_PATHS.workdir}/shared.txt`);
          await sh(parent, `echo from-parent > ${SANDBOX_PATHS.workdir}/shared.txt`);
          expect(await sh(b, `cat ${SANDBOX_PATHS.workdir}/shared.txt`)).toBe("base");
          expect(await sh(a, `cat ${SANDBOX_PATHS.workdir}/shared.txt`)).toBe("from-a");
          expect(await sh(parent, `cat ${SANDBOX_PATHS.workdir}/shared.txt`)).toBe("from-parent");
        },
        timeout,
      );

      it(
        "a failed fork child comes back as an error item, never one throw",
        async (ctx) => {
          if (!hasFork) ctx.skip("the provider has no fork()");
          if (!opts.faults) ctx.skip("no fault injection (pass opts.faults)");
          const parent = await fx.box(provider, "fork-fail");
          faults().inject("503", "fork.child");
          const children = await provider.fork?.(parent.ref, {
            children: [0, 1].map((i) => ({ name: `${parent.ref.name}-x${i}`, labels: {} })),
            lifetimeMs: fx.lifetimeMs,
          });
          expect(children).toHaveLength(2);
          expect(children?.filter((c) => c instanceof Error)).toHaveLength(1);
          expect(children?.find((c) => c instanceof Error)).toBeInstanceOf(SandboxUnavailableError);
        },
        timeout,
      );
    });

    describe("runtime and images", () => {
      it(
        "the image has Node 20 or later for the runtime bundle",
        async () => {
          const box = await fx.box(provider, "runtime");
          const major = Number(await sh(box, `node -p "process.versions.node.split('.')[0]"`));
          expect(major).toBeGreaterThanOrEqual(20);
        },
        timeout,
      );

      caseIf(opts.runtime !== undefined, "no runtime bundles (pass opts.runtime)")(
        "the runtime bundles upload intact and parse",
        async () => {
          const box = await fx.box(provider, "runtime");
          const bundles = opts.runtime as NonNullable<ConformanceOptions["runtime"]>;
          await box.writeFiles([
            { path: SANDBOX_PATHS.runtimeBundle, data: bundles.runtime, mode: 0o755, owner: "root" },
            { path: SANDBOX_PATHS.mcpBundle, data: bundles.mcp, mode: 0o755, owner: "root" },
          ]);
          for (const [file, data] of [
            [SANDBOX_PATHS.runtimeBundle, bundles.runtime],
            [SANDBOX_PATHS.mcpBundle, bundles.mcp],
          ] as const) {
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
            expect(sha256(await box.readFile(file))).toBe(sha256(bytes));
            expect((await box.exec(`node --check ${file}`)).exitCode).toBe(0);
          }
        },
        timeout,
      );

      caseIf((opts.harnessBinaries ?? []).length > 0, "no harness binaries listed (pass opts.harnessBinaries)")(
        "every harness CLI in the image prints --version",
        async () => {
          const box = await fx.box(provider, "images");
          for (const bin of opts.harnessBinaries ?? []) {
            const result = await box.exec(`${bin} --version`);
            expect(result.exitCode, `${bin} --version`).toBe(0);
            expect(result.stdoutTail.trim()).not.toBe("");
          }
        },
        timeout,
      );
    });
  });
}
