// Live 15 (release-prep §3): the project in ./trigger deployed (`trigger.dev deploy`), so its tasks run on machines
// that share nothing but an R2 bucket. The deployed worker must have the R2_* variables set: it then keeps its
// result store in R2 (`r2ResultStoreFromEnv`), and this test reads the run's records back from the same bucket.
// It starts runs and reads the platform's view of them; it never prints a value.
import { r2ResultStoreFromEnv } from "@selfbuilding/artifacts-s3";
import { configure, runs, tasks } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import { liveRunId, needs } from "./support/live.js";

const env = process.env;
const skip = needs(
  env.SELFBUILDING_LIVE_TRIGGER !== "1" && "set SELFBUILDING_LIVE_TRIGGER=1",
  env.SELFBUILDING_LIVE_TRIGGER_DEPLOYED !== "1" &&
    "set SELFBUILDING_LIVE_TRIGGER_DEPLOYED=1 with tests/live/trigger deployed (trigger.dev deploy)",
  !env.TRIGGER_SECRET_KEY && "set TRIGGER_SECRET_KEY (the deployed environment's key)",
  !env.TRIGGER_PROJECT_REF && "set TRIGGER_PROJECT_REF",
  (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) &&
    "set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (the same bucket the deployed worker uses)",
);

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"]);
const deployment = env.SELFBUILDING_DEPLOYMENT ?? "live-trigger";

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

describe.skipIf(skip !== "")(`live 15: a deployed Trigger.dev project${skip ? ` (${skip})` : ""}`, () => {
  it("runs agent calls as child runs on other machines, with every record in R2", async () => {
    configure({ secretKey: env.TRIGGER_SECRET_KEY ?? "" });
    const runId = liveRunId("deployed");
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

    // The parent and the children wrote to the bucket, not to a machine's disk.
    const store = r2ResultStoreFromEnv(env, { prefix: `${deployment}/results` });
    expect(await store.get(`runs/${runId}/run.json`)).toMatchObject({ status: "ok", factory: "hello" });
    const registered: string[] = [];
    for await (const key of store.list(`runs/${runId}/e0/children/`)) registered.push(key);
    expect(registered.length).toBeGreaterThanOrEqual(2);
    const outcomes: string[] = [];
    for await (const key of store.list(`outcomes/${runId}/`)) outcomes.push(key);
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
  });

  it("runs a workflow script through the deployed run-script factory", async () => {
    configure({ secretKey: env.TRIGGER_SECRET_KEY ?? "" });
    const runId = liveRunId("deployed_script");
    const source =
      "export default async function main(input, sb) { sb.phase('add'); return { sum: input.a + input.b }; }";
    const handle = await tasks.trigger(
      "selfbuilding.factory",
      { factory: "run-script", input: { source, input: { a: 2, b: 3 }, name: "live-deployed-add" }, runId },
      { tags: [runId] },
    );
    const parent = await until(
      () => runs.retrieve(handle.id),
      (r) => TERMINAL.has(r.status),
      10 * 60_000,
    );
    expect(parent.status, JSON.stringify(parent.error ?? null)).toBe("COMPLETED");
    expect(parent.output).toMatchObject({ runId, status: "ok", output: { sum: 5 } });
  });
});
