import type { HarnessCredential, HarnessFailure } from "@selfbuilding/core";

// The credential pool rules (spec §4.9, §4.12, BASIC-SCOPE "Credentials"). Harness-neutral: nothing here knows a
// vendor. Subscriptions are tried first and API keys are the fallback; a run stays pinned to one credential so
// prompt caches stay warm, and moves on only for an account failure.

export const isSubscription = (cred: HarnessCredential): boolean =>
  cred.kind === "auth-file" || cred.kind === "oauth-token";

/** The `credentials` option as an ordered pool: subscriptions first, then the rest, each group in the given order. */
export function credentialPool(
  credentials: HarnessCredential | readonly HarnessCredential[] | undefined,
): HarnessCredential[] {
  const list =
    credentials === undefined ? [] : Array.isArray(credentials) ? [...credentials] : [credentials as HarnessCredential];
  return [...list.filter(isSubscription), ...list.filter((c) => !isSubscription(c))];
}

/**
 * Whether `failure` on `cred` should move the run to another credential. `auth` and `quota` always do. A
 * subscription that is rate-limited also does when an API key is waiting: a subscription's rate limit is a plan
 * limit that outlasts the harness's own retries. A bare 403 is not an account failure, because tools produce those
 * too, and classify() never reports it as `auth`.
 */
export function isAccountFailure(
  cred: HarnessCredential,
  failure: HarnessFailure,
  pool: readonly HarnessCredential[],
): boolean {
  if (failure.code === "auth" || failure.code === "quota") return true;
  return failure.code === "rate_limit" && isSubscription(cred) && pool.some((c) => !isSubscription(c));
}

export interface FailoverInput {
  pool: readonly HarnessCredential[];
  /** Index of the credential the failed turn ran on. */
  current: number;
  failure: HarnessFailure;
  /** Whether the failed turn had effects (spec §4.12.1): an effect tool, a file change, or a moved HEAD or tree. */
  turnHadEffects: boolean;
  /** Whether the harness can resume this session (it has `resume()`, the session is intact, maxResumes is left). */
  canResume: boolean;
  /** Indexes that cannot take the run now: already failed in this run, or a leased file another sandbox holds. */
  unavailable?: ReadonlySet<number>;
}

export type FailoverDecision =
  /** Not an account failure: the ordinary retry rules apply on the same credential. */
  | { action: "stay" }
  /** Resume the same session on `next`, with the nudge. Counts against maxResumes. */
  | { action: "resume"; next: number }
  /** The turn had no effects: start a fresh attempt on `next`. */
  | { action: "fresh"; next: number }
  /** Nothing left to try, or the session cannot be resumed after effects. Never a fresh session after effects. */
  | { action: "fail"; reason: string };

/** What the pool does after a failed turn. */
export function credentialFailover(input: FailoverInput): FailoverDecision {
  const { pool, current, failure } = input;
  const cred = pool[current];
  if (!cred || !isAccountFailure(cred, failure, pool)) return { action: "stay" };
  // Later credentials first; earlier ones only if they were skipped as busy and have not failed in this run.
  let next = -1;
  for (let step = 1; step < pool.length; step++) {
    const i = (current + step) % pool.length;
    if (!input.unavailable?.has(i)) {
      next = i;
      break;
    }
  }
  if (next < 0) {
    return { action: "fail", reason: `no other credential in the pool can take over after ${failure.code}` };
  }
  if (!input.turnHadEffects) return { action: "fresh", next };
  if (!input.canResume) {
    return {
      action: "fail",
      reason: `the turn had effects and its session cannot be resumed on the next credential after ${failure.code}`,
    };
  }
  return { action: "resume", next };
}

/** The first credential a run pins: the first one not held elsewhere. -1 when every one is busy or failed. */
export function pickCredential(pool: readonly HarnessCredential[], unavailable?: ReadonlySet<number>): number {
  for (let i = 0; i < pool.length; i++) if (!unavailable?.has(i)) return i;
  return -1;
}

/** The fixed resume nudge after a model API error (spec §4.12.1). */
export function resumeNudge(code: HarnessFailure["code"]): string {
  return (
    `Your previous turn stopped because of a model API error (${code}). Your work so far is in this session and in ` +
    "the working tree. Check `git status`, `git log` and any external actions you already took before you continue. " +
    "Do not repeat actions that already took effect. Continue the task and call submit_result when done."
  );
}
