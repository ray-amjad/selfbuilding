import { createHmac } from "node:crypto";
import { type SlackChannel, slack } from "@selfbuilding/channel-slack";
import type { Actor, AskRecord, AskResolution, AskSpec, ChannelMessageRef, ThreadKey } from "@selfbuilding/core";
import { HitlConfigError } from "@selfbuilding/core";
import { type SlackEmulator, startSlackEmulator } from "@selfbuilding/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { askRecord, memoryAskStore } from "../test/memory-store.js";
import { serveFetch } from "../test/serve.js";
import { createHitlHandler, type HitlHandlerOptions } from "./index.js";

// End to end against emulate's Slack emulator: real cards, real button clicks and modal submissions delivered
// to the handler over HTTP. Thread replies are Events API deliveries, which emulate 0.13 cannot route to a URL,
// so those bodies are built here and signed with the seeded signing secret (a local fake for that one path).

type Call = { method: string; body: Record<string, unknown>; response: Record<string, unknown> };

describe("createHitlHandler with the Slack channel", () => {
  let emu: SlackEmulator;
  let server: Awaited<ReturnType<typeof serveFetch>>;
  let store: ReturnType<typeof memoryAskStore>;
  let channel: SlackChannel;
  let calls: Call[];
  let lines: string[];
  let pending: Promise<unknown>[];
  let thread: ThreadKey;
  let lastDelivery: { body: string; headers: Record<string, string> } | undefined;
  const resolveWaitpoint = vi.fn<(r: AskRecord, res: AskResolution) => Promise<void>>();
  const onStop = vi.fn<(runId: string, actor: Actor) => Promise<void>>();

  beforeAll(async () => {
    server = await serveFetch(async () => new Response(null, { status: 503 }));
    emu = await startSlackEmulator({ interactivityUrl: server.url });
  });
  afterAll(async () => {
    await emu?.close();
    await server?.close();
  });

  const mount = (over: Partial<HitlHandlerOptions> = {}) => {
    const handler = createHitlHandler({
      channels: [channel],
      store,
      approvers: [{ slack: emu.human.userId }],
      resolveWaitpoint,
      onStop,
      waitUntil: (work) => pending.push(work),
      log: (l) => lines.push(l),
      ...over,
    });
    server.set(async (req) => {
      const copy = req.clone();
      lastDelivery = { body: await copy.text(), headers: Object.fromEntries(copy.headers) };
      return handler(req);
    });
    return handler;
  };

  beforeEach(async () => {
    await emu.reset();
    store = memoryAskStore();
    calls = [];
    lines = [];
    pending = [];
    lastDelivery = undefined;
    resolveWaitpoint.mockReset().mockResolvedValue(undefined);
    onStop.mockReset().mockResolvedValue(undefined);
    channel = slack({
      channel: `#${emu.channelName}`,
      botToken: emu.bot.token,
      signingSecret: emu.signingSecret,
      apiUrl: emu.url,
      retries: 0,
      log: (l) => lines.push(l),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        calls.push({
          method: String(input).split("/api/")[1] ?? "",
          body: JSON.parse(String(init?.body ?? "{}")),
          response: (await response.clone().json()) as Record<string, unknown>,
        });
        return response;
      },
    });
    thread = await channel.openThread({ runId: "run_test", factory: "ship-issues" });
    mount();
  });

  const settle = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const rootTs = () => thread.id.split(":")[1] ?? "";

  const postAsk = async (spec: AskSpec, over: Partial<AskRecord> = {}) => {
    const record = askRecord(spec, over);
    const ref: ChannelMessageRef = await channel.post(record, thread);
    record.messages = [ref];
    await store.create(record);
    return { record, ref };
  };

  const card = async (ts: string) => {
    const { messages } = await emu.api<{ messages: Array<{ ts: string; blocks?: unknown[] }> }>(
      "conversations.replies",
      { channel: emu.channelId, ts: rootTs() },
      "human",
    );
    return JSON.stringify(messages.find((m) => m.ts === ts)?.blocks);
  };

  const ephemerals = () => calls.filter((c) => c.method === "chat.postEphemeral").map((c) => String(c.body.text));

  /** Posts a real thread reply in the emulator, then delivers its signed Events API callback. */
  const replyInThread = async (text: string, opts: { eventId?: string; botId?: string } = {}) => {
    const posted = await emu.reply(rootTs(), text);
    const body = JSON.stringify({
      type: "event_callback",
      event_id: opts.eventId ?? `Ev${posted.ts.replace(".", "")}`,
      event: {
        type: "message",
        channel: emu.channelId,
        user: emu.human.userId,
        text,
        ts: posted.ts,
        thread_ts: rootTs(),
        ...(opts.botId ? { bot_id: opts.botId } : {}),
      },
    });
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...emu.sign(body) },
      body,
    });
    await settle();
    return res;
  };

  it("resolves a click by CAS, wakes the waitpoint and rebuilds every card", async () => {
    const { record, ref } = await postAsk({
      question: "Label 3 PRs ready-to-merge?",
      choices: ["yes", "no"],
      risk: "high",
    });
    await emu.click(ref.id, { text: "yes" });
    await settle();

    const stored = await store.get(record.askId);
    expect(stored?.status).toBe("answered");
    expect(stored?.resolution).toMatchObject({
      askId: record.askId,
      answer: { kind: "choice", choiceId: "yes" },
      choiceId: "yes",
      answeredBy: { kind: "human", channel: "slack", userId: emu.human.userId, displayName: emu.human.name },
    });
    expect(resolveWaitpoint).toHaveBeenCalledTimes(1);
    expect(resolveWaitpoint.mock.calls[0]?.[1].choiceId).toBe("yes");
    const blocks = await card(ref.id);
    expect(blocks).toContain(`Answered by <@${emu.human.userId}>: yes`);
    expect(blocks).not.toContain("ns_choice");
  });

  it("refuses a click from someone who is not an approver, ephemerally, naming who can answer", async () => {
    // A permission lookup that finds nobody: the clicker is neither U0ALICE nor a maintainer.
    mount({
      approvers: [{ slack: "U0ALICE" }, { githubPermission: "maintain" }],
      authorize: (actor) => actor.channel === "slack" && actor.userId === "U0ALICE",
    });
    const { record, ref } = await postAsk({ question: "Merge?", choices: ["merge", "hold"] });
    await emu.click(ref.id, { text: "merge" });
    await settle();
    expect((await store.get(record.askId))?.status).toBe("open");
    expect(store.resolveCalls).toBe(0);
    expect(ephemerals()).toEqual(["Only @U0ALICE or repo maintainers can answer this."]);
    expect(lines).toContain(`skip [not-approver] slack:${emu.human.userId} on ${record.askId}`);
  });

  it("answers the single open free-text ask from a thread reply", async () => {
    const { record } = await postAsk({ question: "Which endpoint?" });
    const res = await replyInThread("use the v2 endpoint");
    expect(res.status).toBe(200);
    expect((await store.get(record.askId))?.resolution?.answer).toEqual({ kind: "text", text: "use the v2 endpoint" });
  });

  it("asks for an ordinal when several free-text asks are open, then takes '#n ...'", async () => {
    const first = await postAsk({ question: "Which endpoint?" });
    const second = await postAsk({ question: "Which region?" });
    await replyInThread("eu-west-1");
    expect(store.resolveCalls).toBe(0);
    const listing = calls.filter((c) => c.method === "chat.postMessage").at(-1);
    expect(String(listing?.body.text)).toContain(`#${first.record.ordinal} Which endpoint?`);
    expect(String(listing?.body.text)).toContain(`#${second.record.ordinal} Which region?`);
    expect(lines.some((l) => l.startsWith("skip [ambiguous-reply]"))).toBe(true);

    await replyInThread(`#${second.record.ordinal} eu-west-1`);
    expect((await store.get(second.record.askId))?.resolution?.answer).toEqual({ kind: "text", text: "eu-west-1" });
    expect((await store.get(first.record.askId))?.status).toBe("open");
  });

  it("ignores chatter, bots, and replies when no ask is open", async () => {
    await replyInThread("anything");
    expect(lines).toContain(`skip [no-open-ask] ${thread.id}`);
    const { record } = await postAsk({ question: "Which endpoint?" });
    await replyInThread("// thinking out loud");
    await replyInThread("I am a bot", { botId: "B0OTHER" });
    expect((await store.get(record.askId))?.status).toBe("open");
    expect(lines.some((l) => l.startsWith("skip [chatter]"))).toBe(true);
    expect(lines.some((l) => l.startsWith("skip [bot]"))).toBe(true);
  });

  it("handles a double answer and a redelivered webhook: one answer wins, the later one is told", async () => {
    const { record, ref } = await postAsk({
      question: "Merge?",
      choices: [
        { id: "merge", label: "Merge" },
        { id: "hold", label: "Hold", safe: true },
      ],
      freeText: true,
    });
    await replyInThread("hold until Monday");
    // Someone whose client still shows the buttons clicks after the reply won.
    const actionTs = `${Math.floor(Date.now() / 1000)}.000100`;
    const payload = {
      type: "block_actions",
      user: { id: emu.human.userId, username: emu.human.name },
      trigger_id: "t1",
      container: { type: "message", channel_id: emu.channelId, message_ts: ref.id },
      actions: [{ type: "button", action_id: "ns_choice:merge", value: `${record.askId}:merge`, action_ts: actionTs }],
    };
    const clickBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const click = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...emu.sign(clickBody) },
      body: clickBody,
    });
    expect(click.status).toBe(200);
    await settle();
    expect(ephemerals().at(-1)).toBe(`Already answered by @${emu.human.userId}: "hold until Monday".`);
    const clickDelivery = lastDelivery;

    // Slack retrying the same interaction body is a no-op.
    if (!clickDelivery) throw new Error("no click delivery captured");
    const replay = await fetch(server.url, {
      method: "POST",
      headers: clickDelivery.headers,
      body: clickDelivery.body,
    });
    await settle();
    expect(replay.status).toBe(200);
    expect(lines.some((l) => l.startsWith("skip [duplicate-delivery]"))).toBe(true);
    expect(store.resolveCalls).toBe(1);
    expect((await store.get(record.askId))?.resolution?.answer).toEqual({ kind: "text", text: "hold until Monday" });
    expect(resolveWaitpoint).toHaveBeenCalledTimes(1);
  });

  it("tells the loser of a compare-and-set race who answered first", async () => {
    const { record, ref } = await postAsk({ question: "Ship?", choices: ["yes", "no"] });
    // The click read the record while it was open; another answer lands before its resolve.
    const staleGet = store.get.bind(store);
    store.get = async (askId) => {
      const snapshot = await staleGet(askId);
      await store.resolve(askId, {
        askId,
        answer: { kind: "choice", choiceId: "no" },
        choiceId: "no",
        answeredBy: { kind: "human", channel: "cli", userId: "ops", displayName: "ops" },
        answeredAt: new Date().toISOString(),
      });
      return snapshot;
    };
    await emu.click(ref.id, { text: "yes" });
    await settle();
    expect(ephemerals()).toEqual(["Already answered by @ops: no."]);
    expect((await staleGet(record.askId))?.resolution?.choiceId).toBe("no");
    expect(resolveWaitpoint).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith("skip [already-answered]"))).toBe(true);
  });

  it("tells a late answerer what the run did instead and never resolves", async () => {
    const { record, ref } = await postAsk({ question: "Merge?", choices: ["merge", "hold"] });
    const stored = store.records.get(record.askId);
    if (!stored) throw new Error("missing record");
    stored.status = "expired";
    stored.resolution = {
      askId: record.askId,
      answer: { kind: "choice", choiceId: "hold" },
      choiceId: "hold",
      answeredBy: { kind: "default", reason: "timeout" },
      answeredAt: record.expiresAt,
    };
    await emu.click(ref.id, { text: "merge" });
    await settle();
    expect(ephemerals()).toEqual([`This question expired at ${record.expiresAt}; the run proceeded with hold.`]);
    expect(store.resolveCalls).toBe(0);
    expect(resolveWaitpoint).not.toHaveBeenCalled();
  });

  it("takes a schema form from the modal, validated by the ask's schema", async () => {
    const schema = {
      type: "object",
      properties: { branch: { type: "string" }, env: { enum: ["staging", "prod"] }, force: { type: "boolean" } },
      required: ["branch", "env", "force"],
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          (value as { branch?: string }).branch === "bad"
            ? { issues: [{ message: "not an allowed branch", path: ["branch"] }] }
            : { value },
      },
    } as unknown as AskSpec["schema"];
    const { record, ref } = await postAsk({ question: "Deploy settings?", schema });

    const submit = async (values: Record<string, string>) => {
      await emu.click(ref.id, { text: "Answer…" });
      const viewId =
        (calls.filter((c) => c.method === "views.open").at(-1)?.response.view as { id?: string } | undefined)?.id ?? "";
      const res = await fetch(`${emu.url}/_slack/simulate/view-submission`, {
        method: "POST",
        headers: { authorization: `Bearer ${emu.human.token}`, "content-type": "application/json" },
        body: JSON.stringify({ view_id: viewId, values }),
      });
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
      await settle();
    };

    await submit({ "ns_field:s:branch": "bad", "ns_field:e:env": "prod", "ns_field:b:force": "true" });
    expect(ephemerals().at(-1)).toBe("That answer is not valid (branch: not an allowed branch). Please try again.");
    expect((await store.get(record.askId))?.status).toBe("open");

    await submit({ "ns_field:s:branch": "main", "ns_field:e:env": "prod", "ns_field:b:force": "true" });
    expect((await store.get(record.askId))?.resolution?.answer).toEqual({
      kind: "value",
      value: { branch: "main", env: "prod", force: true },
    });
  });

  it("takes free text from the Reply modal", async () => {
    const { record, ref } = await postAsk({ question: "Which branch?" });
    await emu.click(ref.id, { text: "Reply…" });
    const viewId =
      (calls.find((c) => c.method === "views.open")?.response.view as { id?: string } | undefined)?.id ?? "";
    await fetch(`${emu.url}/_slack/simulate/view-submission`, {
      method: "POST",
      headers: { authorization: `Bearer ${emu.human.token}`, "content-type": "application/json" },
      body: JSON.stringify({ view_id: viewId, values: { ns_text: "release-2" } }),
    });
    await settle();
    expect((await store.get(record.askId))?.resolution?.answer).toEqual({ kind: "text", text: "release-2" });
  });

  it("cancels the run when an approver clicks Stop, and refuses anyone else", async () => {
    await postAsk({ question: "Which branch?" });
    await emu.click(rootTs(), { text: "Stop" });
    await settle();
    expect(onStop).toHaveBeenCalledWith("run_test", expect.objectContaining({ userId: emu.human.userId }));

    mount({ approvers: [{ slack: "U0ALICE" }] });
    await emu.click(rootTs(), { text: "Stop" });
    await settle();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(ephemerals().at(-1)).toBe("Only @U0ALICE can stop this run.");
  });

  it("keeps the answer and updates the card when the waitpoint call fails on every retry", async () => {
    resolveWaitpoint.mockRejectedValue(new Error("trigger down"));
    const { record, ref } = await postAsk({ question: "Ship?", choices: ["yes", "no"] });
    await emu.click(ref.id, { text: "no" });
    await settle();
    expect((await store.get(record.askId))?.resolution?.choiceId).toBe("no");
    expect(lines.some((l) => l.startsWith("skip [waitpoint-failed]"))).toBe(true);
    expect(resolveWaitpoint).toHaveBeenCalledTimes(3);
    expect(await card(ref.id)).toContain("Answered by");
  });

  it("records an answer for a parked ask with no run waiting, and hands the stored record to onResolved", async () => {
    const onResolved = vi.fn<(r: AskRecord) => Promise<void>>().mockRejectedValueOnce(new Error("launcher down"));
    // No waitpoint resolver and no process waiting: the store is the only place the answer goes.
    mount({ resolveWaitpoint: undefined, onResolved });
    const cold = { since: "2026-11-02T10:00:00.000Z", sessionId: "sess_parked", launch: 1 };
    const { record, ref } = await postAsk({ question: "Ship?", choices: ["yes", "no"] }, { cold });
    await emu.click(ref.id, { text: "yes" });
    await settle();
    const stored = await store.get(record.askId);
    expect(stored).toMatchObject({ status: "answered", cold, resolution: { choiceId: "yes" } });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0]?.[0]).toMatchObject({ askId: record.askId, status: "answered", cold });
    // A failing callback is logged; the answer and the card stand.
    expect(lines.some((l) => l.startsWith("skip [on-resolved-failed]"))).toBe(true);
    expect(await card(ref.id)).toContain("Answered by");
  });

  it("lets authorize() replace the approver list", async () => {
    mount({
      approvers: undefined,
      authorize: async (actor, record) => actor.userId === emu.human.userId && record?.spec.risk !== "high",
    });
    const low = await postAsk({ question: "Ship?", choices: ["yes", "no"] });
    const high = await postAsk({ question: "Merge?", choices: ["merge", "hold"], risk: "high" });
    await emu.click(low.ref.id, { text: "yes" });
    await emu.click(high.ref.id, { text: "merge" });
    await settle();
    expect((await store.get(low.record.askId))?.status).toBe("answered");
    expect((await store.get(high.record.askId))?.status).toBe("open");
  });
});

describe("createHitlHandler request handling", () => {
  const secret = "test-signing-secret";
  const channel = slack({ channel: "C1", botToken: "xoxb-unused", signingSecret: secret, log: () => {} });
  const lines: string[] = [];
  const handler = createHitlHandler({
    channels: [channel],
    store: memoryAskStore(),
    approvers: [{ slack: "U1" }],
    log: (l) => lines.push(l),
  });
  const signed = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
  });
  const post = (body: string, headers: Record<string, string>) =>
    handler(
      new Request("http://localhost/hitl", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );

  it("rejects bad and stale signatures with 401", async () => {
    const body = JSON.stringify({ type: "event_callback", event: {} });
    expect((await post(body, { ...signed(body), "x-slack-signature": "v0=00" })).status).toBe(401);
    expect((await post(body, signed(body, Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
    expect((await post(`${body} `, signed(body))).status).toBe(401);
    expect(lines.filter((l) => l === "skip [signature] no channel verified the request")).toHaveLength(3);
  });

  it("answers Slack's url_verification challenge after verifying it", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "ch4ll3nge" });
    const res = await post(body, signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "ch4ll3nge" });
  });

  it("acks foreign events with 200 and refuses non-POST and oversized bodies", async () => {
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev9", event: { type: "reaction_added" } });
    expect((await post(body, signed(body))).status).toBe(200);
    expect((await handler(new Request("http://localhost/hitl"))).status).toBe(405);
    const small = createHitlHandler({
      channels: [channel],
      store: memoryAskStore(),
      approvers: [{ slack: "U1" }],
      maxBodyBytes: 10,
    });
    expect((await small(new Request("http://localhost/hitl", { method: "POST", body: "x".repeat(11) }))).status).toBe(
      413,
    );
  });

  it("fails at construction when nobody could answer", () => {
    expect(() => createHitlHandler({ channels: [channel], store: memoryAskStore() })).toThrow(HitlConfigError);
    expect(() => createHitlHandler({ channels: [], store: memoryAskStore(), approvers: [{ slack: "U1" }] })).toThrow(
      HitlConfigError,
    );
    // A { githubPermission } entry matches nobody without authorize(), so the handler refuses it up front.
    const permission = [{ slack: "U1" }, { githubPermission: "write" as const }];
    expect(() => createHitlHandler({ channels: [channel], store: memoryAskStore(), approvers: permission })).toThrow(
      /only authorize\(\) can check/,
    );
    expect(() =>
      createHitlHandler({
        channels: [channel],
        store: memoryAskStore(),
        approvers: permission,
        authorize: () => false,
      }),
    ).not.toThrow();
  });
});
