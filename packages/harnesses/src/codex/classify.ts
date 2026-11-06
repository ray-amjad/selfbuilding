import type { FailureSignal, HarnessFailure } from "@selfbuilding/core";
import { SELFBUILDING_SERVER } from "./constants.js";

// The only place that reads Codex's error wording (spec §4.12). Bundled into the runtime with the parser, so it
// imports nothing but types and constants.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Codex wraps vendor errors as text around JSON, e.g. `unexpected status 429 Too Many Requests: {"error":{...}}`.
 * Returns the innermost human message plus the vendor's `type`/`code`, which carry the most reliable signal.
 */
export function unwrapMessage(raw: string): { message: string; vendorCode: string; status?: number } {
  let message = raw.trim();
  const codes: string[] = [];
  const status = statusOf(message);
  for (let depth = 0; depth < 4; depth++) {
    const start = message.indexOf("{");
    if (start < 0) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.slice(start));
    } catch {
      break;
    }
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : parsed;
    if (!isObject(error)) break;
    for (const key of ["type", "code"]) if (typeof error[key] === "string") codes.push(error[key] as string);
    if (typeof error.message !== "string" || error.message === "") break;
    message = error.message.trim();
  }
  return { message, vendorCode: codes.join(" "), ...(status === undefined ? {} : { status }) };
}

function statusOf(text: string): number | undefined {
  const match = /(?:unexpected status|last status:|status(?: code)?:?|HTTP\/\d(?:\.\d)?)\s*(\d{3})\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("ms") || u.startsWith("milli")) return UNIT_MS.ms as number;
  if (u.startsWith("mi")) return UNIT_MS.m as number;
  return UNIT_MS[u[0] as string] ?? 1000;
}

/** "try again in 4 days 3 hours 22 minutes", "Please try again in 1.5s", "retry after 20 seconds". */
export function retryAfterMs(text: string): number | undefined {
  const lead = /(?:try again in|retry after|retry in|resets in)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(
    text,
  );
  if (lead?.[1]) {
    let total = 0;
    for (const part of lead[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      total += Number(part[1]) * unitMs(part[2] as string);
    }
    if (total > 0) return Math.round(total);
  }
  const seconds = /"?resets_in_seconds"?\s*[:=]\s*(\d+)/i.exec(text);
  return seconds ? Number(seconds[1]) * 1000 : undefined;
}

const SELFBUILDING_MCP_DOWN = new RegExp(
  `MCP (?:client for|server) [\`'"]?${SELFBUILDING_SERVER}[\`'"]? (?:failed to start|timed out)|MCP startup (?:failed|incomplete|interrupted)[^]*\\b${SELFBUILDING_SERVER}\\b`,
  "i",
);

/** True when the text says the `selfbuilding` MCP server never came up: no `submit_result`, so the call cannot work. */
export function isSelfbuildingMcpFailure(text: string): boolean {
  return SELFBUILDING_MCP_DOWN.test(text);
}

const fail = (
  code: HarnessFailure["code"],
  retryable: boolean,
  message: string,
  retryAfter?: number,
): HarnessFailure => ({ code, retryable, message, ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }) });

/**
 * Classifies one piece of Codex error text. Account failures (`auth`, `quota`) are matched narrowly: they move a
 * credential pool to its next account, and a bare 403 or a tool's permission error must not (spec §4.9).
 */
export function classifyCodexMessage(raw: string): HarnessFailure {
  const { message, vendorCode, status } = unwrapMessage(raw);
  const text = `${raw} ${vendorCode}`;
  const after = retryAfterMs(text);

  if (isSelfbuildingMcpFailure(text)) return fail("harness_crash", false, message);
  if (/usage limit|usage_limit_reached|usage_not_included|hit your usage limit/i.test(text)) {
    return fail("quota", false, message, after);
  }
  if (/insufficient_quota|quota exceeded|check your plan and billing|billing_hard_limit|out of credits?/i.test(text)) {
    return fail("billing", false, message);
  }
  if (/context_length_exceeded|context window|ran out of room|maximum context length|prompt is too long/i.test(text)) {
    return fail("context_overflow", false, message);
  }
  if (
    status === 401 ||
    /unauthori[sz]ed|invalid_api_key|incorrect api key|access token could not be refreshed|refresh token|sign in again|log in again|not logged in|token_expired|token (?:has )?expired|account (?:has been )?deactivated|organization (?:has been )?disabled/i.test(
      text,
    )
  ) {
    return fail("auth", false, message);
  }
  if (status === 429 || /rate.?limit|too many requests|overloaded|slow_down/i.test(text)) {
    return fail("rate_limit", true, message, after);
  }
  if (
    (status !== undefined && status >= 500) ||
    /stream disconnected|internal server error|bad gateway|service unavailable|gateway timeout|connection (?:reset|refused|closed)|exceeded retry limit|server_error/i.test(
      text,
    )
  ) {
    return fail("provider", true, message, after);
  }
  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    /invalid_request|bad request|model .*(?:not found|does not exist|not supported)|unsupported (?:model|parameter|value)|invalid (?:model|value|parameter)/i.test(
      text,
    )
  ) {
    return fail("invalid_request", false, message);
  }
  return fail("unknown", false, message);
}

function eventMessage(event: unknown): string {
  if (typeof event === "string") return event;
  if (!isObject(event)) return "unknown error";
  if (typeof event.message === "string") return event.message;
  if (isObject(event.error) && typeof event.error.message === "string") return event.error.message;
  if (isObject(event.item)) return eventMessage(event.item);
  return JSON.stringify(event);
}

const ACCOUNT_OR_VENDOR = new Set<HarnessFailure["code"]>([
  "auth",
  "quota",
  "rate_limit",
  "billing",
  "context_overflow",
  "provider",
  "invalid_request",
]);

/** `Harness.classify`: a native error event, or the process exit with its stderr tail. */
export function classifyCodexFailure(signal: FailureSignal): HarnessFailure {
  if (signal.kind === "event") return classifyCodexMessage(eventMessage(signal.event));
  const tail = signal.stderrTail.trim();
  if (tail) {
    // stderr is diagnostics only, but a CLI that dies before streaming (bad auth.json, unknown model) says why here.
    const fromStderr = classifyCodexMessage(tail.split("\n").slice(-20).join("\n"));
    if (ACCOUNT_OR_VENDOR.has(fromStderr.code)) return fromStderr;
  }
  const how = signal.signal ? `signal ${signal.signal}` : `code ${signal.code}`;
  const why = signal.code === 127 ? " (the codex binary was not found)" : "";
  const lastLine = tail.split("\n").at(-1);
  return fail("harness_crash", false, `codex exited with ${how}${why}${lastLine ? `: ${lastLine}` : ""}`);
}
