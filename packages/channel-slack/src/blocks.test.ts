import { describe, expect, it } from "vitest";
import { askRecord, flatSchema } from "../test/fixtures.js";
import { ACTION, askCard, mention, notificationMessage, rootCard, settledCard } from "./blocks.js";
import { formFields, readFormValues } from "./forms.js";
import { parseSlackRequest } from "./inbound.js";
import { slackAppManifest } from "./manifest.js";
import { escapeMrkdwn, splitOrdinal, truncate } from "./text.js";

const identity = (s: string) => s;
type Block = { type: string; text?: { text: string }; elements?: Array<Record<string, unknown>> };
const blocksOf = (b: unknown) => b as Block[];
const allText = (b: unknown) => JSON.stringify(b);

describe("askCard", () => {
  it("renders shorthand choices as buttons whose value names the ask and choice, with unique action ids", () => {
    const record = askRecord({ question: "Ship it?", choices: ["yes", "no"] });
    const { blocks } = askCard(record, identity);
    const actions = blocksOf(blocks).find((b) => b.type === "actions");
    expect(actions?.elements?.map((e) => e.value)).toEqual([`${record.askId}:yes`, `${record.askId}:no`]);
    const ids = actions?.elements?.map((e) => e.action_id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => String(id).startsWith(ACTION.choice))).toBe(true);
    // Choices only: no free-text reply affordance.
    expect(allText(blocks)).not.toContain(ACTION.reply);
  });

  it("escapes every sandbox string so it cannot mention, link or forge markup", () => {
    const record = askRecord({
      title: "<!channel> urgent",
      question: "Approve <!here> and <https://evil.example|Approved> & *bold*?",
      context: "<@U999> said so",
      choices: [{ id: "ok", label: "<!channel>" }],
    });
    const text = allText(askCard(record, identity).blocks);
    // Slack parses mentions and links only in mrkdwn; plain_text (header, button labels) renders literally.
    const mrkdwnTexts = [...text.matchAll(/"type":"mrkdwn","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(mrkdwnTexts.length).toBeGreaterThan(1);
    for (const t of mrkdwnTexts) expect(t).not.toMatch(/<!channel>|<!here>|<@U999>|<https:/);
    expect(text).toContain("&lt;!here&gt;");
    expect(text).toContain("&amp; *bold*");
  });

  it("redacts before truncating and applies Slack's limits", () => {
    const secret = "sk-SECRETSECRET";
    const record = askRecord({ question: `${"x".repeat(2990)}${secret}` });
    const card = askCard(record, (s) => s.replaceAll(secret, "[redacted]"));
    expect(allText(card)).not.toContain("SECRET");
    const section = blocksOf(card.blocks).find((b) => b.type === "section");
    expect(Array.from(section?.text?.text ?? "").length).toBeLessThanOrEqual(3000);
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("offers a Reply button for free text and an Answer form for a flat schema", () => {
    const text = askRecord({ question: "Which branch?" });
    const textActions = blocksOf(askCard(text, identity).blocks).find((b) => b.type === "actions");
    expect(textActions?.elements?.map((e) => e.action_id)).toEqual([ACTION.reply]);
    expect(allText(askCard(text, identity).blocks)).toContain(`start with #${text.ordinal}`);

    const form = askRecord({ question: "Deploy settings?", schema: flatSchema() });
    const formButton = blocksOf(askCard(form, identity).blocks)
      .find((b) => b.type === "actions")
      ?.elements?.find((e) => e.action_id === ACTION.form);
    const decoded = JSON.parse(String(formButton?.value));
    expect(decoded.a).toBe(form.askId);
    expect(decoded.f.map((f: { n: string; t: string }) => `${f.n}:${f.t}`)).toEqual([
      "branch:s",
      "retries:n",
      "force:b",
      "env:e",
    ]);
  });

  it("marks high-risk asks", () => {
    const record = askRecord({ question: "Merge?", choices: ["merge", "hold"], risk: "high" });
    expect(allText(askCard(record, identity).blocks)).toContain("High risk");
  });
});

describe("settledCard, rootCard and notifications", () => {
  it("shows who answered with a real mention and drops the buttons", () => {
    const record = askRecord({ question: "Merge?", choices: [{ id: "hold", label: "Hold" }] });
    const settled = {
      ...record,
      status: "answered" as const,
      resolution: {
        askId: record.askId,
        answer: { kind: "choice" as const, choiceId: "hold" },
        choiceId: "hold",
        answeredBy: { kind: "human" as const, channel: "slack" as const, userId: "U0ALICE", displayName: "alice" },
        answeredAt: "2026-11-01T10:05:00.000Z",
      },
    };
    const card = settledCard({ status: "answered", record: settled, text: "Answered by @alice: Hold" }, identity);
    expect(allText(card.blocks)).toContain("Answered by <@U0ALICE>: Hold");
    expect(blocksOf(card.blocks).some((b) => b.type === "actions")).toBe(false);
  });

  it("uses the given text for expiry and supersession", () => {
    const record = askRecord({ question: "Q" });
    const card = settledCard({ status: "superseded", record, text: "Superseded by #3" }, identity);
    expect(allText(card.blocks)).toContain("Superseded by #3");
  });

  it("puts a Stop button on a live root card and removes it once the run ends", () => {
    const run = { runId: "run_1", factory: "ship-issues", requestedBy: "U0BOB", url: "https://viewer.example/r/1" };
    const live = rootCard({ run, line: "phase: review" }, identity);
    const stop = blocksOf(live.blocks)
      .find((b) => b.type === "actions")
      ?.elements?.find((e) => e.action_id === ACTION.stop);
    expect(stop?.value).toBe("run_1");
    expect(allText(live.blocks)).toContain("<@U0BOB>");
    const ended = rootCard({ run, status: "ok" }, identity);
    expect(blocksOf(ended.blocks).some((b) => b.type === "actions")).toBe(false);
    expect(allText(ended.blocks)).toContain("Finished: *ok*");
  });

  it("only turns user-id-shaped strings into mentions", () => {
    expect(mention("U0123ALICE")).toBe("<@U0123ALICE>");
    expect(mention("!channel")).toBe("@!channel");
    const n = notificationMessage(
      { kind: "run.failed", text: "Run failed <!channel>", mention: true, data: { mentions: ["U0ALICE", "!here"] } },
      identity,
    );
    expect(allText(n.blocks)).toContain("<@U0ALICE> @!here");
    expect(allText(n.blocks)).toContain("&lt;!channel&gt;");
  });
});

describe("text helpers", () => {
  it("splits a leading ordinal", () => {
    expect(splitOrdinal("#2 use the v2 endpoint")).toEqual({ ordinal: 2, text: "use the v2 endpoint" });
    expect(splitOrdinal("#12: yes")).toEqual({ ordinal: 12, text: "yes" });
    expect(splitOrdinal("use #2 please")).toEqual({ text: "use #2 please" });
    expect(escapeMrkdwn("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("reads form values back by field type", () => {
    expect(formFields({ question: "q" })).toBeNull();
    expect(formFields({ question: "q", schema: { properties: { a: { type: "array" } } } as never })).toBeNull();
    const values = readFormValues({
      "ns_field:s:branch": { value: { value: "main" } },
      "ns_field:n:retries": { value: { value: "3" } },
      "ns_field:b:force": { value: { selected_option: { value: "false" } } },
      "ns_field:e:env": { value: { selected_option: { value: "true" } } },
      other: { value: { value: "ignored" } },
    });
    expect(values).toEqual({ branch: "main", retries: 3, force: false, env: "true" });
  });
});

describe("parseSlackRequest", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const form = (payload: unknown) => enc(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
  const formType = "application/x-www-form-urlencoded";

  it("decodes a choice click from the button value", () => {
    const parsed = parseSlackRequest(
      form({
        type: "block_actions",
        user: { id: "U1", username: "alice" },
        actions: [{ action_id: "ns_choice:yes", value: "ask_abc:yes", action_ts: "171.1" }],
      }),
      formType,
    );
    expect(parsed).toEqual({
      kind: "event",
      event: {
        kind: "choice",
        askId: "ask_abc",
        choiceId: "yes",
        actor: { channel: "slack", userId: "U1", displayName: "alice", isBot: false },
        deliveryId: "171.1:U1",
      },
    });
  });

  it("decodes Stop, ignores foreign actions and answers the url_verification handshake", () => {
    const stop = parseSlackRequest(
      form({ type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "ns_stop", value: "run_1" }] }),
      formType,
    );
    expect(stop).toMatchObject({ kind: "event", event: { kind: "stop", runId: "run_1" } });
    expect(
      parseSlackRequest(form({ type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "x" }] }), formType),
    ).toMatchObject({ kind: "ignored" });
    expect(
      parseSlackRequest(enc(JSON.stringify({ type: "url_verification", challenge: "c1" })), "application/json"),
    ).toEqual({ kind: "challenge", challenge: "c1" });
    expect(parseSlackRequest(enc("not json"), "application/json")).toMatchObject({ kind: "ignored" });
  });

  it("maps thread replies to text events and flags bots; edits and roots are ignored", () => {
    const envelope = (event: Record<string, unknown>) =>
      enc(
        JSON.stringify({
          type: "event_callback",
          event_id: "Ev1",
          event: { type: "message", channel: "C1", ...event },
        }),
      );
    expect(
      parseSlackRequest(
        envelope({ user: "U1", ts: "2.0", thread_ts: "1.0", text: "#2 use &lt;v2&gt;" }),
        "application/json",
      ),
    ).toEqual({
      kind: "event",
      event: {
        kind: "text",
        thread: { channel: "slack", id: "C1:1.0" },
        ordinal: 2,
        text: "use <v2>",
        actor: { channel: "slack", userId: "U1", displayName: "U1", isBot: false },
        deliveryId: "Ev1",
      },
    });
    const bot = parseSlackRequest(
      envelope({ user: "UBOT", bot_id: "B1", ts: "2.0", thread_ts: "1.0", text: "hi" }),
      "application/json",
    );
    expect(bot).toMatchObject({ kind: "event", event: { actor: { isBot: true } } });
    const ownUser = parseSlackRequest(
      envelope({ user: "UME", ts: "2.0", thread_ts: "1.0", text: "hi" }),
      "application/json",
      "UME",
    );
    expect(ownUser).toMatchObject({ event: { actor: { isBot: true } } });
    expect(
      parseSlackRequest(envelope({ subtype: "message_changed", ts: "2.0", thread_ts: "1.0" }), "application/json"),
    ).toMatchObject({ kind: "ignored", reason: "message-subtype:message_changed" });
    expect(parseSlackRequest(envelope({ user: "U1", ts: "1.0", text: "top level" }), "application/json")).toMatchObject(
      {
        kind: "ignored",
      },
    );
  });

  it("maps a modal submission to a text or form event", () => {
    const view = (m: string, values: Record<string, unknown>) =>
      form({
        type: "view_submission",
        user: { id: "U1", username: "alice" },
        view: {
          id: "V1",
          hash: "h1",
          callback_id: "ns_answer",
          private_metadata: JSON.stringify({ a: "ask_x", t: "C1:1.0", o: 3, m }),
          state: { values },
        },
      });
    expect(parseSlackRequest(view("text", { ns_text: { value: { value: " use main " } } }), formType)).toMatchObject({
      event: { kind: "text", thread: { channel: "slack", id: "C1:1.0" }, ordinal: 3, text: "use main" },
    });
    expect(
      parseSlackRequest(view("form", { "ns_field:s:branch": { value: { value: "main" } } }), formType),
    ).toMatchObject({ event: { kind: "form", askId: "ask_x", value: { branch: "main" }, deliveryId: "view:V1:h1" } });
  });
});

describe("slackAppManifest", () => {
  it("matches the shipped manifest file", async () => {
    const { readFile } = await import("node:fs/promises");
    const file = JSON.parse(await readFile(new URL("../slack-app-manifest.json", import.meta.url), "utf8"));
    expect(slackAppManifest({ requestUrl: "https://example.com/selfbuilding/hitl" })).toEqual(file);
  });
});
