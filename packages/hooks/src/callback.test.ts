import { createHmac } from "node:crypto";
import type { AgentCallback } from "@selfbuilding/core";
import { describe, expect, it, vi } from "vitest";
import {
  CALLBACK_KIND,
  CALLBACK_SIGNATURE_HEADER,
  createCallbackHandler,
  memoryDedupe,
  signCallback,
} from "./index.js";

const token = "cbt-test-token";
const launchId = "STEPKEY000000000000000000A_e0_l1";
const callback: AgentCallback = {
  v: 1,
  runId: "run_1",
  stepKey: "STEPKEY000000000000000000A",
  launchId,
  status: "submitted",
  rearm: 0,
  source: "runtime",
  at: "2026-11-01T10:00:00.000Z",
};

function setup(over: { onCallback?: (b: AgentCallback) => Promise<void> } = {}) {
  const lines: string[] = [];
  const onCallback = vi.fn(over.onCallback ?? (async () => {}));
  const handler = createCallbackHandler({
    tokenFor: async (id) => (id === launchId ? token : null),
    onCallback,
    log: (l) => lines.push(l),
  });
  const send = (body: string, signature?: string, method = "POST") =>
    handler(
      new Request("http://localhost/callbacks", {
        method,
        headers: signature === undefined ? {} : { [CALLBACK_SIGNATURE_HEADER]: signature },
        ...(method === "POST" ? { body } : {}),
      }),
    );
  return { handler, onCallback, lines, send };
}

describe("signCallback", () => {
  it("is HMAC-SHA256 over kind + body, keyed by the callbackToken", () => {
    const body = JSON.stringify(callback);
    const expected = `v1=${createHmac("sha256", token).update(`${CALLBACK_KIND}${body}`).digest("hex")}`;
    expect(signCallback(token, body)).toBe(expected);
    expect(signCallback(token, new TextEncoder().encode(body))).toBe(expected);
  });
});

describe("createCallbackHandler", () => {
  it("verifies, records and acknowledges a signed callback", async () => {
    const { send, onCallback } = setup();
    const body = JSON.stringify(callback);
    const res = await send(body, signCallback(token, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(onCallback).toHaveBeenCalledWith(callback);
  });

  it("rejects a wrong key, a tampered body and another route's signature with 401", async () => {
    const { send, onCallback, lines } = setup();
    const body = JSON.stringify(callback);
    expect((await send(body, signCallback("other-token", body))).status).toBe(401);
    expect((await send(JSON.stringify({ ...callback, status: "failed" }), signCallback(token, body))).status).toBe(401);
    // Domain separation: a body signed for another kind never verifies here.
    expect((await send(body, signCallback(token, body, "ask.answer"))).status).toBe(401);
    expect((await send(body)).status).toBe(401);
    expect(onCallback).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.startsWith("skip [signature]"))).toHaveLength(4);
  });

  it("answers 404 for an unknown launch and 400 for a body that is not an AgentCallback", async () => {
    const { send } = setup();
    const unknown = JSON.stringify({ ...callback, launchId: "OTHER_e0_l1" });
    expect((await send(unknown, signCallback(token, unknown))).status).toBe(404);
    expect((await send("not json", "v1=00")).status).toBe(400);
    for (const bad of [
      { ...callback, v: 2 },
      { ...callback, status: "weird" },
      { ...callback, rearm: -1 },
      { ...callback, launchId: "x" },
    ]) {
      const body = JSON.stringify(bad);
      expect((await send(body, signCallback(token, body))).status).toBe(400);
    }
  });

  it("acknowledges a repeat of the same wake without waking the host again", async () => {
    const { send, onCallback, lines } = setup();
    const body = JSON.stringify(callback);
    await send(body, signCallback(token, body));
    const again = await send(body, signCallback(token, body));
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(onCallback).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.startsWith("skip [duplicate-callback]"))).toBe(true);
    const rearmed = JSON.stringify({ ...callback, rearm: 1 });
    await send(rearmed, signCallback(token, rearmed));
    expect(onCallback).toHaveBeenCalledTimes(2);
  });

  it("binds the token and the dedupe to the run: two runs sharing a launch id stay apart", async () => {
    const lines: string[] = [];
    const tokens: Record<string, string> = { run_1: "token-one", run_2: "token-two" };
    const onCallback = vi.fn(async () => {});
    const handler = createCallbackHandler({
      tokenFor: async (id, runId) => (id === launchId ? (tokens[runId] ?? null) : null),
      onCallback,
      log: (l) => lines.push(l),
    });
    const post = (body: string, signature: string) =>
      handler(
        new Request("http://localhost/callbacks", {
          method: "POST",
          headers: { [CALLBACK_SIGNATURE_HEADER]: signature },
          body,
        }),
      );
    const one = JSON.stringify(callback);
    const two = JSON.stringify({ ...callback, runId: "run_2" });
    expect((await post(one, signCallback("token-one", one))).status).toBe(200);
    // Run 2's own wake for the same launch id is not a duplicate of run 1's.
    const second = await post(two, signCallback("token-two", two));
    expect(await second.json()).toEqual({ ok: true });
    // Run 1's key cannot sign for run 2.
    const forged = JSON.stringify({ ...callback, runId: "run_2", status: "failed" });
    expect((await post(forged, signCallback("token-one", forged))).status).toBe(401);
    expect(onCallback).toHaveBeenCalledTimes(2);
  });

  it("answers 500 when recording fails so the bridge retries, then accepts the retry", async () => {
    let fail = true;
    const { send, onCallback } = setup({
      onCallback: async () => {
        if (fail) {
          fail = false;
          throw new Error("store unavailable");
        }
      },
    });
    const body = JSON.stringify(callback);
    expect((await send(body, signCallback(token, body))).status).toBe(500);
    expect((await send(body, signCallback(token, body))).status).toBe(200);
    expect(onCallback).toHaveBeenCalledTimes(2);
  });

  it("refuses other methods and oversized bodies", async () => {
    const { send } = setup();
    expect((await send("", undefined, "GET")).status).toBe(405);
    expect((await send("x".repeat(17 * 1024), "v1=00")).status).toBe(413);
  });
});

describe("memoryDedupe", () => {
  it("claims a key once within the TTL and evicts the oldest past the cap", async () => {
    let clock = 0;
    const dedupe = memoryDedupe({ ttlMs: 1000, max: 2, now: () => clock });
    expect(await dedupe.claim("a")).toBe(true);
    expect(await dedupe.claim("a")).toBe(false);
    clock = 1001;
    expect(await dedupe.claim("a")).toBe(true);
    expect(await dedupe.claim("b")).toBe(true);
    expect(await dedupe.claim("c")).toBe(true);
    // "a" was evicted to keep the map at two keys.
    expect(await dedupe.claim("a")).toBe(true);
    expect(await dedupe.claim("c")).toBe(false);
  });
});
