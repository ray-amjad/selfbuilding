import { describeFinding, type MergedFinding } from "./findings.js";
import type { CodeReviewFinding, VerifyFlowResult } from "./schemas.js";

export interface RoundSummary {
  round: number;
  tier: "medium" | "high";
  reviewers: { label: string; ok: boolean; verdict?: string; findings?: number; error?: string }[];
  fixNow: number;
  carried: number;
  fixed: number;
  unresolved: string[];
}

export interface DecisionPageInput {
  repo: string;
  pr: { url: string; number: number } | null;
  branch: string;
  title: string;
  summary: string;
  openQuestions: readonly string[];
  rounds: readonly RoundSummary[];
  /** Findings a fixer could not resolve. */
  unresolved: readonly string[];
  /** PLAUSIBLE findings, reported once and never sent to a fixer. */
  carried: readonly (CodeReviewFinding | MergedFinding)[];
  verify: { flows: readonly Pick<VerifyFlowResult, "name" | "outcome" | "detail">[] } | { error: string } | null;
}

export type MergeRecommendation = "merge" | "change-first";

/** Merge only when nothing is left open that could make the change wrong. */
export function recommend(p: DecisionPageInput): { choice: MergeRecommendation; reason: string } {
  if (p.unresolved.length > 0)
    return { choice: "change-first", reason: `${p.unresolved.length} finding(s) unresolved` };
  if (p.verify && "error" in p.verify) return { choice: "change-first", reason: "verification did not run" };
  const flows = p.verify?.flows ?? [];
  const notVerified = flows.filter((f) => f.outcome !== "verified" && f.outcome !== "unverifiable");
  if (notVerified.length > 0) {
    return { choice: "change-first", reason: `${notVerified.length} flow(s) not verified` };
  }
  return { choice: "merge", reason: flows.length > 0 ? "every flow verified" : "reviews clean" };
}

/**
 * The page a human reads before the merge question: one item per open decision, recommendation first. Plain
 * Markdown, so it fits an ask's context and a PR comment alike.
 */
export function renderDecisionPage(p: DecisionPageInput): string {
  const rec = recommend(p);
  const out: string[] = [];
  const prLabel = p.pr ? `PR #${p.pr.number}` : `branch ${p.branch}`;
  out.push(`# ${prLabel}: ${p.title}`);
  if (p.pr) out.push(p.pr.url);
  out.push("", p.summary.trim(), "");
  out.push("## Your call");
  out.push(
    `Merge ${prLabel}? Recommended: **${rec.choice === "merge" ? "Merge" : "Change it first"}** (${rec.reason}).`,
  );

  const items: string[] = [];
  for (const u of p.unresolved) items.push(`- **Unresolved finding:** ${u}`);
  for (const f of p.verify && "flows" in p.verify ? p.verify.flows : []) {
    if (f.outcome === "broken") items.push(`- **Flow broken:** ${f.name}: ${f.detail}`);
    if (f.outcome === "could_not_boot") items.push(`- **Flow unverified (could not boot):** ${f.name}: ${f.detail}`);
    if (f.outcome === "unverifiable") {
      items.push(
        `- **Unreachable branch:** ${f.name}: ${f.detail} Delete that branch, or keep it and say what reaches it?`,
      );
    }
  }
  for (const q of p.openQuestions) items.push(`- **Open question:** ${q}`);
  if (items.length > 0) out.push("", "## Decisions", ...items);

  if (p.carried.length > 0) {
    out.push("", "## Also flagged: plausible, unconfirmed");
    for (const f of p.carried) out.push(`- ${describeFinding(f)}: ${f.failureScenario}`);
  }

  out.push("", "## What was checked", "| Check | Result |", "|---|---|");
  for (const r of p.rounds) {
    const panel = r.reviewers.map((v) => (v.ok ? `${v.label}: ${v.verdict}` : `${v.label}: unavailable`)).join(", ");
    out.push(
      `| Review round ${r.round} (${r.tier}; ${panel}) | ${r.fixNow} to fix, ${r.fixed} fixed, ${r.carried} carried, ${r.unresolved.length} unresolved |`,
    );
  }
  if (p.verify === null) out.push("| Verify | not run |");
  else if ("error" in p.verify) out.push(`| Verify | did not run: ${p.verify.error} |`);
  else if (p.verify.flows.length === 0) out.push("| Verify | no runnable surface |");
  else for (const f of p.verify.flows) out.push(`| Verify: ${f.name} | ${f.outcome} |`);
  return `${out.join("\n")}\n`;
}

/** The PR body: the builder's body with the notes file and the verification results in their sections. */
export function composePrBody(o: {
  prBody: string;
  notes: string;
  verified?: readonly Pick<VerifyFlowResult, "name" | "outcome" | "detail">[] | null;
}): string {
  let body = o.prBody.trim();
  // Demote the notes' own headings so they nest under the section and never end it early.
  const notes = o.notes.trim().replace(/^(#{1,4}) /gm, (_m, hashes: string) => `${"#".repeat(hashes.length + 2)} `);
  if (notes) body = replaceSection(body, "Implementation notes", notes);
  if (o.verified) {
    const lines =
      o.verified.length === 0
        ? "No runnable surface; nothing to verify."
        : o.verified.map((f) => `- **${f.name}**: ${f.outcome}. ${f.detail}`).join("\n");
    body = replaceSection(body, "Verified", lines);
  }
  return `${body}\n`;
}

/** Replaces the body of `## <heading>` (up to the next `## `), or appends the section when it is missing. */
export function replaceSection(markdown: string, heading: string, content: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return `${markdown.trimEnd()}\n\n## ${heading}\n${content}`;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start + 1), content, "", ...lines.slice(end)].join("\n").trimEnd();
}
