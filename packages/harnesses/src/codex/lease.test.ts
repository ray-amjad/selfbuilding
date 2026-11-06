import { CredentialRefreshError } from "@selfbuilding/core";
import { describe, expect, it, vi } from "vitest";
import { AuthFileLeases, chooseAuthFile } from "./lease.js";

// Fake logins only, shaped like Codex's auth.json.
const login = (refresh: string, lastRefresh: string, account = "acct-fake") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "a.e30.s", refresh_token: refresh, account_id: account },
    last_refresh: lastRefresh,
  });

const ORIGINAL = login("rt-1", "2026-11-01T10:00:00Z");
const REFRESHED = login("rt-2", "2026-11-01T11:00:00Z");

describe("chooseAuthFile", () => {
  it("takes the copy Codex refreshed", () => {
    expect(chooseAuthFile(ORIGINAL, REFRESHED)).toEqual({ content: REFRESHED, refreshed: true });
  });

  it("keeps the original when nothing changed or nothing came back", () => {
    expect(chooseAuthFile(ORIGINAL, ORIGINAL)).toEqual({ content: ORIGINAL, refreshed: false });
    expect(chooseAuthFile(ORIGINAL, undefined)).toMatchObject({ content: ORIGINAL, refreshed: false });
  });

  it("refuses a truncated file, a logged-out file, another account and an older file", () => {
    for (const bad of [
      REFRESHED.slice(0, 40),
      JSON.stringify({ auth_mode: "chatgpt", tokens: null }),
      login("rt-x", "2026-11-01T12:00:00Z", "acct-other"),
      login("rt-0", "2026-11-01T09:00:00Z"),
      login("rt-y", "not a date"),
    ]) {
      const decision = chooseAuthFile(ORIGINAL, bad);
      expect(decision.content).toBe(ORIGINAL);
      expect(decision.refreshed).toBe(false);
      expect(decision.rejected).toBeTruthy();
    }
  });
});

describe("AuthFileLeases", () => {
  it("leases each file to one sandbox at a time", async () => {
    const leases = new AuthFileLeases();
    const first = leases.acquire("login-1", "box-a", ORIGINAL);
    expect(first).toEqual({ key: "login-1", holder: "box-a", content: ORIGINAL });
    expect(leases.acquire("login-1", "box-b", ORIGINAL)).toBeNull();
    expect(leases.holder("login-1")).toBe("box-a");
    // Re-acquiring by the same holder (a resume in the same box) is allowed.
    expect(leases.acquire("login-1", "box-a", ORIGINAL)).not.toBeNull();
    await leases.release(first as NonNullable<typeof first>, undefined);
    expect(leases.holder("login-1")).toBeUndefined();
    expect(leases.acquire("login-1", "box-b", ORIGINAL)).not.toBeNull();
  });

  it("copies the refreshed file back and hands the newest copy to the next holder", async () => {
    const writeBack = vi.fn();
    const leases = new AuthFileLeases({ writeBack });
    const lease = leases.acquire("login-1", "box-a", ORIGINAL);
    const release = await leases.release(lease as NonNullable<typeof lease>, REFRESHED);
    expect(release).toEqual({ content: REFRESHED, refreshed: true });
    expect(writeBack).toHaveBeenCalledWith("login-1", REFRESHED);
    // The resolver still returns the stale original; the newer copy wins.
    expect(leases.acquire("login-1", "box-b", ORIGINAL)?.content).toBe(REFRESHED);
  });

  it("does not write back when the sandbox returned nothing usable", async () => {
    const writeBack = vi.fn();
    const leases = new AuthFileLeases({ writeBack });
    const lease = leases.acquire("login-1", "box-a", ORIGINAL);
    expect(await leases.release(lease as NonNullable<typeof lease>, "{}")).toMatchObject({ refreshed: false });
    expect(writeBack).not.toHaveBeenCalled();
  });

  it("keeps the refreshed copy and frees the lease even if the write-back fails", async () => {
    const leases = new AuthFileLeases({
      writeBack: () => {
        throw new Error("store down");
      },
    });
    const lease = leases.acquire("login-1", "box-a", ORIGINAL);
    await expect(leases.release(lease as NonNullable<typeof lease>, REFRESHED)).rejects.toThrow("store down");
    expect(leases.holder("login-1")).toBeUndefined();
    expect(leases.acquire("login-1", "box-b", ORIGINAL)?.content).toBe(REFRESHED);
  });

  it("rejects a release by a holder that does not hold the lease, and a broken file on acquire", async () => {
    const leases = new AuthFileLeases();
    await expect(leases.release({ key: "login-1", holder: "box-z", content: ORIGINAL }, REFRESHED)).rejects.toThrow(
      CredentialRefreshError,
    );
    expect(() => leases.acquire("login-2", "box-a", "nope")).toThrow(CredentialRefreshError);
    expect(leases.holder("login-2")).toBeUndefined();
  });
});
