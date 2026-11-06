import path from "node:path";
import { SANDBOX_PATHS } from "@selfbuilding/core";

/** Directories every box starts with, as canonical sandbox paths. */
export const BOX_DIRS = [
  SANDBOX_PATHS.bin,
  SANDBOX_PATHS.skills,
  path.posix.dirname(SANDBOX_PATHS.contract),
  SANDBOX_PATHS.in,
  SANDBOX_PATHS.workdir,
  SANDBOX_PATHS.home,
  SANDBOX_PATHS.out,
  SANDBOX_PATHS.launches,
  SANDBOX_PATHS.proc,
  SANDBOX_PATHS.calls,
  SANDBOX_PATHS.logs,
  SANDBOX_PATHS.run,
  SANDBOX_PATHS.secrets,
  "/tmp",
] as const;

/** Maps a sandbox path onto the box's host directory. Relative paths resolve against the workdir. */
export function hostPath(root: string, sandboxPath: string): string {
  const absolute = sandboxPath.startsWith("/") ? sandboxPath : path.posix.join(SANDBOX_PATHS.workdir, sandboxPath);
  // normalize() collapses "..", so a path can never climb out of the box root.
  return path.join(root, path.posix.normalize(absolute));
}

// Canonical prefixes appear in commands the host builds ("node /selfbuilding/bin/..."). They are rewritten only at a
// token boundary, and a path that already starts with the box root is left alone. /tmp is the box's own, as in a VM.
const CANONICAL = /(^|[\s'"=:;&|(<>`])(\/run\/selfbuilding|\/selfbuilding|\/tmp)(?=$|[/\s'";&|)<>`])/g;

/** Rewrites canonical sandbox paths inside a shell command to the box's host paths. */
export function rewriteCommand(root: string, cmd: string): string {
  return cmd.replace(CANONICAL, (match: string, lead: string, prefix: string, offset: number) =>
    cmd.startsWith(root, offset + lead.length) ? match : `${lead}${root}${prefix}`,
  );
}

// Variable names that carry credentials. Secrets reach a box only as 0600 files (invariant 18).
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|AUTH)($|_)/i;

/** True when an env var name looks like it carries a credential. */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}
