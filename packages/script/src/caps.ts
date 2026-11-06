import { ConfigError, type Duration, type ScriptCaps, type SizeName } from "@selfbuilding/core";

export type EffectiveCaps = Readonly<Required<ScriptCaps>>;

const NUMERIC = [
  "memoryBytes",
  "stackBytes",
  "cpuSliceMs",
  "maxAgentCalls",
  "maxSandboxes",
  "budgetUsd",
  "maxOutputBytes",
  "maxSourceBytes",
  "maxPrWrites",
] as const;

const KNOWN = new Set<string>([...NUMERIC, "allowedSizes", "wallClock"]);

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** A public `Duration` in milliseconds. */
export function durationMs(value: Duration, what: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new ConfigError(`${what} must be a non-negative number of ms.`);
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(value));
  if (!match) throw new ConfigError(`${what} must look like "30s", "45m", "2h" or "1d"; got "${String(value)}".`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]);
}

function check(caps: ScriptCaps, what: string): void {
  if (caps === null || typeof caps !== "object" || Array.isArray(caps)) {
    throw new ConfigError(`${what} must be an object of script caps.`);
  }
  for (const key of Object.keys(caps)) {
    if (!KNOWN.has(key)) {
      throw new ConfigError(`${what}.${key} is not a script cap. Known caps: ${[...KNOWN].join(", ")}.`);
    }
  }
  for (const key of NUMERIC) {
    const v = caps[key];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
      throw new ConfigError(`${what}.${key} must be a positive number; got ${String(v)}.`);
    }
  }
  if (caps.allowedSizes !== undefined) {
    if (!Array.isArray(caps.allowedSizes) || !caps.allowedSizes.every((s) => typeof s === "string")) {
      throw new ConfigError(`${what}.allowedSizes must be an array of size names.`);
    }
  }
  if (caps.wallClock !== undefined) durationMs(caps.wallClock, `${what}.wallClock`);
}

/**
 * Tightens `base` with each layer in turn (demo-path §8.3): every number is the minimum, `allowedSizes` the
 * intersection, `wallClock` the shorter. A layer can never loosen a cap.
 */
export function tightenCaps(base: EffectiveCaps, ...layers: (ScriptCaps | undefined)[]): EffectiveCaps {
  const out: { -readonly [K in keyof EffectiveCaps]: EffectiveCaps[K] } = {
    ...base,
    allowedSizes: [...base.allowedSizes],
  };
  layers.forEach((layer, i) => {
    if (layer === undefined) return;
    check(layer, i === 0 ? "caps" : `caps (layer ${i + 1})`);
    for (const key of NUMERIC) {
      const v = layer[key];
      if (v !== undefined) out[key] = Math.min(out[key], v);
    }
    if (layer.allowedSizes !== undefined) {
      const allowed = new Set<SizeName>(layer.allowedSizes);
      out.allowedSizes = out.allowedSizes.filter((s) => allowed.has(s));
    }
    if (
      layer.wallClock !== undefined &&
      durationMs(layer.wallClock, "wallClock") < durationMs(out.wallClock, "wallClock")
    ) {
      out.wallClock = layer.wallClock;
    }
  });
  return Object.freeze(out);
}
