import type { Harness, HarnessEvent, McpServerSpec, ProviderSandbox, SandboxProvider } from "@selfbuilding/core";
import { canonicalPaths } from "./harness.js";

export interface HarnessTurnOptions {
  runId?: string;
  callPath?: string;
  attempt?: number;
  /** Written to `{in}/prompt.md` and fed on stdin. Default "Do the task." */
  prompt?: string;
  /** Default: none. The scripted harness then reaches tools over the socket transport only. */
  mcpServers?: McpServerSpec[];
  hotWaitMs?: number;
  /** Continue this session with `harness.resume()` instead of starting fresh. */
  resumeSessionId?: string;
  /** Preassigned session id for a fresh turn. */
  sessionId?: string;
  timeoutMs?: number;
}

export interface HarnessTurn {
  exitCode: number;
  /** Raw native stdout lines. */
  lines: string[];
  stderr: string;
  /** `lines` through the harness's own parser, plus what the exit implies. */
  events: HarnessEvent[];
  sessionId: string | undefined;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Plays one turn of a harness in a box without the runtime: writes the harness's prepared files and the prompt,
 * runs its invocation, and parses the stream. For harness and fixture tests; agent calls go through the runtime.
 */
export async function runHarnessTurn(
  box: ProviderSandbox,
  harness: Harness,
  opts: HarnessTurnOptions = {},
): Promise<HarnessTurn> {
  const paths = canonicalPaths();
  const call = {
    runId: opts.runId ?? "run-test",
    callPath: opts.callPath ?? "root/1/agent",
    attempt: opts.attempt ?? 1,
  };
  const plan = harness.prepare({
    ...call,
    paths,
    skills: [],
    mcpServers: opts.mcpServers ?? [],
    hotWaitMs: opts.hotWaitMs ?? 60_000,
  });
  const promptFile = `${paths.in}/prompt.md`;
  await box.writeFiles([
    ...plan.files.map((f) => ({ path: f.path, data: f.content, mode: f.mode })),
    { path: promptFile, data: opts.prompt ?? "Do the task." },
  ]);
  const ctx = { ...call, paths, promptFile, ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }) };
  let invocation = harness.invoke(ctx);
  if (opts.resumeSessionId !== undefined) {
    if (!harness.resume) throw new Error(`Harness ${harness.id} cannot resume a session.`);
    invocation = harness.resume({ ...ctx, sessionId: opts.resumeSessionId });
  }
  const lines: string[] = [];
  const command = `${invocation.argv.map(quote).join(" ")}${invocation.stdinFile ? ` < ${invocation.stdinFile}` : ""}`;
  const result = await box.exec(command, {
    cwd: invocation.cwd,
    env: invocation.env,
    timeoutMs: opts.timeoutMs ?? 60_000,
    onLine: (stream, line) => {
      if (stream === "stdout") lines.push(line);
    },
  });
  const parser = harness.createParser({ ...call });
  const events = lines.flatMap((line) => parser.line(line));
  const signal = result.exitCode > 128 ? signalName(result.exitCode - 128) : null;
  events.push(...parser.end({ code: signal ? null : result.exitCode, signal }));
  return { exitCode: result.exitCode, lines, stderr: result.stderrTail, events, sessionId: parser.sessionId() };
}

function signalName(n: number): string | null {
  return n === 2 ? "SIGINT" : n === 9 ? "SIGKILL" : n === 15 ? "SIGTERM" : null;
}

/** Opens a throwaway box for a harness turn test. */
export async function openTestBox(provider: SandboxProvider, scope = `turn-${Date.now()}`): Promise<ProviderSandbox> {
  const { handle } = await provider.openOrCreate(
    { runId: "run-test", scope, deployment: "test" },
    {
      image: { name: "selfbuilding-test", ref: "selfbuilding/test", version: "0" },
      env: {},
      lifetimeMs: 10 * 60 * 1000,
      onExpire: "pause",
      labels: {},
    },
  );
  return handle;
}
