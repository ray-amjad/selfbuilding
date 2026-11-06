import { ConfigError } from "../errors/classes.js";

// Pure-JS hashing and ids. The core main entry may import only node:async_hooks (spec §10.1), and step keys
// must be computed synchronously, so neither node:crypto nor WebCrypto's async digest will do.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const encoder = new TextEncoder();

export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const bitLength = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number);
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  let hex = "";
  for (const byte of sha256Bytes(input)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. */
export function base32Lower(bytes: Uint8Array): string {
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

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, no whitespace. Values that JSON cannot
 * carry faithfully throw ConfigError, because a key built from them would not survive a resume.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new ConfigError(`Cannot key a non-finite number (${value}). Use null.`);
      return JSON.stringify(value);
    case "bigint":
    case "function":
    case "symbol":
      throw new ConfigError(`Cannot key a ${typeof value}. Inputs and step values must be JSON.`);
  }
  const obj = value as Record<string, unknown> & { toJSON?: () => unknown };
  if (typeof obj.toJSON === "function") return encode(obj.toJSON(), seen);
  if (seen.has(obj)) throw new ConfigError("Cannot key a circular value. Inputs and step values must be JSON.");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((v) => (v === undefined ? "null" : encode(v, seen))).join(",")}]`;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], seen)}`).join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

// Captured at module load so strict mode's patched globals never affect internals.
const realDateNow = Date.now.bind(Date);
const realMathRandom = Math.random.bind(Math);

export function internalNow(): number {
  return realDateNow();
}

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (webCrypto?.getRandomValues) return webCrypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(realMathRandom() * 256);
  return bytes;
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A lowercase ULID: 10 chars of millisecond time, then 16 chars of randomness. */
export function ulid(time: number = internalNow()): string {
  let t = time;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[t % 32] + head;
    t = Math.floor(t / 32);
  }
  let tail = "";
  for (const byte of randomBytes(16)) tail += CROCKFORD[byte % 32];
  return head + tail;
}

/** RFC 4122 version 4 formatting of 16 bytes. */
export function formatUuidV4(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.subarray(0, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  let hex = "";
  for (const byte of b) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
