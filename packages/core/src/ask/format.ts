import type { AnsweredBy, AskAnswer, AskRecord, AskResolution } from "../types/ask.js";
import { formatDuration } from "./duration.js";
import { choiceLabel, fromStored } from "./spec.js";

// Text the model and the people in the thread read (spec §8.2, §8.4, §8.7).

const CHANNEL_NAMES: Record<string, string> = { slack: "Slack", discord: "Discord", github: "GitHub", cli: "the CLI" };

function describeAnswer(record: AskRecord, answer: AskAnswer<unknown>): string {
  switch (answer.kind) {
    case "choice": {
      const label = choiceLabel(fromStored(record.spec), answer.choiceId);
      return label === answer.choiceId ? `choice "${answer.choiceId}"` : `choice "${answer.choiceId}" (${label})`;
    }
    case "text":
      return `"${answer.text}"`;
    case "value":
      return JSON.stringify(answer.value);
  }
}

/** The short form for cards: the label of a choice, else the answer itself. */
function shortAnswer(record: AskRecord, answer: AskAnswer<unknown>): string {
  if (answer.kind === "choice") return choiceLabel(fromStored(record.spec), answer.choiceId);
  return answer.kind === "text" ? answer.text : JSON.stringify(answer.value);
}

function who(by: Extract<AnsweredBy, { kind: "human" }>): string {
  return `@${by.displayName || by.userId} via ${CHANNEL_NAMES[by.channel] ?? by.channel}`;
}

function timeoutText(record: AskRecord): string {
  return formatDuration(Date.parse(record.expiresAt) - Date.parse(record.createdAt));
}

/** What `ask_human` returns to the model once the ask resolved. */
export function formatToolResult(record: AskRecord, res: AskResolution): string {
  const what = describeAnswer(record, res.answer);
  const by = res.answeredBy;
  switch (by.kind) {
    case "human":
      return `Answer from ${who(by)}: ${what}.`;
    case "auto":
      return `No human was available. An automatic reviewer chose ${what} because ${by.rationale}`;
    case "default":
      return by.reason === "timeout"
        ? `No human answered within ${timeoutText(record)}; proceeding with the default: ${what}.`
        : `No human was available; proceeding with the default: ${what}.`;
  }
}

/** The tool result for a cold wait: the agent must end its turn. */
export function formatSuspended(record: AskRecord): string {
  return `Your question #${record.ordinal} is waiting for a human. End your turn now. Do not make further changes. You will be resumed with the answer.`;
}

/** The first user message of the turn that resumes a cold wait. */
export function formatResumeMessage(record: AskRecord, res: AskResolution): string {
  const what = describeAnswer(record, res.answer);
  const by = res.answeredBy;
  if (by.kind === "human") return `Answer to your question #${record.ordinal} from ${who(by)}: ${what}`;
  return `Answer to your question #${record.ordinal}: ${formatToolResult(record, res)}`;
}

/** The card text once an ask settles, e.g. "Answered by @alice: Hold". */
export function formatSettledCard(record: AskRecord, res: AskResolution | null): string {
  if (!res) return record.status === "cancelled" ? "Cancelled: the run stopped." : "Expired: nobody answered in time.";
  const what = shortAnswer(record, res.answer);
  const by = res.answeredBy;
  if (by.kind === "human") return `Answered by @${by.displayName || by.userId}: ${what}`;
  if (by.kind === "auto") return `Answered automatically (${by.model}): ${what}. ${by.rationale}`;
  return by.reason === "timeout"
    ? `No answer within ${timeoutText(record)}; proceeded with ${what}`
    : `No human available; proceeded with ${what}`;
}

/** The reply to someone who answers a settled ask (spec §8.8, late answers). */
export function formatLateAnswer(record: AskRecord): string {
  const res = record.resolution;
  if (record.status === "answered" && res) {
    const what = shortAnswer(record, res.answer);
    if (res.answeredBy.kind === "human")
      return `Already answered by @${res.answeredBy.displayName || res.answeredBy.userId}: ${what}.`;
    return `Already settled at ${res.answeredAt}; the run proceeded with ${what}.`;
  }
  return record.status === "cancelled"
    ? `Question #${record.ordinal} was cancelled; the run no longer needs an answer.`
    : `Question #${record.ordinal} expired at ${record.expiresAt}; the run proceeded without it.`;
}
