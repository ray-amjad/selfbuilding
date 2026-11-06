import { ConfigError, CredentialRefreshError, MissingCredentialError } from "@selfbuilding/core";
import { canonicalPaths } from "@selfbuilding/testing";
import { describe, expect, it } from "vitest";
import { authFilePath, authFileStatus, codexAuth, parseAuthFile, sameCodexLogin } from "./auth.js";

// Fake tokens only: these are shaped like a Codex login, never real credentials.
const jwt = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

const fakeLogin = (opts: { exp?: number; refresh?: string; account?: string; lastRefresh?: string } = {}) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ sub: "user" }),
      access_token: jwt({ exp: opts.exp ?? 2_000_000_000 }),
      refresh_token: opts.refresh ?? "rt-fake-1",
      account_id: opts.account ?? "acct-fake",
    },
    last_refresh: opts.lastRefresh ?? "2026-11-01T10:00:00Z",
  });

const paths = canonicalPaths();

describe("codexAuth", () => {
  it("auth-file: writes the login as a 0600 file, leases it, and strips the API-key variables", () => {
    const content = fakeLogin();
    const plan = codexAuth({ kind: "auth-file", value: "x", leased: true }, { paths, values: { AUTH_FILE: content } });
    expect(plan).toEqual({
      env: {},
      files: [{ path: "/selfbuilding/home/.codex/auth.json", content, mode: 0o600, secret: true, owner: "agent" }],
      stripEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
      leasedFile: { path: "/selfbuilding/home/.codex/auth.json", accepts: expect.any(Function) },
    });
  });

  it("auth-file: a copy returned from the box goes back to the pool only when it is the same login", () => {
    const content = fakeLogin();
    const plan = codexAuth({ kind: "auth-file", value: "x", leased: true }, { paths, values: { AUTH_FILE: content } });
    const accepts = plan.leasedFile?.accepts;
    expect(accepts?.(fakeLogin({ refresh: "rt-fake-2", lastRefresh: "2026-11-02T10:00:00Z" }))).toBe(true);
    // Another account, a corrupt object, an API-key file, or a file with no login: the agent rewrote it.
    expect(accepts?.(fakeLogin({ account: "acct-attacker" }))).toBe(false);
    expect(accepts?.(JSON.stringify({ x: 1 }))).toBe(false);
    expect(accepts?.(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-other" }))).toBe(false);
    expect(accepts?.("not json")).toBe(false);
    expect(sameCodexLogin(content, content)).toBe(true);
  });

  it("api-key: the key goes into auth.json in API-key mode, never into env or argv, and is not leased", () => {
    const plan = codexAuth({ kind: "api-key", value: "x" }, { paths, values: { CODEX_API_KEY: "sk-fake" } });
    expect(plan.env).toEqual({});
    expect(plan.leasedFile).toBeUndefined();
    expect(plan.stripEnv).toContain("OPENAI_API_KEY");
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({ path: authFilePath(paths.home), mode: 0o600, secret: true, owner: "agent" });
    expect(JSON.parse(plan.files[0]?.content ?? "")).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fake" });
  });

  it("finds the value under its usual names, or as the only value", () => {
    const only = codexAuth({ kind: "api-key", value: "x" }, { paths, values: { WHATEVER: "sk-only" } });
    expect(JSON.parse(only.files[0]?.content ?? "").OPENAI_API_KEY).toBe("sk-only");
    const named = codexAuth({ kind: "api-key", value: "x" }, { paths, values: { OPENAI_API_KEY: "sk-a", OTHER: "b" } });
    expect(JSON.parse(named.files[0]?.content ?? "").OPENAI_API_KEY).toBe("sk-a");
  });

  it("rejects a missing value, a broken auth file and credential kinds Codex cannot use", () => {
    expect(() => codexAuth({ kind: "api-key", value: "x" }, { paths, values: {} })).toThrow(MissingCredentialError);
    expect(() =>
      codexAuth({ kind: "auth-file", value: "x", leased: true }, { paths, values: { AUTH_FILE: "{not json" } }),
    ).toThrow(CredentialRefreshError);
    expect(() => codexAuth({ kind: "oauth-token", value: "x" }, { paths, values: { T: "t" } })).toThrow(ConfigError);
    expect(() => codexAuth({ kind: "provider-keys", values: {} }, { paths, values: {} })).toThrow(ConfigError);
  });
});

describe("parseAuthFile and authFileStatus", () => {
  it("needs a refresh token or an API key", () => {
    expect(() => parseAuthFile("[]")).toThrow(CredentialRefreshError);
    expect(() => parseAuthFile(JSON.stringify({ tokens: { access_token: "a" } }))).toThrow(/refresh token/);
    expect(parseAuthFile(JSON.stringify({ OPENAI_API_KEY: "sk" })).OPENAI_API_KEY).toBe("sk");
  });

  it("reads expiry from the access token itself, with the caller's clock", () => {
    const exp = 1_800_000_000;
    const before = authFileStatus(fakeLogin({ exp }), exp * 1000 - 1);
    expect(before).toEqual({
      mode: "chatgpt",
      accountId: "acct-fake",
      accessTokenExpiresAt: exp * 1000,
      accessTokenExpired: false,
      hasRefreshToken: true,
      usable: true,
    });
    const after = authFileStatus(fakeLogin({ exp }), exp * 1000);
    expect(after).toMatchObject({ accessTokenExpired: true, usable: true });
    expect(authFileStatus(JSON.stringify({ OPENAI_API_KEY: "sk" }), 0)).toMatchObject({ mode: "apikey", usable: true });
  });
});
