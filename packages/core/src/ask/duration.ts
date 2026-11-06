import type { Duration } from "../types/common.js";

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Milliseconds for a public Duration, or null when it is malformed or not positive. */
export function durationToMs(d: Duration | undefined): number | null {
  if (d === undefined) return null;
  if (typeof d === "number") return Number.isFinite(d) && d > 0 ? d : null;
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(d);
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  return ms > 0 ? Math.round(ms) : null;
}

/** "4h", "90m", "45s": the largest whole unit, for text people read. */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [
    ["d", UNIT_MS.d],
    ["h", UNIT_MS.h],
    ["m", UNIT_MS.m],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  if (ms >= UNIT_MS.m) return `${Math.round(ms / UNIT_MS.m)}m`;
  return `${Math.max(1, Math.round(ms / UNIT_MS.s))}s`;
}
