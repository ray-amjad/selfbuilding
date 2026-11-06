import { createHash } from "node:crypto";

// Hashing helpers shared by sandbox naming, step keys and session ids. Internal.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with sorted object keys and no whitespace, so equal values always hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== "function") out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** A name-based UUID (version 5 layout over SHA-256 bytes), stable for the same name. */
export function stableUuid(name: string): string {
  const bytes = sha256(name).subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parses a public Duration ("45m", "2h", or milliseconds). */
export function durationMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === "number") return d;
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(d);
  if (!m) return fallback;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * unit);
}
