import type { AskSpec } from "../types/ask.js";

// Ask identity (spec §8.3). Web Crypto keeps node:crypto out of the core main entry.

/** JSON with object keys sorted and undefined members dropped, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && typeof v !== "function")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: cannot encode a ${typeof value}`);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** sha256 over the validated spec without the fields that only change how long or how it waits. */
export async function computeSpecHash(spec: AskSpec): Promise<string> {
  const { timeout: _t, onTimeout: _o, dedupeKey: _d, ...rest } = spec;
  return hex(await sha256(canonicalJson(rest)));
}

export interface AskIdParts {
  runId: string;
  callPath: string;
  /** The launch for an agent ask; absent for a factory ask, which must stay replay-stable. */
  launchId?: string;
  askSeq: number;
  specHash: string;
  /** 0 for the first try; n after n id collisions. */
  collision?: number;
}

/** "ask_" + 20 base32 chars: 24 chars of [a-z0-9_]. */
export async function deriveAskId(p: AskIdParts): Promise<string> {
  let input = `${p.runId}|${p.callPath}|${p.launchId ?? "factory"}|${p.askSeq}|${p.specHash}`;
  if (p.collision) input += `|${p.collision}`;
  return `ask_${base32(await sha256(input)).slice(0, 20)}`;
}
