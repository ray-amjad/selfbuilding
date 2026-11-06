import { ConfigError } from "../errors/classes.js";
import type { Duration } from "../types/common.js";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Converts a public `Duration` (`"45m"`, `"2h"`, or milliseconds) to milliseconds. */
export function parseDuration(value: Duration, what = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(
        `${what} must be a non-negative number of milliseconds or a string like "45m"; got ${value}.`,
      );
    }
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(value));
  if (!match) {
    throw new ConfigError(`${what} must look like "30s", "45m", "2h" or "1d", or be milliseconds; got "${value}".`);
  }
  return Math.round(Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]);
}

export function parseOptionalDuration(value: Duration | undefined, what?: string): number | undefined {
  return value === undefined ? undefined : parseDuration(value, what);
}
