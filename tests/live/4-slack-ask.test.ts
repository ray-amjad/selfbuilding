// Live acceptance 4: the Slack ask round trip in a real workspace. A real agent asks through ask_human; the person
// named by SELFBUILDING_LIVE_APPROVER answers in Slack (once within the hot wait, once after the box has parked);
// and an AFK ask resolves to its default while only the run summary reaches the channel. The restart case kills the
// host while the ask is cold, takes the person's answer with no run process alive, and resumes on a new process.
import { readFileSync } from "node:fs";
import path from "node:path";
import { slack } from "@selfbuilding/channel-slack";
import { type AskRecord, agent, ask, factory, fileArtifacts, fileJournal, run } from "@selfbuilding/core";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startColdHost } from "./support/cold-restart.js";
import { serveHitl } from "./support/hooks.js";
import {
  approver,
  harnesses,
  hooksPort,
  humanSkip,
  liveRunId,
  needs,
  providers,
  recorder,
  slackChannel,
  slackSkip,
  targets,
  tempDir,
  useBuiltRuntime,
} from "./support/live.js";

beforeAll(() => useBuiltRuntime());

const Decision = z.object({ decision: z.string() });
const Asker = factory({ name: "live-asker", input: z.object({}) }, async () => {
  const r = await agent({
    name: "asker",
    label: "asker",
    output: Decision,
    prompt:
      'Use the ask_human tool to ask "Ship the migration tonight?" with the choices "ship" and "hold". Then submit { "decision": <the answer> }.',
  });
  return r.result;
});

describe("live 4: Slack ask round trip", () => {
  const target = targets.find((t) => t.skip === "") ?? targets[0];
  for (const wait of ["hot", "cold"] as const) {
    const skip = needs(target?.skip, slackSkip, humanSkip);
    it.skipIf(skip !== "")(
      `${wait} wait: a person answers the agent's ask in Slack${skip ? ` (skipped: ${skip})` : ""}`,
      async () => {
        if (!target) throw new Error("no target");
        const dir = await tempDir(`sbl-ask-${wait}-`);
        const journal = fileJournal(path.join(dir, "journal"));
        const channel = slack({ channel: slackChannel });
        if (!journal.asks) throw new Error("fileJournal must provide an ask store");
        const server = await serveHitl({ port: hooksPort, channel, store: journal.asks, approver });
        const events = recorder();
        try {
          const out = await run(
            Asker,
            {},
            {
              runId: liveRunId(`ask_${wait}`),
              config: {
                deployment: "live",
                sandbox: providers[target.provider].make(target.harness),
                harness: harnesses[target.harness].make(),
                hitl: {
                  channels: [channel],
                  approvers: [{ slack: approver }],
                  timeout: "30m",
                  ...(wait === "cold" ? { hotWait: "1s" } : {}),
                },
                artifacts: fileArtifacts(path.join(dir, "artifacts")),
              },
              journal,
              events: [events.sink],
            },
          );
          expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
          expect(["ship", "hold"]).toContain((out.output as { decision: string }).decision);
          if (wait === "cold") {
            expect(events.of("sandbox.parked")).toHaveLength(1);
            expect(events.launched()).toEqual(["asker", "asker"]);
          } else {
            expect(events.launched()).toEqual(["asker"]);
          }
        } finally {
          await server.close();
        }
      },
    );
  }

  const restartSkip = needs(target?.skip, slackSkip, humanSkip);
  it.skipIf(restartSkip !== "")(
    `restart: the host dies during a cold wait, the person answers while nothing runs, and a new process resumes the session${restartSkip ? ` (skipped: ${restartSkip})` : ""}`,
    async () => {
      if (!target) throw new Error("no target");
      const dir = await tempDir("sbl-ask-restart-");
      const runId = liveRunId("ask_restart");
      const journal = fileJournal(path.join(dir, "journal"));
      const asks = journal.asks;
      if (!asks) throw new Error("fileJournal must provide an ask store");
      // The hooks handler outlives the run processes: it writes the answer to the store whether or not one runs.
      const server = await serveHitl({
        port: hooksPort,
        channel: slack({ channel: slackChannel }),
        store: asks,
        approver,
      });
      const provider = target.provider === "e2b" ? "e2b" : "impello";
      const host = (tag: string) => startColdHost({ dir, runId, tag, provider, harness: target.harness });
      const askOf = async (): Promise<AskRecord | undefined> => {
        for await (const r of asks.list?.({ runId }) ?? []) return r;
        return undefined;
      };
      const until = async <T>(what: string, probe: () => Promise<T | null | undefined>, ms: number): Promise<T> => {
        const deadline = Date.now() + ms;
        for (;;) {
          const v = await probe();
          if (v) return v;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      };
      const first = await host("r1");
      try {
        const cold = await until(
          "the ask to go cold",
          async () => ((await askOf())?.cold ? askOf() : null),
          10 * 60_000,
        );
        first.child.kill("SIGKILL");
        await first.result;
        expect(cold.status).toBe("open");
        // Only now does the person answer: no process of this run is alive.
        process.stderr.write(`live 4 restart: answer "${cold.spec.question}" in Slack now (run ${runId}).\n`);
        const answered = await until(
          "the person's answer",
          async () => {
            const r = await asks.get(cold.askId);
            return r?.status === "answered" ? r : null;
          },
          25 * 60_000,
        );
        // The killed process's journal lease lives on for its TTL.
        await new Promise((r) => setTimeout(r, 61_000));
        const second = await host("r2");
        const out = await second.result;
        expect(out?.status, second.stderr().slice(-3000)).toBe("ok");
        expect((out?.output as { decision?: string } | null)?.decision).toBe(answered.resolution?.choiceId);
        const events = readFileSync(path.join(dir, "events-r2.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { type: string; callPath?: string });
        // One resumed launch on the new process, and the ask was not posted again.
        expect(events.filter((e) => e.type === "agent.launched").map((e) => e.callPath)).toEqual(["asker"]);
        expect(events.filter((e) => e.type === "ask.posted")).toHaveLength(0);
      } finally {
        if (first.child.exitCode === null) first.child.kill("SIGKILL");
        await server.close();
      }
    },
  );

  const afkSkip = needs(slackSkip);
  it.skipIf(afkSkip !== "")(
    `AFK: an ask resolves to its default and is never posted${afkSkip ? ` (skipped: ${afkSkip})` : ""}`,
    async () => {
      const dir = await tempDir("sbl-afk-");
      const Gate = factory({ name: "live-afk", input: z.object({}) }, async () => {
        const res = await ask({
          question: "Merge it?",
          choices: ["merge", "hold"],
          default: "hold",
          onTimeout: "default",
        });
        return { choice: res.choiceId, by: res.answeredBy };
      });
      const out = await run(
        Gate,
        {},
        {
          config: {
            deployment: "live",
            harness: harnesses["claude-code"].make(),
            hitl: { channels: [slack({ channel: slackChannel })], mode: "afk" },
            artifacts: fileArtifacts(path.join(dir, "artifacts")),
          },
        },
      );
      expect(out.status).toBe("ok");
      expect(out.output).toEqual({ choice: "hold", by: { kind: "default", reason: "afk" } });
    },
  );
});
