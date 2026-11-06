import type { AskRecord, AskResolution, Json } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { createTriggerAskResolver } from "./asks.js";
import { resultStoreAsks } from "./journal.js";
import type { TriggerSdk } from "./sdk.js";
import { memoryResultStore } from "./store.js";

// The answer outlives the process that wrote it (demo-path §6.4): only the store write counts, and the wake can
// be sent again by anyone holding the store and the Trigger key.

function fakeTrigger() {
  const completed: { tokenId: string; data: Json }[] = [];
  const sdk = {
    kind: "fake",
    async completeToken(tokenId: string, data: Json) {
      completed.push({ tokenId, data });
    },
    async sendWake() {},
  } as unknown as TriggerSdk;
  return { sdk, completed };
}

const record = (askId: string): AskRecord => ({
  askId,
  runId: "ns_cold",
  ordinal: 1,
  callPath: "A#0",
  origin: { kind: "agent", launchId: "A_e0_l0", askSeq: 0 },
  specHash: "h",
  spec: { question: "Ship?", choices: ["ship", "hold"] },
  status: "open",
  waitpoint: { host: "trigger", ref: `tok_${askId}` },
  messages: [],
  createdAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-11-02T14:00:00.000Z",
});

const answer = (askId: string, choiceId: string): AskResolution => ({
  askId,
  answer: { kind: "choice", choiceId },
  choiceId,
  answeredBy: { kind: "human", channel: "slack", userId: "U1", displayName: "alice" },
  answeredAt: "2026-11-02T11:00:00.000Z",
});

describe("createTriggerAskResolver after a restart", () => {
  it("re-sends the wake for an answer whose writer died before waking", async () => {
    const store = memoryResultStore();
    const asks = resultStoreAsks(store);
    await asks.create(record("ask_lost_wake"));
    // The writer won the CAS, then died: the store holds the answer and the token was never completed.
    expect((await asks.resolve("ask_lost_wake", answer("ask_lost_wake", "ship"))).won).toBe(true);

    const { sdk, completed } = fakeTrigger();
    const resolver = createTriggerAskResolver({ trigger: sdk, store });
    // A retried answer loses and wakes nobody...
    expect((await resolver.resolve("ask_lost_wake", answer("ask_lost_wake", "hold"))).won).toBe(false);
    expect(completed).toEqual([]);
    // ...but the stored answer can still be delivered, and it is the first answer, not the retry.
    expect(await resolver.wakeAnswered("ask_lost_wake")).toBe(true);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ tokenId: "tok_ask_lost_wake", data: { choiceId: "ship" } });
  });

  it("wakes nobody for an ask that is still open or missing", async () => {
    const store = memoryResultStore();
    await resultStoreAsks(store).create(record("ask_open"));
    const { sdk, completed } = fakeTrigger();
    const resolver = createTriggerAskResolver({ trigger: sdk, store });
    expect(await resolver.wakeAnswered("ask_open")).toBe(false);
    expect(await resolver.wakeAnswered("ask_missing")).toBe(false);
    expect(completed).toEqual([]);
  });
});
