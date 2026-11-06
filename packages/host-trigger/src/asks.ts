import type { AskRecord, AskResolution, AskStore, Json, ResultStore } from "@selfbuilding/core";
import { readRunRecord, resultStoreAsks } from "./journal.js";
import type { TriggerSdk } from "./sdk.js";

// The Trigger side of answering an ask (spec §8.5). The resolution is always written to the ask store first;
// the wake that follows only tells the waiting run to look.

export interface TriggerAskResolver {
  /** Store first (compare-and-set on `open`), then wake. A losing answer changes nothing and wakes nobody. */
  resolve(askId: string, resolution: AskResolution): Promise<{ won: true } | { won: false; current: AskRecord }>;
  /**
   * Wakes whoever waits on an ask that is already resolved in the store. Agent asks: completes the ask's waitpoint
   * token in the child. Factory-side asks: sends `{ kind: "ask" }` on the parent's wake stream.
   */
  wake(record: AskRecord): Promise<void>;
  /**
   * Wakes the waiter of an ask whose answer is already in the store; false when it is not answered. For an answer
   * whose writer died between the store write and the wake (demo-path §6.4): the CAS was won, so a retried
   * `resolve` loses and wakes nobody, but this sends the wake again. Waking twice is harmless: a waiter re-reads
   * the store, and the token completes once.
   */
  wakeAnswered(askId: string): Promise<boolean>;
}

export function createTriggerAskResolver(opts: {
  trigger: TriggerSdk;
  store: ResultStore;
  asks?: AskStore;
}): TriggerAskResolver {
  const asks = opts.asks ?? resultStoreAsks(opts.store);
  const resolver: TriggerAskResolver = {
    async resolve(askId, resolution) {
      const result = await asks.resolve(askId, resolution);
      if (result.won) {
        const record = await asks.get(askId);
        if (record) await resolver.wake(record);
      }
      return result;
    },
    async wake(record) {
      if (record.origin.kind === "agent") {
        if (record.waitpoint.host !== "trigger") return;
        await opts.trigger.completeToken(record.waitpoint.ref, (record.resolution ?? null) as unknown as Json);
        return;
      }
      const parent = (await readRunRecord(opts.store, record.runId))?.hostRunIds.at(-1);
      if (parent) await opts.trigger.sendWake(parent, { kind: "ask", askId: record.askId });
    },
    async wakeAnswered(askId) {
      const record = await asks.get(askId);
      if (record?.status !== "answered" || !record.resolution) return false;
      await resolver.wake(record);
      return true;
    },
  };
  return resolver;
}
