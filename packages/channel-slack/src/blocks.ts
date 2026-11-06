import type { AskRecord, AskView, Notification, RunInfo } from "@selfbuilding/core";
import { type FormField, formFields } from "./forms.js";
import { acceptsFreeText, answerLabel, escapeMrkdwn, normalizeChoices, truncate } from "./text.js";

// Every Block Kit payload Selfbuilding sends is built here, from typed data, with every string escaped
// (spec §8.1 rule 6). Nothing a sandbox writes is passed through as markup.

export type Block = Record<string, unknown>;
export interface SlackMessage {
  text: string;
  blocks: Block[];
}

/** Action ids. Choice buttons are `ns_choice:<choiceId>` because Slack wants action ids unique per message. */
export const ACTION = {
  choice: "ns_choice",
  reply: "ns_reply",
  form: "ns_form",
  stop: "ns_stop",
} as const;
export const MODAL_CALLBACK_ID = "ns_answer";
/** Slack's limits for section text and button values. */
export const SECTION_LIMIT = 3000;
const BUTTON_VALUE_LIMIT = 2000;

const plain = (text: string, max: number) => ({ type: "plain_text", text: truncate(text, max), emoji: false });
const mrkdwn = (text: string) => ({ type: "mrkdwn", text: truncate(text, SECTION_LIMIT) });
const section = (text: string): Block => ({ type: "section", text: mrkdwn(text) });
const context = (text: string): Block => ({ type: "context", elements: [mrkdwn(text)] });

/** A Slack mention, only for something shaped like a user id, so a display name can never become markup. */
export function mention(userId: string): string {
  return /^[UW][A-Z0-9]{2,}$/.test(userId) ? `<@${userId}>` : `@${escapeMrkdwn(userId)}`;
}

export type Redact = (text: string) => string;

function heading(record: AskRecord): string {
  return `#${record.ordinal} ${record.spec.title ?? "Question"}`;
}

/** The ask card: heading, question, context, choice buttons, and the ways to answer in text. */
export function askCard(record: AskRecord, redact: Redact): SlackMessage {
  const { spec } = record;
  const question = escapeMrkdwn(redact(spec.question));
  const blocks: Block[] = [{ type: "header", text: plain(heading(record), 150) }, section(question)];
  if (spec.context) blocks.push(context(escapeMrkdwn(redact(spec.context))));

  const buttons: Block[] = normalizeChoices(spec).map((choice) => ({
    type: "button",
    action_id: `${ACTION.choice}:${choice.id}`,
    text: plain(redact(choice.label), 75),
    value: `${record.askId}:${choice.id}`,
    ...(choice.style ? { style: choice.style } : {}),
  }));
  const fields = formFields(spec);
  const formValue = fields ? JSON.stringify({ a: record.askId, f: fields }) : "";
  if (fields && formValue.length <= BUTTON_VALUE_LIMIT) {
    buttons.push({ type: "button", action_id: ACTION.form, text: plain("Answer…", 75), value: formValue });
  } else if (acceptsFreeText(spec)) {
    buttons.push({
      type: "button",
      action_id: ACTION.reply,
      text: plain("Reply…", 75),
      value: JSON.stringify({ a: record.askId, o: record.ordinal }),
    });
  }
  if (buttons.length > 0) blocks.push({ type: "actions", block_id: `ns_ask:${record.askId}`, elements: buttons });

  const hints: string[] = [];
  if (acceptsFreeText(spec))
    hints.push(`Reply in this thread to answer. If several questions are open, start with #${record.ordinal}.`);
  if (spec.risk === "high") hints.push("High risk: only a person can approve this.");
  hints.push(`Ask \`${record.askId}\``);
  blocks.push(context(hints.join(" · ")));
  return { text: truncate(`${heading(record)}: ${redact(spec.question)}`, SECTION_LIMIT), blocks };
}

/** The card after its ask settles. Rebuilt in full: chat.update drops blocks that are not re-sent. */
export function settledCard(view: AskView, redact: Redact): SlackMessage {
  const { record } = view;
  const resolution = record.resolution;
  let status: string;
  if (view.status === "answered" && resolution) {
    const by = resolution.answeredBy;
    const who =
      by.kind === "human"
        ? by.channel === "slack"
          ? mention(by.userId)
          : `@${escapeMrkdwn(by.displayName)}`
        : by.kind === "auto"
          ? `an automatic reviewer (${escapeMrkdwn(by.model)})`
          : `the default (${by.reason})`;
    status = `:white_check_mark: Answered by ${who}: ${escapeMrkdwn(redact(answerLabel(record, resolution)))}`;
  } else {
    const icon = {
      answered: ":white_check_mark:",
      expired: ":hourglass:",
      cancelled: ":no_entry_sign:",
      superseded: ":leftwards_arrow_with_hook:",
    }[view.status];
    status = `${icon} ${escapeMrkdwn(redact(view.text))}`;
  }
  const blocks: Block[] = [
    { type: "header", text: plain(heading(record), 150) },
    section(escapeMrkdwn(redact(record.spec.question))),
    section(status),
    context(`Ask \`${record.askId}\``),
  ];
  return { text: truncate(`${heading(record)}: ${view.text}`, SECTION_LIMIT), blocks };
}

export interface RootCardState {
  run: RunInfo;
  /** Final status, once the run has ended. */
  status?: string;
  /** A short live status line (phase, agents, cost). */
  line?: string;
}

/** The run's root message. While the run is live it carries the Stop button. */
export function rootCard(state: RootCardState, redact: Redact): SlackMessage {
  const { run } = state;
  const lines = [`*${escapeMrkdwn(run.factory)}* · run \`${escapeMrkdwn(run.runId)}\``];
  if (run.requestedBy) lines.push(`Requested by ${mention(run.requestedBy)}`);
  if (run.url && /^https?:\/\//.test(run.url))
    lines.push(`<${run.url.replaceAll(">", "%3E").replaceAll("|", "%7C")}|Transcript>`);
  const blocks: Block[] = [{ type: "header", text: plain("Selfbuilding run", 150) }, section(lines.join("\n"))];
  if (state.status) {
    blocks.push(section(`Finished: *${escapeMrkdwn(state.status)}*`));
  } else {
    if (state.line) blocks.push(context(escapeMrkdwn(redact(state.line))));
    blocks.push({
      type: "actions",
      block_id: "ns_run",
      elements: [
        {
          type: "button",
          action_id: ACTION.stop,
          text: plain("Stop", 75),
          style: "danger",
          value: run.runId,
          confirm: {
            title: plain("Stop this run?", 100),
            text: plain("Running agents are cancelled. Their work stays on their branches.", 300),
            confirm: plain("Stop", 30),
            deny: plain("Keep running", 30),
          },
        },
      ],
    });
  }
  return { text: `Selfbuilding run ${run.factory} (${run.runId})${state.status ? `: ${state.status}` : ""}`, blocks };
}

/** A notification in the run thread: redacted first, then escaped and truncated (spec §8.9). */
export function notificationMessage(n: Notification, redact: Redact): SlackMessage {
  const mentions =
    n.mention && Array.isArray(n.data?.mentions)
      ? (n.data.mentions as unknown[]).filter((m) => typeof m === "string")
      : [];
  const prefix = mentions.length > 0 ? `${mentions.map(mention).join(" ")} ` : "";
  const icon = {
    "run.end": ":checkered_flag: ",
    "run.failed": ":x: ",
    "agent.end": "",
    "ask.expired": ":hourglass: ",
    fyi: ":information_source: ",
    reminder: ":bell: ",
    refusal: "",
  }[n.kind];
  const body = `${prefix}${icon}${escapeMrkdwn(redact(n.text))}`;
  return { text: truncate(redact(n.text), SECTION_LIMIT), blocks: [section(body)] };
}

/** The modal opened by "Reply…" or "Answer…". private_metadata names the ask and thread. */
export function answerModal(opts: {
  askId: string;
  ordinal?: number;
  thread: string;
  fields?: FormField[];
  blocks?: Block[];
}): Record<string, unknown> {
  const metadata = JSON.stringify({
    a: opts.askId,
    t: opts.thread,
    ...(opts.ordinal ? { o: opts.ordinal } : {}),
    m: opts.fields ? "form" : "text",
  });
  return {
    type: "modal",
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: metadata,
    title: plain(opts.ordinal ? `Answer #${opts.ordinal}` : "Answer", 24),
    submit: plain("Send", 24),
    close: plain("Cancel", 24),
    blocks: opts.blocks ?? [
      {
        type: "input",
        block_id: "ns_text",
        label: plain("Your answer", 48),
        element: { type: "plain_text_input", action_id: "value", multiline: true },
      },
    ],
  };
}
