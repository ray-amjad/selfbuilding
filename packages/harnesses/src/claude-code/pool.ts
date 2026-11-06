import type { HarnessCredential, HarnessFailure } from "@selfbuilding/core";
import { ConfigError, MissingCredentialError } from "@selfbuilding/core";
import { claudeCredentialVariable } from "./auth.js";

/** What to do with the pool after a failure. A switch always resumes the same session (spec §4.9). */
export type PoolDecision =
  | { action: "stay"; index: number }
  | { action: "switch"; from: number; index: number; credential: HarnessCredential }
  | { action: "exhausted"; index: number; failure: HarnessFailure };

export interface ClaudeCredentialPool {
  /** Subscription credentials first, then API keys, each group in the caller's order. */
  readonly credentials: readonly HarnessCredential[];
  /** The credential a run pins first. One per run keeps prompt caches warm. */
  first(): HarnessCredential;
  at(index: number): HarnessCredential;
  /** Whether the failure is an account failure for the credential at `index`. */
  isAccountFailure(index: number, failure: HarnessFailure): boolean;
  /** Pure and index-based, so a durable host can replay the same decision from journaled values. */
  next(index: number, failure: HarnessFailure): PoolDecision;
}

const isSubscription = (cred: HarnessCredential) => cred.kind === "oauth-token";

/**
 * Moves on only for account failures: `auth` and `quota` on any credential, and `rate_limit` on a subscription,
 * whose rate limit is the plan's own usage cap. Provider errors and bare 403s stay on the credential.
 */
export function isAccountFailure(cred: HarnessCredential, failure: HarnessFailure): boolean {
  if (failure.code === "auth" || failure.code === "quota") return true;
  return failure.code === "rate_limit" && isSubscription(cred);
}

/** Orders a credential option into a pool: subscription first, API key fallback. */
export function claudeCredentialPool(
  credentials: HarnessCredential | readonly HarnessCredential[] | undefined,
): ClaudeCredentialPool {
  const given = credentials === undefined ? [] : Array.isArray(credentials) ? [...credentials] : [credentials];
  if (given.length === 0) throw new MissingCredentialError({ consumer: "claudeCode()" });
  for (const cred of given as HarnessCredential[]) claudeCredentialVariable(cred);
  const ordered = [
    ...(given as HarnessCredential[]).filter(isSubscription),
    ...(given as HarnessCredential[]).filter((c) => !isSubscription(c)),
  ];

  const at = (index: number): HarnessCredential => {
    const cred = ordered[index];
    if (cred === undefined) {
      throw new ConfigError(
        `The Claude Code credential pool has ${ordered.length} entries; index ${index} is out of range.`,
      );
    }
    return cred;
  };

  return {
    credentials: ordered,
    first: () => at(0),
    at,
    isAccountFailure: (index, failure) => isAccountFailure(at(index), failure),
    next(index, failure) {
      if (!isAccountFailure(at(index), failure)) return { action: "stay", index };
      const following = index + 1;
      if (following >= ordered.length) return { action: "exhausted", index, failure };
      return { action: "switch", from: index, index: following, credential: at(following) };
    },
  };
}
