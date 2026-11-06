import { memoryChannel } from "@selfbuilding/core";
import { afterEach, describe, expect, it } from "vitest";
import { askRecord, memoryAskStore } from "../test/memory-store.js";
import { createHitlHandler, WAITPOINT_RETRY, withRetries } from "./hitl.js";

// release-prep §3.2 item 8: completing the host's waitpoint after an answer is retried with backoff (3 attempts);
// the answer itself is in the store before the first attempt, so a completion that never lands only delays the run.

const saved = { ...WAITPOINT_RETRY };
afterEach(() => Object.assign(WAITPOINT_RETRY, saved));

async function clickThrough(failures: number) {
  WAITPOINT_RETRY.baseDelayMs = 1;
  const channel = memoryChannel({ id: "slack" });
  const store = memoryAskStore();
  const thread = await channel.openThread({ runId: "run_wp", factory: "f" });
  const record = askRecord({ question: "Ship?", choices: ["yes", "no"] }, { runId: "run_wp" });
  record.messages = [await channel.post(record, thread)];
  await store.create(record);
  const lines: string[] = [];
  let calls = 0;
  const pending: Promise<unknown>[] = [];
  const handler = createHitlHandler({
    channels: [channel],
    store,
    approvers: [{ slack: channel.user.userId }],
    log: (l) => lines.push(l),
    waitUntil: (work) => pending.push(work),
    async resolveWaitpoint() {
      calls += 1;
      if (calls <= failures) throw new Error(`completion ${calls} failed`);
    },
  });
  const res = await handler(
    new Request("https://hooks.test/slack", {
      method: "POST",
      headers: { "x-memory-signature": "valid" },
      body: JSON.stringify({ channel: "slack", event: channel.click(record.askId, "yes") }),
    }),
  );
  expect(res.status).toBe(200);
  while (pending.length > 0) await Promise.all(pending.splice(0));
  return { calls, lines, stored: await store.get(record.askId) };
}

describe("waitpoint completion after an answer", () => {
  it("retries a failed completion and stops at the first success", async () => {
    const { calls, lines, stored } = await clickThrough(2);
    expect(calls).toBe(3);
    expect(lines.filter((l) => l.includes("waitpoint-failed"))).toEqual([]);
    expect(stored?.status).toBe("answered");
  });

  it("gives up after three attempts, logs once, and keeps the answer", async () => {
    const { calls, lines, stored } = await clickThrough(5);
    expect(calls).toBe(3);
    expect(lines.filter((l) => l.includes("waitpoint-failed"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("waitpoint-failed"))).toContain("completion 3 failed");
    expect(stored).toMatchObject({ status: "answered", resolution: { choiceId: "yes" } });
  });

  it("withRetries returns the first success and rethrows the last failure", async () => {
    let n = 0;
    await expect(withRetries(async () => ++n, { attempts: 3, baseDelayMs: 0 })).resolves.toBe(1);
    n = 0;
    const failing = withRetries(
      async () => {
        n += 1;
        throw new Error(`try ${n}`);
      },
      { attempts: 3, baseDelayMs: 0 },
    );
    await expect(failing).rejects.toThrow("try 3");
    expect(n).toBe(3);
  });
});
