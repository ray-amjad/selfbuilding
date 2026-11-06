// Acceptance 3 (docs/BASIC-SCOPE.md) on the Trigger host, with the local Trigger stand-in: the worker process is
// killed mid-run and a new one starts the same run id again. The result store on disk is the journal both see.
import path from "node:path";
import { agent, factory, fileArtifacts } from "@selfbuilding/core";
import { createLocalTrigger, createTriggerHost, memoryResultStore } from "@selfbuilding/host-trigger";
import { scripted, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { hostDiesMidCall, machineDiesThenPromptEdit } from "./support/crash-scenarios.js";
import { scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => tmpdirProvider({ root: path.join(d, "boxes") }).close()));
});

const fresh = async () => {
  const dir = await tempDir("sba-crash-trigger-");
  dirs.push(dir);
  return dir;
};

describe("acceptance 3: crash and resume on the Trigger host (local Trigger)", () => {
  it.concurrent("the machine dies mid-call: replay, refuse the interrupted call, then run the edited prompt live", async () => {
    await machineDiesThenPromptEdit(await fresh(), "trigger", "ns_accept_crash_trigger");
  });

  it.concurrent("the worker dies mid-call: the box finishes it and the resume collects it without a re-run", async () => {
    await hostDiesMidCall(await fresh(), "trigger", "ns_accept_hostdies_trigger");
  });
});

describe("acceptance 3 on Trigger: agent calls are child tasks", () => {
  it("dispatches each agent call to a selfbuilding.agent child task and accepts it in the parent", async () => {
    const dir = await tempDir("sba-dispatch-");
    dirs.push(dir);
    useBuiltRuntime();
    const t = createLocalTrigger({ startAt: Date.now() });
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
      config: {
        deployment: "acceptance",
        artifacts: fileArtifacts(path.join(dir, "artifacts")),
        sandbox: tmpdirProvider({ root: path.join(dir, "boxes") }),
        harness: scriptedClaude([scripted.submit({ ok: true })]),
      },
      factories: { one: One },
      trigger: t,
      store: memoryResultStore(),
      settleMs: 0,
    });
    const { id } = await t.start("selfbuilding.factory", { factory: "one", input: {}, runId: "ns_accept_dispatch" });
    while (!["COMPLETED", "FAILED"].includes(t.run(id).status)) await new Promise((r) => setTimeout(r, 50));
    expect(t.run(id).output).toMatchObject({ status: "ok" });
    expect(t.runs({ taskId: "selfbuilding.agent" }).length).toBeGreaterThan(0);
  });
});
