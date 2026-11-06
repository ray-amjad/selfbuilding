import type { HarnessCredential, HarnessFailure } from "../types/harness.js";

// The credential pool (spec §4.9, BASIC-SCOPE "Credentials"), harness-neutral. Subscriptions go first and API keys
// are the fallback; a call stays on one credential and moves on only for an account failure. A login file is a
// rotating refresh token, so it is leased to one sandbox at a time and its refreshed copy is kept for the next one.

export const isSubscription = (cred: HarnessCredential): boolean =>
  cred.kind === "auth-file" || cred.kind === "oauth-token";

/** The `credentials` option as an ordered pool: subscriptions first, then the rest, each in the given order. */
export function credentialPool(
  credentials: HarnessCredential | readonly HarnessCredential[] | undefined,
): HarnessCredential[] {
  const list =
    credentials === undefined ? [] : Array.isArray(credentials) ? [...credentials] : [credentials as HarnessCredential];
  return [...list.filter(isSubscription), ...list.filter((c) => !isSubscription(c))];
}

/**
 * `auth` and `quota` always move on. A rate-limited subscription moves on when an API key is waiting: its limit
 * is the plan's usage cap, which outlasts the harness's own retries.
 */
export function isAccountFailure(
  cred: HarnessCredential,
  failure: Pick<HarnessFailure, "code">,
  pool: readonly HarnessCredential[],
): boolean {
  if (failure.code === "auth" || failure.code === "quota") return true;
  return failure.code === "rate_limit" && isSubscription(cred) && pool.some((c) => !isSubscription(c));
}

interface LeaseSlot {
  holder: string | null;
  /** The newest copy of the file, after a sandbox refreshed it. */
  latest?: string;
  waiters: (() => void)[];
}

// Keyed by the credential value the user passed: the same login object is the same refresh chain.
const leases = new WeakMap<HarnessCredential, LeaseSlot>();

function slotOf(cred: HarnessCredential): LeaseSlot {
  let slot = leases.get(cred);
  if (!slot) {
    slot = { holder: null, waiters: [] };
    leases.set(cred, slot);
  }
  return slot;
}

/** Takes the lease when it is free (or already ours). */
export function tryLease(cred: HarnessCredential, holder: string): boolean {
  const slot = slotOf(cred);
  if (slot.holder !== null && slot.holder !== holder) return false;
  slot.holder = holder;
  return true;
}

/** Waits for the lease; a second concurrent holder never gets the same login file. */
export async function waitForLease(cred: HarnessCredential, holder: string, signal?: AbortSignal): Promise<void> {
  while (!tryLease(cred, holder)) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => {
      const slot = slotOf(cred);
      const done = () => {
        signal?.removeEventListener("abort", done);
        resolve();
      };
      slot.waiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/** The newest known copy of a leased file, if a sandbox refreshed it. */
export function leasedContent(cred: HarnessCredential): string | undefined {
  return leases.get(cred)?.latest;
}

/**
 * Keeps the copy a sandbox returned when it is a usable file: valid JSON that is not empty. Harness-specific
 * checks (same account, newer refresh) belong to the harness; this only refuses a truncated or wiped file.
 */
export function keepReturnedCopy(cred: HarnessCredential, returned: string | null | undefined): boolean {
  if (!returned?.trim()) return false;
  try {
    const parsed = JSON.parse(returned) as unknown;
    if (parsed === null || typeof parsed !== "object" || Object.keys(parsed).length === 0) return false;
  } catch {
    return false;
  }
  slotOf(cred).latest = returned;
  return true;
}

export function releaseLease(cred: HarnessCredential, holder: string): void {
  const slot = leases.get(cred);
  if (!slot || slot.holder !== holder) return;
  slot.holder = null;
  const waiters = slot.waiters.splice(0);
  for (const wake of waiters) wake();
}
