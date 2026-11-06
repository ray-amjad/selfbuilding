import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentCallback, DurableHost } from "@selfbuilding/core";
import type { FetchHandler } from "./hitl.js";

/** The header the in-sandbox bridge puts its signature in: `v1=<hex HMAC-SHA256>`. */
export const CALLBACK_SIGNATURE_HEADER = "x-selfbuilding-signature";
/** The domain separator for wake callbacks; a body signed for another route never verifies here. */
export const CALLBACK_KIND = "agent.callback";

/**
 * Signs a wake callback body the way the bridge must: HMAC-SHA256 keyed by the call's `callbackToken`,
 * over `kind + body` (spec §6.6). Returns the header value.
 */
export function signCallback(callbackToken: string, body: string | Uint8Array, kind: string = CALLBACK_KIND): string {
  const hmac = createHmac("sha256", callbackToken);
  hmac.update(kind);
  hmac.update(body);
  return `v1=${hmac.digest("hex")}`;
}

export interface CallbackHandlerOptions {
  host?: DurableHost;
  /**
   * Resolves the callbackToken of one launch of one run, so the HMAC can be checked. null = unknown pair. Look it
   * up by both: launch ids derive from step keys, which two runs of the same factory on the same input share.
   */
  tokenFor(launchId: string, runId: string): Promise<string | null>;
  /**
   * Records the callback and wakes the host (spec §7.5.2: write `callbacks/<runId>/<launchId>.json`, then
   * send the host event). A throw answers 500, so the bridge retries.
   */
  onCallback(body: AgentCallback): Promise<void>;
  /** Domain separator. Default "agent.callback". */
  kind?: string;
  /** Where `skip [reason]` lines go. Default console.warn. */
  log?: (line: string) => void;
  /** Larger bodies get 413. Default 16 KiB; a callback is a few hundred bytes. */
  maxBodyBytes?: number;
}

const STATUSES = new Set<AgentCallback["status"]>([
  "submitted",
  "no_result",
  "failed",
  "timeout",
  "stopped",
  "lost",
  "finished",
  "ask",
]);
const SOURCES = new Set<AgentCallback["source"]>(["runtime", "reaper", "cancel"]);

function asCallback(value: unknown): AgentCallback | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok =
    v.v === 1 &&
    typeof v.runId === "string" &&
    typeof v.stepKey === "string" &&
    typeof v.launchId === "string" &&
    /_e\d+_l\d+$/.test(v.launchId) &&
    typeof v.status === "string" &&
    STATUSES.has(v.status as AgentCallback["status"]) &&
    typeof v.rearm === "number" &&
    Number.isInteger(v.rearm) &&
    v.rearm >= 0 &&
    typeof v.source === "string" &&
    SOURCES.has(v.source as AgentCallback["source"]) &&
    typeof v.at === "string";
  return ok ? (value as AgentCallback) : null;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Sandbox wake callbacks: verify the per-launch HMAC, record, then wake the host (spec §6.6, §7.5.2). */
export function createCallbackHandler(opts: CallbackHandlerOptions): FetchHandler {
  const kind = opts.kind ?? CALLBACK_KIND;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const maxBody = opts.maxBodyBytes ?? 16 * 1024;
  // A wake is a hint; repeats after a success are acknowledged without waking the host again.
  const delivered = new Set<string>();

  return async (req) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    if (Number(req.headers.get("content-length") ?? "0") > maxBody) return json(413, { error: "payload too large" });
    const rawBody = new Uint8Array(await req.arrayBuffer());
    if (rawBody.byteLength > maxBody) return json(413, { error: "payload too large" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      log("skip [callback-unreadable] body is not JSON");
      return json(400, { error: "body is not JSON" });
    }
    const callback = asCallback(parsed);
    if (!callback) {
      log("skip [callback-malformed] body is not an AgentCallback v1");
      return json(400, { error: "body is not an AgentCallback v1" });
    }

    const token = await opts.tokenFor(callback.launchId, callback.runId);
    if (token === null) {
      log(`skip [unknown-launch] ${callback.launchId}`);
      return json(404, { error: "unknown launch" });
    }
    const given = Buffer.from(req.headers.get(CALLBACK_SIGNATURE_HEADER) ?? "");
    const expected = Buffer.from(signCallback(token, rawBody, kind));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      log(`skip [signature] callback for ${callback.launchId}`);
      return json(401, { error: "invalid signature" });
    }

    const key = `${callback.runId}|${callback.launchId}|w${callback.rearm}|${callback.status}|${callback.source}`;
    if (delivered.has(key)) {
      log(`skip [duplicate-callback] ${key}`);
      return json(200, { ok: true, duplicate: true });
    }
    try {
      await opts.onCallback(callback);
    } catch (error) {
      log(`callback for ${callback.launchId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return json(500, { error: "callback could not be recorded; retry" });
    }
    delivered.add(key);
    if (delivered.size > 10_000) delivered.delete(delivered.values().next().value as string);
    return json(200, { ok: true });
  };
}
