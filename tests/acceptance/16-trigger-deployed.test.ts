// Acceptance 16 (release-prep §3.3): acceptance 12 as a deployed Trigger.dev project would run it. Every task run,
// and every retry of one, builds its own host with its own s3ResultStore instance over one fake S3 bucket, so
// nothing passes between the parent and its children except the bucket and the platform: no shared memory. Offline,
// with the local Trigger stand-in, tmpdir boxes and the real runtime.
import fs from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  type AskRecord,
  agent,
  factory,
  fileArtifacts,
  memoryChannel,
  type SelfbuildingConfig,
  sandbox,
} from "@selfbuilding/core";
import {
  createLocalTrigger,
  createTriggerAskResolver,
  type LocalTrigger,
  resultStoreAsks,
} from "@selfbuilding/host-trigger";
import { createLocalRemote, scripted, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";
import { type FakeBucket, fakeBucket, perRunHosts, storeOver } from "./support/trigger-deployed.js";

const BUCKET = "selfbuilding-acceptance";
const providers: ReturnType<typeof tmpdirProvider>[] = [];
const triggers: LocalTrigger[] = [];
afterAll(async () => {
  await Promise.all(providers.map((p) => p.close()));
  await Promise.all(triggers.map((t) => t.close()));
});

async function world(prefix: string) {
  useBuiltRuntime();
  const dir = await tempDir(prefix);
  const provider = tmpdirProvider({ root: path.join(dir, "boxes") });
  providers.push(provider);
  // A deployed environment: the host refuses any store but a shared one.
  const t = createLocalTrigger({ startAt: Date.now(), environment: "PRODUCTION" });
  triggers.push(t);
  const bucket = fakeBucket(BUCKET, 7);
  const rec = recorder();
  const config = (
    harness: SelfbuildingConfig["harness"],
    over: Partial<SelfbuildingConfig> = {},
  ): SelfbuildingConfig => ({
    deployment: "acceptance",
    artifacts: fileArtifacts(path.join(dir, "artifacts")),
    sandbox: provider,
    ...(harness ? { harness } : {}),
    events: [rec.sink],
    ...over,
  });
  return { dir, provider, t, bucket, rec, config, store: () => storeOver(bucket, BUCKET) };
}

async function finished(t: LocalTrigger, id: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE"].includes(t.run(id).status)) {
    if (Date.now() > deadline) throw new Error(`run ${id} is still ${t.run(id).status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return t.run(id);
}

async function until<T>(what: string, read: () => Promise<T | null | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function keysUnder(bucket: FakeBucket, prefix: string): string[] {
  return [...bucket.objects.keys()].filter((k) => k.startsWith(`selfbuilding/results/${prefix}`));
}

async function writeSkill(dir: string): Promise<string> {
  const skill = path.join(dir, "skills", "greet");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: greet\ndescription: Greets the reader politely.\n---\n\nWrite a greeting and submit it.\n",
  );
  return skill;
}

describe("acceptance 16: a deployed Trigger.dev project over a shared bucket", () => {
  it("a local store is refused in a deployed environment", async () => {
    const w = await world("sba-deployed-refuse-");
    const { memoryResultStore, createTriggerHost } = await import("@selfbuilding/host-trigger");
    const One = factory({ name: "one", input: z.object({}) }, async () => 1);
    const t = createLocalTrigger({ environment: "PRODUCTION", maxAttempts: 1 });
    triggers.push(t);
    createTriggerHost({ config: w.config(undefined), factories: { one: One }, trigger: t, store: memoryResultStore() });
    const { id } = await t.start("selfbuilding.factory", { factory: "one", input: {} });
    const run = await finished(t, id);
    expect(run.status).toBe("FAILED");
    expect(run.error?.message).toContain("needs a result store every machine can reach");
  });

  it("a done-check retry is a second child resuming the session, each task on its own store instance", async () => {
    const w = await world("sba-deployed-retry-");
    const asserted: string[] = [];
    const Greet = await Agent.fromSkill(await writeSkill(w.dir), {
      output: z.object({ greeting: z.string() }),
      workspace: { repo: "optional" },
      done: [
        {
          id: "polite",
          assert: (r: { greeting: string }) => {
            asserted.push(r.greeting);
            return r.greeting.includes("please") || "Add the word please.";
          },
        },
      ],
    });
    const harness = scriptedClaude([scripted.submit({ greeting: "hello" })], {
      turns: [[scripted.submit({ greeting: "hello, please" })]],
    });
    const Polite = factory(
      { name: "polite", input: z.object({}) },
      async () => (await Greet({ task: "Greet the reader." })).result,
    );
    const hosts = perRunHosts(w.t, () => ({
      config: w.config(harness),
      factories: { polite: Polite },
      agents: [Greet],
      store: w.store(),
      providers: [w.provider],
      settleMs: 0,
    }));
    const { id } = await w.t.start("selfbuilding.factory", {
      factory: "polite",
      input: {},
      runId: "ns_deployed_retry",
    });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output, JSON.stringify(w.rec.events.filter((e) => e.level === "error"))).toMatchObject({
      status: "ok",
      output: { greeting: "hello, please" },
    });
    expect(asserted).toEqual(["hello", "hello, please"]);
    const children = w.t.runs({ taskId: "selfbuilding.agent" });
    expect(children.map((c) => c.status)).toEqual(["COMPLETED", "COMPLETED"]);
    // One host for the template, one per task run: the parent and both children each built their own.
    expect(hosts.built).toBeGreaterThanOrEqual(4);
    // Everything the run kept is in the bucket.
    expect(keysUnder(w.bucket, "runs/ns_deployed_retry/run.json")).toHaveLength(1);
    expect(keysUnder(w.bucket, "runs/ns_deployed_retry/e0/accepted/")).not.toHaveLength(0);
    expect(keysUnder(w.bucket, "outcomes/ns_deployed_retry/")).toHaveLength(2);
    expect(w.bucket.refused).toBeGreaterThan(0);
    // Box time reaches the accepted result although the box lived in the children.
    const entries = [];
    for (const key of keysUnder(w.bucket, "runs/ns_deployed_retry/e0/accepted/")) {
      entries.push(
        await w
          .store()
          .get<{ kind: string; value: { usage?: { sandboxMs: number } } }>(key.slice("selfbuilding/results/".length)),
      );
    }
    const accepted = entries.find((e) => e?.kind === "agent");
    expect(accepted?.value.usage?.sandboxMs, JSON.stringify(entries)).toBeGreaterThan(0);
    const left = [];
    for await (const box of w.provider.list({ deployment: "acceptance", runId: "ns_deployed_retry" })) left.push(box);
    expect(left).toHaveLength(0);
  });

  it("parallel agent calls run as concurrent children and the parent accepts each", async () => {
    const w = await world("sba-deployed-parallel-");
    const harness = scriptedClaude((call) => [scripted.sh("sleep 1"), scripted.submit({ name: call.callPath })]);
    const Two = factory({ name: "two", input: z.object({}) }, async () => {
      const [a, b] = await Promise.all(
        ["left", "right"].map((label) =>
          agent({ name: label, prompt: `Do the ${label} half.`, output: z.object({ name: z.string() }), label }),
        ),
      );
      return [a?.result.name, b?.result.name];
    });
    perRunHosts(w.t, () => ({
      config: w.config(harness),
      factories: { two: Two },
      store: w.store(),
      providers: [w.provider],
      settleMs: 0,
    }));
    const { id } = await w.t.start("selfbuilding.factory", {
      factory: "two",
      input: {},
      runId: "ns_deployed_parallel",
    });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output).toMatchObject({ status: "ok", output: ["left", "right"] });
    const started = w.rec.of("turn.started").map((e) => Date.parse(e.ts));
    const ended = w.rec.of("turn.ended").map((e) => Date.parse(e.ts));
    expect(Math.max(...started)).toBeLessThan(Math.min(...ended));
  });

  it("the worker dies while the parent and its child wait: the restart collects the turn without running it again", async () => {
    const w = await world("sba-deployed-crash-");
    const harness = scriptedClaude([scripted.say("working"), scripted.sh("sleep 2"), scripted.submit({ ok: true })]);
    const One = factory({ name: "one", input: z.object({}) }, async () => {
      const r = await agent({
        name: "one",
        prompt: "Do one thing.",
        output: z.object({ ok: z.boolean() }),
        label: "one",
      });
      return r.result;
    });
    perRunHosts(w.t, () => ({
      config: w.config(harness),
      factories: { one: One },
      store: w.store(),
      providers: [w.provider],
      settleMs: 0,
    }));
    const { id } = await w.t.start("selfbuilding.factory", { factory: "one", input: {}, runId: "ns_deployed_crash" });
    await until("the turn to start", async () => w.rec.of("turn.started").length > 0);
    w.t.crash();
    await until("the wake to land while nothing runs", async () =>
      w.t.tokens().find((tk) => tk.idempotencyKey.includes(":done:w0") && tk.status === "COMPLETED"),
    );
    await w.t.advance(61_000);
    w.t.restart();
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output).toMatchObject({ status: "ok", output: { ok: true } });
    expect(w.rec.of("turn.started")).toHaveLength(1);
    expect(w.t.run(id).attempts).toBe(2);
    expect(w.t.runs({ taskId: "selfbuilding.agent" })[0]?.attempts).toBe(2);
  });

  it("a cold ask is marked in the bucket, survives a crash, and its answer resumes the session", async () => {
    const w = await world("sba-deployed-cold-");
    const channel = memoryChannel();
    const harness = scriptedClaude(
      [
        scripted.askHuman(
          { question: "Ship the migration tonight?", choices: ["ship", "hold"], default: "hold" },
          "suspended",
        ),
      ],
      {
        turns: [
          [
            scripted.sh("grep -rqi 'answer to your question #1.*ship' /selfbuilding/in", { expectExit: 0 }),
            scripted.submit({ decision: "resumed after the answer" }),
          ],
        ],
      },
    );
    const Asking = factory({ name: "asking", input: z.object({}) }, async () => {
      const r = await agent({
        name: "asker",
        prompt: "Ask whether to ship, then submit.",
        output: z.object({ decision: z.string() }),
        label: "asker",
      });
      return r.result;
    });
    const sliceMs = 60_000;
    perRunHosts(w.t, () => ({
      config: w.config(harness, {
        hitl: {
          channels: [channel],
          approvers: [{ slack: channel.user.userId }],
          hotWait: "1s",
          timeout: "1h",
          onTimeout: "fail",
        },
      }),
      factories: { asking: Asking },
      store: w.store(),
      providers: [w.provider],
      settleMs: 0,
      askSliceMs: sliceMs,
    }));
    const { id } = await w.t.start("selfbuilding.factory", { factory: "asking", input: {}, runId: "ns_deployed_cold" });
    const asks = resultStoreAsks(w.store());
    const opened = await until("the ask to be posted", async () => {
      for await (const r of asks.open({ runId: "ns_deployed_cold" })) return r;
      return null;
    });
    expect(channel.posts).toHaveLength(1);
    // The hot wait ends in the box; the child sees it when its wait slice ends.
    const cold = await until(
      "the ask to be marked cold",
      async () => {
        const r = await asks.get(opened.askId);
        if (r?.cold) return r;
        await w.t.advance(sliceMs);
        return null;
      },
      45_000,
    );
    expect(cold.status).toBe("open");
    expect(cold.cold?.sessionId).toBeTruthy();
    expect(cold.cold?.sandbox?.provider).toBe(w.provider.id);

    // The worker dies with the ask parked; the answer arrives through yet another store instance while it is down.
    w.t.crash();
    const resolver = createTriggerAskResolver({ trigger: w.t, store: w.store() });
    const result = await resolver.resolve(opened.askId, {
      askId: opened.askId,
      answer: { kind: "choice", choiceId: "ship" },
      choiceId: "ship",
      answeredBy: { kind: "human", channel: "slack", userId: channel.user.userId, displayName: "approver" },
      answeredAt: new Date().toISOString(),
    });
    expect(result.won).toBe(true);
    // The killed attempt's lease on the run runs out before the platform retries it.
    await w.t.advance(61_000);
    w.t.restart();
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output, JSON.stringify([run.output, w.rec.events.filter((e) => e.level === "error")])).toMatchObject({
      status: "ok",
      output: { decision: "resumed after the answer" },
    });
    const record = (await asks.get(opened.askId)) as AskRecord;
    expect(record).toMatchObject({ status: "answered", resolution: { choiceId: "ship" } });
    expect(record.cold?.since).toBe(cold.cold?.since);
    // The ask was posted once, never again after the restart.
    expect(channel.posts).toHaveLength(1);
  });

  it("calls on a shared handle stay in the parent task, said once per run, and are never dispatched", async () => {
    const w = await world("sba-deployed-handle-");
    const repo = (await createLocalRemote(path.join(w.dir, "remote"), { files: { "README.md": "# handle\n" } })).url;
    const must = (cmd: string) => scripted.sh(cmd, { expectExit: 0 });
    const harness = scriptedClaude((call) => {
      const label = call.callPath.split("/").at(-1);
      const steps = label === "a" ? [must("echo shared > notes.txt")] : [must("grep -q shared notes.txt")];
      return [...steps, scripted.submit({ ok: true })];
    });
    const Ok = z.object({ ok: z.literal(true) });
    const Shared = factory({ name: "shared", input: z.object({}) }, async () => {
      await using box = sandbox({ label: "work", repo });
      await agent({ name: "a", prompt: "Write notes.", output: Ok, label: "a", sandbox: box, repo });
      await agent({ name: "b", prompt: "Read notes.", output: Ok, label: "b", sandbox: box, repo });
      return "shared";
    });
    perRunHosts(w.t, () => ({
      config: w.config(harness),
      factories: { shared: Shared },
      store: w.store(),
      providers: [w.provider],
      settleMs: 0,
    }));
    const { id } = await w.t.start("selfbuilding.factory", {
      factory: "shared",
      input: {},
      runId: "ns_deployed_handle",
    });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output, JSON.stringify(w.rec.events.filter((e) => e.level === "error"))).toMatchObject({
      status: "ok",
      output: "shared",
    });
    expect(w.t.runs({ taskId: "selfbuilding.agent" })).toHaveLength(0);
    const notes = w.rec
      .of("log")
      .filter((e) =>
        String((e.data as { message?: string }).message).startsWith("shared-handle call runs in the parent task"),
      );
    expect(notes).toHaveLength(1);
    const boxes = w.rec.of("agent.launched").map((e) => (e.data as { sandbox: string }).sandbox);
    expect(boxes).toHaveLength(2);
    expect(new Set(boxes).size).toBe(1);
  });
});
