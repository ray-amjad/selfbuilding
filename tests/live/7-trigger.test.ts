// Live 7 (demo-path §5): a run on a real Trigger.dev project, whose agent calls are selfbuilding.agent child runs.
// The project in ./trigger must be running (`trigger.dev dev`) or deployed with the same TRIGGER_PROJECT_REF; see
// trigger/README.md. This file only starts the run and reads the platform's view of it.
import { configure, runs, tasks } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import { liveRunId, needs } from "./support/live.js";

const env = process.env;
const skip = needs(
  env.SELFBUILDING_LIVE_TRIGGER !== "1" &&
    "set SELFBUILDING_LIVE_TRIGGER=1 with the project in tests/live/trigger running",
  !env.TRIGGER_SECRET_KEY && "set TRIGGER_SECRET_KEY",
  !env.TRIGGER_PROJECT_REF && "set TRIGGER_PROJECT_REF",
);

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"]);

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

describe.skipIf(skip !== "")(`live 7: agent calls as Trigger.dev child runs${skip ? ` (${skip})` : ""}`, () => {
  it("runs the factory, each agent call as a child run, and returns the accepted results", async () => {
    configure({ secretKey: env.TRIGGER_SECRET_KEY ?? "" });
    const runId = liveRunId("trigger");
    const handle = await tasks.trigger(
      "selfbuilding.factory",
      { factory: "hello", input: {}, runId },
      { tags: [runId] },
    );
    const parent = await until(
      () => runs.retrieve(handle.id),
      (r) => TERMINAL.has(r.status),
      30 * 60_000,
    );
    expect(parent.status, JSON.stringify(parent.error ?? null)).toBe("COMPLETED");
    expect(parent.output).toMatchObject({ runId, status: "ok", output: { said: ["hello first", "hello second"] } });

    const children = [];
    for await (const child of runs.list({ taskIdentifier: "selfbuilding.agent", tag: runId })) children.push(child);
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(children.every((c) => c.status === "COMPLETED")).toBe(true);
  });
});
