import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { AskCancelledError, AskTimeoutError, HitlConfigError, NoActiveRunError } from "../errors/classes.js";
import type { AskRecord, AskSpec, AskStore, HitlOptions, InboundEvent, MemoryChannel } from "../types/ask.js";
import { runWithAskScope } from "./context.js";
import { formatResumeMessage } from "./format.js";
import { handleInbound } from "./inbound.js";
import { ask } from "./index.js";
import { memoryChannel } from "./memory-channel.js";
import { AskSession, type AskSessionOptions, mergeHitlOptions, validateHitlConfig } from "./session.js";
import { memoryAskStore } from "./store.js";

const MIN = 60_000;
const H = 60 * MIN;

interface Setup {
  session: AskSession;
  store: AskStore;
  ch: MemoryChannel;
  events: { type: string; data: Record<string, unknown> }[];
  inbound: (ev: InboundEvent) => ReturnType<typeof handleInbound>;
  factoryAsk: <const C extends string>(
    spec: AskSpec<unknown, C>,
    callPath?: string,
  ) => ReturnType<typeof ask<unknown, C>>;
}

function setup(
  o: { hitl?: HitlOptions; store?: AskStore; ch?: MemoryChannel } & Partial<AskSessionOptions> = {},
): Setup {
  const store = o.store ?? memoryAskStore();
  const ch = o.ch ?? memoryChannel({ id: "slack" });
  const events: Setup["events"] = [];
  const { hitl, ...rest } = o;
  const session = new AskSession({
    run: { runId: "run-1", factory: "ship-change" },
    store,
    hitl: { channels: [ch], approvers: [{ slack: "user-1" }], ...hitl },
    emit: (type, data) => events.push({ type, data }),
    pollMs: 10 * MIN,
    notifyRetry: { tries: 3, backoffMs: 1 },
    ...rest,
  });
  return {
    session,
    store,
    ch,
    events,
    inbound: (ev) => handleInbound(ev, { store, channels: [ch], approvers: [{ slack: "user-1" }] }),
    factoryAsk: (spec, callPath = "root") => runWithAskScope({ session, callPath: () => callPath }, () => ask(spec)),
  };
}

/** Waits until the session has recorded `n` posted asks (cards posted and saved on the record). */
async function posted(t: Setup, n: number): Promise<void> {
  await t.ch.waitForPosts(n);
  await vi.waitFor(() => {
    if (t.events.filter((e) => e.type === "ask.posted").length < n) throw new Error("not yet posted");
  });
}

const lastPost = (ch: MemoryChannel): AskRecord => {
  const p = ch.posts.at(-1);
  if (!p) throw new Error("nothing posted");
  return p.record;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ask() from factory code", () => {
  it("throws NoActiveRunError outside a run", async () => {
    await expect(ask({ question: "Ship?" })).rejects.toBeInstanceOf(NoActiveRunError);
  });

  it("resolves from a button click, with choiceId narrowed to the shorthand ids", async () => {
    const t = setup();
    const p = t.factoryAsk({ question: "Label 3 PRs ready-to-merge?", choices: ["yes", "no"] });
    await t.ch.waitForPosts(1);
    const record = lastPost(t.ch);
    expect(record.spec.choices).toEqual([
      { id: "yes", label: "yes" },
      { id: "no", label: "no" },
    ]);
    expect(record.ordinal).toBe(1);
    const out = await t.inbound(t.ch.click(record.askId, "yes"));
    expect(out.action).toBe("answered");
    const res = await p;
    expectTypeOf(res.choiceId).toEqualTypeOf<"yes" | "no" | null>();
    expect(res.choiceId).toBe("yes");
    expect(res.answeredBy).toEqual({ kind: "human", channel: "slack", userId: "user-1", displayName: "user-1" });
    expect(t.ch.updates.at(-1)?.view).toMatchObject({ status: "answered", text: "Answered by @user-1: yes" });
    expect(t.events.map((e) => e.type)).toEqual(expect.arrayContaining(["ask.created", "ask.posted"]));
  });

  it("resolves from a free-text reply in the run thread", async () => {
    const t = setup();
    const p = t.factoryAsk({ question: "Which endpoint?" });
    await posted(t, 1);
    const thread = t.ch.posts[0]?.ref.thread ?? { channel: "", id: "" };
    await t.inbound(t.ch.reply(thread, "use the v2 endpoint"));
    const res = await p;
    expect(res.answer).toEqual({ kind: "text", text: "use the v2 endpoint" });
    expect(res.choiceId).toBeNull();
    expect(t.ch.threads).toHaveLength(1);
  });

  it("returns the stored answer on replay and posts nothing", async () => {
    const store = memoryAskStore();
    const first = setup({ store });
    const p = first.factoryAsk({ question: "Ship?", choices: ["yes", "no"] });
    await first.ch.waitForPosts(1);
    await first.inbound(first.ch.click(lastPost(first.ch).askId, "no"));
    const original = await p;

    const replay = setup({ store });
    const again = await replay.factoryAsk({ question: "Ship?", choices: ["yes", "no"], timeout: "8h" });
    expect(again).toEqual(original);
    expect(replay.ch.posts).toHaveLength(0);
  });

  it("gives each ask at the same place its own id and the next ordinal", async () => {
    const t = setup();
    const a = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"] });
    const b = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"] });
    await t.ch.waitForPosts(2);
    const [ra, rb] = t.ch.posts.map((p) => p.record);
    expect(ra?.askId).not.toBe(rb?.askId);
    expect([ra?.ordinal, rb?.ordinal].sort()).toEqual([1, 2]);
    await t.session.cancelOpen();
    await expect(a).rejects.toBeInstanceOf(AskCancelledError);
    await expect(b).rejects.toBeInstanceOf(AskCancelledError);
  });

  it("lets one answer win across a click, a reply and a redelivered webhook", async () => {
    const t = setup();
    const p = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"], freeText: true });
    await posted(t, 1);
    const r = lastPost(t.ch);
    const click = t.ch.click(r.askId, "yes");
    const outs = await Promise.all([
      t.inbound(click),
      t.inbound(t.ch.reply(t.ch.posts[0]?.ref.thread ?? { channel: "", id: "" }, "no")),
      t.inbound(click),
    ]);
    expect(outs.filter((o) => o.action === "answered")).toHaveLength(1);
    const late = outs.filter((o) => o.action !== "answered");
    for (const o of late) expect(["late", "skip"]).toContain(o.action);
    const res = await p;
    const later = await t.inbound(t.ch.click(r.askId, "no"));
    expect(later).toMatchObject({ action: "late" });
    expect(later.action === "late" && later.text).toMatch(/^Already answered by @user-1/);
    expect((await t.store.get(r.askId))?.resolution).toEqual(res);
  });

  it("refuses a click from someone who is not an approver, naming who can answer", async () => {
    const t = setup();
    const p = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"] });
    await t.ch.waitForPosts(1);
    const askId = lastPost(t.ch).askId;
    const out = await t.inbound(t.ch.click(askId, "yes", { userId: "user-2", displayName: "user-2" }));
    expect(out).toEqual({ action: "refuse", text: "Only <@user-1> can answer this." });
    expect(await t.inbound(t.ch.click(askId, "yes", { isBot: true }))).toEqual({ action: "skip", reason: "bot" });
    expect((await t.store.get(askId))?.status).toBe("open");
    await t.inbound(t.ch.click(askId, "no"));
    expect((await p).choiceId).toBe("no");
  });

  it("asks for an ordinal when two free-text asks are open, and ignores chatter", async () => {
    const t = setup();
    const a = t.factoryAsk({ question: "Which endpoint?" });
    const b = t.factoryAsk({ question: "Which region?" });
    await posted(t, 2);
    const thread = t.ch.posts[0]?.ref.thread ?? { channel: "", id: "" };
    expect(await t.inbound(t.ch.reply(thread, "// thinking"))).toEqual({ action: "skip", reason: "chatter" });
    const amb = await t.inbound(t.ch.reply(thread, "v2"));
    expect(amb.action).toBe("clarify");
    expect(amb.action === "clarify" && amb.text).toMatch(
      /\n#[12] Which (endpoint|region)\?\n#[12] Which (endpoint|region)\?$/,
    );
    const ordinalOf = (q: string) => t.ch.posts.find((p) => p.record.spec.question === q)?.record.ordinal;
    await t.inbound(t.ch.reply(thread, `#${ordinalOf("Which region?")} eu-west`));
    await t.inbound(t.ch.reply(thread, "v2"));
    expect((await b).answer).toEqual({ kind: "text", text: "eu-west" });
    expect((await a).answer).toEqual({ kind: "text", text: "v2" });
    expect(await t.inbound(t.ch.reply(thread, "anything"))).toEqual({ action: "skip", reason: "no-open-ask" });
  });

  it("accepts a schema form answer and rejects an invalid one", async () => {
    const t = setup();
    const schema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    } as unknown as AskSpec["schema"];
    const p = t.factoryAsk({ question: "How many?", schema });
    await t.ch.waitForPosts(1);
    const askId = lastPost(t.ch).askId;
    expect(await t.inbound(t.ch.submit(askId, { n: "x" }))).toEqual({ action: "skip", reason: "invalid-form" });
    await t.inbound(t.ch.submit(askId, { n: 3 }));
    expect((await p).answer).toEqual({ kind: "value", value: { n: 3 } });
  });

  it("moves the waiter to a re-ask with the same dedupeKey", async () => {
    const t = setup();
    const first = t.factoryAsk({ question: "Ship v1?", choices: ["yes", "no"], dedupeKey: "ship" }, "a");
    await t.ch.waitForPosts(1);
    const second = t.factoryAsk({ question: "Ship v2?", choices: ["yes", "no"], dedupeKey: "ship" }, "b");
    await t.ch.waitForPosts(2);
    const old = t.ch.posts[0]?.record as AskRecord;
    const next = t.ch.posts[1]?.record as AskRecord;
    expect(t.ch.updates[0]?.view).toMatchObject({ status: "superseded", text: `Superseded by #${next.ordinal}` });
    expect(await t.inbound(t.ch.click(old.askId, "yes"))).toMatchObject({ action: "late" });
    await t.inbound(t.ch.click(next.askId, "yes"));
    expect((await first).askId).toBe(next.askId);
    expect((await second).choiceId).toBe("yes");
  });

  it("fails at start when channels are set but nobody can answer", () => {
    const ch = memoryChannel();
    expect(() => validateHitlConfig({ channels: [ch] })).toThrow(HitlConfigError);
    expect(() => validateHitlConfig({ channels: [ch] }, "user-1")).not.toThrow();
    expect(() => validateHitlConfig({ channels: [ch], mode: "afk" })).not.toThrow();
    expect(() => validateHitlConfig({ onTimeout: "auto" })).toThrow(/autoAnswer/);
    expect(() => validateHitlConfig({ timeout: "forever" as never })).toThrow(/duration/);
    expect(() => setup({ hitl: { approvers: [] } })).toThrow(/hitl.approvers/);
  });

  it("merges HITL layers field by field, highest first", () => {
    const ch = memoryChannel();
    expect(
      mergeHitlOptions({ timeout: "1h" }, { timeout: "2h", channels: [ch] }, { onTimeout: "default", timeout: "3h" }),
    ).toEqual({ timeout: "1h", channels: [ch], onTimeout: "default" });
  });
});

describe("timeouts and AFK policies", () => {
  async function timeOut(t: Setup, spec: AskSpec, ms: number) {
    const p = t.factoryAsk(spec);
    p.catch(() => {});
    await t.ch.waitForPosts(1);
    await vi.advanceTimersByTimeAsync(ms);
    return p;
  }

  it('uses spec.default under onTimeout: "default"', async () => {
    vi.useFakeTimers();
    const t = setup();
    const res = await timeOut(
      t,
      { question: "Ship?", choices: ["yes", "no"], default: "no", timeout: "1h", onTimeout: "default" },
      H,
    );
    expect(res.answeredBy).toEqual({ kind: "default", reason: "timeout" });
    expect(res.choiceId).toBe("no");
    expect(t.ch.updates.at(-1)?.view.text).toBe("No answer within 1h; proceeded with no");
  });

  it('throws AskTimeoutError under onTimeout: "fail" and marks the ask expired', async () => {
    vi.useFakeTimers();
    const t = setup({ notify: { on: ["ask.expired"] } });
    const p = timeOut(t, { question: "Ship?", choices: ["yes", "no"], timeout: "30m" }, 30 * MIN);
    await expect(p).rejects.toBeInstanceOf(AskTimeoutError);
    const r = lastPost(t.ch);
    expect((await t.store.get(r.askId))?.status).toBe("expired");
    expect(t.ch.updates.at(-1)?.view.status).toBe("expired");
    expect(t.ch.notifications.at(-1)?.notification.kind).toBe("ask.expired");
    const late = await t.inbound(t.ch.click(r.askId, "yes"));
    expect(late.action === "late" && late.text).toMatch(/expired at/);
  });

  it("does not time out early", async () => {
    vi.useFakeTimers();
    const t = setup();
    const p = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"], timeout: "1h" });
    await t.ch.waitForPosts(1);
    await vi.advanceTimersByTimeAsync(H - 1000);
    await t.inbound(t.ch.click(lastPost(t.ch).askId, "yes"));
    expect((await p).answeredBy.kind).toBe("human");
  });

  it('auto-answers under onTimeout: "auto" and shows the rationale', async () => {
    vi.useFakeTimers();
    const autoAnswer = vi.fn(async () => ({
      answer: { kind: "choice" as const, choiceId: "hold" },
      rationale: "tests are red",
      costUsd: 0.01,
    }));
    const t = setup({ hitl: { onTimeout: "auto", autoAnswer: { model: "judge-1" } }, autoAnswer });
    const res = await timeOut(t, { question: "Merge?", choices: ["merge", "hold"], timeout: "1h" }, H);
    expect(res.answeredBy).toEqual({ kind: "auto", model: "judge-1", rationale: "tests are red" });
    expect(autoAnswer).toHaveBeenCalledWith(expect.objectContaining({ model: "judge-1", maxUsd: 0.05 }));
    expect(t.events.some((e) => e.type === "budget.charge")).toBe(true);
  });

  it("falls back to the default, then fails, when auto-answer is invalid", async () => {
    vi.useFakeTimers();
    const autoAnswer = vi.fn(async () => ({ answer: { kind: "choice" as const, choiceId: "nope" }, rationale: "x" }));
    const t = setup({ hitl: { onTimeout: "auto", autoAnswer: { model: "judge-1" } }, autoAnswer });
    const res = await timeOut(t, { question: "Merge?", choices: ["merge", "hold"], default: "hold", timeout: "1h" }, H);
    expect(res.answeredBy).toEqual({ kind: "default", reason: "timeout" });

    const t2 = setup({ hitl: { onTimeout: "auto", autoAnswer: { model: "judge-1" } }, autoAnswer });
    await expect(
      timeOut(t2, { question: "Merge?", choices: ["merge", "hold"], timeout: "1h" }, H),
    ).rejects.toBeInstanceOf(AskTimeoutError);
  });

  it("resolves a high-risk ask under AFK only to its safe choice, and never auto-answers it", async () => {
    const autoAnswer = vi.fn();
    const t = setup({ hitl: { mode: "afk", onTimeout: "auto", autoAnswer: { model: "judge-1" } }, autoAnswer });
    const res = await t.factoryAsk({
      question: "Merge?",
      choices: [
        { id: "merge", label: "Merge" },
        { id: "hold", label: "Hold", safe: true },
      ],
      risk: "high",
    });
    expect(res).toMatchObject({ choiceId: "hold", answeredBy: { kind: "default", reason: "afk" } });
    expect(autoAnswer).not.toHaveBeenCalled();
    expect(t.ch.posts).toHaveLength(0);

    const noSafe = setup({ hitl: { mode: "afk", onTimeout: "default" } });
    await expect(
      noSafe.factoryAsk({ question: "Deploy?", choices: ["yes", "no"], default: "no", risk: "high" }),
    ).rejects.toThrow(/safe: true/);
  });

  it("applies the policy at once when no channel can deliver the ask", async () => {
    const ch = memoryChannel({ id: "slack" });
    ch.fail("openThread", 1);
    const t = setup({ ch, hitl: { onTimeout: "default" } });
    const res = await t.factoryAsk({ question: "Ship?", choices: ["yes", { id: "no", label: "No", safe: true }] });
    expect(res.answeredBy).toEqual({ kind: "default", reason: "undeliverable" });
    expect(t.events.map((e) => e.type)).toContain("ask.undeliverable");

    ch.fail("post", 1);
    await expect(setup({ ch }).factoryAsk({ question: "Again?", choices: ["yes", "no"] })).rejects.toBeInstanceOf(
      AskTimeoutError,
    );
  });

  it("fails at once in AFK mode with the default fail policy", async () => {
    const t = setup({ hitl: { mode: "afk" } });
    await expect(t.factoryAsk({ question: "Ship?", choices: ["yes", "no"] })).rejects.toBeInstanceOf(AskTimeoutError);
  });

  it("takes an answer a missed webhook carried from the final reconcile", async () => {
    vi.useFakeTimers();
    const ch = memoryChannel({ id: "github", reconcile: true, actorChannel: "github" });
    const t = setup({ ch, hitl: { approvers: [{ github: "user-1" }] } });
    const p = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"], timeout: "1h" });
    await ch.waitForPosts(1);
    ch.missed.push(ch.click(lastPost(ch).askId, "yes"));
    await vi.advanceTimersByTimeAsync(H);
    const res = await p;
    expect(res.answeredBy).toMatchObject({ kind: "human", channel: "github" });
    expect(t.events.map((e) => e.type)).toContain("ask.reconciled");
    expect((await t.store.get(res.askId))?.reconciledAt).toBeDefined();
  });

  it("cancels open asks with the run", async () => {
    const t = setup();
    const p = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"] });
    await t.ch.waitForPosts(1);
    expect(await t.session.cancelOpen("stop button")).toBe(1);
    await expect(p).rejects.toBeInstanceOf(AskCancelledError);
    expect(t.ch.updates.at(-1)?.view.status).toBe("cancelled");
  });

  it("cancels when the run's signal aborts", async () => {
    const ac = new AbortController();
    const t = setup({ signal: ac.signal });
    const p = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"] });
    await t.ch.waitForPosts(1);
    ac.abort("user cancel");
    await expect(p).rejects.toBeInstanceOf(AskCancelledError);
  });
});

describe("agent asks (ask_human)", () => {
  const harness = { mcpToolTimeoutMs: 12 * MIN, canResume: true };
  const req = (over: Partial<Parameters<AskSession["openAgentAsk"]>[0]> = {}) => ({
    callPath: "ImplementSpec#0",
    launchId: "step_e0_l1",
    askSeq: 0,
    spec: { question: "Merge?", choices: ["merge", "hold"] } as AskSpec,
    harness,
    ...over,
  });

  it("waits hot and returns the answer as tool text", async () => {
    const t = setup();
    const ticket = await t.session.openAgentAsk(req());
    if (ticket.kind !== "wait") throw new Error(ticket.kind);
    expect(ticket.plan).toEqual({ mode: "hot", hotMs: 10 * MIN, afterHot: "cold" });
    const hot = t.session.waitHot(ticket.record.askId, ticket.plan.hotMs);
    await t.inbound(t.ch.click(ticket.record.askId, "hold"));
    const res = await hot;
    expect(res?.choiceId).toBe("hold");
  });

  it("moves to a cold wait after the hot window and resumes with the answer", async () => {
    vi.useFakeTimers();
    const t = setup();
    const ticket = await t.session.openAgentAsk(req());
    if (ticket.kind !== "wait") throw new Error(ticket.kind);
    const hot = t.session.waitHot(ticket.record.askId, ticket.plan.hotMs);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(await hot).toBeNull();
    expect(ticket.suspendedText).toBe(
      "Your question #1 is waiting for a human. End your turn now. Do not make further changes. You will be resumed with the answer.",
    );

    // The orchestrator process died during the cold wait; a fresh session on the same store picks it up.
    const later = setup({ store: t.store, ch: t.ch });
    const cold = later.session.awaitResolution(ticket.record.askId);
    await vi.advanceTimersByTimeAsync(H);
    await later.inbound(t.ch.click(ticket.record.askId, "merge", { displayName: "alice", userId: "user-1" }));
    const res = await cold;
    expect(formatResumeMessage(ticket.record, res)).toBe(
      'Answer to your question #1 from @alice via Slack: choice "merge"',
    );
  });

  it("never carries an answer from one launch to the next", async () => {
    const t = setup();
    const first = await t.session.openAgentAsk(req());
    if (first.kind !== "wait") throw new Error(first.kind);
    await t.inbound(t.ch.click(first.record.askId, "merge"));
    const second = await t.session.openAgentAsk(req({ launchId: "step_e0_l2" }));
    expect(second.kind).toBe("wait");
    expect(second.kind === "wait" && second.record.askId).not.toBe(first.record.askId);
    expect(t.ch.posts).toHaveLength(2);
    // The same launch re-sending the answered tool call gets the stored answer.
    const replay = await t.session.openAgentAsk(req());
    expect(replay).toMatchObject({ kind: "resolved", resolution: { choiceId: "merge" } });
    expect(replay.kind === "resolved" && replay.toolText).toBe('Answer from @user-1 via Slack: choice "merge".');
  });

  it("attaches a retried tool call to the open ask instead of posting twice", async () => {
    const t = setup();
    const a = await t.session.openAgentAsk(req());
    const b = await t.session.openAgentAsk(req({ askSeq: 1 }));
    expect(a.kind === "wait" && b.kind === "wait" && a.record.askId === b.record.askId).toBe(true);
    expect(t.ch.posts).toHaveLength(1);
  });

  it("records the cold wait on the ask before waiting, with the parked box and session", async () => {
    const t = setup();
    const ticket = await t.session.openAgentAsk(req());
    if (ticket.kind !== "wait") throw new Error(ticket.kind);
    const sandbox = { provider: "tmpdir", id: "box-1", state: "paused" } as never;
    const cold = t.session.awaitCold(ticket.record.askId, { sessionId: "sess_1", launch: 1, sandbox });
    await vi.waitFor(async () => {
      if (!(await t.store.get(ticket.record.askId))?.cold) throw new Error("not cold yet");
    });
    const stored = await t.store.get(ticket.record.askId);
    expect(stored?.cold).toMatchObject({ sessionId: "sess_1", launch: 1, sandbox });
    expect(t.events.some((e) => e.type === "ask.cold")).toBe(true);
    await t.inbound(t.ch.click(ticket.record.askId, "hold"));
    expect((await cold).message).toContain('choice "hold"');
    // A resumed run waiting again keeps when the ask first went cold.
    const since = stored?.cold?.since;
    await t.session.markCold(ticket.record.askId, { sessionId: "sess_1" });
    expect((await t.store.get(ticket.record.askId))?.cold?.since).toBe(since);
  });

  it("after a restart, finds an ask answered while no host ran, even when the limits are used up", async () => {
    const t = setup({ hitl: { maxAsksPerAgent: 1, maxOpenAsks: 1 } });
    const ticket = await t.session.openAgentAsk(req());
    if (ticket.kind !== "wait") throw new Error(ticket.kind);
    await t.session.markCold(ticket.record.askId, { sessionId: "sess_1" });
    await t.inbound(t.ch.click(ticket.record.askId, "merge"));

    // A new process: a fresh session on the same store, the runtime re-surfacing the same pending ask.
    const restarted = setup({ store: t.store, ch: t.ch, hitl: { maxAsksPerAgent: 1, maxOpenAsks: 1 } });
    const again = await restarted.session.openAgentAsk(req());
    expect(again).toMatchObject({ kind: "resolved", resolution: { choiceId: "merge" } });
    expect(t.ch.posts).toHaveLength(1);
  });

  it("after a restart, re-enters the wait on an ask still open, without posting it again", async () => {
    const t = setup({ hitl: { maxOpenAsks: 1 } });
    const open = await t.session.openAgentAsk(req());
    if (open.kind !== "wait") throw new Error(open.kind);
    const restarted = setup({ store: t.store, ch: t.ch, hitl: { maxOpenAsks: 1 } });
    const reopened = await restarted.session.openAgentAsk(req());
    expect(reopened.kind === "wait" && reopened.record.askId === open.record.askId).toBe(true);
    expect(t.ch.posts).toHaveLength(1);
  });

  it("pauses the run's wall clock while it waits for a human, hot or cold", async () => {
    const calls: string[] = [];
    const clock = { pauseClock: () => calls.push("pause"), resumeClock: () => calls.push("resume") };
    const t = setup({ clock });
    const ticket = await t.session.openAgentAsk(req());
    if (ticket.kind !== "wait") throw new Error(ticket.kind);
    const hot = t.session.waitHot(ticket.record.askId, ticket.plan.hotMs);
    await vi.waitFor(() => expect(calls).toEqual(["pause"]));
    await t.inbound(t.ch.click(ticket.record.askId, "hold"));
    await hot;
    expect(calls).toEqual(["pause", "resume"]);
    await t.session.awaitCold(ticket.record.askId);
    expect(calls).toEqual(["pause", "resume", "pause", "resume"]);
  });

  it("returns a tool error past the per-agent and per-run limits", async () => {
    const t = setup({ hitl: { maxOpenAsks: 2 } });
    const q = (i: number, over = {}) => req({ askSeq: i, spec: { question: `Q${i}?`, choices: ["a", "b"] }, ...over });
    expect((await t.session.openAgentAsk(q(0))).kind).toBe("wait");
    expect((await t.session.openAgentAsk(q(1, { agentHitl: { maxAsks: 2 } }))).kind).toBe("wait");
    const perAgent = await t.session.openAgentAsk(q(2, { agentHitl: { maxAsks: 2 } }));
    expect(perAgent).toMatchObject({ kind: "rejected", toolText: expect.stringMatching(/Decide for yourself/) });
    const perRun = await t.session.openAgentAsk(q(3, { callPath: "Verify#0" }));
    expect(perRun).toMatchObject({ kind: "rejected", toolText: expect.stringMatching(/2 questions are already open/) });
  });

  it("returns an invalid spec as a tool error, not a thrown error", async () => {
    const t = setup();
    const ticket = await t.session.openAgentAsk(req({ spec: { question: "Merge?", choices: ["Yes!"] } }));
    expect(ticket).toMatchObject({ kind: "rejected", toolText: expect.stringMatching(/object form/) });
    expect(t.ch.posts).toHaveLength(0);
  });

  it("lets the factory force risk high so the agent cannot default to an unsafe choice", async () => {
    const t = setup({ hitl: { mode: "afk", onTimeout: "default" } });
    const ticket = await t.session.openAgentAsk(
      req({
        spec: {
          question: "Deploy?",
          choices: ["deploy", { id: "wait", label: "Wait", safe: true }],
          default: "deploy",
        },
        agentHitl: { risk: "high" },
      }),
    );
    expect(ticket).toMatchObject({ kind: "resolved", resolution: { choiceId: "wait" } });
    expect(ticket.kind === "resolved" && ticket.toolText).toBe(
      'No human was available; proceeding with the default: choice "wait" (Wait).',
    );
  });

  it("applies the policy at once when the harness can neither wait 30 s nor resume", async () => {
    const t = setup({ hitl: { onTimeout: "default" } });
    const ticket = await t.session.openAgentAsk(
      req({
        spec: { question: "Merge?", choices: ["merge", "hold"], default: "hold" },
        harness: { mcpToolTimeoutMs: 40_000, canResume: false },
      }),
    );
    expect(ticket).toMatchObject({
      kind: "resolved",
      resolution: { choiceId: "hold", answeredBy: { kind: "default", reason: "timeout" } },
    });
  });

  it("keeps an ask from a shared handle hot-only, then applies the policy", async () => {
    vi.useFakeTimers();
    const t = setup({ hitl: { hotWait: "1h" } });
    const ticket = await t.session.openAgentAsk(
      req({
        spec: { question: "Merge?", choices: ["merge", "hold"] },
        sharedHandle: true,
        harness: { mcpToolTimeoutMs: null, canResume: true },
      }),
    );
    if (ticket.kind !== "wait") throw new Error(ticket.kind);
    expect(ticket.plan).toEqual({ mode: "hot", hotMs: 30 * MIN, afterHot: "policy" });
    const hot = t.session.waitHot(ticket.record.askId, ticket.plan.hotMs);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(await hot).toBeNull();
    await expect(t.session.expire(ticket.record.askId)).rejects.toBeInstanceOf(AskTimeoutError);
  });

  it("returns the timeout text the model reads", async () => {
    vi.useFakeTimers();
    const t = setup({ hitl: { onTimeout: "default", timeout: "4h" } });
    const ticket = await t.session.openAgentAsk(
      req({ spec: { question: "Merge?", choices: ["merge", { id: "hold", label: "Hold", safe: true }] } }),
    );
    if (ticket.kind !== "wait") throw new Error(ticket.kind);
    const p = t.session.awaitResolution(ticket.record.askId);
    await vi.advanceTimersByTimeAsync(4 * H);
    const { formatToolResult } = await import("./format.js");
    expect(formatToolResult(ticket.record, await p)).toBe(
      'No human answered within 4h; proceeding with the default: choice "hold" (Hold).',
    );
  });

  it("posts notify_human as an FYI, within the same limits", async () => {
    const t = setup({ hitl: { maxAsksPerAgent: 1 } });
    expect(await t.session.notifyHuman({ callPath: "a", text: "found a second bug" })).toEqual({
      isError: false,
      toolText: "Posted to the run thread.",
    });
    expect(t.ch.notifications[0]?.notification).toMatchObject({ kind: "fyi", text: "found a second bug" });
    expect((await t.session.notifyHuman({ callPath: "a", text: "again" })).isError).toBe(true);
  });
});

describe("completion notifications", () => {
  it("posts the summary into the thread the run opened, mentioning approvers on failure", async () => {
    const t = setup({ notify: { on: [] } });
    const p = t.factoryAsk({ question: "Ship?", choices: ["yes", "no"] });
    await t.ch.waitForPosts(1);
    await t.inbound(t.ch.click(lastPost(t.ch).askId, "yes"));
    await p;
    await t.session.notifyRunEnd({
      status: "failed",
      durationMs: 90 * MIN,
      costUsd: 1.234,
      error: { name: "AskTimeoutError", message: "boom", hint: "re-run with --resume", branch: "selfbuilding/run-1" },
    });
    const n = t.ch.notifications.at(-1);
    expect(n?.thread).toEqual(t.ch.posts[0]?.ref.thread);
    expect(n?.notification).toMatchObject({ kind: "run.failed", mention: true });
    expect(n?.notification.text).toContain("*ship-change* finished: failed");
    expect(n?.notification.text).toContain("took 90m, cost $1.23");
    expect(n?.notification.text).toContain("Questions: 1 (answered by @user-1)");
    expect(n?.notification.text).toContain("Work kept on branch selfbuilding/run-1");
  });

  it("posts to the configured channels when no ask opened a thread, only if notify asks", async () => {
    const quiet = setup({ notify: { on: ["run.failed"] } });
    await quiet.session.notifyRunEnd({ status: "ok", result: { summary: "3 PRs merged" } });
    expect(quiet.ch.notifications).toHaveLength(0);

    const t = setup();
    await t.session.notifyRunEnd({ status: "ok", result: { summary: "3 PRs merged" } });
    expect(t.ch.notifications[0]?.notification).toMatchObject({ kind: "run.end", mention: false });
    expect(t.ch.notifications[0]?.notification.text).toContain("3 PRs merged");
  });

  it("redacts before it truncates", async () => {
    const t = setup({ redact: (s) => s.replaceAll("sk-SECRET", "[redacted]") });
    await t.session.notifyRunEnd({ status: "ok", result: { summary: `${"x".repeat(2_990)}sk-SECRET-tail` } });
    const text = t.ch.notifications[0]?.notification.text ?? "";
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text).not.toContain("sk-");
  });

  it("retries delivery and records notify.failed without throwing", async () => {
    const t = setup();
    t.ch.fail("notify", 3);
    await t.session.notifyRunEnd({ status: "ok" });
    expect(t.ch.notifications).toHaveLength(0);
    expect(t.events.find((e) => e.type === "notify.failed")?.data).toMatchObject({ channel: "slack", kind: "run.end" });

    t.ch.fail("notify", 2);
    await t.session.notifyRunEnd({ status: "ok" });
    expect(t.ch.notifications).toHaveLength(1);
  });

  it("sends agent.end only when opted in", async () => {
    const t = setup();
    await t.session.notifyEvent("agent.end", "ImplementSpec finished");
    expect(t.ch.notifications).toHaveLength(0);
    const opted = setup({ notify: { on: ["agent.end"] } });
    await opted.session.notifyEvent("agent.end", "ImplementSpec finished");
    expect(opted.ch.notifications[0]?.notification.kind).toBe("agent.end");
  });
});
