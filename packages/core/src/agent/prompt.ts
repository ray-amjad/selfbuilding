import type { JsonSchema } from "../types/common.js";
import type { RuntimeDoneCheck } from "../types/runtime.js";
import { SANDBOX_PATHS } from "../types/runtime.js";

// Prompt assembly (spec §2.3). File templates are processed; programmatic strings (input values, inline prompts)
// are literal and never expanded.

export const PREAMBLE_VERSION = 1;

export interface WorkspaceView {
  repo?: string;
  baseBranch?: string;
  baseSha?: string;
  branch?: string;
  readOnly: boolean;
  pr?: { number: number; url: string };
}

export interface PreambleInput {
  resultSchema: JsonSchema;
  doneChecks: RuntimeDoneCheck[];
  protectedPaths: string[];
  branchRequirement: "required" | "optional" | "forbidden";
  testCommand?: string;
  submitTool: string;
  askTool: string;
  harnessNotes: string[];
}

/** The system prompt every agent turn starts with (spec §2.3.2, preamble v1). */
export function buildPreamble(p: PreambleInput): string {
  const lines = [
    `# Selfbuilding preamble v${PREAMBLE_VERSION}`,
    "",
    `You are running unattended inside a disposable sandbox. The repository is at ${SANDBOX_PATHS.workdir}.`,
    `Finish by calling \`${p.submitTool}\` exactly once with your result. Its input schema is below.`,
    `\`${p.submitTool}\` is the only way to return a result; files you write are never read as a result.`,
    "If the tool rejects your submission, fix the issues it lists and call it again.",
    "",
    "## Result schema",
    "```json",
    JSON.stringify(p.resultSchema, null, 2),
    "```",
    "",
    "## Definition of done",
  ];
  if (p.doneChecks.length === 0) lines.push("- No commands are run after you submit beyond the built-in checks.");
  for (const check of p.doneChecks) {
    lines.push(`- \`${check.cmd}\` must exit ${check.expectExit ?? 0} (check \`${check.id}\`).`);
  }
  if (p.testCommand === undefined) {
    lines.push("- No test command is declared: any `tests` claim in your result is recorded as unverified.");
  }
  if (p.branchRequirement === "required") {
    lines.push("- Commit your work on the current branch. At least one commit ahead of the base is required.");
  } else if (p.branchRequirement === "forbidden") {
    lines.push("- This task is read-only: make no commits and leave the working tree clean.");
  } else {
    lines.push("- Commit as you go; uncommitted changes are committed for you when the turn ends.");
  }
  lines.push("- Do not push and do not open pull requests; the host does that after you finish.");
  if (p.protectedPaths.length > 0) {
    lines.push(
      `- These paths are restored from the base commit while checks run, so editing them does not change the checks: ${p.protectedPaths.join(", ")}.`,
    );
  }
  lines.push(
    "",
    "## Asking a human",
    `Use \`${p.askTool}\` when you are blocked on a decision only a human can make. Do not use any other question tool.`,
    "A human may not answer quickly; when the question is not essential, pick the safe option and say so in your result.",
  );
  if (p.harnessNotes.length > 0) lines.push("", "## Notes", ...p.harnessNotes.map((n) => `- ${n}`));
  return `${lines.join("\n")}\n`;
}

export interface SubstitutionContext {
  skillName: string;
  sessionId?: string;
  input: unknown;
  /** Names declared in frontmatter `arguments`. */
  argumentNames: string[];
}

/** One pass over the SKILL.md body (spec §2.3.3). Inserted values are never scanned again. */
export function substituteBody(body: string, s: SubstitutionContext): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const input = (s.input ?? {}) as Record<string, unknown>;
  const args = typeof input.args === "string" ? input.args : undefined;
  const tokens = args?.split(/\s+/).filter(Boolean) ?? [];
  const asString = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  const pattern =
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)\b|\$([a-z][a-zA-Z0-9_]*)\b/g;
  const text = body.replace(pattern, (match, braced?: string, argIndex?: string, digit?: string, named?: string) => {
    if (braced !== undefined) {
      switch (braced) {
        case "CLAUDE_SKILL_DIR":
        case "SELFBUILDING_SKILL_DIR":
          return `${SANDBOX_PATHS.skills}/${s.skillName}`;
        case "CLAUDE_PROJECT_DIR":
        case "SELFBUILDING_WORKDIR":
          return SANDBOX_PATHS.workdir;
        case "CLAUDE_SESSION_ID":
          return s.sessionId ?? match;
        default:
          warnings.push(`unknown token ${match} left as is`);
          return match;
      }
    }
    if (argIndex !== undefined) return tokens[Number(argIndex)] ?? "";
    if (digit !== undefined) return tokens[Number(digit)] ?? "";
    if (named !== undefined) {
      return s.argumentNames.includes(named) ? asString(input[named]) : match;
    }
    return args ?? JSON.stringify(s.input ?? null);
  });
  return { text, warnings };
}

/** The user message: skill body, workspace, input as JSON (spec §2.3.2). */
export function buildUserPrompt(o: { title: string; body: string; workspace: WorkspaceView; input: unknown }): string {
  const ws: string[] = [];
  if (o.workspace.repo) ws.push(`- Repository: ${o.workspace.repo}`);
  if (o.workspace.baseBranch)
    ws.push(`- Base branch: ${o.workspace.baseBranch}${o.workspace.baseSha ? ` (${o.workspace.baseSha})` : ""}`);
  if (o.workspace.branch)
    ws.push(`- Working branch: ${o.workspace.branch}${o.workspace.readOnly ? " (read-only)" : ""}`);
  if (o.workspace.pr) ws.push(`- Pull request: #${o.workspace.pr.number} ${o.workspace.pr.url}`);
  if (ws.length === 0) ws.push("- No repository is attached to this call.");
  return [
    `# ${o.title}`,
    "",
    o.body.trim(),
    "",
    "# Workspace",
    "",
    ...ws,
    "",
    "# Input",
    "",
    "```json",
    JSON.stringify(o.input ?? null, null, 2),
    "```",
    "",
  ].join("\n");
}

/** The fixed message for a resumed interrupted turn (spec §6.8). */
export function interruptedMessage(at: string): string {
  return `Your previous turn was interrupted at ${at}. Inspect \`git status\`, \`git log\` and the state of any external actions before continuing. Do not repeat actions that already took effect. Call submit_result when done.`;
}

/** Feedback for a result the host parse rejected (spec §2.6.4). */
export function invalidResultMessage(issues: string[]): string {
  return `Your submitted result failed validation on the host:\n${issues.map((i) => `- ${i}`).join("\n")}\nFix these and call submit_result again.`;
}

/** Feedback for a failed host-side done check (spec §2.7.2). */
export function doneCheckMessage(id: string, output: string): string {
  return `Done check \`${id}\` failed: ${output.slice(-4096)}\nFix the problem and call submit_result again.`;
}
