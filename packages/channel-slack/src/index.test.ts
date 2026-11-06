import type { InboundEvent } from "@selfbuilding/core";
import { type SlackEmulator, startSlackEmulator } from "@selfbuilding/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { askRecord, flatSchema } from "../test/fixtures.js";
import { serveFetch } from "../test/serve.js";
import { type SlackChannel, slack } from "./index.js";

// Runs against emulate's Slack emulator: chat.postMessage/update/postEphemeral, views.open, button clicks and
// modal submissions are real emulator round trips. Events API deliveries are signed by hand (see the
// thread-reply test), because emulate 0.13 has no public way to subscribe a URL to Slack events.

type Recorded = { method: string; body: Record<string, unknown>; response: Record<string, unknown> };

describe("slack() against the Slack emulator", () => {
  let emu: SlackEmulator;
  let server: Awaited<ReturnType<typeof serveFetch>>;
  let channel: SlackChannel;
  let calls: Recorded[];
  let inbound: Array<InboundEvent | null>;
  let lines: string[];

  beforeAll(async () => {
    server = await serveFetch(async () => new Response(null, { status: 200 }));
    emu = await startSlackEmulator({ interactivityUrl: server.url });
  });
  afterAll(async () => {
    await emu?.close();
    await server?.close();
  });

  beforeEach(async () => {
    await emu.reset();
    calls = [];
    inbound = [];
    lines = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const clone = response.clone();
      const method = String(input).split("/api/")[1] ?? String(input);
      calls.push({
        method,
        body: JSON.parse(String(init?.body ?? "{}")),
        response: (await clone.json().catch(() => ({}))) as Record<string, unknown>,
      });
      return response;
    };
    channel = slack({
      channel: `#${emu.channelName}`,
      botToken: emu.bot.token,
      signingSecret: emu.signingSecret,
      apiUrl: emu.url,
      fetch: recordingFetch,
      retries: 0,
      log: (l) => lines.push(l),
    });
    // The interactivity URL runs verify + parse, exactly what the hooks handler does first.
    server.set(async (req) => {
      const raw = new Uint8Array(await req.arrayBuffer());
      if (!(await channel.verify(req, raw))) return new Response("bad signature", { status: 401 });
      const ev = await channel.parse(req, raw);
      inbound.push(ev);
      return ev ? channel.ack(ev) : new Response(null, { status: 200 });
    });
  });

  const replies = async (ts: string) =>
    (
      await emu.api<{ messages: Array<{ ts: string; text?: string; blocks?: unknown[] }> }>(
        "conversations.replies",
        { channel: emu.channelId, ts },
        "human",
      )
    ).messages;

  it("opens the run thread, posts an ask card as a broadcast reply and decodes a button click", async () => {
    const thread = await channel.openThread({ runId: "run_1", factory: "ship-issues" });
    expect(thread).toEqual({
      channel: "slack",
      id: expect.stringMatching(new RegExp(`^${emu.channelId}:\\d+\\.\\d+$`)),
    });
    const record = askRecord({ question: "Label 3 PRs ready-to-merge?", choices: ["yes", "no"] });
    const ref = await channel.post(record, thread);
    expect(ref).toMatchObject({ channel: "slack", thread });
    const postCall = calls.find((c) => c.method === "chat.postMessage" && c.body.thread_ts);
    expect(postCall?.body.reply_broadcast).toBe(true);

    await emu.click(ref.id, { text: "yes" });
    expect(inbound.at(-1)).toMatchObject({
      kind: "choice",
      askId: record.askId,
      choiceId: "yes",
      actor: { channel: "slack", userId: emu.human.userId, isBot: false },
    });
  });

  it("rebuilds the card on update and posts the summary before marking the root finished", async () => {
    const thread = await channel.openThread({ runId: "run_2", factory: "ship-issues" });
    const rootTs = thread.id.split(":")[1] ?? "";
    const record = askRecord({ question: "Merge?", choices: [{ id: "hold", label: "Hold", safe: true }] });
    const ref = await channel.post(record, thread);
    const settled = {
      ...record,
      status: "answered" as const,
      resolution: {
        askId: record.askId,
        answer: { kind: "choice" as const, choiceId: "hold" },
        choiceId: "hold",
        answeredBy: {
          kind: "human" as const,
          channel: "slack" as const,
          userId: emu.human.userId,
          displayName: emu.human.name,
        },
        answeredAt: new Date().toISOString(),
      },
    };
    await channel.update(ref, { status: "answered", record: settled, text: "Answered" });
    const card = (await replies(rootTs)).find((m) => m.ts === ref.id);
    expect(JSON.stringify(card?.blocks)).toContain(`Answered by <@${emu.human.userId}>: Hold`);
    expect(JSON.stringify(card?.blocks)).not.toContain("ns_choice");

    await channel.notify(thread, { kind: "run.end", text: "Run finished: 3 PRs labelled.", data: { status: "ok" } });
    const methods = calls.map((c) => c.method);
    expect(methods.lastIndexOf("chat.update")).toBeGreaterThan(methods.lastIndexOf("chat.postMessage"));
    const thread2 = await replies(rootTs);
    expect(thread2.some((m) => m.text?.includes("Run finished: 3 PRs labelled."))).toBe(true);
    const root = thread2.find((m) => m.ts === rootTs);
    expect(JSON.stringify(root?.blocks)).toContain("Finished: *ok*");
    expect(JSON.stringify(root?.blocks)).not.toContain("ns_stop");
  });

  it("sends refusals as ephemeral messages to the one person", async () => {
    const thread = await channel.openThread({ runId: "run_3", factory: "f" });
    const ref = await channel.notify(thread, {
      kind: "refusal",
      text: "Only @alice can answer this.",
      data: { userId: emu.human.userId },
    });
    expect(ref.id).toMatch(/^ephemeral:/);
    expect(calls.at(-1)).toMatchObject({ method: "chat.postEphemeral", body: { user: emu.human.userId } });
  });

  it("opens a modal from Reply… inside the ack window and decodes the submission", async () => {
    const thread = await channel.openThread({ runId: "run_4", factory: "f" });
    const record = askRecord({ question: "Which branch?" });
    const ref = await channel.post(record, thread);
    await emu.click(ref.id, { text: "Reply…" });
    expect(inbound.at(-1)).toBeNull();
    const opened = calls.find((c) => c.method === "views.open");
    const viewId = (opened?.response.view as { id?: string } | undefined)?.id;
    expect(viewId).toBeTruthy();

    const submitted = await fetch(`${emu.url}/_slack/simulate/view-submission`, {
      method: "POST",
      headers: { authorization: `Bearer ${emu.human.token}`, "content-type": "application/json" },
      body: JSON.stringify({ view_id: viewId, values: { ns_text: "release-2" } }),
    });
    expect(((await submitted.json()) as { ok: boolean }).ok).toBe(true);
    expect(inbound.at(-1)).toMatchObject({
      kind: "text",
      thread,
      ordinal: record.ordinal,
      text: "release-2",
    });
  });

  it("opens a schema form modal with one input per field", async () => {
    const thread = await channel.openThread({ runId: "run_5", factory: "f" });
    const record = askRecord({ question: "Deploy settings?", schema: flatSchema() });
    const ref = await channel.post(record, thread);
    await emu.click(ref.id, { text: "Answer…" });
    const opened = calls.find((c) => c.method === "views.open");
    const view = opened?.body.view as { blocks: Array<{ block_id: string }>; private_metadata: string };
    expect(view.blocks.map((b) => b.block_id)).toEqual([
      "ns_field:s:branch",
      "ns_field:n:retries",
      "ns_field:b:force",
      "ns_field:e:env",
    ]);
    expect(JSON.parse(view.private_metadata)).toMatchObject({ a: record.askId, m: "form" });
  });

  it("decodes a signed thread reply delivered through the Events API", async () => {
    const thread = await channel.openThread({ runId: "run_6", factory: "f" });
    const rootTs = thread.id.split(":")[1] ?? "";
    const reply = await emu.reply(rootTs, "#4 use the v2 endpoint");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev0001",
      event: {
        type: "message",
        channel: emu.channelId,
        user: emu.human.userId,
        text: reply.text,
        ts: reply.ts,
        thread_ts: rootTs,
      },
    });
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...emu.sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(inbound.at(-1)).toMatchObject({
      kind: "text",
      thread,
      ordinal: 4,
      text: "use the v2 endpoint",
      deliveryId: "Ev0001",
    });

    // The bot's own thread posts are flagged so the handler drops them.
    await channel.notify(thread, { kind: "fyi", text: "found a second bug" });
    const botPost = calls.at(-1)?.response.message as { user?: string; ts: string };
    const botBody = JSON.stringify({
      type: "event_callback",
      event_id: "Ev0002",
      event: {
        type: "message",
        channel: emu.channelId,
        user: botPost.user,
        text: "x",
        ts: botPost.ts,
        thread_ts: rootTs,
      },
    });
    await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...emu.sign(botBody) },
      body: botBody,
    });
    expect(inbound.at(-1)).toMatchObject({ actor: { isBot: true } });
  });

  it("answers the url_verification handshake", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const req = new Request(server.url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const res = channel.handshake(req, new TextEncoder().encode(body));
    expect(await res?.json()).toEqual({ challenge: "abc123" });
  });

  it("throttles live status edits of the root card", async () => {
    let clock = 1_000_000;
    const throttled = slack({
      channel: `#${emu.channelName}`,
      botToken: emu.bot.token,
      signingSecret: emu.signingSecret,
      apiUrl: emu.url,
      now: () => clock,
    });
    const thread = await throttled.openThread({ runId: "run_7", factory: "f" });
    expect(await throttled.status(thread, "phase: build")).toBe(true);
    clock += 5_000;
    expect(await throttled.status(thread, "phase: review")).toBe(false);
    clock += 15_000;
    expect(await throttled.status(thread, "phase: verify")).toBe(true);
  });

  it("names the fix when Slack rejects a call", async () => {
    const wrong = slack({ channel: "#nope", botToken: emu.bot.token, signingSecret: "s", apiUrl: emu.url, retries: 0 });
    await expect(wrong.openThread({ runId: "r", factory: "f" })).rejects.toMatchObject({
      name: "ChannelDeliveryError",
      message: expect.stringContaining("channel_not_found"),
    });
  });
});
