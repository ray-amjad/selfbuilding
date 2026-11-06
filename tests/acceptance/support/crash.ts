// Drives fixtures/crash-host.mjs for acceptance test 3: start a host process, wait for a moment in its event
// stream, kill it (and, to model a machine dying, every process of its boxes), and read what each process did.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SelfbuildingEvent } from "@selfbuilding/core";

const HOST = fileURLToPath(new URL("../fixtures/crash-host.mjs", import.meta.url));

/** How long a killed process's journal lease lives on (core's lease TTL is 60 s). */
export const LEASE_EXPIRY_MS = 61_000;

export interface HostConfig {
  dir: string;
  runId: string;
  host: "node" | "trigger";
  /** Names this process in its events file and in every result it produces. */
  tag: string;
  promptB: string;
  /** Seconds a call's shell step sleeps, by label, so the test can kill the host mid-call. */
  slow?: Record<string, number>;
  /**
   * Trigger host: names the platform run. Reusing a name is the platform retrying that run after its worker died
   * (same epoch); a new name is a new trigger of the run id (the next epoch). Default "run_".
   */
  triggerRun?: string;
  /** Plain Node host: the journal to run on. Default "file". */
  journal?: "file" | "sqlite";
}

export interface HostResult {
  status: string;
  output: { label: string; step: string; replayed: boolean }[] | null;
  epoch?: number;
  error?: unknown;
}

export interface HostProcess {
  child: ChildProcess;
  /** Resolves with the RESULT line, or null when the process died first. */
  done: Promise<HostResult | null>;
  stderr(): string;
}

export function startHost(cfg: HostConfig): HostProcess {
  const child = spawn(process.execPath, [HOST], {
    cwd: path.dirname(HOST),
    env: { ...process.env, SBA_CRASH: JSON.stringify(cfg) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const done = new Promise<HostResult | null>((resolve) => {
    child.on("exit", () => {
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      resolve(line ? (JSON.parse(line.slice("RESULT ".length)) as HostResult) : null);
    });
  });
  return { child, done, stderr: () => stderr };
}

export function readEvents(dir: string, tag: string): SelfbuildingEvent[] {
  const file = path.join(dir, `events-${tag}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SelfbuildingEvent);
}

export async function waitForEvent(
  dir: string,
  tag: string,
  match: (e: SelfbuildingEvent) => boolean,
  host: HostProcess,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readEvents(dir, tag).some(match)) return;
    if (host.child.exitCode !== null) throw new Error(`the host exited early: ${host.stderr()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no matching event from ${tag} within ${timeoutMs} ms`);
}

/** SIGKILLs the host process. With `boxes`, also every process running out of those boxes: the machine died. */
export async function kill(host: HostProcess, boxes?: string): Promise<void> {
  host.child.kill("SIGKILL");
  await host.done;
  if (boxes) spawnSync("pkill", ["-KILL", "-f", boxes]);
}

export const launched = (events: SelfbuildingEvent[]) =>
  events.filter((e) => e.type === "agent.launched").map((e) => e.callPath);

/** Turns the harness actually started for a call, across every process. */
export const turnsOf = (events: SelfbuildingEvent[], callPath: string) =>
  events.filter((e) => e.type === "turn.started" && e.callPath === callPath).length;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
