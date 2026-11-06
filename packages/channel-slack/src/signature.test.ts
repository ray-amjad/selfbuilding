import { createHmac } from "node:crypto";
import { WebhookSignatureError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { slack } from "./index.js";
import { SLACK_MAX_SKEW_SECONDS, signSlackRequest, verifySlackSignature } from "./signature.js";

const secret = "test-signing-secret";
const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
const now = 1_790_000_000;

// Built by hand, independently of signSlackRequest, because emulators always sign correctly.
const handSigned = (ts: number, raw = body, key = secret) =>
  `v0=${createHmac("sha256", key).update(`v0:${ts}:${raw}`).digest("hex")}`;

describe("verifySlackSignature", () => {
  it("accepts a correct v0 signature, from a string or from bytes", () => {
    expect(signSlackRequest(secret, now, body)).toBe(handSigned(now));
    const input = { signingSecret: secret, timestamp: String(now), signature: handSigned(now), nowSeconds: now };
    expect(() => verifySlackSignature({ ...input, rawBody: body })).not.toThrow();
    expect(() => verifySlackSignature({ ...input, rawBody: new TextEncoder().encode(body) })).not.toThrow();
  });

  it.each([
    ["a tampered body", { rawBody: `${body}x` }],
    ["the wrong secret", { signature: handSigned(now, body, "other-secret") }],
    ["a missing signature", { signature: null }],
    ["a missing timestamp", { timestamp: null }],
    ["a non-numeric timestamp", { timestamp: "12abc" }],
    ["a non-v0 scheme", { signature: handSigned(now).replace("v0=", "v1=") }],
    ["a truncated signature", { signature: handSigned(now).slice(0, 20) }],
  ])("rejects %s with WebhookSignatureError", (_name, override) => {
    const input = {
      signingSecret: secret,
      timestamp: String(now),
      signature: handSigned(now),
      rawBody: body,
      nowSeconds: now,
      ...override,
    };
    expect(() => verifySlackSignature(input)).toThrow(WebhookSignatureError);
  });

  it("enforces the five-minute skew in both directions, inclusive at the limit", () => {
    for (const offset of [SLACK_MAX_SKEW_SECONDS, -SLACK_MAX_SKEW_SECONDS]) {
      const ts = now + offset;
      expect(() =>
        verifySlackSignature({
          signingSecret: secret,
          timestamp: String(ts),
          signature: handSigned(ts),
          rawBody: body,
          nowSeconds: now,
        }),
      ).not.toThrow();
    }
    for (const offset of [SLACK_MAX_SKEW_SECONDS + 1, -(SLACK_MAX_SKEW_SECONDS + 1)]) {
      const ts = now + offset;
      expect(() =>
        verifySlackSignature({
          signingSecret: secret,
          timestamp: String(ts),
          signature: handSigned(ts),
          rawBody: body,
          nowSeconds: now,
        }),
      ).toThrow(/away from this server's clock/);
    }
  });
});

describe("slack().verify", () => {
  const request = (headers: Record<string, string>) =>
    new Request("http://localhost/slack", { method: "POST", headers, body });

  it("returns true for a signed request and false, with a skip line, otherwise", async () => {
    const lines: string[] = [];
    const channel = slack({
      channel: "#factory",
      signingSecret: secret,
      now: () => now * 1000,
      log: (l) => lines.push(l),
    });
    const raw = new TextEncoder().encode(body);
    const good = { "x-slack-request-timestamp": String(now), "x-slack-signature": handSigned(now) };
    expect(await channel.verify(request(good), raw)).toBe(true);
    expect(await channel.verify(request({ ...good, "x-slack-signature": handSigned(now, "other") }), raw)).toBe(false);
    const stale = now - 3600;
    expect(
      await channel.verify(
        request({ "x-slack-request-timestamp": String(stale), "x-slack-signature": handSigned(stale) }),
        raw,
      ),
    ).toBe(false);
    expect(await channel.verify(request({}), raw)).toBe(false);
    expect(lines.filter((l) => l.startsWith("skip [signature]"))).toHaveLength(3);
  });

  it("resolves the signing secret lazily, from a function or SLACK_SIGNING_SECRET", async () => {
    const raw = new TextEncoder().encode(body);
    const headers = { "x-slack-request-timestamp": String(now), "x-slack-signature": handSigned(now) };
    const fromFn = slack({ channel: "C1", signingSecret: async () => secret, now: () => now * 1000 });
    expect(await fromFn.verify(request(headers), raw)).toBe(true);

    const previous = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = secret;
    try {
      const fromEnv = slack({ channel: "C1", now: () => now * 1000 });
      expect(await fromEnv.verify(request(headers), raw)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SLACK_SIGNING_SECRET;
      else process.env.SLACK_SIGNING_SECRET = previous;
    }
  });

  it("throws MissingSecretError when no signing secret is configured anywhere", async () => {
    const previous = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    try {
      const channel = slack({ channel: "C1" });
      await expect(channel.verify(request({}), new Uint8Array())).rejects.toMatchObject({
        name: "MissingSecretError",
        secret: "SLACK_SIGNING_SECRET",
      });
    } finally {
      if (previous !== undefined) process.env.SLACK_SIGNING_SECRET = previous;
    }
  });
});
