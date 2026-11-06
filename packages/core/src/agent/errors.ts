import type { SelfbuildingError } from "../errors/base.js";
import type { ErrorCode, Recovery, SerializedSelfbuildingError } from "../errors/codes.js";
import { ERROR_REGISTRY } from "../errors/registry.js";

// Error helpers for the agent call path. Errors are matched by `code`, never by class identity, because an error
// can cross a host boundary or come from a second copy of this package.

export function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function hasCode(error: unknown, ...codes: ErrorCode[]): boolean {
  const code = errorCode(error);
  return code !== undefined && (codes as string[]).includes(code);
}

export function isSelfbuildingError(error: unknown): error is SelfbuildingError {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean" &&
    typeof (error as { toJSON?: unknown }).toJSON === "function"
  );
}

export function isUsageError(error: unknown): boolean {
  return isSelfbuildingError(error) && error.kind === "usage";
}

/**
 * Rebuilds a registered error class from its serialised form, without running its constructor (constructors take
 * class-specific fields). Instances pass `instanceof` and serialise back to the same JSON.
 */
export function rehydrateError(s: SerializedSelfbuildingError): SelfbuildingError {
  const row = ERROR_REGISTRY.find((r) => r.name === s.name) ?? ERROR_REGISTRY.find((r) => r.code === s.code);
  const ctor = (row?.ctor ?? ERROR_REGISTRY.find((r) => r.code === "harness_error")?.ctor) as unknown as {
    prototype: object;
  };
  const error = Object.create(ctor.prototype) as SelfbuildingError & Record<string, unknown>;
  const fields: Record<string, unknown> = {
    name: row?.name ?? s.name,
    message: s.message,
    code: s.code,
    retryable: s.retryable,
    kind: s.kind,
    ...(s.details ?? {}),
  };
  if (s.runId !== undefined) fields.runId = s.runId;
  if (s.callPath !== undefined) fields.callPath = s.callPath;
  if (s.recovery !== undefined) fields.recovery = s.recovery as Recovery;
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(error, key, {
      value,
      enumerable: key !== "name" && key !== "message",
      writable: true,
      configurable: true,
    });
  }
  Error.captureStackTrace?.(error, rehydrateError);
  return error;
}

/** A registered error for a runtime `Outcome.reason`, with the runtime's message. */
export function errorForCode(
  code: ErrorCode,
  message: string,
  extra: { runId?: string; callPath?: string; recovery?: Recovery; details?: Record<string, unknown> } = {},
): SelfbuildingError {
  const row = ERROR_REGISTRY.find((r) => r.code === code);
  const instance = rehydrateError({
    name: row?.name ?? "HarnessStreamError",
    code,
    kind: row?.kind ?? "agent",
    retryable: row?.retryable === "yes",
    message,
    ...(extra.runId === undefined ? {} : { runId: extra.runId }),
    ...(extra.callPath === undefined ? {} : { callPath: extra.callPath }),
    ...(extra.recovery === undefined ? {} : { recovery: extra.recovery as SerializedSelfbuildingError["recovery"] }),
    ...(extra.details === undefined ? {} : { details: extra.details }),
  });
  return instance;
}

/** Serialises any thrown value as a SerializedSelfbuildingError, wrapping foreign errors as infrastructure faults. */
export function serializeError(error: unknown): SerializedSelfbuildingError {
  if (isSelfbuildingError(error)) return error.toJSON();
  const message = error instanceof Error ? error.message : String(error);
  return { name: "HarnessStreamError", code: "harness_error", kind: "agent", retryable: false, message };
}
