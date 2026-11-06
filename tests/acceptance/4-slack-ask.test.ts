// Acceptance 4 (docs/BASIC-SCOPE.md): the Slack ask round trip. A hot wait is answered by a button click; a cold
// wait parks the sandbox and resumes the session with the answer; AFK policies resolve asks without a human.
//
// The agent asks from inside its box through the real selfbuilding-mcp `ask_human` tool. The ask is posted by the
// real Slack channel to the Slack emulator, the click is delivered to the hooks HITL handler over HTTP, the handler
// writes the run's ask store, and the run picks the answer up.
import path from "node:path";
import { agent, ask, factory, fileArtifacts, fileJournal, run, type SelfbuildingEvent } from "@selfbuilding/core";
import { scripted, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";
import { type SlackRig, startSlackRig } from "./support/slack.js";

let dir: string;
let slackRig: SlackRig;
let provider: TmpdirProvider;

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-ask-");
  slackRig = await startSlackRig();
  provider = tmpdirProvider({ root: path.join(dir, "boxes") });
});

afterAll(async () => {
  await provider?.close();
  await slackRig?.close();
});

const Decision = z.object({ decision: z.string() });
const question = { question: "Ship the migration tonight?", choices: ["ship", "hold"], default: "hold" };

/** One agent that asks a human from inside its box, then submits. */
const AskingAgent = factory({ name: "asking-agent", input: z.object({}) }, async () => {
  const r = await agent({
    name: "asker",
    prompt: "Ask whether to ship, then submit.",
    output: Decision,
    label: "asker",
  });
  return r.result;
});

function toolOutputs(events: SelfbuildingEvent[], tool: string): string[] {
  const ids = new Set(
    events
      .filter((e) => e.type === "harness.tool.started" && JSON.stringify(e.data).includes(tool))
      .map((e) => (e.data as { callId: string }).callId),
  );
  return events
    .filter((e) => e.type === "harness.tool.completed" && ids.has((e.data as { callId: string }).callId))
    .map((e) => String((e.data as { output?: unknown }).output ?? ""));
}

const artifacts = () => fileArtifacts(path.join(dir, "artifacts"));

async function boxStates(runId: string): Promise<string[]> {
  const states: string[] = [];
  for await (const ref of provider.list({ deployment: "acceptance", runId })) states.push(ref.state);
  return states;
}

describe("acceptance 4: Slack ask round trip", () => {
  it("hot wait: the agent's ask_human blocks, a button click in Slack answers it, and the agent carries on", async () => {
    const runId = "ns_accept_hot";
    const journal = fileJournal(path.join(dir, "hot"));
    const asks = journal.asks;
    if (!asks) throw new Error("fileJournal must provide an ask store");
    slackRig.listen(asks);
    const events = recorder();
    const harness = scriptedClaude([
      scripted.askHuman(question, "accepted"),
      scripted.submit({ decision: "after the human answered" }),
    ]);
    const running = run(
      AskingAgent,
      {},
      {
        runId,
        config: {
          deployment: "acceptance",
          sandbox: provider,
          harness,
          artifacts: artifacts(),
          hitl: slackRig.hitl({ hotWait: "10m" }),
        },
        journal,
        events: [events.sink],
      },
    );
    running.catch(() => {});

    const record = await slackRig.waitForAsk(asks, runId);
    expect(record.spec.question).toBe(question.question);
    // While the hot wait holds, the box stays up.
    expect(await boxStates(runId)).toEqual(["running"]);
    await slackRig.click(record, "ship");

    const out = await running;
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    expect(out.output).toEqual({ decision: "after the human answered" });
    // The tool call returned the human's answer to the agent, in the same launch.
    expect(toolOutputs(events.events, "ask_human").join("\n")).toContain("ship");
    expect(events.launched()).toEqual(["asker"]);
    const resolved = await asks.get(record.askId);
    expect(resolved?.status).toBe("answered");
    expect(resolved?.resolution?.answeredBy).toMatchObject({ kind: "human" });
    expect(await slackRig.transcript()).toContain(question.question);
  });

  it("cold wait: the ask suspends the turn, the box is parked, and the answer resumes the session", async () => {
    const runId = "ns_accept_cold";
    const journal = fileJournal(path.join(dir, "cold"));
    const asks = journal.asks;
    if (!asks) throw new Error("fileJournal must provide an ask store");
    slackRig.listen(asks);
    const events = recorder();
    // A hot limit under 30 s goes cold at once (spec §8.4). The resumed turn is the script's second turn.
    const harness = scriptedClaude([scripted.askHuman(question, "suspended")], {
      turns: [
        [
          // The resumed turn's prompt carries the human's answer.
          scripted.sh("grep -rqi 'answer to your question #1.*hold' /selfbuilding/in", { expectExit: 0 }),
          scripted.submit({ decision: "resumed with the answer" }),
        ],
      ],
    });
    const running = run(
      AskingAgent,
      {},
      {
        runId,
        config: {
          deployment: "acceptance",
          sandbox: provider,
          artifacts: artifacts(),
          harness,
          hitl: slackRig.hitl({ hotWait: "1s", timeout: "1h", onTimeout: "default" }),
        },
        journal,
        events: [events.sink],
      },
    );
    running.catch(() => {});

    const record = await slackRig.waitForAsk(asks, runId);
    // Parked while it waits: the box is paused, not running and not gone.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(await boxStates(runId)).includes("paused")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const parked = await boxStates(runId);
    await slackRig.click(record, "hold");

    const out = await running;
    expect(parked).toEqual(["paused"]);
    expect(events.of("sandbox.parked")).toHaveLength(1);
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    expect(out.output).toEqual({ decision: "resumed with the answer" });
    // One box, two launches of the same call: the ask, then the resumed session with the answer.
    expect(events.launched()).toEqual(["asker", "asker"]);
    const sessions = events.of("harness.session.started").map((e) => JSON.stringify(e.data));
    expect(new Set(sessions.map((s) => /"sessionId":"([^"]+)"/.exec(s)?.[1])).size).toBe(1);
    expect((await asks.get(record.askId))?.resolution?.answeredBy).toMatchObject({ kind: "human" });
  });

  describe("AFK policies", () => {
    const Gate = (policy: "default" | "fail", risk?: "high") =>
      factory({ name: `afk-${policy}${risk ? "-high" : ""}`, input: z.object({}) }, async () => {
        const res = await ask({
          question: "Merge it?",
          choices: [
            { id: "merge", label: "Merge" },
            { id: "hold", label: "Hold", safe: true },
          ],
          default: risk ? "merge" : "hold",
          onTimeout: policy,
          ...(risk ? { risk } : {}),
        });
        return { choice: res.choiceId, by: res.answeredBy };
      });
    const config = () => ({
      deployment: "acceptance",
      sandbox: provider,
      harness: scriptedClaude([]),
      artifacts: artifacts(),
    });

    it("mode afk with onTimeout default: resolves at once to the default, posts no ask, records the decision", async () => {
      const events = recorder();
      const before = (await slackRig.emu.messages()).length;
      const out = await run(
        Gate("default"),
        {},
        {
          config: { ...config(), hitl: slackRig.hitl({ mode: "afk" }) },
          events: [events.sink],
        },
      );
      expect(out.status).toBe("ok");
      expect(out.output).toEqual({ choice: "hold", by: { kind: "default", reason: "afk" } });
      // The ask itself is never posted; only the run-end summary the default notify options ask for.
      const posted = JSON.stringify((await slackRig.emu.messages()).slice(before));
      expect(posted).not.toContain("Merge it?");
      expect(posted).toContain("Finished: *ok*");
      expect(JSON.stringify(events.events.filter((e) => e.type.startsWith("ask.")))).toContain("afk");
    });

    it("a high-risk ask without a human resolves only to its safe choice", async () => {
      const out = await run(
        Gate("default", "high"),
        {},
        { config: { ...config(), hitl: { mode: "afk" } }, events: [] },
      );
      expect(out.status).toBe("ok");
      expect((out.output as { choice: string }).choice).toBe("hold");
    });

    it("onTimeout fail: the run fails with AskTimeoutError when nobody answers in time", async () => {
      const events = recorder();
      const out = await run(
        Gate("fail"),
        {},
        {
          config: { ...config(), hitl: slackRig.hitl({ timeout: "1s" }) },
          events: [events.sink],
        },
      );
      expect(out.status).toBe("failed");
      expect(JSON.stringify(events.of("error"))).toContain("AskTimeoutError");
    });

    it("an agent's ask_human under AFK gets the default at once and the agent finishes", async () => {
      const events = recorder();
      const harness = scriptedClaude([
        scripted.askHuman({ ...question, onTimeout: "default" }, "accepted"),
        scripted.submit({ decision: "went with the default" }),
      ]);
      const out = await run(
        AskingAgent,
        {},
        {
          config: {
            deployment: "acceptance",
            sandbox: provider,
            harness,
            artifacts: artifacts(),
            hitl: { mode: "afk", onTimeout: "default" },
          },
          events: [events.sink],
        },
      );
      expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
      expect(toolOutputs(events.events, "ask_human").join("\n")).toContain("hold");
    });
  });
});
