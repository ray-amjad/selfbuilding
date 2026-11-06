import {
  SandboxAuthError,
  SandboxNotFoundError,
  SandboxQuotaError,
  SandboxUnavailableError,
  SelfbuildingError,
} from "@selfbuilding/core";

export interface ErrorContext {
  provider: string;
  sandboxId?: string;
}

/** What dockerode and the HTTP layer attach to a rejection. */
interface DaemonError {
  statusCode?: number;
  code?: string;
  message?: string;
  json?: { message?: string } | null;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "ABORT_ERR",
]);

export function statusOf(error: unknown): number | undefined {
  const status = (error as DaemonError | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

export function daemonMessage(error: unknown): string {
  const e = error as DaemonError | null;
  return `${e?.json?.message ?? ""} ${e?.message ?? ""}`.trim();
}

/**
 * Whether a 404 says the container itself is gone. Only the daemon's own body counts: the HTTP client prefixes every
 * 404 on the archive endpoint with "no such container", even when the daemon said the path is missing. Without a
 * body the answer is unknown.
 */
export function containerMissing(error: unknown): boolean | undefined {
  const body = (error as DaemonError | null)?.json?.message;
  return typeof body === "string" && body !== "" ? /no such container/i.test(body) : undefined;
}

/**
 * Classifies a daemon rejection once, at the adapter boundary (spec §5.1 rule 5, §5.3). 404 is a confirmed miss;
 * 401/402/403 and a refused socket are fleet-wide; everything unknown (409, 5xx, a dropped connection) is an outage,
 * never absence.
 */
export function classify(error: unknown, ctx: ErrorContext, hint?: string): SelfbuildingError {
  if (error instanceof SelfbuildingError) return error;
  const status = statusOf(error);
  const opts = { cause: error, ...(hint === undefined ? {} : { message: hint }) };
  if (status === 404) return new SandboxNotFoundError(ctx, { cause: error });
  if (status === 401 || status === 402 || status === 403) return new SandboxAuthError(ctx, { cause: error });
  if (status === 429) return new SandboxQuotaError(ctx, { cause: error });
  const code = (error as DaemonError | null)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new SandboxAuthError(ctx, {
      cause: error,
      message: `Provider "${ctx.provider}" may not use the Docker socket (${code}). Add the user to the docker group or pass socketPath.`,
    });
  }
  if (status === 409 && /is paused/i.test(daemonMessage(error))) {
    return new SandboxUnavailableError(ctx, {
      cause: error,
      message: `Sandbox ${ctx.sandboxId ?? ""} is paused. Reopen it with provider.open(ref) before using a handle.`,
    });
  }
  if (code !== undefined && NETWORK_CODES.has(code) && hint === undefined) {
    return new SandboxUnavailableError(ctx, {
      cause: error,
      message: `The Docker daemon did not answer (${code}). Start it, or check socketPath. The outcome is unknown; this is never treated as not-found.`,
    });
  }
  return new SandboxUnavailableError(ctx, opts);
}

/** A 4xx other than 404/409/429 is a deterministic refusal; retrying it within a deadline only wastes the deadline. */
export function isPermanent(error: unknown): boolean {
  if (error instanceof SandboxAuthError) return true;
  const status = statusOf(error instanceof Error && error.cause !== undefined ? error.cause : error);
  return status !== undefined && status >= 400 && status < 500 && status !== 404 && status !== 409 && status !== 429;
}
