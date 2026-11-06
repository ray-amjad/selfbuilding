import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { signalGroup } from "./tree.js";

export interface CommandRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** The last `tailBytes` of combined output. */
  tail: string;
}

export interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Combined stdout and stderr are appended here. */
  logFile?: string;
  tailBytes?: number;
  signal?: AbortSignal;
  uid?: number;
  gid?: number;
}

function shell(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) if (fs.existsSync(candidate)) return candidate;
  return "/bin/sh";
}

/** Runs a shell command in its own process group; a timeout or abort kills the whole group. */
export function runCommand(command: string, opts: CommandOptions): Promise<CommandRun> {
  const tailBytes = opts.tailBytes ?? 4096;
  if (opts.logFile) fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const log = opts.logFile ? fs.openSync(opts.logFile, "a") : undefined;
  let tail = Buffer.alloc(0);
  const child = spawn(shell(), ["-c", command], {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.uid === undefined ? {} : { uid: opts.uid }),
    ...(opts.gid === undefined ? {} : { gid: opts.gid }),
  });
  const onData = (chunk: Buffer) => {
    if (log !== undefined) fs.writeSync(log, chunk);
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > tailBytes * 2) tail = tail.subarray(tail.length - tailBytes);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  let timedOut = false;
  let cancelled = false;
  const kill = () => {
    if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
  };
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
  const onAbort = () => {
    cancelled = true;
    kill();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Background children of the command must not outlive it.
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
      if (log !== undefined) fs.closeSync(log);
      const text = tail.subarray(Math.max(0, tail.length - tailBytes)).toString("utf8");
      resolve({ code, signal, timedOut, cancelled, tail: text.replace(/^�+/, "") });
    };
    child.on("error", (error) => {
      onData(Buffer.from(`${String(error)}\n`));
      finish(127, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // A background child holding the pipes must not keep a finished command open.
    child.on("exit", (code, signal) => {
      setTimeout(() => finish(code, signal), 2_000).unref();
    });
  });
}
