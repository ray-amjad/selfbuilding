import { ConfigError, type Effort, type Invocation, type InvokeContext } from "@selfbuilding/core";
import { mcpOverrides, normaliseServers, tomlString } from "./mcp.js";

// Codex invocation per spec §4.4. Checked against `codex exec --help`, `codex exec resume --help` and
// `codex exec fork --help` for codex-cli 0.164.0. Two findings shape it:
// - `exec resume` and `exec fork` reject `-s/--sandbox`, so the sandbox mode goes in as `-c sandbox_mode=...`,
//   which every form accepts.
// - `resume`/`fork` are subcommands: they must come straight after `exec`, or they parse as the prompt.

export type CodexMode = "fresh" | "resume" | "fork";

/** Spec effort → `model_reasoning_effort`. There is no `xhigh` in Selfbuilding; Codex's level above `high` is `max`'s. */
export const CODEX_EFFORT: Record<Effort, string> = { low: "low", medium: "medium", high: "high", max: "xhigh" };

// Session ids come from `thread.started`; the host's resume template uses the literal "{sessionId}".
const SESSION_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|\{sessionId\})$/;

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) {
    throw new ConfigError(`${JSON.stringify(id)} is not a Codex session id. Pass the thread_id from thread.started.`);
  }
}

// Prepends the system text to the prompt on stdin: Codex has no verified system-prompt flag (spec §4.6). The
// script is fixed and every path travels as an argument, so nothing user-controlled is interpolated.
export const PREPEND_SYSTEM_SCRIPT = [
  "system=$1; shift",
  '[ -r "$system" ] || { echo "selfbuilding: system prompt file $system is missing" >&2; exit 66; }',
  '{ cat -- "$system"; printf "\\n\\n"; cat; } | exec "$@"',
].join("; ");

export interface CodexInvocationOptions {
  binary: string;
  model?: string;
  effort?: Effort;
}

/** The options shared by every form, in the order `codex exec` documents them. */
export function codexOptions(ctx: InvokeContext, opts: CodexInvocationOptions): string[] {
  const model = ctx.model ?? opts.model;
  const effort = ctx.effort ?? opts.effort;
  const servers = normaliseServers(ctx.mcpServers, ctx.paths);
  return [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    ...(model ? ["-m", model] : []),
    ...(effort ? ["-c", `model_reasoning_effort=${tomlString(CODEX_EFFORT[effort])}`] : []),
    // Codex's own sandbox cannot start inside container sandboxes; the box is the boundary (spec §4.4).
    "-c",
    `sandbox_mode=${tomlString("danger-full-access")}`,
    "-c",
    `approval_policy=${tomlString("never")}`,
    // auth.json is the one credential path; never a keyring, which a sandbox does not have.
    "-c",
    `cli_auth_credentials_store=${tomlString("file")}`,
    "-c",
    "check_for_update_on_startup=false",
    ...mcpOverrides(servers, ctx.paths, ctx.hotWaitMs),
  ];
}

export function codexInvocation(
  ctx: InvokeContext,
  opts: CodexInvocationOptions,
  mode: CodexMode,
  sessionId?: string,
): Invocation {
  if (!opts.binary.startsWith("/")) {
    throw new ConfigError(`The codex binary must be an absolute path, not ${JSON.stringify(opts.binary)}.`);
  }
  const head = ["exec"];
  if (mode !== "fresh") {
    if (sessionId === undefined) throw new ConfigError(`codex exec ${mode} needs a session id.`);
    assertSessionId(sessionId);
    head.push(mode, sessionId);
  }
  // The trailing "-" reads the prompt from stdin, which the runtime redirects from the prompt file.
  const codexArgv = [opts.binary, ...head, ...codexOptions(ctx, opts), "-"];
  // A follow-up turn continues a session that already holds the system text.
  const argv =
    mode === "fresh" && ctx.systemFile
      ? ["/bin/sh", "-c", PREPEND_SYSTEM_SCRIPT, "codex-prompt", ctx.systemFile, ...codexArgv]
      : codexArgv;
  return {
    argv,
    env: { HOME: ctx.paths.home, CODEX_HOME: `${ctx.paths.home}/.codex`, PWD: ctx.paths.workdir },
    cwd: ctx.paths.workdir,
    stdinFile: ctx.promptFile,
  };
}
