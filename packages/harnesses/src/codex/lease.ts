import { CredentialRefreshError } from "@selfbuilding/core";
import { type CodexAuthFile, parseAuthFile } from "./auth.js";

// A Codex login is a rotating refresh token: if two sandboxes refresh the same chain, the vendor revokes the older
// token and the slower box loses its credential mid-run (spec §4.9). So a login file is leased to one sandbox at a
// time, and the file Codex rewrote is copied back when the call ends.

export interface AuthFileLease {
  /** Identifies the credential, e.g. its pool position or account id. Stable across refreshes. */
  readonly key: string;
  /** Identifies the sandbox or agent call holding it. */
  readonly holder: string;
  /** The auth.json to write into the sandbox: the newest copy known. */
  readonly content: string;
}

export interface AuthFileRelease {
  /** The auth.json the pool now holds. */
  content: string;
  /** True when the sandbox's copy replaced the previous one. */
  refreshed: boolean;
  /** Why a returned copy was not taken, when it was not. */
  rejected?: string;
}

export interface AuthFileLeasesOptions {
  /** Persists a refreshed file, e.g. back to the secret store. Called before `release()` resolves. */
  writeBack?: (key: string, content: string) => void | Promise<void>;
}

function tryParse(content: string | undefined): CodexAuthFile | undefined {
  if (content === undefined) return undefined;
  try {
    return parseAuthFile(content);
  } catch {
    return undefined;
  }
}

function refreshedAt(file: CodexAuthFile): number | undefined {
  const at = file.last_refresh ? Date.parse(file.last_refresh) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/**
 * Decides which auth.json survives a call: the copy the sandbox returned, or the one it was given. A returned
 * copy is taken only when it is a valid login for the same account and no older than the original, so a
 * truncated write, a logged-out file or a swapped account never replaces a good credential.
 */
export function chooseAuthFile(original: string, returned: string | undefined): AuthFileRelease {
  const before = parseAuthFile(original);
  if (returned === undefined) return { content: original, refreshed: false, rejected: "nothing was copied back" };
  if (returned === original) return { content: original, refreshed: false };
  const after = tryParse(returned);
  if (!after) return { content: original, refreshed: false, rejected: "the returned file is not a usable auth.json" };
  const beforeAccount = before.tokens?.account_id;
  const afterAccount = after.tokens?.account_id;
  if (beforeAccount && afterAccount !== beforeAccount) {
    return { content: original, refreshed: false, rejected: "the returned file belongs to another account" };
  }
  const beforeAt = refreshedAt(before);
  const afterAt = refreshedAt(after);
  if (beforeAt !== undefined && (afterAt === undefined || afterAt < beforeAt)) {
    return { content: original, refreshed: false, rejected: "the returned file is older than the leased one" };
  }
  return { content: returned, refreshed: true };
}

/**
 * In-process lease table for leased auth files: one holder per credential, newest copy kept in memory. Hosts that
 * run calls from several processes need a shared lock instead; this is the single-process form.
 */
export class AuthFileLeases {
  readonly #held = new Map<string, string>();
  readonly #latest = new Map<string, string>();
  readonly #writeBack: AuthFileLeasesOptions["writeBack"];

  constructor(opts: AuthFileLeasesOptions = {}) {
    this.#writeBack = opts.writeBack;
  }

  /** Who holds `key`, if anyone. */
  holder(key: string): string | undefined {
    return this.#held.get(key);
  }

  /**
   * Leases `key` to `holder`. Returns null when another holder has it: the pool then tries its next credential.
   * `resolved` is the credential's value as resolved on the orchestrator; a newer copy from an earlier release wins.
   */
  acquire(key: string, holder: string, resolved: string): AuthFileLease | null {
    const current = this.#held.get(key);
    if (current !== undefined && current !== holder) return null;
    const content = this.#latest.get(key) ?? resolved;
    parseAuthFile(content);
    this.#held.set(key, holder);
    this.#latest.set(key, content);
    return { key, holder, content };
  }

  /** Ends the lease with the file copied back from the sandbox (undefined if the copy failed). */
  async release(lease: AuthFileLease, returned: string | undefined): Promise<AuthFileRelease> {
    if (this.#held.get(lease.key) !== lease.holder) {
      throw new CredentialRefreshError(
        `The Codex auth file "${lease.key}" is not leased to ${lease.holder}; it cannot be released by it.`,
      );
    }
    const decision = chooseAuthFile(this.#latest.get(lease.key) ?? lease.content, returned);
    // Kept in memory first: once Codex has refreshed, the old refresh token is dead, even if the write-back fails.
    this.#latest.set(lease.key, decision.content);
    try {
      if (decision.refreshed) await this.#writeBack?.(lease.key, decision.content);
    } finally {
      this.#held.delete(lease.key);
    }
    return decision;
  }
}
