import {
  type AuthContext,
  type AuthPlan,
  ConfigError,
  CredentialRefreshError,
  type HarnessCredential,
  MissingCredentialError,
} from "@selfbuilding/core";
import { API_KEY_VALUE_NAMES, AUTH_FILE_VALUE_NAMES, CODEX_AUTH_ENV } from "./constants.js";

// Codex credentials (spec §4.9). Both modes arrive as `{CODEX_HOME}/auth.json`, a 0600 file: a subscription login
// is the leased file itself, and an API key is written in the file shape `codex login --with-api-key` produces.
// That keeps every secret out of argv and out of env, and an API-key call overwrites any login file a previous
// call left behind, so the two modes are never set together.
// The file is owned by `agent`: Codex runs as the agent user and reads it itself (and rewrites it on refresh). A
// root-owned 0600 file is invisible to it, and Codex then sends requests with no Authorization header at all.

/** The parts of Codex's auth.json that Selfbuilding reads. */
export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string } | null;
  last_refresh?: string | null;
}

export const authFilePath = (home: string): string => `${home}/.codex/auth.json`;

function pickValue(values: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = values[name];
    if (value) return value;
  }
  const all = Object.values(values).filter((v) => v !== "");
  return all.length === 1 ? all[0] : undefined;
}

/** Parses auth.json text. Throws `CredentialRefreshError` when it is not a usable Codex login or key. */
export function parseAuthFile(content: string): CodexAuthFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CredentialRefreshError("The Codex auth file is not JSON. Pass the auth.json that `codex login` wrote.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialRefreshError("The Codex auth file is not a JSON object.");
  }
  const file = parsed as CodexAuthFile;
  const hasLogin = typeof file.tokens?.refresh_token === "string" && file.tokens.refresh_token !== "";
  const hasKey = typeof file.OPENAI_API_KEY === "string" && file.OPENAI_API_KEY !== "";
  if (!hasLogin && !hasKey) {
    throw new CredentialRefreshError(
      "The Codex auth file has neither a refresh token nor an API key. Run `codex login` again and pass the new auth.json.",
    );
  }
  return file;
}

function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims: unknown = JSON.parse(json);
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface AuthFileStatus {
  mode: "chatgpt" | "apikey";
  accountId?: string;
  /** From the access token's own `exp` claim, never from `codex login status` (spec §4.9). */
  accessTokenExpiresAt?: number;
  accessTokenExpired: boolean;
  hasRefreshToken: boolean;
  /** False only when the access token has expired and nothing can refresh it. */
  usable: boolean;
}

/** Reads an auth.json's state at `nowMs`. The caller supplies the clock; adapters never read one. */
export function authFileStatus(content: string, nowMs: number): AuthFileStatus {
  const file = parseAuthFile(content);
  const hasRefreshToken = typeof file.tokens?.refresh_token === "string" && file.tokens.refresh_token !== "";
  if (!file.tokens && file.OPENAI_API_KEY) {
    return { mode: "apikey", accessTokenExpired: false, hasRefreshToken: false, usable: true };
  }
  const exp = jwtClaims(file.tokens?.access_token)?.exp;
  const expiresAt = typeof exp === "number" ? exp * 1000 : undefined;
  const expired = expiresAt !== undefined && expiresAt <= nowMs;
  const accountId = file.tokens?.account_id;
  return {
    mode: "chatgpt",
    ...(accountId ? { accountId } : {}),
    ...(expiresAt === undefined ? {} : { accessTokenExpiresAt: expiresAt }),
    accessTokenExpired: expired,
    hasRefreshToken,
    usable: !expired || hasRefreshToken,
  };
}

/**
 * Whether a copy of auth.json read back from a box is the leased login refreshed, not another login: it parses as
 * an auth file, keeps the auth mode, and keeps the account (or, for a key, the key).
 */
export function sameCodexLogin(leased: string, returned: string): boolean {
  let before: CodexAuthFile;
  let after: CodexAuthFile;
  try {
    before = parseAuthFile(leased);
    after = parseAuthFile(returned);
  } catch {
    return false;
  }
  if ((before.auth_mode ?? null) !== (after.auth_mode ?? null)) return false;
  if (before.tokens?.refresh_token) {
    const account = before.tokens.account_id;
    return Boolean(after.tokens?.refresh_token) && (account === undefined || after.tokens?.account_id === account);
  }
  return after.OPENAI_API_KEY === before.OPENAI_API_KEY;
}

/** `Harness.auth` for Codex. */
export function codexAuth(cred: HarnessCredential, ctx: AuthContext): AuthPlan {
  const path = authFilePath(ctx.paths.home);
  switch (cred.kind) {
    case "auth-file": {
      const content = pickValue(ctx.values, AUTH_FILE_VALUE_NAMES);
      if (!content) throw new MissingCredentialError({ consumer: "codex (auth-file)" });
      parseAuthFile(content);
      return {
        env: {},
        files: [{ path, content, mode: 0o600, secret: true, owner: "agent" }],
        stripEnv: [...CODEX_AUTH_ENV],
        // Codex rewrites this file when it refreshes; the refreshed copy goes back to the pool after the call.
        leasedFile: { path, accepts: (returned) => sameCodexLogin(content, returned) },
      };
    }
    case "api-key": {
      const key = pickValue(ctx.values, API_KEY_VALUE_NAMES);
      if (!key) throw new MissingCredentialError({ consumer: "codex (api-key)" });
      const content = `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }, null, 2)}\n`;
      return {
        env: {},
        files: [{ path, content, mode: 0o600, secret: true, owner: "agent" }],
        stripEnv: [...CODEX_AUTH_ENV],
      };
    }
    default:
      throw new ConfigError(
        `Codex takes an "auth-file" credential (auth.json, leased) or an "api-key"; got "${cred.kind}".`,
      );
  }
}
