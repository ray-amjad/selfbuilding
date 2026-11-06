import type { CodeReviewFinding, FindingSeverity } from "./schemas.js";

/** A finding after the reviewers' outputs are merged: who flagged it, and the strongest verdict any gave it. */
export type MergedFinding = CodeReviewFinding & { reviewers: string[] };

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };

/** Same defect, same place: one line, or the same summary when there is no line. */
export function findingKey(f: Pick<CodeReviewFinding, "file" | "line" | "summary">): string {
  const file = f.file.replace(/^\.\//, "");
  return f.line !== undefined ? `${file}:${f.line}` : `${file}#${f.summary.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/**
 * Merges the panel's findings. A defect two reviewers flag is the higher-confidence one, so it keeps the stronger
 * verdict, the more severe severity and both names. CONFIRMED findings are fixed now; PLAUSIBLE ones are carried
 * to the decision page, never sent to a fixer.
 */
export function mergeFindings(reviews: readonly { label: string; findings: readonly CodeReviewFinding[] }[]): {
  fixNow: MergedFinding[];
  carry: MergedFinding[];
} {
  const byKey = new Map<string, MergedFinding>();
  for (const review of reviews) {
    for (const f of review.findings) {
      const key = findingKey(f);
      const prior = byKey.get(key);
      if (!prior) {
        byKey.set(key, { ...f, reviewers: [review.label] });
        continue;
      }
      if (!prior.reviewers.includes(review.label)) prior.reviewers.push(review.label);
      if (f.verdict === "CONFIRMED" && prior.verdict !== "CONFIRMED") {
        prior.verdict = "CONFIRMED";
        prior.failureScenario = f.failureScenario;
      }
      if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[prior.severity]) prior.severity = f.severity;
    }
  }
  const all = [...byKey.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.reviewers.length - a.reviewers.length,
  );
  return { fixNow: all.filter((f) => f.verdict === "CONFIRMED"), carry: all.filter((f) => f.verdict === "PLAUSIBLE") };
}

export function describeFinding(f: CodeReviewFinding & { reviewers?: string[] }): string {
  const where = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  const who = f.reviewers && f.reviewers.length > 0 ? ` (${f.reviewers.join(" + ")})` : "";
  return `${where} [${f.severity}] ${f.summary}${who}`;
}
