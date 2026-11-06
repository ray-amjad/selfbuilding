import { declaredArguments } from "./frontmatter.js";
import { PREAMBLE_VERSION } from "./hash.js";
import type { SkillDef } from "./types.js";

/** Where a skill is materialised inside the sandbox (spec §2.3.1). */
export const SANDBOX_SKILLS_DIR = "/selfbuilding/skills";
export const SANDBOX_WORKDIR = "/selfbuilding/work";

export interface SubstitutionContext {
  skillName: string;
  /** Default /selfbuilding/work. */
  workdir?: string;
  /** Default /selfbuilding/skills. */
  skillsDir?: string;
  sessionId?: string;
  /** The validated call input. */
  input?: unknown;
  /** Names declared in frontmatter `arguments`. */
  declaredArgs?: readonly string[];
}

const TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)\b|\$([A-Za-z_][A-Za-z0-9_]*)/g;

const stringify = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * One pass over the SKILL.md body (spec §2.3.3). Values inserted here are never scanned again, and input
 * values are inserted only where the body asks for them; they are never expanded or run.
 */
export function substitute(body: string, ctx: SubstitutionContext): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const workdir = ctx.workdir ?? SANDBOX_WORKDIR;
  const skillDir = `${ctx.skillsDir ?? SANDBOX_SKILLS_DIR}/${ctx.skillName}`;
  const input = ctx.input;
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const args = typeof record?.args === "string" ? record.args : undefined;
  const tokens = args?.trim() ? args.trim().split(/\s+/) : [];
  const declared = new Set(ctx.declaredArgs ?? []);

  const text = body.replace(TOKEN, (whole, braced?: string, argIndex?: string, dollarIndex?: string, bare?: string) => {
    if (braced !== undefined) {
      switch (braced) {
        case "CLAUDE_SKILL_DIR":
        case "SELFBUILDING_SKILL_DIR":
          return skillDir;
        case "CLAUDE_PROJECT_DIR":
        case "SELFBUILDING_WORKDIR":
          return workdir;
        case "CLAUDE_SESSION_ID":
          if (ctx.sessionId !== undefined) return ctx.sessionId;
          warnings.push("CLAUDE_SESSION_ID is used but no session id is known yet; the token is left as is");
          return whole;
        default:
          warnings.push(`unknown token ${whole} left as is`);
          return whole;
      }
    }
    const index = argIndex ?? dollarIndex;
    if (index !== undefined) return tokens[Number(index)] ?? "";
    if (whole === "$ARGUMENTS") return args ?? (input === undefined ? "" : JSON.stringify(input));
    if (bare !== undefined && declared.has(bare)) {
      const value = record?.[bare];
      return value === undefined ? "" : stringify(value);
    }
    return whole;
  });
  return { text, warnings };
}

export interface ContextExpression {
  /** The full `` !`cmd` `` text as it appears in the body. */
  raw: string;
  /** The command, with the skill-dir and workdir tokens filled in (never input values). */
  cmd: string;
  index: number;
}

const EXPRESSION = /!`([^`\n]+)`/g;
const COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Finds the inline `` !`cmd` `` expressions the runtime runs before the turn (spec §2.3.4). It scans only the
 * original file text, so an expression that arrives through an input value is never found. Expressions inside
 * HTML comments are inert.
 */
export function findContextExpressions(body: string, ctx: Omit<SubstitutionContext, "input">): ContextExpression[] {
  const inert: [number, number][] = [];
  for (const m of body.matchAll(COMMENT)) inert.push([m.index, m.index + m[0].length]);
  const out: ContextExpression[] = [];
  for (const m of body.matchAll(EXPRESSION)) {
    if (inert.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const cmd = substitute(m[1] ?? "", { ...ctx, declaredArgs: [] }).text;
    out.push({ raw: m[0], cmd, index: m.index });
  }
  return out;
}

/** Replaces each expression with its command's output, by position, so equal expressions stay independent. */
export function applyContextOutputs(
  body: string,
  expressions: readonly ContextExpression[],
  outputs: readonly string[],
): string {
  if (outputs.length !== expressions.length) {
    throw new Error(`expected ${expressions.length} context outputs, got ${outputs.length}`);
  }
  let text = "";
  let cursor = 0;
  expressions.forEach((e, i) => {
    text += body.slice(cursor, e.index) + (outputs[i] ?? "").replace(/\n+$/, "");
    cursor = e.index + e.raw.length;
  });
  return text + body.slice(cursor);
}

/** Expansion first, then substitution, as spec §2.3.4 orders them. */
export function processBody(
  skill: Pick<SkillDef, "name" | "body" | "frontmatter">,
  ctx: Omit<SubstitutionContext, "skillName" | "declaredArgs"> & { contextOutputs?: readonly string[] },
): { text: string; warnings: string[] } {
  const base = { ...ctx, skillName: skill.name };
  const expressions = findContextExpressions(skill.body, base);
  const expanded =
    expressions.length > 0 && ctx.contextOutputs
      ? applyContextOutputs(skill.body, expressions, ctx.contextOutputs)
      : skill.body;
  return substitute(expanded, { ...base, declaredArgs: declaredArguments(skill.frontmatter) });
}

export interface PreambleOptions {
  workdir?: string;
  /** Draft-07 result schema. */
  resultSchema: unknown;
  /** The commands the done checks will run, by id. */
  doneCommands?: readonly { id: string; cmd: string }[];
  /** Other checks, described in words. */
  doneNotes?: readonly string[];
  /** Branch and PR expectations (spec §2.4). */
  artifacts?: { branch?: "required" | "optional" | "forbidden"; pr?: "required" | "optional" | "forbidden" };
  /** Paths restored from the base commit while checks run (spec §2.7.4). */
  protectedPaths?: readonly string[];
  /** How unanswered questions resolve (spec §8). */
  ask?: { available: boolean; afkPolicy?: string };
  /** Harness-specific notes, e.g. that subagents are unavailable. */
  harnessNotes?: readonly string[];
  /** Whether `tests` claims will be checked against a declared command. */
  testCommandDeclared?: boolean;
}

/** The system part of the prompt (spec §2.3.2). Its version is part of every skill hash. */
export function renderPreamble(o: PreambleOptions): string {
  const workdir = o.workdir ?? SANDBOX_WORKDIR;
  const lines: string[] = [
    `<!-- ${PREAMBLE_VERSION} -->`,
    `You are running unattended inside a disposable sandbox. The repository is checked out at ${workdir}.`,
    "Finish by calling the submit_result tool exactly once, with arguments that match the result schema below.",
    "submit_result is the only way to return a result. Files you write are never read as a result.",
    "If submit_result reports problems, fix the arguments and call it again. Do not redo the work.",
    "",
    "## Result schema (JSON Schema)",
    "```json",
    JSON.stringify(o.resultSchema, null, 2),
    "```",
    "",
    "## Definition of done",
  ];
  const done = o.doneCommands ?? [];
  if (done.length === 0 && (o.doneNotes ?? []).length === 0) lines.push("- No commands are run after you submit.");
  for (const c of done) lines.push(`- Check \`${c.id}\` runs \`${c.cmd}\` and must exit 0.`);
  for (const n of o.doneNotes ?? []) lines.push(`- ${n}`);
  if (o.artifacts?.branch === "required")
    lines.push("- Commit your work: at least one commit ahead of the base branch.");
  if (o.artifacts?.branch === "forbidden") {
    lines.push("- This is a read-only task: make no commits and leave the working tree clean.");
  }
  if (!o.testCommandDeclared) {
    lines.push("- No test command is declared, so a `tests` claim in your result is recorded as unverified.");
  }
  if ((o.protectedPaths ?? []).length > 0) {
    lines.push(
      `- These paths are restored from the base commit while checks run, so edits to them do not change the outcome: ${o.protectedPaths?.join(", ")}`,
    );
  }
  lines.push(
    "- Checks run only when your result reports success. A failed check resumes this session with its output.",
  );
  lines.push("");
  lines.push("## Asking a human");
  if (o.ask?.available === false) {
    lines.push("No human is reachable during this run. Decide, record the decision, and keep going.");
  } else {
    lines.push(
      "Use the ask_human tool only when a decision blocks the work and cannot be reversed later. Never use AskUserQuestion.",
    );
    if (o.ask?.afkPolicy) lines.push(`If nobody answers: ${o.ask.afkPolicy}`);
  }
  if ((o.harnessNotes ?? []).length > 0) {
    lines.push("", "## Harness notes");
    for (const n of o.harnessNotes ?? []) lines.push(`- ${n}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface WorkspaceFacts {
  repo?: string;
  baseBranch?: string;
  baseSha?: string;
  branch?: string;
  pr?: { number: number; url: string };
}

/** The user message (spec §2.3.2): the processed body, the workspace rendered from call options, then the input. */
export function renderUserPrompt(o: {
  skillName: string;
  body: string;
  workspace?: WorkspaceFacts;
  input: unknown;
}): string {
  const ws = o.workspace ?? {};
  const facts: string[] = [];
  if (ws.repo) facts.push(`- Repository: ${ws.repo}`);
  if (ws.baseBranch) facts.push(`- Base branch: ${ws.baseBranch}${ws.baseSha ? ` (${ws.baseSha})` : ""}`);
  if (ws.branch) facts.push(`- Working branch: ${ws.branch}`);
  if (ws.pr) facts.push(`- Pull request: #${ws.pr.number} ${ws.pr.url}`);
  if (facts.length === 0) facts.push("- No repository facts were given for this call.");
  return [
    `# Skill: ${o.skillName}`,
    "",
    o.body.trim(),
    "",
    "# Workspace",
    ...facts,
    "",
    "# Input",
    "```json",
    JSON.stringify(o.input ?? {}, null, 2),
    "```",
    "",
  ].join("\n");
}
