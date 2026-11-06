// A dispatching host (the Trigger parent) replays an agent call from its journal: a follow-up launch must be sent
// again with its launch number and the resume payload it was first sent with, never as launch 0's child.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { scriptedHarness, tempDir, tmpdirProvider } from "../../test/agent-kit/kit.js";
import { ConfigError } from "../errors/classes.js";
import { nodeHost } from "../host-node/index.js";
import { agent, factory, fileJournal, noteLaunchedBy, run } from "../index.js";
import type { DurableHost, HostAgentCall, LaunchId, RawOutcome } from "../types/host.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const ref = { uri: "artifact://x", bytes: 0, sha256: "0".repeat(64), contentType: "text/plain" };
const usage = { usd: null, inputTokens: 0, outputTokens: 0, turns: 1, wallClockMs: 0, sandboxMs: 0 };

function okOutcome(call: HostAgentCall, result: unknown): RawOutcome {
  return {
    ok: true,
    launchId: `${call.stepKey}_e${call.epoch}_l${call.launch}` as LaunchId,
    result,
    artifacts: { files: [], transcript: ref, logs: ref } as unknown as Extract<RawOutcome, { ok: true }>["artifacts"],
    usage,
    sessionId: "session-1",
  };
}

function dispatchingHost(runId: string, dispatch: (call: HostAgentCall) => Promise<RawOutcome>): DurableHost {
  return Object.create(nodeHost({ runId, epoch: 0 }), { dispatchAgent: { value: dispatch } }) as DurableHost;
}

const One = factory({ name: "dispatch-replay", input: z.object({}) }, async () => {
  const r = await agent({ name: "One", prompt: "Answer.", output: z.object({ ok: z.boolean() }), label: "one" });
  return r.result;
});

describe("dispatched agent calls on replay", () => {
  it("re-dispatches a started follow-up launch with its launch number and its journaled resume payload", async () => {
    const dir = await tempDir("sbc-dispatch-replay-");
    dirs.push(dir);
    const runId = "ns_dispatch_replay";
    const provider = tmpdirProvider({ root: path.join(dir, "boxes") });
    const config = { deployment: "test", sandbox: provider, harness: scriptedHarness([]) };
    const journal = fileJournal(path.join(dir, "journal"));

    const first: HostAgentCall[] = [];
    await expect(
      run(
        One,
        {},
        {
          runId,
          config,
          journal,
          host: dispatchingHost(runId, async (call) => {
            first.push(call);
            // Launch 0's result fails validation, so the parent sends launch 1 as a resume. The parent then
            // "dies" before launch 1's child answers: a usage error leaves the started entry in place.
            if (call.launch === 0) return okOutcome(call, { wrong: true });
            throw new ConfigError("the parent died here");
          }),
        },
      ),
    ).rejects.toThrow();
    expect(first.map((c) => c.launch)).toEqual([0, 1]);
    const resume = first[1]?.resume;
    expect(resume?.sessionId).toBe("session-1");

    const second: HostAgentCall[] = [];
    const outcome = await run(
      One,
      {},
      {
        runId,
        config,
        journal,
        host: dispatchingHost(runId, async (call) => {
          second.push(call);
          return okOutcome(call, { ok: true });
        }),
      },
    );
    expect(outcome.status, JSON.stringify(outcome)).toBe("ok");
    // One dispatch: launch 1 again, with the same follow-up message, so the host keys it as launch 1's child.
    expect(second.map((c) => c.launch)).toEqual([1]);
    expect(second[0]?.resume).toEqual(resume);
    await provider.close();
  });

  it("a failed entry re-runs live as the next launch, which a host can key apart from the old child", async () => {
    const dir = await tempDir("sbc-dispatch-failed-");
    dirs.push(dir);
    const runId = "ns_dispatch_failed";
    const provider = tmpdirProvider({ root: path.join(dir, "boxes") });
    const config = { deployment: "test", sandbox: provider, harness: scriptedHarness([]) };
    const journal = fileJournal(path.join(dir, "journal"));
    const failing = async (call: HostAgentCall): Promise<RawOutcome> => ({
      ok: false,
      launchId: `${call.stepKey}_e${call.epoch}_l${call.launch}` as LaunchId,
      error: { name: "HarnessError", code: "harness_error", message: "boom" } as never,
    });
    const first = await run(One, {}, { runId, config, journal, host: dispatchingHost(runId, failing) });
    expect(first.status).not.toBe("ok");
    const calls: HostAgentCall[] = [];
    const second = await run(
      One,
      {},
      {
        runId,
        config,
        journal,
        host: dispatchingHost(runId, async (call) => {
          calls.push(call);
          return okOutcome(call, { ok: true });
        }),
      },
    );
    expect(second.status, JSON.stringify(second)).toBe("ok");
    expect(calls.map((c) => c.launch)).toEqual([1]);
    expect(calls[0]?.resume).toBeUndefined();
    await provider.close();
  });

  it("carries an agent-launched run's depth in the spec, for the child process that mints grants", async () => {
    const dir = await tempDir("sbc-dispatch-depth-");
    dirs.push(dir);
    const runId = "ns_wf_dispatch_depth";
    noteLaunchedBy(runId, { kind: "agent", runId: "ns_parent", callPath: "Plan#0", depth: 2 });
    const provider = tmpdirProvider({ root: path.join(dir, "boxes") });
    const config = { deployment: "test", sandbox: provider, harness: scriptedHarness([]) };
    const calls: HostAgentCall[] = [];
    const host = dispatchingHost(runId, async (call) => {
      calls.push(call);
      return okOutcome(call, { ok: true });
    });
    const out = await run(One, {}, { runId, config, journal: fileJournal(path.join(dir, "journal")), host });
    expect(out.status).toBe("ok");
    expect((calls[0]?.spec as { launchDepth?: number } | undefined)?.launchDepth).toBe(2);
    await provider.close();
  });
});
