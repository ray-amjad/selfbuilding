// Redaction (spec §9.4): pure functions with no I/O, so they cannot fail at run time.

const SECRET_ENV_NAME = /key|token|secret|password|credential|auth|cookie|dsn|private/i;
const NOT_SECRET_SUFFIX = /_(url|path|id)$/i;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bimp_[A-Za-z0-9_-]{12,}/g,
  /\bsgamp_[A-Za-z0-9_-]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export const REDACTED = "[REDACTED]";

/** True for an env var name whose value is treated as a secret. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME.test(name) && !NOT_SECRET_SUFFIX.test(name);
}

function eligible(value: string): boolean {
  return value.length >= 12 && value.length <= 4096 && !/\s/.test(value);
}

export class Redactor {
  #values: string[] = [];

  constructor(values: Iterable<string> = []) {
    for (const value of values) this.add(value);
  }

  /** Adds an exact value to hide. Values outside 12..4096 characters or with whitespace are ignored. */
  add(value: string | undefined): void {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (!eligible(trimmed) || this.#values.includes(trimmed)) return;
    this.#values.push(trimmed);
    // Longest first, so a secret that contains another is replaced whole.
    this.#values.sort((a, b) => b.length - a.length);
  }

  addEnv(env: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(env)) if (isSecretEnvName(name)) this.add(value);
  }

  text(input: string): string {
    let out = input;
    for (const value of this.#values) if (out.includes(value)) out = out.split(value).join(REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  }

  /** Redacts every string inside a JSON-like value. */
  value<T>(input: T): T {
    if (typeof input === "string") return this.text(input) as T;
    if (Array.isArray(input)) return input.map((item) => this.value(item)) as T;
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) out[key] = this.value(item);
      return out as T;
    }
    return input;
  }
}

/** Truncates to a UTF-8 byte cap, after redaction, and says so. */
export function capBytes(text: string, maxBytes: number): { text: string; truncatedBytes: number } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncatedBytes: 0 };
  const buffer = Buffer.from(text).subarray(0, maxBytes);
  return { text: buffer.toString("utf8").replace(/�$/, ""), truncatedBytes: bytes - maxBytes };
}
