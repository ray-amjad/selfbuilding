import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, type RunStatus } from "@selfbuilding/core";
import type { StatePaths } from "./project.js";

/** Valid on every host (spec §7.2). */
export const RUN_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/;

export function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ConfigError(
      `Run id "${runId}" is not valid. Use 1 to 100 letters, digits, "-" or "_", not starting with "-".`,
    );
  }
  return runId;
}

// Lowercase, like the ids core mints, so branch names built from run ids stay one case.
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A ULID: 48 bits of time then 80 random bits, Crockford base32, so ids sort by start time. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
}

/** The CLI mints the id itself so it can name the event file and run record before the run starts. */
export function newRunId(): string {
  return `ns_${ulid()}`;
}

/**
 * What the CLI remembers about a run it started, so `resume`, `watch` and `cancel` work from a run id alone.
 * The journal stays the source of truth for the run itself; this is only the CLI's bookkeeping.
 */
export interface RunRecord {
  v: 1;
  runId: string;
  factoryFile: string;
  exportName?: string;
  input: unknown;
  configPath: string | null;
  envFile?: string;
  afk?: boolean;
  startedAt: string;
  updatedAt: string;
  /** The process currently driving the run; absent once it has exited. */
  pid?: number;
  status?: RunStatus;
  /** Set when the last process driving the run returned; a later `resume` clears it. */
  finishedAt?: string;
}

export interface CancelRequest {
  reason: string;
  at: string;
  by: string;
}

function recordPath(paths: StatePaths, runId: string): string {
  return path.join(paths.runs, `${runId}.json`);
}

export function cancelPath(paths: StatePaths, runId: string): string {
  return path.join(paths.runs, `${runId}.cancel`);
}

export function eventsPath(paths: StatePaths, runId: string): string {
  return path.join(paths.events, `${runId}.jsonl`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function readRunRecord(paths: StatePaths, runId: string): RunRecord | null {
  const file = recordPath(paths, runId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  } catch {
    throw new ConfigError(`${file} is not valid JSON. Delete it to forget the run, or fix it by hand.`);
  }
}

export function writeRunRecord(paths: StatePaths, record: RunRecord): void {
  writeJsonAtomic(recordPath(paths, record.runId), { ...record, updatedAt: new Date().toISOString() });
}

export function readCancelRequest(paths: StatePaths, runId: string): CancelRequest | null {
  const file = cancelPath(paths, runId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CancelRequest;
  } catch {
    return { reason: "cancelled", at: new Date().toISOString(), by: "unknown" };
  }
}

export function writeCancelRequest(paths: StatePaths, runId: string, request: CancelRequest): void {
  writeJsonAtomic(cancelPath(paths, runId), request);
}

/** Signal 0 probes for existence; EPERM still means the process is there. */
export function isAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
