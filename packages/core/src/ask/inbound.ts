import type {
  Actor,
  ApproverContext,
  AskAnswer,
  AskRecord,
  AskStore,
  HandleInboundOptions,
  InboundDecision,
  InboundEvent,
  InboundOutcome,
} from "../types/ask.js";
import { answerAsk } from "./answer.js";
import { formatLateAnswer } from "./format.js";
import { checkAnswer, fromStored } from "./spec.js";

// Who may answer, and which ask a message answers (spec §8.7). Channel adapters only parse; the core
// decides. Every ignored event carries a `skip` reason so a guard is never a silent return.

export async function isApprover(actor: Actor, ctx: ApproverContext): Promise<boolean> {
  // The CLI reaches the ask store directly, so it is trusted the same way (rule 5).
  if (actor.channel === "cli") return true;
  if (actor.isBot) return false;
  if (ctx.approvers.length === 0) return ctx.requester !== undefined && ctx.requester === actor.userId;
  for (const a of ctx.approvers) {
    if ("slack" in a && actor.channel === "slack" && a.slack === actor.userId) return true;
    if ("discord" in a && actor.channel === "discord" && a.discord === actor.userId) return true;
    if ("github" in a && actor.channel === "github" && a.github.toLowerCase() === actor.userId.toLowerCase())
      return true;
    if (
      "githubPermission" in a &&
      actor.channel === "github" &&
      (await ctx.hasGithubPermission?.(actor.userId, a.githubPermission))
    )
      return true;
  }
  return false;
}

/** Names who can answer, for the refusal a non-approver gets. */
export function describeApprovers(ctx: ApproverContext): string {
  const names = ctx.approvers.map((a) => {
    if ("slack" in a) return `<@${a.slack}>`;
    if ("discord" in a) return `<@${a.discord}>`;
    if ("github" in a) return `@${a.github}`;
    return `repo members with ${a.githubPermission} access`;
  });
  if (names.length === 0 && ctx.requester) names.push(`@${ctx.requester}`);
  if (names.length === 0) return "Only the CLI can answer this.";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Only ${list} can answer this.`;
}

const ORDINAL = /^#(\d+)\s+([\s\S]+)$/;

function freeTextAsks(records: AskRecord[]): AskRecord[] {
  return records.filter((r) => fromStored(r.spec).freeText).sort((a, b) => a.ordinal - b.ordinal);
}

/** Maps a verified, parsed inbound event to what should happen. Reads the store; writes nothing. */
export async function routeInbound(store: AskStore, ev: InboundEvent, ctx: ApproverContext): Promise<InboundDecision> {
  const actor = ev.actor;
  if (actor.isBot || ctx.selfUserIds?.includes(actor.userId)) return { action: "skip", reason: "bot" };
  const approved = await isApprover(actor, ctx);

  if (ev.kind === "stop") {
    return approved ? { action: "stop", runId: ev.runId, actor } : { action: "refuse", text: describeApprovers(ctx) };
  }

  if (ev.kind === "choice" || ev.kind === "form") {
    const record = await store.get(ev.askId);
    if (!record) return { action: "skip", reason: "unknown-ask" };
    if (!approved) return { action: "refuse", text: describeApprovers(ctx) };
    if (record.status !== "open") return { action: "late", record, text: formatLateAnswer(record) };
    const answer: AskAnswer<unknown> =
      ev.kind === "choice" ? { kind: "choice", choiceId: ev.choiceId } : { kind: "value", value: ev.value };
    const problem = await checkAnswer(fromStored(record.spec), answer);
    if (problem) return { action: "skip", reason: ev.kind === "choice" ? "invalid-choice" : "invalid-form" };
    return { action: "answer", askId: record.askId, answer, actor };
  }

  // Free text (rule 2 and 3).
  let text = ev.text.trim();
  if (text.startsWith("//")) return { action: "skip", reason: "chatter" };
  if (!approved) return { action: "skip", reason: "not-approver" };
  let ordinal = ev.ordinal;
  const m = ORDINAL.exec(text);
  if (m) {
    ordinal = Number(m[1]);
    text = (m[2] as string).trim();
  }
  if (text === "") return { action: "skip", reason: "empty" };
  const open = freeTextAsks(await store.openForThread(ev.thread));
  if (ordinal !== undefined) {
    const target = open.find((r) => r.ordinal === ordinal);
    if (!target) return { action: "skip", reason: "no-open-ask" };
    return { action: "answer", askId: target.askId, answer: { kind: "text", text }, actor };
  }
  if (open.length === 0) return { action: "skip", reason: "no-open-ask" };
  if (open.length > 1) {
    const list = open.map((r) => `#${r.ordinal} ${r.spec.title ?? r.spec.question.slice(0, 60)}`).join("\n");
    return {
      action: "clarify",
      open,
      text: `Several questions are open. Start your reply with the number, e.g. "#${open[0]?.ordinal} ...":\n${list}`,
    };
  }
  return { action: "answer", askId: (open[0] as AskRecord).askId, answer: { kind: "text", text }, actor };
}

/** routeInbound, then answerAsk for an answer. A lost race becomes "late" with the winner named. */
export async function handleInbound(ev: InboundEvent, o: HandleInboundOptions): Promise<InboundOutcome> {
  const d = await routeInbound(o.store, ev, o);
  if (d.action === "skip") o.onSkip?.(d.reason, ev);
  if (d.action !== "answer") return d;
  const result = await answerAsk({
    store: o.store,
    askId: d.askId,
    answer: d.answer,
    answeredBy: { kind: "human", channel: d.actor.channel, userId: d.actor.userId, displayName: d.actor.displayName },
    channels: o.channels,
  });
  switch (result.status) {
    case "answered":
      return { action: "answered", result };
    case "lost":
      return { action: "late", record: result.current, text: formatLateAnswer(result.current) };
    case "invalid":
      o.onSkip?.("invalid-answer", ev);
      return { action: "skip", reason: "invalid-answer" };
    case "not-found":
      o.onSkip?.("unknown-ask", ev);
      return { action: "skip", reason: "unknown-ask" };
  }
}
