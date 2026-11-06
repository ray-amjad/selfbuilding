import { ConfigError, MissingCredentialError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { pat } from "./pat.js";

const req = { repo: "github.com/acme/api", runId: "ns_1", callPath: "ImplementSpec#0" };
const now = () => Date.parse("2026-11-01T00:00:00Z");

describe("pat()", () => {
  it("gives the agent the separate read PAT and the host the push PAT, both marked long-lived", async () => {
    const broker = pat({ read: "read-pat", push: async () => "push-pat", now });
    expect(broker.id).toBe("pat");
    expect(await broker.readToken(req)).toEqual({
      value: "read-pat",
      expiresAt: "2026-11-01T01:00:00.000Z",
      permissions: { contents: "read", metadata: "read" },
      longLived: true,
    });
    expect(await broker.pushToken({ ...req, launchId: "l1" })).toEqual({
      value: "push-pat",
      expiresAt: "2026-11-01T01:00:00.000Z",
      permissions: { contents: "write", metadata: "read" },
      longLived: true,
    });
    expect(broker.describe?.()).toEqual({ broker: "pat", host: "github.com", separateReadToken: true });
  });

  it("with only a push PAT, marks the read token clone-only so the agent never holds it", async () => {
    const token = await pat({ push: "push-pat", now }).readToken(req);
    expect(token).toMatchObject({ value: "push-pat", cloneOnly: true, longLived: true });
    expect(token.permissions.contents).toBe("write");
  });

  it("rejects bad config and empty secrets", async () => {
    expect(() => pat({ push: "" })).toThrow(ConfigError);
    await expect(pat({ push: async () => "" }).pushToken({ ...req, launchId: "l" })).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
    await expect(pat({ push: "p" }).readToken({ ...req, repo: "gitlab.com/a/b" })).rejects.toThrow(/gitlab\.com/);
    await expect(pat({ push: "p" }).pushToken({ ...req, launchId: "" })).rejects.toThrow(/launchId/);
  });

  it("has no ruleset check or revoke: a PAT cannot be proven limited", () => {
    const broker = pat({ push: "p" });
    expect(broker.assertProtected).toBeUndefined();
    expect(broker.revoke).toBeUndefined();
  });
});
