import {
  ImageUnavailableError,
  SandboxAuthError,
  SandboxFileNotFoundError,
  SandboxGuestGoneError,
  SandboxNotFoundError,
  SandboxQuotaError,
  SandboxUnavailableError,
  SandboxUnsupportedError,
  SelfbuildingError,
} from "@selfbuilding/core";

/** Where an SDK call was made. `file` marks filesystem calls, where a 404 means the file, not the box. */
export interface ErrorSite {
  provider: string;
  sandboxId?: string;
  op: string;
  file?: string;
  template?: string;
}

/** What the vendor SDK told us, read once at the adapter boundary (spec §5.1 rule 5). */
export interface VendorFailure {
  name: string;
  status?: number;
  message: string;
}

// Both SDKs prefix API errors with "<status>: ". The newer one also sets `statusCode`; the older one only the prefix.
const STATUS_PREFIX = /^(\d{3}):\s/;
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function readVendorFailure(error: unknown): VendorFailure {
  if (typeof error !== "object" || error === null) return { name: typeof error, message: String(error) };
  const e = error as { name?: unknown; message?: unknown; statusCode?: unknown; status?: unknown };
  const message = typeof e.message === "string" ? e.message : String(error);
  const name = typeof e.name === "string" ? e.name : "Error";
  let status: number | undefined;
  if (typeof e.statusCode === "number") status = e.statusCode;
  else if (typeof e.status === "number") status = e.status;
  else {
    const match = STATUS_PREFIX.exec(message);
    if (match) status = Number(match[1]);
  }
  return status === undefined ? { name, message } : { name, status, message };
}

function isNetworkFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
    if (e.name === "AbortError" || e.name === "ConnectError") return true;
    if (e.name === "TypeError" && typeof e.message === "string" && /fetch failed|network/i.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}

/** True for failures that say nothing about the box: a retry later may succeed. */
export function isTransient(error: unknown): boolean {
  return (
    (error instanceof SandboxUnavailableError && !(error instanceof SandboxGuestGoneError) && !isRefusal(error)) ||
    error instanceof SandboxQuotaError ||
    isNetworkFailure(error)
  );
}

/**
 * The vendor's Retry-After, in ms, when the SDK error carries it: as a `retryAfter` field (seconds) or as a
 * `retry-after` header on the error or its response. HTTP-date values are read too.
 */
export function retryAfterOf(error: unknown, nowMs = Date.now()): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { retryAfter?: unknown; headers?: unknown; response?: { headers?: unknown } };
  const header = (headers: unknown): unknown => {
    if (headers === null || typeof headers !== "object") return undefined;
    const get = (headers as { get?: unknown }).get;
    if (typeof get === "function") return (get as (n: string) => unknown).call(headers, "retry-after");
    const record = headers as Record<string, unknown>;
    return record["retry-after"] ?? record["Retry-After"];
  };
  const raw = e.retryAfter ?? header(e.headers) ?? header(e.response?.headers);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw * 1000;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
}

/**
 * Turns any vendor SDK failure into one of the sandbox error classes (spec §5.3). Only a positive 404 from the
 * control plane becomes `SandboxNotFoundError`; timeouts, 5xx, 409 and network failures stay "unknown".
 */
export function classify(error: unknown, site: ErrorSite): SelfbuildingError {
  if (error instanceof SelfbuildingError) return error;
  const ctx =
    site.sandboxId === undefined ? { provider: site.provider } : { provider: site.provider, sandboxId: site.sandboxId };
  const failure = readVendorFailure(error);
  const detail = `${site.op}: ${failure.message}`;
  const { name, status } = failure;

  if (name === "AuthenticationError" || status === 401 || status === 402 || status === 403) {
    return new SandboxAuthError(ctx, { cause: error });
  }
  if (name === "RateLimitError" || status === 429) {
    const retryAfterMs = retryAfterOf(error);
    return new SandboxQuotaError(retryAfterMs === undefined ? ctx : { ...ctx, retryAfterMs }, { cause: error });
  }
  if (site.file !== undefined && (name === "FileNotFoundError" || name === "NotFoundError" || status === 404)) {
    return new SandboxFileNotFoundError({ ...ctx, path: site.file }, { cause: error });
  }
  if (status === 501 || status === 405) {
    return new SandboxUnsupportedError({ ...ctx, op: site.op }, { cause: error });
  }
  if (
    site.template !== undefined &&
    (status === 404 || status === 400) &&
    /template|snapshot|alias/i.test(failure.message)
  ) {
    return new ImageUnavailableError(
      `Template "${site.template}" is not available on ${site.provider}: ${failure.message}. Use a selfbuilding template such as "selfbuilding-claude-code" or "selfbuilding-codex", or build it into your account with \`selfbuilding images build --provider ${site.provider}\`.`,
      { cause: error },
    );
  }
  if (name === "SandboxNotFoundError" || (status === 404 && site.file === undefined)) {
    return new SandboxNotFoundError(ctx, { cause: error });
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409) {
    // A deterministic refusal (bad request). The registry has no closer class; the adapter itself never retries it.
    return new SandboxUnavailableError(ctx, {
      cause: error,
      message: `Provider "${site.provider}" refused ${detail} (HTTP ${status}). Retrying will not help.`,
    });
  }
  // 5xx, 503 "service busy", 408, 409, request timeouts, dropped streams and network errors: the outcome is unknown.
  return new SandboxUnavailableError(ctx, {
    cause: error,
    message: `Provider "${site.provider}" did not answer (${detail}). The outcome is unknown.`,
  });
}

/** True when the vendor answered with a deterministic 4xx, so retrying the same call cannot help. */
export function isRefusal(error: unknown): boolean {
  if (!(error instanceof SandboxUnavailableError)) return false;
  const status = readVendorFailure(error.cause).status;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409;
}
