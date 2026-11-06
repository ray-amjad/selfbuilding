import type { DoneCheck, DoneContext } from "@selfbuilding/core";
import type { z } from "zod";
import {
  type CodeReviewResult,
  IMPLEMENTATION_NOTES_PATH,
  OUT_FILES_DIR,
  REVIEW_DIFF_PATH,
  type ReviewTier,
  TIER_FINDING_CAP,
  VerifyClaimFile,
  type VerifyResult,
  VerifyVerdictFile,
  verifyFlowPaths,
} from "./schemas.js";

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Tier choice (code-review SKILL.md §2). Exported so a factory can pick the tier on the host, deterministically.

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  /** Changed paths, used to spot dangerous subsystems. */
  paths?: readonly string[];
}

/** Paths that put a change in the high tier whatever its size: auth, money, migrations, concurrency. */
const DANGEROUS_PATH =
  /(^|[/._-])(auth|authn|authz|oauth|session|sessions|login|password|permission|permissions|acl|rbac|billing|payment|payments|invoice|invoices|checkout|stripe|money|ledger|wallet|migration|migrations|migrate|schema\.prisma|mutex|semaphore|queue|queues|worker|workers|concurrency|race)([/._-]|$)/i;

export function pickReviewTier(stat: DiffStat): { tier: ReviewTier; reason: string } {
  const lines = stat.insertions + stat.deletions;
  const dangerous = (stat.paths ?? []).filter((p) => DANGEROUS_PATH.test(p));
  if (dangerous.length > 0) {
    return { tier: "high", reason: `touches a sensitive area (${dangerous.slice(0, 3).join(", ")})` };
  }
  if (lines <= 100 && stat.files <= 3) {
    return { tier: "medium", reason: `${lines} changed lines in ${stat.files} files` };
  }
  return { tier: "high", reason: `${lines} changed lines in ${stat.files} files` };
}

/** Parses `git diff --numstat` output. Binary files ("-\t-\tpath") count as one changed file with no lines. */
export function parseNumstat(text: string): DiffStat & { paths: string[] } {
  const paths: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    insertions += m[1] === "-" ? 0 : Number(m[1]);
    deletions += m[2] === "-" ? 0 : Number(m[2]);
    paths.push(renamedTo(m[3] as string));
  }
  return { files: paths.length, insertions, deletions, paths };
}

/** `src/{a => b}/x.ts` and `a => b` are git's rename forms; the new path is what a reviewer reads. */
function renamedTo(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\//g, "/");
  const plain = /^(.*) => (.*)$/.exec(path);
  return plain ? (plain[2] as string) : path;
}

/** The paths a unified diff touches, from its `--- a/` and `+++ b/` headers. */
export function filesInPatch(patch: string): Set<string> {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\t?$/.exec(line);
    if (m && m[1] !== "/dev/null") out.add(m[1] as string);
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      out.add(git[1] as string);
      out.add(git[2] as string);
    }
  }
  return out;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const FOCUS_OR_SKIP =
  /\b(?:describe|it|test|context|suite)\.(?:only|skip)\b|\bx(?:it|describe|test)\s*\(|\bf(?:it|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/;

/**
 * Finds what the `no-test-removal` check rejects (spec §2.7.4): a deleted test file, or an added line that
 * focuses or skips a test. `nameStatus` is `git diff --name-status`, `patch` is `git diff -U0`.
 */
export function findTestRemovals(nameStatus: string, patch: string): string[] {
  const issues: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const [status, path] = line.trim().split(/\t+/);
    if (status === "D" && path && TEST_FILE.test(path)) issues.push(`deleted test file ${path}`);
  }
  let file = "";
  for (const line of patch.split("\n")) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      file = header[1] as string;
      continue;
    }
    if (line.startsWith("+") && FOCUS_OR_SKIP.test(line)) issues.push(`${file}: added "${line.slice(1).trim()}"`);
  }
  return issues;
}

async function execText(ctx: DoneContext, cmd: string): Promise<string> {
  const r = await ctx.sandbox.exec(cmd);
  if (r.exitCode !== 0) throw new Error(`\`${cmd}\` exited ${r.exitCode}: ${r.stderrTail.slice(-500)}`);
  return r.stdoutTail;
}

// code-review checks

/** Pure form of the `findings-in-diff` check. */
export function findingsOutsideDiff(result: CodeReviewResult, diffFiles: ReadonlySet<string>): string[] {
  return [...new Set(result.findings.map((f) => f.file.replace(/^\.\//, "")))].filter((f) => !diffFiles.has(f));
}

export const findingsInDiffCheck: DoneCheck<unknown, CodeReviewResult> = {
  id: "findings-in-diff",
  async assert(r, ctx) {
    if (r.findings.length === 0) return true;
    const headers = await execText(
      ctx,
      `grep -E '^(diff --git |\\+\\+\\+ |--- )' ${REVIEW_DIFF_PATH} || test ! -s ${REVIEW_DIFF_PATH}`,
    );
    const outside = findingsOutsideDiff(r, filesInPatch(headers));
    return outside.length === 0
      ? true
      : `These findings name files that are not in ${REVIEW_DIFF_PATH}: ${outside.join(", ")}. Report only files in the diff, with paths relative to the repository root.`;
  },
};

/** Pure form of the `verdict-consistent` check. */
export function verdictProblems(r: CodeReviewResult): string[] {
  const problems: string[] = [];
  if (r.verdict === "approve" && r.findings.length > 0) {
    problems.push(`verdict is approve but ${r.findings.length} finding(s) remain; use comment or request_changes`);
  }
  const blocking = r.findings.filter(
    (f) => f.verdict === "CONFIRMED" && (f.severity === "critical" || f.severity === "high"),
  );
  if (r.verdict === "comment" && blocking.length > 0) {
    problems.push(`${blocking.length} CONFIRMED critical or high finding(s) need request_changes, not comment`);
  }
  const cap = TIER_FINDING_CAP[r.tier];
  if (r.findings.length > cap) problems.push(`the ${r.tier} tier returns at most ${cap} findings`);
  return problems;
}

export const verdictConsistentCheck: DoneCheck<unknown, CodeReviewResult> = {
  id: "verdict-consistent",
  assert(r) {
    const problems = verdictProblems(r);
    return problems.length === 0 ? true : `${problems.join("; ")}.`;
  },
};

// implement-spec checks

export const noTestRemovalCheck: DoneCheck<unknown, unknown> = {
  id: "no-test-removal",
  async assert(_r, ctx) {
    const range = `${shellQuote(ctx.git.base)}...${shellQuote(ctx.git.head)}`;
    const nameStatus = await execText(ctx, `git diff --name-status ${range}`);
    const patch = await execText(ctx, `git diff -U0 ${range}`);
    const issues = findTestRemovals(nameStatus, patch);
    return issues.length === 0
      ? true
      : `The change removes, skips or focuses tests: ${issues.join("; ")}. Restore them; fix the code instead.`;
  },
};

export const implementationNotesCheck: DoneCheck<unknown, unknown> = {
  id: "implementation-notes",
  async assert(_r, ctx) {
    const r = await ctx.sandbox.exec(`test -s ${IMPLEMENTATION_NOTES_PATH}`);
    return r.exitCode === 0
      ? true
      : `${IMPLEMENTATION_NOTES_PATH} is missing or empty. Create it with the four sections and record your decisions.`;
  },
};

// verify checks

/**
 * Pure form of the `verify-evidence` check: every flow has its own evidence file in its own flow directory
 * (demo-path §4.2), every file is collected, and no claim was raised.
 */
export function verifyResultProblems(r: VerifyResult): string[] {
  const problems: string[] = [];
  const files = new Set(r.files);
  const seen = new Map<string, string>();
  for (const f of r.flows) {
    const { dir } = verifyFlowPaths(f.name);
    if (!f.evidence.startsWith(`${OUT_FILES_DIR}/`)) {
      problems.push(`flow "${f.name}": evidence ${f.evidence} is not under ${OUT_FILES_DIR}/`);
    } else if (!f.evidence.startsWith(`${dir}/`) || f.evidence.includes("/../")) {
      problems.push(`flow "${f.name}": evidence ${f.evidence} is not in the flow's directory ${dir}/`);
    }
    if (!files.has(f.evidence)) problems.push(`flow "${f.name}": evidence ${f.evidence} is not listed in files`);
    for (const extra of f.evidenceFiles ?? []) {
      if (extra === f.evidence) {
        problems.push(`flow "${f.name}": evidenceFiles repeats the evidence file; list only the other files`);
      } else if (!extra.startsWith(`${dir}/`) || extra.includes("/../")) {
        problems.push(`flow "${f.name}": evidence file ${extra} is not in the flow's directory ${dir}/`);
      } else if (!files.has(extra)) {
        problems.push(`flow "${f.name}": evidence file ${extra} is not listed in files`);
      }
    }
    const other = seen.get(f.evidence);
    if (other) problems.push(`flows "${other}" and "${f.name}" share one evidence file; each flow needs its own`);
    seen.set(f.evidence, f.name);
    if (f.claim === "broken" && f.outcome !== "broken") {
      problems.push(`flow "${f.name}": a broken claim stays broken`);
    } else if (f.claim !== undefined && f.claim !== "verified" && f.outcome === "verified") {
      problems.push(`flow "${f.name}": the checker may lower a claim, never raise it to verified`);
    }
  }
  return problems;
}

/** The role files of one flow as read from the box: their text, or undefined when the file is absent. */
export interface VerifyRoleFiles {
  claim?: string | undefined;
  verdict?: string | undefined;
}

function parseRoleFile<T>(schema: z.ZodType<T>, text: string): T | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "is not one JSON object";
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : `does not match its shape (${parsed.error.message.slice(0, 300)})`;
}

/**
 * Pure form of the role-file half of `verify-evidence`: the result repeats what the roles wrote. A claim with no
 * verdict means the checker never ran; a result outcome other than the verdict's means the checker was overruled.
 * Flows with neither file (a run that never reached the verifier) are judged by the result alone.
 */
export function verifyRoleFileProblems(flow: VerifyResult["flows"][number], files: VerifyRoleFiles): string[] {
  const problems: string[] = [];
  const paths = verifyFlowPaths(flow.name);
  if (files.claim !== undefined) {
    const claim = parseRoleFile(VerifyClaimFile, files.claim);
    if (typeof claim === "string") problems.push(`flow "${flow.name}": ${paths.claim} ${claim}`);
    else if (flow.claim !== claim.outcome) {
      problems.push(
        `flow "${flow.name}": claim is ${flow.claim ?? "missing"} but ${paths.claim} says ${claim.outcome}; the result repeats the verifier's claim`,
      );
    }
    if (files.verdict === undefined) {
      problems.push(
        `flow "${flow.name}": ${paths.claim} has no ${paths.verdict}; run the checker role and write its verdict`,
      );
    }
  }
  if (files.verdict !== undefined) {
    const verdict = parseRoleFile(VerifyVerdictFile, files.verdict);
    if (typeof verdict === "string") problems.push(`flow "${flow.name}": ${paths.verdict} ${verdict}`);
    else if (verdict.outcome !== flow.outcome) {
      problems.push(
        `flow "${flow.name}": outcome is ${flow.outcome} but ${paths.verdict} says ${verdict.outcome}; the result repeats the checker's verdict`,
      );
    }
  }
  return problems;
}

/** Prints the file and exits 0, or exits 3 when it is absent, so "absent" and "unreadable" stay apart. */
const readIfPresent = (p: string) => `if [ -f ${shellQuote(p)} ]; then cat ${shellQuote(p)}; else exit 3; fi`;

async function readRoleFile(ctx: DoneContext, p: string): Promise<string | undefined> {
  const r = await ctx.sandbox.exec(readIfPresent(p));
  if (r.exitCode === 3) return undefined;
  if (r.exitCode !== 0) throw new Error(`reading ${p} exited ${r.exitCode}: ${r.stderrTail.slice(-500)}`);
  return r.stdoutTail;
}

export const verifyEvidenceCheck: DoneCheck<unknown, VerifyResult> = {
  id: "verify-evidence",
  async assert(r, ctx) {
    const problems = verifyResultProblems(r);
    for (const f of r.flows) {
      const exists = await ctx.sandbox.exec(`test -s ${shellQuote(f.evidence)}`);
      if (exists.exitCode !== 0) problems.push(`flow "${f.name}": evidence file ${f.evidence} is missing or empty`);
      if (f.evidenceFiles && f.evidenceFiles.length > 0) {
        const missing = await ctx.sandbox.exec(
          `for p in ${f.evidenceFiles.map(shellQuote).join(" ")}; do [ -e "$p" ] || printf '%s\\n' "$p"; done`,
        );
        for (const p of missing.stdoutTail.split("\n").filter(Boolean)) {
          problems.push(`flow "${f.name}": evidence file ${p} does not exist`);
        }
      }
      const paths = verifyFlowPaths(f.name);
      const files = { claim: await readRoleFile(ctx, paths.claim), verdict: await readRoleFile(ctx, paths.verdict) };
      problems.push(...verifyRoleFileProblems(f, files));
    }
    return problems.length === 0 ? true : `${problems.join("; ")}.`;
  },
};
