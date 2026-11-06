import { ConfigError, type PathsContext, type SessionTransfer } from "@selfbuilding/core";

// Codex keeps each session as `{CODEX_HOME}/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl` (spec §4.7). The
// date folders are only known on the box, so capture finds the file there. Scripts are fixed; ids and paths travel
// as arguments.

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** Where a captured session waits under `{state}`, laid out relative to `{home}`. */
export const capturedSessionDir = (paths: PathsContext, sessionId: string): string =>
  `${paths.state}/sessions/codex/${sessionId}`;

const CAPTURE = [
  "set -e",
  "home=$1; dest=$2; id=$3; found=0",
  'mkdir -p "$dest"',
  'cd "$home"',
  'for f in $(find .codex/sessions -type f -name "rollout-*-$id.jsonl" 2>/dev/null); do',
  '  mkdir -p "$dest/$(dirname "$f")"; cp -p "$f" "$dest/$f"; found=1',
  "done",
  'if [ "$found" = 0 ]; then echo "selfbuilding: no codex session file for $id under $home/.codex/sessions" >&2; exit 66; fi',
].join("\n");

const RESTORE = [
  "set -e",
  "src=$1; home=$2",
  'if [ ! -d "$src/.codex" ]; then echo "selfbuilding: no captured codex session at $src" >&2; exit 66; fi',
  'mkdir -p "$home/.codex"',
  'cp -Rp "$src/.codex/." "$home/.codex/"',
].join("\n");

export function codexSessionTransfer(sessionId: string, paths: PathsContext): SessionTransfer {
  if (!THREAD_ID.test(sessionId)) {
    throw new ConfigError(`${JSON.stringify(sessionId)} is not a Codex thread id; cannot move its session.`);
  }
  const dest = capturedSessionDir(paths, sessionId);
  return {
    capture: [{ argv: ["/bin/sh", "-c", CAPTURE, "codex-capture", paths.home, dest, sessionId] }],
    restore: [{ argv: ["/bin/sh", "-c", RESTORE, "codex-restore", dest, paths.home] }],
    files: [`.codex/sessions/**/rollout-*-${sessionId}.jsonl`],
  };
}
