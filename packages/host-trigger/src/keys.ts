import { createHash } from "node:crypto";
import { ConfigError, type Duration, type HostAgentCall, type HostKey, type LaunchId } from "@selfbuilding/core";

// Every identifier the Trigger host derives (spec §7.2, §7.5.1, §7.10). One place, so replay re-derives the
// same keys from the same values.

export const FACTORY_TASK_ID = "selfbuilding.factory";
export const AGENT_TASK_ID = "selfbuilding.agent";
export const REAPER_TASK_ID = "selfbuilding.reaper";
export const REAPER_CRON = "*/2 * * * *";

export const MINUTE_MS = 60_000;
/** The host wait outlives the call's own timeout by this much (spec §7.7). */
export const WAIT_GRACE_MS = 30 * MINUTE_MS;
/** The parent's reconcile timeout on its wake stream (spec §7.5.1). */
export const RECONCILE_MS = 10 * MINUTE_MS;
/** Premature re-arms allowed per launch before a wake counts as a wait timeout (spec §7.4.2). */
export const MAX_PREMATURE_REARMS = 3;
/** Inline cut-off for step values on every host (spec §7.4.3). */
export const MAX_STEP_OUTPUT_BYTES = 262_144;
/**
 * An agent child waits for a human in slices of at most this long and re-reads the ask store after each, so an
 * answer whose waitpoint completion was lost costs at most one slice (release-prep §3.2 item 8).
 */
export const ASK_SLICE_MS = 10 * MINUTE_MS;

export function hostKeyOf(call: Pick<HostAgentCall, "stepKey" | "epoch">): HostKey {
  return `${call.stepKey}_e${call.epoch}`;
}

export function launchIdOf(call: Pick<HostAgentCall, "stepKey" | "epoch">, launch: number): LaunchId {
  return `${hostKeyOf(call)}_l${launch}`;
}

/** One token per armed wait: a completed token cannot be reused (spec §6.6). */
export function wakeTokenKey(runId: string, launchId: string, rearm: number): string {
  return `ns:${runId}:${launchId}:done:w${rearm}`;
}

/**
 * The first dispatch of a step uses the spec's key; every later launch (check retries, interrupted resumes, the
 * live re-run of a failed entry) needs its own child run, so it carries the launch number. Keyed on the number,
 * not on `resume`: a parent replaying from its journal may re-dispatch launch n without the resume payload, and
 * must still land on launch n's child rather than launch 0's.
 */
export function agentChildKey(call: HostAgentCall): string {
  const base = `ns:${call.runId}:${call.stepKey}:e${call.epoch}`;
  return call.resume || call.launch > 0 ? `${base}:l${call.launch}` : base;
}

/** The registry file name for a dispatched child; unique per child run. */
export function agentRegistryName(call: HostAgentCall): string {
  return call.resume || call.launch > 0 ? `${call.stepKey}_l${call.launch}` : call.stepKey;
}

export function nestedChildKey(runId: string, key: string, epoch: number): string {
  return `ns:${runId}:${key}:e${epoch}`;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Hash(text: string, length: number): string {
  const bytes = createHash("sha256").update(text).digest();
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out;
}

/** A run id stable across retries of one host run, in the `ns_` + 26-char shape. */
export function runIdForHostRun(hostRunId: string): string {
  return `ns_${base32Hash(`host-run|${hostRunId}`, 26)}`;
}

/** The run id of a nested factory: derived, so a re-trigger after a parent retry lands on the same journal. */
export function nestedRunId(parentRunId: string, key: string): string {
  return `ns_${base32Hash(`nested|${parentRunId}|${key}`, 26)}`;
}

const RUN_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/;

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new ConfigError(
      `Run id "${runId}" is not valid. Use 1-100 characters from [a-zA-Z0-9_-], not starting with "-".`,
    );
  }
}

/** Store keys never contain "/" from user values, so a key cannot escape its prefix. */
export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:#[\]-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export const storeKeys = {
  run: (runId: string) => `runs/${runId}/run.json`,
  lease: (runId: string) => `runs/${runId}/lease.json`,
  cache: (runId: string, key: string) => `runs/${runId}/cache/${safeSegment(key)}.json`,
  cachePrefix: (runId: string) => `runs/${runId}/cache/`,
  accepted: (runId: string, epoch: number, key: string) => `runs/${runId}/e${epoch}/accepted/${safeSegment(key)}.json`,
  acceptedPrefix: (runId: string, epoch: number) => `runs/${runId}/e${epoch}/accepted/`,
  child: (runId: string, epoch: number, name: string) => `runs/${runId}/e${epoch}/children/${safeSegment(name)}.json`,
  childPrefix: (runId: string, epoch: number) => `runs/${runId}/e${epoch}/children/`,
  /** A child's final value, written by the child before it wakes the parent, so the wake never races the status. */
  childResult: (runId: string, epoch: number, name: string) =>
    `runs/${runId}/e${epoch}/results/${safeSegment(name)}.json`,
  ask: (askId: string) => `asks/${safeSegment(askId)}.json`,
  askPrefix: () => "asks/",
  probe: (nonce: string) => `selfbuilding/probe/${nonce}.json`,
  /** When an agent child first started a dispatched launch: its box time survives a child retry. */
  launchClock: (runId: string, launchId: string) => `runs/${runId}/clock/${safeSegment(launchId)}.json`,
};

/** Reverses `safeSegment` for keys read back from `list()`. */
export function unsafeSegment(value: string): string {
  return value.replace(/%([0-9a-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const DURATION = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS } as const;

export function durationMs(d: Duration): number {
  if (typeof d === "number") {
    if (!Number.isFinite(d) || d < 0) throw new ConfigError(`Duration ${d} must be a non-negative number of ms.`);
    return d;
  }
  const m = DURATION.exec(d);
  if (!m) throw new ConfigError(`Duration "${d}" is not valid. Use a number of ms or "45s", "30m", "2h", "1d".`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}
