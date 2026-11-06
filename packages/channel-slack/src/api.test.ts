import { ChannelDeliveryError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { SlackApi } from "./api.js";

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function scripted(responses: Array<Response | Error>) {
  const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    seen.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn, seen };
}

const api = (fetchFn: typeof fetch, retries = 3) =>
  new SlackApi({
    baseUrl: "https://slack.test/api",
    token: async () => "xoxb-test",
    fetch: fetchFn,
    retries,
    retryDelayMs: 1,
  });

describe("SlackApi", () => {
  it("posts JSON with bearer auth and returns the parsed body", async () => {
    const { fetchFn, seen } = scripted([respond(200, { ok: true, ts: "1.0" })]);
    await expect(api(fetchFn).call("chat.postMessage", { channel: "C1" })).resolves.toMatchObject({ ts: "1.0" });
    expect(seen[0]).toEqual({
      url: "https://slack.test/api/chat.postMessage",
      auth: "Bearer xoxb-test",
      body: { channel: "C1" },
    });
  });

  it("retries 429, 5xx, ratelimited and network errors, then gives up with ChannelDeliveryError", async () => {
    const { fetchFn, seen } = scripted([
      respond(429, {}, { "retry-after": "0" }),
      respond(503, {}),
      new TypeError("fetch failed"),
      respond(200, { ok: false, error: "ratelimited" }),
    ]);
    const failure = api(fetchFn, 3).call("chat.update", {});
    await expect(failure).rejects.toBeInstanceOf(ChannelDeliveryError);
    await expect(failure).rejects.toThrow(/after 4 attempts: ratelimited/);
    expect(seen).toHaveLength(4);
  });

  it("succeeds after transient failures", async () => {
    const { fetchFn, seen } = scripted([respond(500, {}), respond(200, { ok: true })]);
    await expect(api(fetchFn).call("chat.update", {})).resolves.toMatchObject({ ok: true });
    expect(seen).toHaveLength(2);
  });

  it("does not retry a user error and names the fix", async () => {
    const { fetchFn, seen } = scripted([respond(200, { ok: false, error: "not_in_channel" })]);
    const failure = api(fetchFn).call("chat.postMessage", {});
    await expect(failure).rejects.toBeInstanceOf(ChannelDeliveryError);
    await expect(failure).rejects.toThrow(/Invite the Selfbuilding bot/);
    expect(seen).toHaveLength(1);
  });
});
