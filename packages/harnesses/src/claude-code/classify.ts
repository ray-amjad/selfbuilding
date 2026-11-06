import type { FailureSignal, HarnessFailure } from "@selfbuilding/core";

// The only place Claude Code's vendor error text is read (spec §4.12). The runtime bundles this file with the parser,
// so it imports nothing but core types.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Order matters: the first matching rule wins. Each pattern is pinned by a fixture on both sides (spec §4.9).
const TEXT_RULES: { code: HarnessFailure["code"]; pattern: RegExp }[] = [
  { code: "billing", pattern: /credit balance is too low|billing|payment required|insufficient credit/i },
  {
    code: "quota",
    pattern:
      /hit your [\w -]{0,24}limit|usage limit|out of (extra )?usage|usage allocation has been disabled|usage limit is set to \$0|requires usage credits|doesn't include (extra )?usage|quota/i,
  },
  {
    code: "auth",
    pattern:
      /not logged in|please run \/login|invalid (x-)?api[ -]?key|invalid bearer token|oauth token (has )?(expired|revoked|is invalid)|token has expired|authentication[_ ](failed|error)|organization has been disabled|oauth authentication is (currently )?not (supported|allowed)|\b401\b|unauthorized/i,
  },
  {
    code: "context_overflow",
    pattern: /prompt is too long|context (window|length)|too many tokens|exceeds? the context/i,
  },
  { code: "rate_limit", pattern: /rate[_ ]?limit|too many requests|\b429\b/i },
  {
    code: "provider",
    pattern:
      /overloaded|\b5\d\d\b|internal server error|api_error|server[_ ]error|service unavailable|bad gateway|gateway timeout|connection (error|refused|reset)|econnrefused|econnreset|etimedout|fetch failed|socket hang up/i,
  },
  {
    code: "invalid_request",
    pattern:
      /invalid_request|invalid model|model .*(not found|does not exist|is not available)|not_found_error|invalid request/i,
  },
];

const RETRYABLE: ReadonlySet<HarnessFailure["code"]> = new Set(["rate_limit", "provider"]);

/** Classifies one vendor message. A bare 403 or `permission_error` is not an account failure (spec §4.9). */
export function classifyText(message: string): HarnessFailure {
  const text = message.trim() || "unknown error";
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) return { code: rule.code, retryable: RETRYABLE.has(rule.code), message: text };
  }
  return { code: "unknown", retryable: false, message: text };
}

// `system/api_retry.error` categories as Claude Code 2.1 names them.
function fromRetryCategory(category: string, status: number | null, message: string): HarnessFailure {
  switch (category) {
    case "rate_limit":
      return { code: "rate_limit", retryable: true, message };
    case "overloaded":
    case "server_error":
      return { code: "provider", retryable: true, message };
    case "authentication_failed":
      // Claude folds 403 into this category; a bare 403 is often a tool or org policy, not a dead account.
      return status === 403
        ? { code: "unknown", retryable: false, message }
        : { code: "auth", retryable: false, message };
    case "billing_error":
      return { code: "billing", retryable: false, message };
    case "invalid_request":
      return { code: "invalid_request", retryable: false, message };
    default:
      return classifyText(message);
  }
}

/** Pulls the human-readable message out of nested vendor JSON such as `API Error: 400 {"error":{"message":...}}`. */
export function unwrapMessage(raw: string): string {
  const start = raw.indexOf("{");
  if (start < 0) return raw.trim();
  try {
    const parsed: unknown = JSON.parse(raw.slice(start));
    const inner = isObject(parsed) && isObject(parsed.error) ? parsed.error : parsed;
    if (isObject(inner) && typeof inner.message === "string") {
      const prefix = raw.slice(0, start).trim();
      return prefix ? `${prefix} ${unwrapMessage(inner.message)}` : unwrapMessage(inner.message);
    }
  } catch {
    // Not JSON after all; keep the raw text.
  }
  return raw.trim();
}

function resultMessage(event: Json): string {
  if (typeof event.result === "string" && event.result.trim()) return unwrapMessage(event.result);
  if (Array.isArray(event.errors) && event.errors.length > 0) return event.errors.map(String).join("; ");
  if (typeof event.subtype === "string") return event.subtype;
  return "Claude Code reported an error";
}

/** Classifies a native Claude Code event (a `result`, `system/api_retry`, `rate_limit_event` or error message). */
export function classifyEvent(event: unknown): HarnessFailure {
  if (!isObject(event)) return classifyText(String(event ?? ""));
  if (event.type === "system" && event.subtype === "api_retry") {
    const status = typeof event.error_status === "number" ? event.error_status : null;
    const category = String(event.error ?? "unknown");
    const failure = fromRetryCategory(
      category,
      status,
      `API retry: ${category}${status === null ? "" : ` (${status})`}`,
    );
    return typeof event.retry_delay_ms === "number" ? { ...failure, retryAfterMs: event.retry_delay_ms } : failure;
  }
  if (event.type === "rate_limit_event" && isObject(event.rate_limit_info)) {
    const info = event.rate_limit_info;
    const kind = typeof info.rateLimitType === "string" ? ` (${info.rateLimitType})` : "";
    const reset =
      typeof info.resetsAt === "number" ? `; resets at ${new Date(info.resetsAt * 1000).toISOString()}` : "";
    return { code: "quota", retryable: false, message: `Subscription usage limit reached${kind}${reset}` };
  }
  if (event.type === "result") {
    const message = resultMessage(event);
    const failure = classifyText(message);
    const status = typeof event.api_error_status === "number" ? event.api_error_status : null;
    if (failure.code === "unknown" && status !== null) return { ...classifyText(`${status} ${message}`), message };
    return failure;
  }
  if (event.type === "assistant" && typeof event.error === "string") {
    const content = isObject(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
    const text = content
      .filter(isObject)
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join(" ")
      .trim();
    const message = unwrapMessage(text || event.error);
    const fromText = classifyText(message);
    return fromText.code === "unknown" ? fromRetryCategory(event.error, null, message) : fromText;
  }
  for (const key of ["message", "result", "error"] as const) {
    const value = event[key];
    if (typeof value === "string") return classifyText(unwrapMessage(value));
    if (isObject(value) && typeof value.message === "string") return classifyText(unwrapMessage(value.message));
  }
  return classifyText(JSON.stringify(event));
}

/** Classifies a process exit with no terminal stream event. */
export function classifyExit(exit: { code: number | null; signal: string | null; stderrTail: string }): HarnessFailure {
  const tail = exit.stderrTail.trim();
  const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
  if (tail) {
    const fromText = classifyText(tail);
    if (fromText.code !== "unknown")
      return { ...fromText, message: `Claude Code exited with ${how}: ${fromText.message}` };
  }
  let hint = "";
  if (exit.code === 127) hint = " (the claude binary is missing; check the image or the install plan)";
  else if (exit.code === 143 || exit.signal === "SIGTERM")
    hint = " (SIGTERM: Claude Code records no result for the turn)";
  return {
    code: "harness_crash",
    retryable: false,
    message: `Claude Code exited with ${how}${hint}${tail ? `: ${tail}` : ""}`,
  };
}

export function classifyClaudeFailure(signal: FailureSignal): HarnessFailure {
  return signal.kind === "event" ? classifyEvent(signal.event) : classifyExit(signal);
}
