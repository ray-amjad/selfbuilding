import type { AnswerAskOptions, AnswerResult, AskRecord, AskResolution, AskStore, HitlChannel } from "../types/ask.js";
import { formatSettledCard } from "./format.js";
import { checkAnswer, fromStored } from "./spec.js";

// The answer path shared by every way an answer arrives: a channel webhook, the CLI, an in-process test
// and the policy at a deadline. Store first, then wake (spec §8.5): a waiter always re-reads the store.

type Waker = () => void;
const waiters = new WeakMap<AskStore, Map<string, Set<Waker>>>();

/** Registers a wake-up for one ask on one store. Returns the unsubscribe. */
export function onAskSettled(store: AskStore, askId: string, wake: Waker): () => void {
  let byId = waiters.get(store);
  if (!byId) {
    byId = new Map();
    waiters.set(store, byId);
  }
  let set = byId.get(askId);
  if (!set) {
    set = new Set();
    byId.set(askId, set);
  }
  set.add(wake);
  return () => {
    set.delete(wake);
    if (set.size === 0) byId.delete(askId);
  };
}

/** Wakes every in-process waiter on an ask. Other processes notice on their next store poll. */
export function wakeAsk(store: AskStore, askId: string): void {
  for (const wake of [...(waiters.get(store)?.get(askId) ?? [])]) wake();
}

/** Edits every card posted for an ask. Never throws: a failed edit must not undo an answer. */
export async function updateCards(
  record: AskRecord,
  channels: readonly HitlChannel[],
  status: "answered" | "expired" | "cancelled" | "superseded",
  text: string,
  onError?: (err: unknown, channel: string) => void,
): Promise<void> {
  await Promise.all(
    record.messages.map(async (ref) => {
      const ch = channels.find((c) => c.id === ref.channel);
      if (!ch) return;
      try {
        await ch.update(ref, { status, record, text });
      } catch (err) {
        onError?.(err, ref.channel);
      }
    }),
  );
}

/**
 * Answers an ask: validates against the ask's own spec, wins or loses the compare-and-set, edits every card
 * and wakes waiters. The first valid answer wins; a loser gets the current record to tell its actor who won.
 */
export async function answerAsk(o: AnswerAskOptions): Promise<AnswerResult> {
  const record = await o.store.get(o.askId);
  if (!record) return { status: "not-found" };
  if (record.status !== "open") return { status: "lost", current: record };
  const problem = await checkAnswer(fromStored(record.spec), o.answer);
  if (problem) return { status: "invalid", message: problem };
  const resolution: AskResolution = {
    askId: o.askId,
    answer: o.answer,
    choiceId: o.answer.kind === "choice" ? o.answer.choiceId : null,
    answeredBy: o.answeredBy,
    answeredAt: o.at ?? new Date().toISOString(),
  };
  const cas = await o.store.resolve(o.askId, resolution);
  if (!cas.won) return { status: "lost", current: cas.current };
  const settled: AskRecord = { ...record, status: "answered", resolution };
  wakeAsk(o.store, o.askId);
  await updateCards(settled, o.channels ?? [], "answered", formatSettledCard(settled, resolution), o.onCardError);
  return { status: "answered", record: settled, resolution };
}
