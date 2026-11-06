// Acceptance 12 (demo-path §5): on the Trigger host every agent call is a selfbuilding.agent child task. The child
// runs launch → wait on a waitpoint token → collect; accept (closures, follow-up turns, the journal) runs in the
// parent. Offline, with the local Trigger stand-in, tmpdir boxes and the real runtime.
import fs from "node:fs/promises";
import path from "node:path";
import { Agent, agent, factory, fileArtifacts, type SelfbuildingConfig } from "@selfbuilding/core";
import {
  createLocalTrigger,
  createTriggerHost,
  type LocalTrigger,
  memoryResultStore,
} from "@selfbuilding/host-trigger";
import { scripted, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

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
  const t = createLocalTrigger({ startAt: Date.now() });
  triggers.push(t);
  const rec = recorder();
  const config = (harness: SelfbuildingConfig["harness"]): SelfbuildingConfig => ({
    deployment: "acceptance",
    artifacts: fileArtifacts(path.join(dir, "artifacts")),
    sandbox: provider,
    ...(harness ? { harness } : {}),
    events: [rec.sink],
  });
  return { dir, provider, t, rec, config };
}

async function finished(t: LocalTrigger, id: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE"].includes(t.run(id).status)) {
    if (Date.now() > deadline) throw new Error(`run ${id} is still ${t.run(id).status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return t.run(id);
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

describe("acceptance 12: agent calls as Trigger child tasks", () => {
  it("a skill agent's done check runs in the parent, and its retry is a second child resuming the session", async () => {
    const w = await world("sba-children-retry-");
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
    // The follow-up turn resumes the first turn's session, so it plays the script's second turn.
    const harness = scriptedClaude([scripted.submit({ greeting: "hello" })], {
      turns: [[scripted.submit({ greeting: "hello, please" })]],
    });
    const Polite = factory(
      { name: "polite", input: z.object({}) },
      async () => (await Greet({ task: "Greet the reader." })).result,
    );
    createTriggerHost({
      config: w.config(harness),
      factories: { polite: Polite },
      agents: [Greet],
      trigger: w.t,
      store: memoryResultStore(),
      providers: [w.provider],
      settleMs: 0,
    });
    const { id } = await w.t.start("selfbuilding.factory", { factory: "polite", input: {}, runId: "ns_accept_retry" });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output, JSON.stringify(w.rec.events.filter((e) => e.level === "error"))).toMatchObject({
      status: "ok",
      output: { greeting: "hello, please" },
    });

    // The check closure saw both results; only the parent can run it, since no closure crosses into a child.
    expect(asserted).toEqual(["hello", "hello, please"]);
    const children = w.t.runs({ taskId: "selfbuilding.agent" });
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(children[0]?.idempotencyKey).toMatch(/^ns:ns_accept_retry:[a-z2-7]{26}:e0$/);
    expect(children[1]?.idempotencyKey).toMatch(/:e0:l1$/);
    const second = children[1]?.payload as {
      call: { launch: number; resume?: { message: string; sessionId?: string } };
    };
    expect(second.call.launch).toBe(1);
    expect(second.call.resume?.message).toContain("please");
    expect(second.call.resume?.sessionId).toBeTruthy();
    // The payload is plain JSON: no credentials and no check source.
    expect(JSON.stringify(children.map((c) => c.payload))).not.toContain("includes(");

    // One box for the call, reused by the follow-up turn, disposed of by the parent after accept.
    const launched = w.rec.of("agent.launched").map((e) => (e.data as { sandbox: string }).sandbox);
    expect(launched).toHaveLength(2);
    expect(new Set(launched).size).toBe(1);
    expect(w.rec.of("sandbox.disposed")).toHaveLength(1);
    const left = [];
    for await (const box of w.provider.list({ deployment: "acceptance", runId: "ns_accept_retry" })) left.push(box);
    expect(left).toHaveLength(0);
  });

  it("parallel agent calls run as concurrent children and the parent accepts each", async () => {
    const w = await world("sba-children-parallel-");
    const harness = scriptedClaude((call) => [scripted.sh("sleep 1"), scripted.submit({ name: call.callPath })]);
    const Two = factory({ name: "two", input: z.object({}) }, async () => {
      const [a, b] = await Promise.all(
        ["left", "right"].map((label) =>
          agent({ name: label, prompt: `Do the ${label} half.`, output: z.object({ name: z.string() }), label }),
        ),
      );
      return [a?.result.name, b?.result.name];
    });
    createTriggerHost({
      config: w.config(harness),
      factories: { two: Two },
      trigger: w.t,
      store: memoryResultStore(),
      providers: [w.provider],
      settleMs: 0,
    });
    const { id } = await w.t.start("selfbuilding.factory", { factory: "two", input: {}, runId: "ns_accept_parallel" });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output).toMatchObject({ status: "ok", output: ["left", "right"] });
    const children = w.t.runs({ taskId: "selfbuilding.agent" });
    expect(children.map((c) => (c.payload as { call: { callPath: string } }).call.callPath).sort()).toEqual([
      "left",
      "right",
    ]);
    // Both turns were running before either finished.
    const started = w.rec.of("turn.started").map((e) => Date.parse(e.ts));
    const ended = w.rec.of("turn.ended").map((e) => Date.parse(e.ts));
    expect(Math.max(...started)).toBeLessThan(Math.min(...ended));
  });

  it("the worker dies while a child waits: the restart collects the finished turn without running it again", async () => {
    const w = await world("sba-children-crash-");
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
    createTriggerHost({
      config: w.config(harness),
      factories: { one: One },
      trigger: w.t,
      store: memoryResultStore(),
      providers: [w.provider],
      settleMs: 0,
    });
    const { id } = await w.t.start("selfbuilding.factory", {
      factory: "one",
      input: {},
      runId: "ns_accept_child_crash",
    });
    const deadline = Date.now() + 30_000;
    while (w.rec.of("turn.started").length === 0) {
      if (Date.now() > deadline) throw new Error("the turn never started");
      await new Promise((r) => setTimeout(r, 25));
    }
    w.t.crash();
    // The box finishes on its own and wakes a token nobody is waiting on; the killed run's lease runs out.
    const token = () => w.t.tokens().find((t) => t.idempotencyKey.includes(":done:w0"));
    while (token()?.status !== "COMPLETED") {
      if (Date.now() > deadline) throw new Error(`the wake never arrived: ${JSON.stringify(w.t.tokens())}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    await w.t.advance(61_000);
    w.t.restart();
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output).toMatchObject({ status: "ok", output: { ok: true } });
    expect(w.rec.of("turn.started")).toHaveLength(1);
    expect(w.rec.launched()).toEqual(["one"]);
    expect(w.t.runs({ taskId: "selfbuilding.agent" })[0]?.attempts).toBe(2);
  });

  it("an agent's ask_human under AFK is opened by the child on its own token and answered in the box", async () => {
    const w = await world("sba-children-ask-");
    const question = { question: "Ship tonight?", choices: ["ship", "hold"], default: "hold", onTimeout: "default" };
    const harness = scriptedClaude([
      scripted.askHuman(question, "accepted"),
      scripted.submit({ decision: "went with the default" }),
    ]);
    const Asking = factory({ name: "asking", input: z.object({}) }, async () => {
      const r = await agent({
        name: "asker",
        prompt: "Ask whether to ship, then submit.",
        output: z.object({ decision: z.string() }),
        label: "asker",
      });
      return r.result;
    });
    const store = memoryResultStore();
    createTriggerHost({
      config: { ...w.config(harness), hitl: { mode: "afk", onTimeout: "default" } },
      factories: { asking: Asking },
      trigger: w.t,
      store,
      providers: [w.provider],
      settleMs: 0,
    });
    const { id } = await w.t.start("selfbuilding.factory", { factory: "asking", input: {}, runId: "ns_accept_ask" });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output, JSON.stringify(w.rec.events.filter((e) => e.level === "error"))).toMatchObject({
      status: "ok",
      output: { decision: "went with the default" },
    });
    const asks = Object.entries(store.dump()).filter(([key]) => key.startsWith("asks/"));
    expect(asks).toHaveLength(1);
    const record = asks[0]?.[1] as { askId: string; status: string; waitpoint: { host: string; ref: string } };
    expect(record.status).toBe("answered");
    // The ask's waitpoint is a Trigger token keyed on the ask id, created before the ask was posted.
    expect(record.waitpoint.host).toBe("trigger");
    const token = w.t.tokens().find((t) => t.id === record.waitpoint.ref);
    expect(token?.idempotencyKey).toBe(record.askId);
  });
});
