import { createHash } from "node:crypto";
import { ConfigError, type PathsContext, type SessionTransfer } from "@selfbuilding/core";

// A fixed namespace, so every host derives the same session id for the same call with no lookup (spec §4.7).
const SESSION_NAMESPACE = "8d3f6c2e-4a1b-5e7f-9c0d-2b4a6e8f1c3d";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** RFC 4122 version 5 (SHA-1, name-based) UUID. */
export function uuidv5(name: string, namespace: string = SESSION_NAMESPACE): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `uuidv5(runId + callPath + attempt)`, with separators so distinct triples can never collide. */
export function claudeSessionId(call: { runId: string; callPath: string; attempt: number }): string {
  return uuidv5(`${call.runId}\0${call.callPath}\0${call.attempt}`);
}

/** Claude Code names a project directory after its cwd, every non-alphanumeric character becoming "-". */
export function encodeProjectDir(workdir: string): string {
  return workdir.replace(/[^A-Za-z0-9]/g, "-");
}

/** The session transcript and its subagent folder, relative to `{home}`. */
export function claudeSessionFiles(sessionId: string, paths: PathsContext): string[] {
  const dir = `.claude/projects/${encodeProjectDir(paths.workdir)}`;
  return [`${dir}/${sessionId}.jsonl`, `${dir}/${sessionId}`];
}

// Fixed scripts with positional arguments: ids and paths are never interpolated into shell text.
const CAPTURE_SCRIPT = [
  'set -eu; home="$1"; dest="$2"; shift 2',
  'mkdir -p "$dest"',
  'for rel in "$@"; do if [ -e "$home/$rel" ]; then mkdir -p "$dest/$(dirname "$rel")"; cp -a "$home/$rel" "$dest/$rel"; fi; done',
].join("; ");

const RESTORE_SCRIPT = [
  'set -eu; home="$1"; src="$2"; shift 2',
  'for rel in "$@"; do if [ -e "$src/$rel" ]; then mkdir -p "$home/$(dirname "$rel")"; rm -rf "$home/$rel"; cp -a "$src/$rel" "$home/$rel"; fi; done',
].join("; ");

/** Moves a session between sandboxes: `{home}` and `{workdir}` are the same constants on every box (spec §4.2.1). */
export function claudeSessionArtifacts(sessionId: string, paths: PathsContext): SessionTransfer {
  if (!isUuid(sessionId)) throw new ConfigError(`Claude Code session ids are UUIDs, got "${sessionId}".`);
  const files = claudeSessionFiles(sessionId, paths);
  const staged = `${paths.state}/sessions/claude-code/${sessionId}`;
  return {
    capture: [{ argv: ["/bin/sh", "-c", CAPTURE_SCRIPT, "capture-session", paths.home, staged, ...files] }],
    restore: [{ argv: ["/bin/sh", "-c", RESTORE_SCRIPT, "restore-session", paths.home, staged, ...files] }],
    files,
  };
}
