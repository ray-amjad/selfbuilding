import fs from "node:fs";
import path from "node:path";
import {
  type InboxAnswer,
  type LaunchProbe,
  type Outcome,
  RUNTIME_EXIT,
  type RuntimeSpec,
  type RuntimeState,
  SANDBOX_PATHS,
  type WaitResponse,
} from "@selfbuilding/core";
import { readEventsAfter } from "./events.js";
import { exists, readJson, sleep, writeAtomic, writeExclusive } from "./fsutil.js";
import { probeTurnLock } from "./lock.js";
import { RuntimeLog } from "./log.js";
import { isSafeName, type Layout } from "./paths.js";
import { harnessTree, type SuperviseOptions, Supervisor } from "./supervisor.js";
import { groupAlive, signalGroup } from "./tree.js";

/** The runtime's command-line verbs (docs/BUILD-MAP.md §3). */
export const RUNTIME_VERBS = ["launch", "supervise", "wait", "ack", "quiesce", "answer"] as const;
export type RuntimeVerb = (typeof RUNTIME_VERBS)[number];

/** `wait` responses stay under 256 KiB (spec §6.6). */
export const MAX_WAIT_BYTES = 256 * 1024;
/** `wait --max` is capped at 25 s, under every provider gateway's call ceiling. */
export const MAX_WAIT_MS = 25_000;

export interface VerbResult {
  exitCode: number;
  /** Printed as exactly one JSON line on stdout. Absent for `supervise`. */
  output?: unknown;
}

export class UsageProblem {
  constructor(readonly message: string) {}
}

export interface ParsedArgs {
  verb: string | undefined;
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [verb, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      const value = rest[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        flags[arg.slice(2)] = value;
        i++;
      } else flags[arg.slice(2)] = "true";
    }
  }
  return { verb, flags };
}

/** "25s", "500ms", "2m", "1h" or plain milliseconds. */
export function parseDuration(value: string | undefined, fallbackMs: number): number {
  if (value === undefined) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) throw new UsageProblem(`invalid duration "${value}"`);
  const n = Number(match[1]);
  const unit = match[2] ?? "ms";
  return Math.round(n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000));
}

interface CallArgs {
  stepKey: string;
  attempt: number;
}

function callArgs(flags: Record<string, string>): CallArgs {
  const stepKey = flags.call;
  const attempt = Number(flags.attempt);
  if (!stepKey || !isSafeName(stepKey)) throw new UsageProblem("--call <stepKey> is required and must be a file name");
  if (!Number.isInteger(attempt) || attempt < 1) throw new UsageProblem("--attempt <n> must be a positive integer");
  return { stepKey, attempt };
}

function launchArg(flags: Record<string, string>): string {
  const launchId = flags.launch;
  if (!launchId || !isSafeName(launchId))
    throw new UsageProblem("--launch <launchId> is required and must be a file name");
  return launchId;
}

// ───────────────────────────── launch ─────────────────────────────

/** Idempotent probe-and-mark (spec §6.8). Starts nothing. */
export function launch(layout: Layout, flags: Record<string, string>): VerbResult {
  const { stepKey, attempt } = callArgs(flags);
  const launchId = launchArg(flags);
  const files = layout.attempt(stepKey, attempt);
  const spec = readJson<RuntimeSpec>(files.spec);
  if (!spec) throw new UsageProblem(`spec.json is missing for ${stepKey}/${attempt}; stage it before launch`);
  if (spec.launchId !== launchId) throw new UsageProblem(`spec.json is for launch ${spec.launchId}, not ${launchId}`);
  const outcome = readJson<Outcome>(files.outcome);
  if (outcome) return { exitCode: RUNTIME_EXIT.ok, output: { action: "settled", outcome } satisfies LaunchProbe };
  const marker = layout.launchMarker(launchId);
  const created = writeExclusive(
    marker,
    `${JSON.stringify({ launchId, stepKey, attempt, at: new Date().toISOString() })}\n`,
  );
  if (created) return { exitCode: RUNTIME_EXIT.ok, output: { action: "start" } satisfies LaunchProbe };
  if (probeTurnLock(layout.callLock) === "BUSY") {
    return { exitCode: RUNTIME_EXIT.ok, output: { action: "reattached" } satisfies LaunchProbe };
  }
  const settled = readJson<Outcome>(files.outcome);
  if (settled)
    return { exitCode: RUNTIME_EXIT.ok, output: { action: "settled", outcome: settled } satisfies LaunchProbe };
  const state = readJson<RuntimeState>(files.state);
  if (state?.launchId === launchId && state.phase === "suspended" && state.pendingAsk) {
    return { exitCode: RUNTIME_EXIT.ok, output: { action: "suspended" } satisfies LaunchProbe };
  }
  const harnessStarted = state?.launchId === launchId && state.harnessStartedAt !== undefined;
  return { exitCode: RUNTIME_EXIT.ok, output: { action: "interrupted", harnessStarted } satisfies LaunchProbe };
}

// ───────────────────────────── wait ─────────────────────────────

function snapshot(layout: Layout, call: CallArgs, after: number): WaitResponse {
  const files = layout.attempt(call.stepKey, call.attempt);
  const state = readJson<RuntimeState>(files.state) ?? null;
  const outcome = readJson<Outcome>(files.outcome);
  // Leave room for the state, ask and outcome around the events.
  const fixed = Buffer.byteLength(JSON.stringify({ state, outcome })) + 1024;
  const { events, lastSeq } = readEventsAfter(files.events, after, Math.max(4096, MAX_WAIT_BYTES - fixed));
  const pendingAsk = state?.pendingAsk?.spec;
  return {
    events,
    lastSeq,
    state,
    ...(pendingAsk ? { pendingAsk } : {}),
    ...(outcome ? { outcome } : {}),
    lock: probeTurnLock(layout.callLock),
  };
}

/** Long-poll (spec §6.6): returns as soon as events exist past `--after`, an outcome exists, or `--max` passes. */
export async function wait(layout: Layout, flags: Record<string, string>): Promise<VerbResult> {
  const call = callArgs(flags);
  const after = Number(flags.after ?? "0");
  if (!Number.isInteger(after) || after < 0) throw new UsageProblem("--after <seq> must be a non-negative integer");
  const maxMs = Math.min(parseDuration(flags.max, MAX_WAIT_MS), MAX_WAIT_MS);
  const files = layout.attempt(call.stepKey, call.attempt);
  const deadline = Date.now() + maxMs;
  for (;;) {
    const hasNew = readEventsAfter(files.events, after, 1).events.length > 0;
    if (hasNew || exists(files.outcome) || Date.now() >= deadline) {
      return { exitCode: RUNTIME_EXIT.ok, output: snapshot(layout, call, after) };
    }
    // The turn died without an outcome: nothing more will come, so say so now.
    const state = readJson<RuntimeState>(files.state);
    if (state && state.phase !== "booting" && probeTurnLock(layout.callLock) === "FREE" && !hasNew) {
      return { exitCode: RUNTIME_EXIT.ok, output: snapshot(layout, call, after) };
    }
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}

// ───────────────────────────── ack ─────────────────────────────

export function ack(layout: Layout, flags: Record<string, string>): VerbResult {
  const call = callArgs(flags);
  const files = layout.attempt(call.stepKey, call.attempt);
  if (!exists(files.outcome)) return { exitCode: RUNTIME_EXIT.ok, output: { acked: false } };
  writeAtomic(files.outcomeAck, `${new Date().toISOString()}\n`);
  return { exitCode: RUNTIME_EXIT.ok, output: { acked: true } };
}

// ───────────────────────────── quiesce ─────────────────────────────

/**
 * Confirms no harness process tree is left (before push, snapshot or fork). With `--call` and `--attempt` it waits
 * for that attempt; without them it covers the whole box (spec §5.8), as the host's snapshot and fork need.
 */
export async function quiesce(layout: Layout, flags: Record<string, string>): Promise<VerbResult> {
  if (flags.call === undefined && flags.attempt === undefined) return quiesceBox(layout, flags);
  const call = callArgs(flags);
  const timeoutMs = parseDuration(flags.timeout, 10_000);
  const files = layout.attempt(call.stepKey, call.attempt);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readJson<RuntimeState>(files.state);
    const outcome = exists(files.outcome);
    const busy = probeTurnLock(layout.callLock) === "BUSY";
    const pgid = state?.pids.harnessPgid;
    const tree = state ? harnessTree(layout, call.stepKey, call.attempt, state.launchId, pgid) : [];
    const groupLeft = pgid !== undefined && groupAlive(pgid) && tree.length > 0;
    if ((!busy || outcome) && tree.length === 0 && !groupLeft) {
      return { exitCode: RUNTIME_EXIT.ok, output: { quiescent: true } };
    }
    if (Date.now() >= deadline) {
      const reason = busy && !outcome ? "turn-running" : "processes";
      return {
        exitCode: RUNTIME_EXIT.ok,
        output: { quiescent: false, reason, ...(tree.length ? { pids: tree } : {}) },
      };
    }
    await sleep(100);
  }
}

/** Every attempt in the box that recorded a harness launch. */
function launchedAttempts(layout: Layout): { stepKey: string; attempt: number; state: RuntimeState }[] {
  const out: { stepKey: string; attempt: number; state: RuntimeState }[] = [];
  const calls = layout.host(SANDBOX_PATHS.calls);
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const stepKey of list(calls)) {
    if (!isSafeName(stepKey)) continue;
    for (const n of list(path.join(calls, stepKey))) {
      const attempt = Number(n);
      if (!Number.isInteger(attempt) || attempt < 1) continue;
      const state = readJson<RuntimeState>(layout.attempt(stepKey, attempt).state);
      if (state?.launchId) out.push({ stepKey, attempt, state });
    }
  }
  return out;
}

/**
 * Box-wide quiescence: the turn lock is free, and every process tree a call left behind is interrupted, then
 * killed after 2 s. Killed, not stopped: a stopped process still holds its environment and sockets.
 */
async function quiesceBox(layout: Layout, flags: Record<string, string>): Promise<VerbResult> {
  const timeoutMs = parseDuration(flags.timeout, 10_000);
  const deadline = Date.now() + timeoutMs;
  let interruptedAt: number | undefined;
  for (;;) {
    const busy = probeTurnLock(layout.callLock) === "BUSY";
    const trees = busy
      ? []
      : launchedAttempts(layout).flatMap((a) => {
          const pgid = a.state.pids.harnessPgid;
          const pids = harnessTree(layout, a.stepKey, a.attempt, a.state.launchId, pgid);
          return pids.length > 0 ? [{ pgid, pids }] : [];
        });
    if (!busy && trees.length === 0) return { exitCode: RUNTIME_EXIT.ok, output: { quiescent: true } };
    if (Date.now() >= deadline) {
      const pids = trees.flatMap((t) => t.pids);
      return {
        exitCode: RUNTIME_EXIT.ok,
        output: { quiescent: false, reason: busy ? "turn-running" : "processes", ...(pids.length ? { pids } : {}) },
      };
    }
    if (trees.length > 0) {
      interruptedAt ??= Date.now();
      const signal: NodeJS.Signals = Date.now() - interruptedAt < 2_000 ? "SIGINT" : "SIGKILL";
      for (const t of trees) {
        if (t.pgid !== undefined) signalGroup(t.pgid, signal);
        for (const pid of t.pids) {
          try {
            process.kill(pid, signal);
          } catch {
            // Already gone.
          }
        }
      }
    }
    await sleep(100);
  }
}

// ───────────────────────────── answer ─────────────────────────────

/** Writes inbox/<askId>.json, only while inbox/.open exists; a duplicate is a no-op (spec §6.9). */
export function answer(layout: Layout, flags: Record<string, string>, body: string): VerbResult {
  const call = callArgs(flags);
  const askId = flags.ask;
  if (!askId || !isSafeName(askId)) throw new UsageProblem("--ask <askId> is required and must be a file name");
  let parsed: InboxAnswer;
  try {
    parsed = JSON.parse(body) as InboxAnswer;
  } catch {
    throw new UsageProblem("the answer body on stdin is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || !parsed.resolution)
    throw new UsageProblem("the answer body needs a `resolution`");
  const files = layout.attempt(call.stepKey, call.attempt);
  if (!exists(files.inboxOpen))
    return { exitCode: RUNTIME_EXIT.ok, output: { written: false, reason: "inbox-closed" } };
  const target = path.join(files.inbox, `${askId}.json`);
  if (exists(target) || exists(path.join(files.inbox, `${askId}.taken`))) {
    return { exitCode: RUNTIME_EXIT.ok, output: { written: false, reason: "duplicate" } };
  }
  // Never follow a planted symlink: the name must not exist, and the write lands through a fresh link.
  const written = writeExclusive(target, JSON.stringify({ ...parsed, askId }), 0o644);
  return { exitCode: RUNTIME_EXIT.ok, output: { written } };
}

// ───────────────────────────── dispatch ─────────────────────────────

export async function runVerb(
  layout: Layout,
  argv: string[],
  io: { stdin: () => Promise<string>; bundlePath?: string; supervise?: Partial<SuperviseOptions> },
): Promise<VerbResult> {
  const { verb, flags } = parseArgs(argv);
  try {
    switch (verb) {
      case "launch":
        return launch(layout, flags);
      case "wait":
        return await wait(layout, flags);
      case "ack":
        return ack(layout, flags);
      case "quiesce":
        return await quiesce(layout, flags);
      case "answer":
        return answer(layout, flags, await io.stdin());
      case "supervise": {
        const call = callArgs(flags);
        const supervisor = new Supervisor({
          layout,
          stepKey: call.stepKey,
          attempt: call.attempt,
          launchId: launchArg(flags),
          ...(io.bundlePath ? { bundlePath: io.bundlePath } : {}),
          ...io.supervise,
        });
        return { exitCode: await supervisor.run() };
      }
      default:
        throw new UsageProblem(`unknown verb "${verb ?? ""}"; expected one of ${RUNTIME_VERBS.join(", ")}`);
    }
  } catch (error) {
    if (error instanceof UsageProblem) {
      const log = new RuntimeLog(undefined);
      log.error(error.message);
      return { exitCode: RUNTIME_EXIT.config, output: { error: "config", message: error.message } };
    }
    throw error;
  }
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
