import { ConfigError, HarnessStartError, SandboxUnavailableError } from "../errors/classes.js";
import type { CancelSentinel, InboxAnswer, LaunchProbe, Outcome, RuntimeSpec, WaitResponse } from "../types/runtime.js";
import { ATTEMPT_FILES, RUNTIME_ENV, RUNTIME_EXIT, SANDBOX_PATHS } from "../types/runtime.js";
import type { ExecResult, ProviderSandbox, SandboxProvider } from "../types/sandbox.js";
import { sha256Hex } from "./hash.js";

// The host side of the runtime contract (spec §6, docs/BUILD-MAP.md §3). The host talks to the in-sandbox runtime
// only through these verbs and files, always over the provider's exec channel.

export interface RuntimeBundles {
  runtime: string | Uint8Array;
  mcp: string | Uint8Array;
  /** The process-tree reaper, for /selfbuilding/bin/ns-reap. Without it the runtime only warns about containment. */
  nsReap?: string | Uint8Array;
}

let configuredBundles: RuntimeBundles | (() => Promise<RuntimeBundles>) | undefined;

/** Sets where the runtime bundles come from. Tests pass a fake runtime; hosts pass the built bundles. */
export function setRuntimeBundles(bundles: RuntimeBundles | (() => Promise<RuntimeBundles>) | undefined): void {
  configuredBundles = bundles;
}

/**
 * The runtime bundles: the configured ones, else the files `@selfbuilding/runtime` ships, found next to core or in
 * the project the process runs from.
 */
export async function resolveRuntimeBundles(): Promise<RuntimeBundles> {
  if (typeof configuredBundles === "function") return configuredBundles();
  if (configuredBundles) return configuredBundles;
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const locate = [
    () => fileURLToPath(import.meta.resolve("@selfbuilding/runtime/package.json")),
    () => createRequire(path.join(process.cwd(), "package.json")).resolve("@selfbuilding/runtime/package.json"),
  ];
  let lastError: unknown;
  for (const find of locate) {
    try {
      const dir = path.dirname(find());
      return {
        runtime: await readFile(path.join(dir, "dist/selfbuilding-runtime.mjs")),
        mcp: await readFile(path.join(dir, "dist/selfbuilding-mcp.mjs")),
        nsReap: await readFile(path.join(dir, "dist/ns-reap.mjs")),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new ConfigError(
    "The selfbuilding runtime bundles were not found. Add @selfbuilding/runtime to the project (and build it), or register them with setRuntimeBundles().",
    { cause: lastError },
  );
}

export function attemptDir(stepKey: string, attempt: number): string {
  return `${SANDBOX_PATHS.calls}/${stepKey}/${attempt}`;
}

export function launchMarker(launchId: string, suffix: "launched" | "collected" | "status"): string {
  return `${SANDBOX_PATHS.launches}/${launchId}.${suffix}`;
}

/** Single-quotes a value for /bin/sh. Only host-built identifiers and paths go through here, never prompts. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Env for runtime execs: never secrets. */
export function runtimeExecEnv(provider: SandboxProvider | undefined, runId: string): Record<string, string> {
  const env: Record<string, string> = { [RUNTIME_ENV.runId]: runId };
  if (provider?.fsRoot) env[RUNTIME_ENV.fsRoot] = provider.fsRoot;
  return env;
}

/**
 * Uploads the runtime bundles unless `/selfbuilding/runtime-version` already holds the runtime's SHA-256, the
 * stamp the runtime checks at boot (spec §6.4). The stamp goes last, so a partial upload never looks complete.
 */
export async function ensureRuntime(box: ProviderSandbox, bundles: RuntimeBundles): Promise<string> {
  const version = sha256Hex(Buffer.from(bundles.runtime as string | Uint8Array));
  let current = "";
  try {
    current = new TextDecoder().decode(await box.readFile(SANDBOX_PATHS.runtimeVersion)).trim();
  } catch (error) {
    if ((error as { code?: string }).code !== "sandbox_file_not_found") throw error;
  }
  if (current === version) return version;
  await box.writeFiles([
    { path: SANDBOX_PATHS.runtimeBundle, data: bundles.runtime, mode: 0o755, owner: "root" },
    { path: SANDBOX_PATHS.mcpBundle, data: bundles.mcp, mode: 0o755, owner: "root" },
    ...(bundles.nsReap
      ? [{ path: SANDBOX_PATHS.nsReap, data: bundles.nsReap, mode: 0o755, owner: "root" as const }]
      : []),
  ]);
  await box.writeFiles([{ path: SANDBOX_PATHS.runtimeVersion, data: `${version}\n`, mode: 0o644, owner: "root" }]);
  return version;
}

export interface VerbContext {
  box: ProviderSandbox;
  provider?: SandboxProvider;
  runId: string;
}

function verbCommand(verb: string, args: Record<string, string | number>): string {
  const parts = ["node", SANDBOX_PATHS.runtimeBundle, verb];
  for (const [key, value] of Object.entries(args)) parts.push(`--${key}`, shq(String(value)));
  return parts.join(" ");
}

function parseVerbOutput<T>(verb: string, result: ExecResult, ctx: VerbContext): T {
  if (result.exitCode === RUNTIME_EXIT.ok) {
    const line = result.stdoutTail.trim().split("\n").filter(Boolean).at(-1) ?? "";
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new HarnessStartError(`selfbuilding-runtime ${verb} printed no JSON: ${result.stdoutTail.slice(-400)}`);
    }
  }
  const detail = (result.stderrTail || result.stdoutTail).trim().slice(-2000);
  if (result.exitCode === RUNTIME_EXIT.transient || result.exitCode === RUNTIME_EXIT.generationMismatch) {
    throw new SandboxUnavailableError(
      { provider: ctx.box.ref.provider, sandboxId: ctx.box.ref.id },
      { message: `selfbuilding-runtime ${verb} exited ${result.exitCode}: ${detail}` },
    );
  }
  throw new HarnessStartError(`selfbuilding-runtime ${verb} exited ${result.exitCode}: ${detail}`);
}

export async function runVerb<T>(
  ctx: VerbContext,
  verb: string,
  args: Record<string, string | number>,
  opts: { timeoutMs?: number; stdin?: string; idempotent?: boolean } = {},
): Promise<T> {
  const result = await ctx.box.exec(verbCommand(verb, args), {
    user: "root",
    env: runtimeExecEnv(ctx.provider, ctx.runId),
    timeoutMs: opts.timeoutMs ?? 60_000,
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    ...(opts.idempotent === undefined ? {} : { idempotent: opts.idempotent }),
  });
  return parseVerbOutput<T>(verb, result, ctx);
}

/** Idempotent probe-and-mark (BUILD-MAP §3.9). Starts nothing. */
export function launchProbe(
  ctx: VerbContext,
  stepKey: string,
  attempt: number,
  launchId: string,
): Promise<LaunchProbe> {
  return runVerb<LaunchProbe>(ctx, "launch", { call: stepKey, attempt, launch: launchId }, { idempotent: true });
}

/** Starts the supervisor detached. Never retried: an ambiguous start is resolved by probing the marker. */
export async function startSupervisor(ctx: VerbContext, stepKey: string, attempt: number, launchId: string) {
  return ctx.box.spawn(verbCommand("supervise", { call: stepKey, attempt, launch: launchId }), {
    user: "root",
    env: runtimeExecEnv(ctx.provider, ctx.runId),
  });
}

export function waitVerb(ctx: VerbContext, stepKey: string, attempt: number, after: number, maxMs: number) {
  return runVerb<WaitResponse>(
    ctx,
    "wait",
    { call: stepKey, attempt, after, max: `${Math.max(0, Math.round(maxMs / 1000))}s` },
    { timeoutMs: maxMs + 30_000, idempotent: true },
  );
}

export function ackVerb(ctx: VerbContext, stepKey: string, attempt: number) {
  return runVerb<{ acked: boolean }>(ctx, "ack", { call: stepKey, attempt }, { idempotent: true });
}

export function quiesceVerb(ctx: VerbContext, timeoutMs = 10_000) {
  return runVerb<{ quiescent: boolean; reason?: string }>(
    ctx,
    "quiesce",
    { timeout: `${Math.ceil(timeoutMs / 1000)}s` },
    { timeoutMs: timeoutMs + 30_000 },
  );
}

export function answerVerb(ctx: VerbContext, stepKey: string, attempt: number, answer: InboxAnswer) {
  return runVerb<{ written: boolean }>(
    ctx,
    "answer",
    { call: stepKey, attempt, ask: answer.askId },
    { stdin: JSON.stringify(answer), idempotent: true },
  );
}

/**
 * Stages spec.json, the prompt files and the result schema at `<attempt>.tmp/` and moves them into place in one
 * exec (spec §6.4 "Spec handoff"). Prompts travel as files, never through a shell string.
 */
export async function stageAttempt(
  box: ProviderSandbox,
  spec: RuntimeSpec,
  inFiles: Record<string, string>,
): Promise<void> {
  const dir = attemptDir(spec.stepKey, spec.attempt);
  const tmp = `${dir}.tmp`;
  await box.writeFiles([
    // Root-only: spec.json may carry the launch's callbackToken, which must never be readable by the agent.
    { path: `${tmp}/${ATTEMPT_FILES.spec}`, data: JSON.stringify(spec, null, 2), mode: 0o600, owner: "root" },
    {
      path: `${tmp}/result.schema.json`,
      data: JSON.stringify(spec.resultSchema, null, 2),
      mode: 0o644,
      owner: "root",
    },
    ...Object.entries(inFiles).map(([name, data]) => ({
      path: `${tmp}/in/${name}`,
      data,
      mode: 0o644,
      owner: "root" as const,
    })),
  ]);
  const contractDir = SANDBOX_PATHS.contract.slice(0, SANDBOX_PATHS.contract.lastIndexOf("/"));
  const script = [
    "set -e",
    `mkdir -p ${shq(dir)}`,
    `if [ ! -e ${shq(`${dir}/${ATTEMPT_FILES.spec}`)} ]; then mv ${shq(`${tmp}/${ATTEMPT_FILES.spec}`)} ${shq(`${dir}/${ATTEMPT_FILES.spec}`)}; fi`,
    `rm -rf ${shq(SANDBOX_PATHS.in)}`,
    `mv ${shq(`${tmp}/in`)} ${shq(SANDBOX_PATHS.in)}`,
    `mkdir -p ${shq(contractDir)}`,
    `mv -f ${shq(`${tmp}/result.schema.json`)} ${shq(SANDBOX_PATHS.contract)}`,
    `rm -rf ${shq(tmp)}`,
  ].join("\n");
  const result = await box.exec(script, { user: "root", timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new HarnessStartError(`Staging the call files failed: ${result.stderrTail.trim().slice(-400)}`);
  }
}

/** Writes the durable cancel sentinel (spec §6.10). */
export async function writeCancel(box: ProviderSandbox, stepKey: string, attempt: number, reason: string) {
  const sentinel: CancelSentinel = { reason, at: new Date().toISOString() };
  await box.writeFiles([
    {
      path: `${attemptDir(stepKey, attempt)}/${ATTEMPT_FILES.cancel}`,
      data: JSON.stringify(sentinel),
      mode: 0o644,
      owner: "root",
    },
  ]);
}

/** BUSY is checked first, so garbled output resolves to BUSY; an exec failure is UNKNOWN (spec §6.14). */
export async function probeTurnLock(box: ProviderSandbox): Promise<"FREE" | "BUSY" | "UNKNOWN"> {
  try {
    const r = await box.exec(
      `mkdir -p ${shq(SANDBOX_PATHS.run)}; if flock -n ${shq(SANDBOX_PATHS.callLock)} true; then echo FREE; else echo BUSY; fi`,
      { user: "root", timeoutMs: 20_000, idempotent: true },
    );
    const out = r.stdoutTail.trim();
    if (out.includes("BUSY")) return "BUSY";
    if (out === "FREE") return "FREE";
    return out ? "BUSY" : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

export async function readText(box: ProviderSandbox, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await box.readFile(path));
  } catch (error) {
    if ((error as { code?: string }).code === "sandbox_file_not_found") return null;
    throw error;
  }
}

export async function readOutcome(box: ProviderSandbox, stepKey: string, attempt: number): Promise<Outcome | null> {
  const text = await readText(box, `${attemptDir(stepKey, attempt)}/${ATTEMPT_FILES.outcome}`);
  return text === null ? null : (JSON.parse(text) as Outcome);
}
