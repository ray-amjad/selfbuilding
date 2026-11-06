// Shared handles, forks and the sandbox cap across a crash and a resume: what a replay must rebuild exactly, and
// what a live run must never hold or hang on. Offline, on tmpdir boxes and the fake runtime.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLocalRemote,
  scriptedHarness,
  type TmpdirProvider,
  tempDir,
  tmpdirProvider,
  useFakeRuntime,
} from "../../test/agent-kit/kit.js";
import { AGENT_TUNABLES } from "../agent/lifecycle.js";
import { agent, factory, fileJournal, run, sandbox, step } from "../index.js";
import type { SelfbuildingEvent } from "../types/events.js";
import type { SandboxProvider } from "../types/sandbox.js";
import { runFactory } from "./run.js";

const Out = z.object({ summary: z.string() });

let dir: string;
let build: TmpdirProvider;
let repo: string;

beforeAll(async () => {
  AGENT_TUNABLES.waitSliceMs = 2_000;
  dir = await tempDir("sbc-handle-");
  build = tmpdirProvider({ root: path.join(dir, "build") });
  repo = `file://${(await createLocalRemote(dir, { files: { "README.md": "# playground\n" } })).bareDir}`;
});

afterAll(async () => {
  await build.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const config = (provider: SandboxProvider = build) => ({
  deployment: "test",
  sandbox: provider,
  harness: scriptedHarness([]),
});

function launched(events: SelfbuildingEvent[]): string[] {
  return events.filter((e) => e.type === "agent.launched").map((e) => e.callPath);
}

async function liveBoxes(runId: string): Promise<number> {
  let n = 0;
  for await (const ref of build.list({ deployment: "test", runId })) if (ref.state !== "stopped") n++;
  return n;
}

/** Wraps a provider (binding every method, since the tmpdir provider keeps private fields). */
function wrapped(provider: SandboxProvider, over: Partial<SandboxProvider>): SandboxProvider {
  return new Proxy(provider, {
    get(target, prop) {
      if (prop in over) return over[prop as keyof SandboxProvider];
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("shared handles across a resume", () => {
  it("replays every finished call on a handle, not just the first, and replays its fork", async () => {
    useFakeRuntime({ "*": [{ result: { summary: "ok" } }] });
    let crash = true;
    const Pipeline = factory({ name: "handle-pipeline", input: z.object({ repo: z.string() }) }, async ({ repo }) => {
      await using box = sandbox({ label: "work", repo });
      const a = await agent({ name: "A", prompt: "a", output: Out, sandbox: box, label: "a" });
      const b = await agent({ name: "B", prompt: "b", output: Out, sandbox: box, label: "b" });
      const forks = await box.fork(1);
      const c = await agent({ name: "C", prompt: "c", output: Out, sandbox: forks[0] ?? "fresh", label: "c" });
      await forks[0]?.dispose();
      if (crash) throw new Error("the orchestrator died here");
      return [a.replayed, b.replayed, c.replayed];
    });
    const journal = fileJournal(path.join(dir, "journal-pipeline"));
    const first: SelfbuildingEvent[] = [];
    const runId = "ns_handlepipeline";
    const crashed = await run(Pipeline, { repo }, { runId, config: config(), journal, events: [(e) => first.push(e)] });
    expect(crashed.status).toBe("failed");
    expect(launched(first)).toEqual(["a", "b", "c"]);

    crash = false;
    const again: SelfbuildingEvent[] = [];
    const second = await run(Pipeline, { repo }, { runId, config: config(), journal, events: [(e) => again.push(e)] });
    expect(second.status).toBe("ok");
    expect(second.output).toEqual([true, true, true]);
    expect(launched(again)).toEqual([]);
    // The fork came from the journal: no box was made for it, or for the handle.
    expect(again.some((e) => e.type === "sandbox.forked")).toBe(false);
    expect(again.some((e) => e.type === "sandbox.fork_replayed")).toBe(true);
    expect(again.some((e) => e.type === "sandbox.created")).toBe(false);
  });

  it("keys an agent call the same whether a step started beside it replayed or ran live", async () => {
    useFakeRuntime({ "*": [{ result: { summary: "ok" } }] });
    const Mixed = factory({ name: "mixed-order", input: z.object({ repo: z.string() }) }, async ({ repo }) => {
      const review = agent({ name: "Review", prompt: "review", output: Out, repo, label: "review" });
      const fetched = await step("fetch", async () => "data");
      const r = await review;
      const later = await agent({ name: "Later", prompt: "later", output: Out, repo, label: "later" });
      return { fetched, replayed: [r.replayed, later.replayed] };
    });
    const journal = fileJournal(path.join(dir, "journal-mixed"));
    const runId = "ns_mixedorder";
    const first = await run(Mixed, { repo }, { runId, config: config(), journal, events: [] });
    expect(first.status).toBe("ok");
    const again: SelfbuildingEvent[] = [];
    const second = await run(Mixed, { repo }, { runId, config: config(), journal, events: [(e) => again.push(e)] });
    expect((second.output as { replayed: boolean[] }).replayed).toEqual([true, true]);
    expect(launched(again)).toEqual([]);
  });

  it("kills a box whose workspace setup failed, so a retry never finds a half-set-up box", async () => {
    const Broken = factory({ name: "broken-setup", input: z.object({}) }, async () => {
      const box = sandbox({ label: "w", repo: `file://${path.join(dir, "no-such-remote.git")}` });
      const first = await box.exec("true").catch((e: unknown) => e);
      const second = await box.exec("true").catch((e: unknown) => e);
      return [(first as Error).name, (second as Error).name];
    });
    const runId = "ns_brokensetup";
    const out = await run(Broken, {}, { runId, config: config(), events: [] });
    expect(out.output).toEqual(["PushFailedError", "PushFailedError"]);
    expect(await liveBoxes(runId)).toBe(0);
  });
});

describe("the sandbox cap with shared handles", () => {
  it("reports a fork the cap can never admit as SandboxCapDeadlockError instead of hanging", async () => {
    const Greedy = factory({ name: "greedy-fork", input: z.object({}) }, async () => {
      await using box = sandbox({ label: "w" });
      await box.exec("true");
      await box.fork(2);
      return null;
    });
    await expect(
      runFactory(Greedy, {}, { config: config(), concurrency: { sandboxes: 2 }, events: [] }, { deadlockAfterMs: 50 }),
    ).rejects.toMatchObject({ name: "SandboxCapDeadlockError" });
  }, 20_000);

  it("parks an idle handle so a fresh call can run under a full cap, then reopens it", async () => {
    useFakeRuntime({ "*": [{ result: { summary: "ok" } }] });
    const Parks = factory({ name: "parks-idle", input: z.object({}) }, async () => {
      await using box = sandbox({ label: "w" });
      await box.exec("echo one > one.txt");
      const r = await agent({ name: "Fresh", prompt: "go", output: Out, label: "fresh" });
      const back = await box.exec("cat one.txt");
      return [r.result.summary, back.stdoutTail.trim()];
    });
    const events: SelfbuildingEvent[] = [];
    const out = await runFactory(
      Parks,
      {},
      { config: config(), concurrency: { sandboxes: 1 }, events: [(e) => events.push(e)] },
      { deadlockAfterMs: 50 },
    );
    expect(out.output).toEqual(["ok", "one"]);
    expect(events.some((e) => e.type === "sandbox.parked")).toBe(true);
  }, 30_000);

  it("gives back every slot when a fork throws, and falls back to git in best mode", async () => {
    let refuse = 2;
    const refusing = wrapped(build, {
      fork: async (...args: Parameters<NonNullable<SandboxProvider["fork"]>>) => {
        if (refuse-- > 0) throw new Error("the provider refused the fork");
        return (build.fork as NonNullable<SandboxProvider["fork"]>).apply(build, args);
      },
    });
    const Forks = factory({ name: "fork-throws", input: z.object({ repo: z.string() }) }, async ({ repo }) => {
      await using box = sandbox({ label: "w", repo, provider: refusing });
      await box.exec("true");
      const strict = await box.fork(1, { mode: "filesystem" }).catch((e: unknown) => (e as Error).message);
      const best = await box.fork(1);
      await Promise.all(best.map((f) => f?.dispose()));
      // Under a cap of 2 this only fits if the failed fork gave its slot back.
      const again = await box.fork(1, { mode: "filesystem" });
      await Promise.all(again.map((f) => f?.dispose()));
      return { strict, best: best.map((f) => f?.forkedWith ?? null), again: again.map((f) => f?.forkedWith ?? null) };
    });
    const out = await run(Forks, { repo }, { config: config(), concurrency: { sandboxes: 2 }, events: [] });
    expect(out.output).toEqual({ strict: "the provider refused the fork", best: ["git"], again: ["filesystem"] });
  }, 30_000);
});
