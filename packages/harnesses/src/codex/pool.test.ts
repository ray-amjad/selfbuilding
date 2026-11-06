import type { HarnessCredential, HarnessFailure } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { classifyCodexMessage } from "./classify.js";
import { credentialFailover, credentialPool, isAccountFailure, pickCredential, resumeNudge } from "./pool.js";

const login = (n: number): HarnessCredential => ({ kind: "auth-file", value: `login-${n}`, leased: true });
const key = (n: number): HarnessCredential => ({ kind: "api-key", value: `key-${n}` });
const failure = (code: HarnessFailure["code"]): HarnessFailure => ({ code, retryable: false, message: code });

describe("credentialPool", () => {
  it("puts subscriptions first and keeps the given order inside each group", () => {
    expect(credentialPool([key(1), login(1), key(2), login(2)])).toEqual([login(1), login(2), key(1), key(2)]);
    expect(credentialPool(key(1))).toEqual([key(1)]);
    expect(credentialPool(undefined)).toEqual([]);
  });

  it("pins the first credential nobody else holds", () => {
    const pool = credentialPool([login(1), login(2), key(1)]);
    expect(pickCredential(pool)).toBe(0);
    expect(pickCredential(pool, new Set([0]))).toBe(1);
    expect(pickCredential(pool, new Set([0, 1, 2]))).toBe(-1);
  });
});

describe("isAccountFailure", () => {
  const pool = [login(1), key(1)];

  it("auth and quota always move the pool", () => {
    expect(isAccountFailure(login(1), failure("auth"), pool)).toBe(true);
    expect(isAccountFailure(key(1), failure("quota"), pool)).toBe(true);
  });

  it("a rate-limited subscription falls back to an API key; a rate-limited key does not move", () => {
    expect(isAccountFailure(login(1), failure("rate_limit"), pool)).toBe(true);
    expect(isAccountFailure(login(1), failure("rate_limit"), [login(1), login(2)])).toBe(false);
    expect(isAccountFailure(key(1), failure("rate_limit"), [key(1), key(2)])).toBe(false);
  });

  it("never moves for provider, billing, invalid requests, crashes or a bare 403", () => {
    for (const code of [
      "provider",
      "billing",
      "invalid_request",
      "context_overflow",
      "harness_crash",
      "unknown",
    ] as const) {
      expect(isAccountFailure(login(1), failure(code), pool)).toBe(false);
    }
    expect(isAccountFailure(login(1), classifyCodexMessage("unexpected status 403 Forbidden"), pool)).toBe(false);
  });
});

describe("credentialFailover", () => {
  const pool = credentialPool([login(1), key(1)]);

  it("a quota failure with no effects starts a fresh attempt on the next credential", () => {
    expect(
      credentialFailover({ pool, current: 0, failure: failure("quota"), turnHadEffects: false, canResume: true }),
    ).toEqual({ action: "fresh", next: 1 });
  });

  it("after effects it resumes the same session on the next credential, never a fresh one", () => {
    expect(
      credentialFailover({ pool, current: 0, failure: failure("quota"), turnHadEffects: true, canResume: true }),
    ).toEqual({ action: "resume", next: 1 });
    expect(
      credentialFailover({ pool, current: 0, failure: failure("auth"), turnHadEffects: true, canResume: false }),
    ).toMatchObject({ action: "fail" });
  });

  it("stays on the credential when the failure is not about the account", () => {
    expect(
      credentialFailover({ pool, current: 0, failure: failure("provider"), turnHadEffects: true, canResume: true }),
    ).toEqual({ action: "stay" });
  });

  it("fails when every other credential has failed or is leased elsewhere", () => {
    expect(
      credentialFailover({
        pool,
        current: 1,
        failure: failure("auth"),
        turnHadEffects: false,
        canResume: true,
        unavailable: new Set([0]),
      }),
    ).toMatchObject({ action: "fail", reason: expect.stringContaining("auth") });
    expect(
      credentialFailover({
        pool: [key(1)],
        current: 0,
        failure: failure("auth"),
        turnHadEffects: false,
        canResume: true,
      }),
    ).toMatchObject({ action: "fail" });
  });

  it("skips a busy credential and wraps to an earlier one that was only busy", () => {
    const three = credentialPool([login(1), login(2), key(1)]);
    expect(
      credentialFailover({
        pool: three,
        current: 0,
        failure: failure("quota"),
        turnHadEffects: false,
        canResume: true,
        unavailable: new Set([1]),
      }),
    ).toEqual({ action: "fresh", next: 2 });
    expect(
      credentialFailover({
        pool: three,
        current: 1,
        failure: failure("auth"),
        turnHadEffects: false,
        canResume: true,
        unavailable: new Set([2]),
      }),
    ).toEqual({ action: "fresh", next: 0 });
  });

  it("the resume nudge is the fixed text with the failure code", () => {
    expect(resumeNudge("quota")).toBe(
      "Your previous turn stopped because of a model API error (quota). Your work so far is in this session and in " +
        "the working tree. Check `git status`, `git log` and any external actions you already took before you continue. " +
        "Do not repeat actions that already took effect. Continue the task and call submit_result when done.",
    );
  });
});
