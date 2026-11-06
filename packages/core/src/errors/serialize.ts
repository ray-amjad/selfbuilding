import { SelfbuildingError, SelfbuildingUsageError } from "./base.js";
import type { SerializedSelfbuildingError } from "./codes.js";
import { ERROR_REGISTRY } from "./registry.js";

export function isSelfbuildingError(error: unknown): error is SelfbuildingError {
  return error instanceof SelfbuildingError;
}

/** Usage errors are bugs in the factory; they throw through every primitive (spec §3.1). */
export function isUsageError(error: unknown): error is SelfbuildingUsageError {
  return error instanceof SelfbuildingUsageError;
}

/**
 * Rebuilds a thrown error from its JSON form (journals, host step values, `RawOutcome`), as an instance of
 * the registered class so `instanceof` and `code` work across hosts. Unknown names fall back to the class
 * registered for the code.
 */
export function deserializeError(json: SerializedSelfbuildingError): SelfbuildingError {
  const row = ERROR_REGISTRY.find((r) => r.name === json.name) ?? ERROR_REGISTRY.find((r) => r.code === json.code);
  const proto = (row?.ctor.prototype ?? SelfbuildingError.prototype) as object;
  const error = Object.create(proto) as SelfbuildingError & Record<string, unknown>;
  const assign = (key: string, value: unknown) =>
    Object.defineProperty(error, key, { value, enumerable: true, writable: true, configurable: true });
  assign("name", json.name);
  assign("message", json.message);
  assign("code", json.code);
  assign("kind", json.kind);
  assign("retryable", json.retryable);
  if (json.runId !== undefined) assign("runId", json.runId);
  if (json.callPath !== undefined) assign("callPath", json.callPath);
  if (json.recovery !== undefined) assign("recovery", json.recovery);
  for (const [key, value] of Object.entries(json.details ?? {})) {
    if (!(key in error) || error[key] === undefined) assign(key, value);
  }
  Object.defineProperty(error, "stack", {
    value: `${json.name}: ${json.message}\n    (deserialized)`,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return error;
}

/** The JSON form of any thrown value. Non-Selfbuilding errors keep only their name and message. */
export function serializeThrown(error: unknown): SerializedSelfbuildingError | { name: string; message: string } {
  if (isSelfbuildingError(error)) return error.toJSON();
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}
