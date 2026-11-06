// Hot vs cold waits (spec §8.4). The agent never chooses; this does.

/** A hot wait must leave this much room before the harness's own tool timeout fires. */
export const HOT_MARGIN_MS = 15_000;
/** Below this a hot wait is not worth holding the tool call open. */
export const MIN_HOT_MS = 30_000;
/** A hot wait on a shared handle never exceeds this: parking would stall the siblings. */
export const SHARED_HOT_CAP_MS = 30 * 60_000;
export const DEFAULT_HOT_WAIT_MS = 10 * 60_000;
export const DEFAULT_ASK_TIMEOUT_MS = 4 * 3_600_000;

/** hotLimitMs = min(hotWait, mcpToolTimeoutMs − 15 s); a null tool timeout means no harness limit. */
export function hotLimitMs(hotWaitMs: number, mcpToolTimeoutMs: number | null): number {
  if (mcpToolTimeoutMs === null) return hotWaitMs;
  return Math.max(0, Math.min(hotWaitMs, mcpToolTimeoutMs - HOT_MARGIN_MS));
}

export interface WaitModeInput {
  /** Effective hotWait (HitlOptions.hotWait, default 10m). */
  hotWaitMs: number;
  /** FilePlan.mcpToolTimeoutMs from the harness's prepare(). */
  mcpToolTimeoutMs: number | null;
  /** The ask's own timeout. */
  askTimeoutMs: number;
  /** The harness adapter has resume(). */
  canResume: boolean;
  /** The agent runs on a shared sandbox handle. */
  sharedHandle?: boolean;
}

export interface WaitPlan {
  /**
   * "hot": hold the tool call for `hotMs`. "cold": return `suspended` at once and park.
   * "policy": nobody can wait at all, so the onTimeout policy applies at once.
   */
  mode: "hot" | "cold" | "policy";
  /** How long the tool call stays open; 0 unless mode is "hot". */
  hotMs: number;
  /** What happens when a hot wait runs out without an answer. */
  afterHot: "cold" | "policy";
}

/**
 * Picks the wait mode for one agent ask.
 *
 * The spec lists "the ask's timeout is longer than 2 hours" as a cold-wait trigger. Read literally it would
 * send every ask under the 4h default straight to cold and no default ask would ever be hot, so it is read
 * as: an ask that can outlive its hot window continues cold. An ask whose whole timeout fits in the hot
 * window stays hot and its expiry applies the policy.
 */
export function selectWaitMode(i: WaitModeInput): WaitPlan {
  const limit = hotLimitMs(i.hotWaitMs, i.mcpToolTimeoutMs);
  if (i.sharedHandle) {
    const hot = Math.min(i.askTimeoutMs, SHARED_HOT_CAP_MS, limit);
    return hot < MIN_HOT_MS
      ? { mode: "policy", hotMs: 0, afterHot: "policy" }
      : { mode: "hot", hotMs: hot, afterHot: "policy" };
  }
  if (limit < MIN_HOT_MS) {
    return i.canResume
      ? { mode: "cold", hotMs: 0, afterHot: "cold" }
      : { mode: "policy", hotMs: 0, afterHot: "policy" };
  }
  if (i.askTimeoutMs <= limit) return { mode: "hot", hotMs: i.askTimeoutMs, afterHot: "policy" };
  return { mode: "hot", hotMs: limit, afterHot: i.canResume ? "cold" : "policy" };
}
