import type { AskChoice, AskRecord, AskResolution, AskSpec } from "@selfbuilding/core";

/**
 * Escapes the three characters Slack mrkdwn treats as control. With them escaped, text from a sandbox
 * cannot produce a mention (`<!channel>`, `<@U…>`) or a disguised link; *bold*, _italic_ and `code` survive.
 */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Reverses Slack's escaping of message text received from the Events API. */
export function unescapeSlackText(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Cuts on a code point boundary and marks the cut. */
export function truncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function normalizeChoices(spec: AskSpec): AskChoice[] {
  return (spec.choices ?? []).map((c) => (typeof c === "string" ? { id: c, label: c } : c));
}

/** spec §8.2: free text defaults to true when there are no choices. */
export function acceptsFreeText(spec: AskSpec): boolean {
  return spec.freeText ?? normalizeChoices(spec).length === 0;
}

/** A short, human label for an answer: the choice label, the quoted text, or the value as JSON. */
export function answerLabel(record: AskRecord, resolution: AskResolution): string {
  const { answer } = resolution;
  if (answer.kind === "choice") {
    return normalizeChoices(record.spec).find((c) => c.id === answer.choiceId)?.label ?? answer.choiceId;
  }
  if (answer.kind === "text") return `"${truncate(answer.text, 200)}"`;
  return truncate(JSON.stringify(answer.value) ?? "null", 200);
}

/** Leading `#<n>` in a reply addresses ask ordinal n (spec §8.7 rule 2). */
export function splitOrdinal(text: string): { ordinal?: number; text: string } {
  const match = /^\s*#(\d{1,6})\b[\s:,.-]*/.exec(text);
  if (!match?.[1]) return { text: text.trim() };
  return { ordinal: Number(match[1]), text: text.slice(match[0].length).trim() };
}
