import { createHash } from "node:crypto";

/** The version of the preamble that wraps every skill prompt (spec §2.3.2). Part of every skill hash. */
export const PREAMBLE_VERSION = "selfbuilding-preamble-v1";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted at every level, so equal values always serialise to equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export interface HashedFile {
  path: string;
  mode: number;
  sha256: string;
}

/**
 * Only the executable bit is hashed: the rest of the mode depends on the checkout's umask, and a hash that
 * changes between two clones of the same commit would invalidate every replay.
 */
function portableMode(mode: number): string {
  return mode & 0o111 ? "755" : "644";
}

/** sha256 over the sorted (path, mode, sha256) triples. */
export function filesHash(files: readonly HashedFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\0${portableMode(f.mode)}\0${f.sha256}`);
  return sha256Hex(lines.join("\n"));
}

/**
 * `hash = sha256(preambleVersion ‖ sorted[(relPath, mode, sha256(bytes))] ‖ contractFingerprint)` (spec §2.2.4).
 * `files` includes the sidecar, so a schema change invalidates replay.
 */
export function skillHash(parts: {
  files: readonly HashedFile[];
  contractFingerprint?: string;
  preambleVersion?: string;
}): string {
  return sha256Hex(
    [parts.preambleVersion ?? PREAMBLE_VERSION, filesHash(parts.files), parts.contractFingerprint ?? ""].join("\n"),
  );
}

/** What a contract contributes to the hash (spec §2.2.4). Function checks contribute only their id. */
export interface FingerprintParts {
  inputJsonSchema?: unknown;
  outputJsonSchema?: unknown;
  workspace?: unknown;
  protect?: unknown;
  /** Done checks: `cmd` strings are kept, functions are reduced to their id. */
  done?: readonly ({ id: string } & Record<string, unknown>)[];
  artifacts?: unknown;
  testCommand?: unknown;
}

export function contractFingerprint(parts: FingerprintParts): string {
  const done = (parts.done ?? []).map((check) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(check)) {
      if (typeof value === "function") out[key] = `fn:${check.id}`;
      else if (key === "judge" && value && typeof value === "object") {
        out[key] = { rubric: (value as { rubric?: unknown }).rubric };
      } else out[key] = value;
    }
    return out;
  });
  const fn = (v: unknown) => (typeof v === "function" ? "fn" : v);
  const artifacts =
    parts.artifacts && typeof parts.artifacts === "object"
      ? Object.fromEntries(Object.entries(parts.artifacts).map(([k, v]) => [k, fn(v)]))
      : parts.artifacts;
  return sha256Hex(
    canonicalJson({
      input: parts.inputJsonSchema ?? null,
      output: parts.outputJsonSchema ?? null,
      workspace: parts.workspace ?? null,
      protect: parts.protect ?? null,
      done,
      artifacts: artifacts ?? null,
      testCommand: fn(parts.testCommand) ?? null,
    }),
  );
}
