import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AuthPlan,
  type FailureSignal,
  type FilePlan,
  type Harness,
  type HarnessCapabilities,
  type HarnessFailure,
  type HarnessParser,
  type Invocation,
  type InvokeContext,
  type ParseContext,
  type PathsContext,
  type PrepareContext,
  RUNTIME_ENV,
  SANDBOX_PATHS,
} from "@selfbuilding/core";
import { classifyMessage, claudeStreamParser, codexStreamParser } from "./parser.js";
import type { ScriptStep } from "./steps.js";

/** The version the scripted harness reports from `--version`. */
export const SCRIPTED_HARNESS_VERSION = "1.0.0";

/** Identifies one agent call, so one harness value can play a different script per call. */
export interface ScriptCall {
  runId: string;
  callPath: string;
  attempt: number;
}

/**
 * Where a script comes from: one turn's steps, or a function of the call returning one turn's steps or every turn's.
 * The function runs on the host when the call is prepared.
 */
export type ScriptSource = ScriptStep[] | ((call: ScriptCall) => ScriptStep[] | ScriptStep[][]);

export interface ScriptedHarnessOptions {
  /** The native stream format the player prints, so the real parsers are exercised. Default "claude-code". */
  format?: "claude-code" | "codex";
  /**
   * Follow-up turns: resumes, nudges, done-check feedback and ask answers each start the next one. Turn 1 is the
   * script itself. A turn with no script left says so and ends without a submit.
   */
  turns?: ScriptStep[][];
  /** How tool calls reach the supervisor: the `selfbuilding-mcp` stdio server (default) or the tool socket directly. */
  toolTransport?: "mcp" | "socket";
  /** Reported as the model. Default "scripted". */
  model?: string;
  /** Reported as the turn's cost (Claude format). Default 0. */
  costUsdPerTurn?: number;
  /** Swap in a real adapter's parser, e.g. `claudeCode().createParser`. Default: the kit's own small parser. */
  parser?: (ctx: ParseContext) => HarnessParser;
  /** false: no `resume()`, like a harness that cannot continue a session. Default true. */
  resumable?: boolean;
}

/** The script file the player reads, written by `prepare()`. */
interface ScriptFile {
  format: "claude-code" | "codex";
  home: string;
  turns: ScriptStep[][];
  mcpServers: PrepareContext["mcpServers"];
  toolTransport: "mcp" | "socket";
  toolSocket: string;
  model: string;
  costUsdPerTurn: number;
}

let playerSource: string | undefined;

/** The player script, as shipped into the sandbox. Exposed for tests that run it directly. */
export function scriptedPlayerSource(): string {
  if (playerSource !== undefined) return playerSource;
  // dist: copied next to the bundle; src (vitest): beside this file.
  for (const candidate of ["./scripted-player.mjs", "./player.mjs"]) {
    const file = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(file)) {
      playerSource = readFileSync(file, "utf8");
      return playerSource;
    }
  }
  throw new Error("scripted-player.mjs is missing from @selfbuilding/testing; rebuild the package.");
}

/** The per-call directory name under `{home}/.scripted/`. Stable for one call attempt, distinct across calls. */
export function scriptCallKey(call: ScriptCall): string {
  const slug = call.callPath.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
  const hash = createHash("sha256").update(`${call.runId}\0${call.callPath}`).digest("hex").slice(0, 8);
  return `${slug}-${hash}-a${call.attempt}`;
}

function resolveTurns(source: ScriptSource, call: ScriptCall, followUps: ScriptStep[][]): ScriptStep[][] {
  if (Array.isArray(source)) return [source, ...followUps];
  const produced = source(call);
  const isTurnList = produced.length > 0 && produced.every((turn) => Array.isArray(turn));
  return isTurnList ? (produced as ScriptStep[][]) : [produced as ScriptStep[], ...followUps];
}

/**
 * A Harness that replays a script instead of calling a model. `prepare()` writes a small node player and the script
 * into `{home}/.scripted/`; `invoke()` runs the player, which prints the chosen harness's native stream.
 */
export function scriptedHarness(script: ScriptSource, opts: ScriptedHarnessOptions = {}): Harness {
  const format = opts.format ?? "claude-code";
  const model = opts.model ?? "scripted";
  const followUps = opts.turns ?? [];
  const capabilities: HarnessCapabilities = {
    promptVia: "stdin",
    preassignSessionId: format === "claude-code",
    mcp: "native",
    stopAfterSubmit: format === "claude-code" ? "hook" : "kill",
    usage: format === "claude-code" ? "usd" : "tokens",
    nativeBudgetCap: false,
    effort: [],
    skillDirs: format === "claude-code" ? [".claude/skills"] : [".agents/skills"],
    subscriptionAuth: false,
    needsGlibc: false,
    streamFormat: format,
  };

  const invocation = (ctx: InvokeContext, mode: "fresh" | "resume", sessionId: string | undefined): Invocation => {
    const key = scriptCallKey(ctx);
    const player = `${ctx.paths.home}/.scripted/player.mjs`;
    // Under a test provider the box root prefixes every path. The runtime exports it; failing that, the physical
    // working directory reveals it.
    const launcher = [
      `p="\${${RUNTIME_ENV.fsRoot}:-}${player}"`,
      `if [ ! -f "$p" ]; then d=$(pwd -P); p="\${d%%${ctx.paths.workdir}*}${player}"; fi`,
      `exec node "$p" "$@"`,
    ].join("; ");
    return {
      argv: ["/bin/sh", "-c", launcher, "scripted-harness", key, mode, sessionId ?? ""],
      env: {},
      cwd: ctx.paths.workdir,
      stdinFile: ctx.promptFile,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  };

  const harness: Harness = {
    id: "scripted",
    stability: "experimental",
    capabilities,
    options: { model, version: SCRIPTED_HARNESS_VERSION },

    install(version) {
      return { version, commands: [], binary: "/bin/sh" };
    },
    installHosts: () => [],
    versionCommand: () => ({ argv: ["/bin/sh", "-c", `echo "scripted-harness ${SCRIPTED_HARNESS_VERSION}"`] }),
    parseVersion(stdout) {
      return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? SCRIPTED_HARNESS_VERSION;
    },

    auth(cred, ctx): AuthPlan {
      if (cred.kind === "auth-file") {
        const file = `${ctx.paths.home}/.scripted/auth.json`;
        return {
          env: {},
          files: [{ path: file, content: ctx.values.AUTH_FILE ?? "{}", mode: 0o600, secret: true }],
          stripEnv: [],
          leasedFile: { path: file },
        };
      }
      return { env: {}, files: [], stripEnv: [] };
    },

    prepare(ctx): FilePlan {
      const call: ScriptCall = { runId: ctx.runId, callPath: ctx.callPath, attempt: ctx.attempt };
      const file: ScriptFile = {
        format,
        home: ctx.paths.home,
        turns: resolveTurns(script, call, followUps),
        mcpServers: ctx.mcpServers,
        toolTransport: opts.toolTransport ?? "mcp",
        toolSocket: SANDBOX_PATHS.toolSocket,
        model: ctx.model ?? model,
        costUsdPerTurn: opts.costUsdPerTurn ?? 0,
      };
      const dir = `${ctx.paths.home}/.scripted`;
      return {
        files: [
          { path: `${dir}/player.mjs`, content: scriptedPlayerSource(), mode: 0o755 },
          { path: `${dir}/${scriptCallKey(call)}/script.json`, content: JSON.stringify(file, null, 2), mode: 0o644 },
        ],
        symlinks: [],
        gitExcludes: [],
        mcpToolTimeoutMs: ctx.hotWaitMs + 120_000,
      };
    },

    invoke: (ctx) => invocation(ctx, "fresh", ctx.sessionId),

    createParser(ctx) {
      if (opts.parser) return opts.parser(ctx);
      return format === "codex" ? codexStreamParser() : claudeStreamParser();
    },

    classify(signal: FailureSignal): HarnessFailure {
      if (signal.kind === "event") {
        const event = signal.event as { message?: unknown; result?: unknown; error?: { message?: unknown } };
        return classifyMessage(String(event.message ?? event.result ?? event.error?.message ?? "unknown error"));
      }
      return {
        code: "harness_crash",
        retryable: false,
        message: `scripted harness exited with ${signal.signal ? `signal ${signal.signal}` : `code ${signal.code}`}${signal.stderrTail ? `: ${signal.stderrTail.trim()}` : ""}`,
      };
    },

    toolName: (server, tool) => (format === "claude-code" ? `mcp__${server}__${tool}` : `${server}__${tool}`),
  };

  if (opts.resumable !== false) {
    harness.resume = (ctx) => invocation(ctx, "resume", ctx.sessionId);
  }
  return harness;
}

/** The canonical paths context, for calling a harness's pure methods in tests. */
export function canonicalPaths(attemptDir = `${SANDBOX_PATHS.calls}/call/1`): PathsContext {
  return {
    workdir: SANDBOX_PATHS.workdir,
    home: SANDBOX_PATHS.home,
    in: SANDBOX_PATHS.in,
    out: attemptDir,
    bin: SANDBOX_PATHS.bin,
    skills: SANDBOX_PATHS.skills,
    secrets: SANDBOX_PATHS.secrets,
    state: SANDBOX_PATHS.state,
    run: SANDBOX_PATHS.run,
  };
}
