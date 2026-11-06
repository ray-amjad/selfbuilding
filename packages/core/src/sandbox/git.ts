import { PushFailedError, SandboxOutputRejectedError, SnapshotNotCleanError } from "../errors/classes.js";
import { SANDBOX_PATHS } from "../types/runtime.js";
import type { ProviderSandbox } from "../types/sandbox.js";
import type { GitToken } from "../types/security.js";
import { isAllowedPushRef } from "./names.js";
import { shq } from "./runtime-client.js";

// Host-driven git inside a box (spec §6.13, §9.2). Two rules keep the agent's repo from steering the host:
// - Anything that runs in the agent's repo runs as the agent user, with external diff and textconv drivers off.
//   Repo config (filters, diff drivers, ssh commands) can then only run code the agent could run anyway.
// - Anything that carries a credential runs as root in a scratch repo the host made, with global and system
//   config off, against an explicit URL. The agent's remotes, insteadOf and http.* settings never decide where a
//   token goes, and the credential helper answers only for the repo's own host.

const WORK = SANDBOX_PATHS.workdir;
/** The workdir may be owned by root after a clone; ownership is not a trust boundary for the agent user. */
const SAFE = "-c safe.directory=* -c core.hooksPath=/dev/null -c core.fsmonitor=false";
const NO_DRIVERS = "--no-ext-diff --no-textconv";

export const BOT_IDENTITY = { name: "selfbuilding[bot]", email: "selfbuilding@users.noreply.github.com" };

/**
 * The agent user's fetch from the root-owned scratch repo. A local fetch runs `git upload-pack` inside the scratch
 * repo, and git clears GIT_CONFIG_PARAMETERS for that child, so `-c safe.directory` on the outer git never reaches
 * it and it refuses with "detected dubious ownership". The setting therefore also goes on the upload-pack command
 * itself, naming that one repo.
 */
export function scratchFetch(scratchGitDir: string): string {
  const uploadPack = `git -c safe.directory=${shq(scratchGitDir)} upload-pack`;
  return [
    `git ${SAFE} -c safe.directory=${shq(scratchGitDir)} fetch -q --no-tags`,
    `--upload-pack=${shq(uploadPack)}`,
    shq(scratchGitDir),
    "'+refs/remotes/origin/*:refs/remotes/origin/*' '+refs/selfbuilding/*:refs/selfbuilding/*'",
  ].join(" ");
}

/** "github.com/acme/api" → https URL. A local path or file URL (offline remotes) is used as is. */
export function remoteUrlFor(repo: string): string {
  if (repo.startsWith("/") || repo.includes("://")) return repo;
  return `https://${repo.replace(/\.git$/, "")}.git`;
}

/** "github.com" for a hosted repo; undefined for a local remote. */
export function gitHostOf(repo: string): string | undefined {
  if (repo.startsWith("/") || repo.startsWith("file://")) return undefined;
  const url = repo.includes("://") ? new URL(repo).host : repo.split("/")[0];
  return url || undefined;
}

/** Runs in the agent's repo as the agent user. */
async function agentSh(box: ProviderSandbox, script: string, timeoutMs = 300_000, remoteUrl?: string) {
  return box.exec(script, {
    user: "agent",
    cwd: WORK,
    timeoutMs,
    env: { GIT_TERMINAL_PROMPT: "0", ...(remoteUrl === undefined ? {} : { SELFBUILDING_REMOTE: remoteUrl }) },
  });
}

/**
 * Runs as root, outside the agent's repo, with no global or system git config. The remote URL travels in the
 * environment as `$REMOTE`: it is not a secret, and keeping it out of the script stops a provider's path rewriting
 * from touching it.
 */
async function hostSh(box: ProviderSandbox, script: string, timeoutMs = 300_000, remoteUrl?: string) {
  return box.exec(script, {
    user: "root",
    cwd: "/",
    timeoutMs,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...(remoteUrl === undefined ? {} : { SELFBUILDING_REMOTE: remoteUrl }),
    },
  });
}

const REMOTE = '"$SELFBUILDING_REMOTE"';

const TOKEN_FILE = `${SANDBOX_PATHS.secrets}/git-host-token`;
const SCAN_FILE = `${SANDBOX_PATHS.secrets}/push-scan.patterns`;

/**
 * The prelude of every credentialed host script: a fresh root-only scratch dir in sticky /tmp (the agent cannot
 * swap it), HOME pointed there, and a credential helper that answers only for `host`.
 */
function hostPrelude(o: { token?: GitToken; host?: string; keep?: boolean }): { script: string[]; cred: string } {
  const script = [
    "set -e",
    "umask 077",
    "D=$(mktemp -d /tmp/selfbuilding-git.XXXXXX)",
    o.keep
      ? `trap 'rm -f ${shq(TOKEN_FILE)} ${shq(SCAN_FILE)}' EXIT`
      : `trap 'rm -rf "$D"; rm -f ${shq(TOKEN_FILE)} ${shq(SCAN_FILE)}' EXIT`,
    'export HOME="$D"',
  ];
  if (!o.token || !o.host) return { script, cred: "-c credential.helper=" };
  script.push(
    `cat > "$D/helper" <<'SELFBUILDING_HELPER'
#!/bin/sh
[ "$1" = get ] || exit 0
ok=
while IFS= read -r l; do [ "$l" = ${shq(`host=${o.host}`)} ] && ok=1; done
[ -n "$ok" ] || exit 0
echo username=x-access-token
printf 'password=%s\\n' "$(cat ${shq(TOKEN_FILE)})"
SELFBUILDING_HELPER`,
    'chmod 700 "$D/helper"',
  );
  return { script, cred: '-c credential.helper= -c credential.helper="$D/helper"' };
}

async function writeToken(box: ProviderSandbox, token: GitToken | undefined): Promise<void> {
  if (token) await box.writeFiles([{ path: TOKEN_FILE, data: token.value, mode: 0o600, owner: "root" }]);
}

function hostOfUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? undefined : u.host;
  } catch {
    return undefined;
  }
}

/**
 * Checks out `branch` in the workdir, created from `base` when the remote does not have it. The remote is
 * fetched as root into a scratch repo (the only place the read token is used); the agent's repo then fetches
 * from that scratch repo as the agent user. Used to materialise shared handles; agent calls clone in the runtime.
 */
export async function syncWorkdir(
  box: ProviderSandbox,
  o: { remoteUrl: string; branch: string; base?: string; checkoutRef?: string; token?: GitToken },
): Promise<{ headSha: string; baseSha: string }> {
  await writeToken(box, o.token);
  const host = hostOfUrl(o.remoteUrl);
  const pre = hostPrelude({ ...(o.token ? { token: o.token } : {}), ...(host ? { host } : {}), keep: true });
  const fetched = await hostSh(
    box,
    [
      ...pre.script,
      'export GIT_DIR="$D/s.git"',
      'git init -q --bare "$GIT_DIR"',
      `git ${pre.cred} fetch -q --no-tags ${REMOTE} '+refs/heads/*:refs/remotes/origin/*'`,
      `git ${pre.cred} fetch -q --no-tags ${REMOTE} '+refs/selfbuilding/*:refs/selfbuilding/*' 2>/dev/null || true`,
      `head=$(git ${pre.cred} ls-remote --symref ${REMOTE} HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\\(.*\\)\tHEAD$#\\1#p' | head -n1)`,
      'rm -f "$D/helper"',
      // The agent reads the scratch repo; it never held a credential.
      'chmod 755 "$D" && chmod -R a+rX "$GIT_DIR"',
      'echo "$D $head"',
    ].join("\n"),
    300_000,
    o.remoteUrl,
  );
  if (fetched.exitCode !== 0) {
    throw new PushFailedError(`Fetching ${o.remoteUrl} failed: ${fetched.stderrTail.trim().slice(-600)}`);
  }
  const [scratch = "", defaultHead = ""] = fetched.stdoutTail.trim().split("\n").at(-1)?.split(" ") ?? [];
  const base = o.base ?? "";
  const script = [
    "set -e",
    `if [ ! -d .git ]; then git ${SAFE} init -q; fi`,
    `if git ${SAFE} remote get-url origin >/dev/null 2>&1; then git ${SAFE} remote set-url origin "$SELFBUILDING_REMOTE"; else git ${SAFE} remote add origin "$SELFBUILDING_REMOTE"; fi`,
    scratchFetch(`${scratch}/s.git`),
    defaultHead
      ? `git ${SAFE} symbolic-ref refs/remotes/origin/HEAD ${shq(`refs/remotes/origin/${defaultHead}`)}`
      : "true",
    o.checkoutRef
      ? `git ${SAFE} checkout -q -B ${shq(o.branch)} ${shq(o.checkoutRef)}`
      : `if git ${SAFE} rev-parse -q --verify ${shq(`refs/remotes/origin/${o.branch}`)} >/dev/null; then git ${SAFE} checkout -q -B ${shq(o.branch)} ${shq(`origin/${o.branch}`)}; else b=${shq(base)}; if [ -z "$b" ]; then b=$(git ${SAFE} symbolic-ref -q --short refs/remotes/origin/HEAD | sed 's#^origin/##'); fi; git ${SAFE} checkout -q -B ${shq(o.branch)} "origin/$b"; fi`,
    "chmod -R a+rwX . 2>/dev/null || true",
    `echo "$(git ${SAFE} rev-parse HEAD) $(git ${SAFE} merge-base HEAD "origin/\${b:-HEAD}" 2>/dev/null || git ${SAFE} rev-parse HEAD)"`,
  ].join("\n");
  const r = await agentSh(box, script, 300_000, o.remoteUrl).finally(() =>
    hostSh(box, `rm -rf ${shq(scratch)}`, 60_000).catch(() => undefined),
  );
  if (r.exitCode !== 0) {
    throw new PushFailedError(
      `Checking out ${o.branch} from ${o.remoteUrl} failed: ${r.stderrTail.trim().slice(-600)}`,
    );
  }
  const [headSha = "", baseSha = ""] = r.stdoutTail.trim().split("\n").at(-1)?.split(" ") ?? [];
  return { headSha, baseSha };
}

/** `git rev-parse <rev>` in the workdir, or null when it does not resolve. */
export async function revParse(box: ProviderSandbox, rev = "HEAD"): Promise<string | null> {
  const r = await agentSh(box, `git ${SAFE} rev-parse -q --verify ${shq(`${rev}^{commit}`)}`, 60_000);
  return r.exitCode === 0 ? r.stdoutTail.trim() : null;
}

/** True when the workdir is exactly at `sha`: HEAD there, nothing uncommitted, nothing stashed (spec §3.11). */
export async function matchesCheckpoint(box: ProviderSandbox, sha: string): Promise<boolean> {
  const r = await agentSh(
    box,
    `[ "$(git ${SAFE} rev-parse HEAD)" = ${shq(sha)} ] && [ -z "$(git ${SAFE} status --porcelain --ignored=no)" ] && [ -z "$(git ${SAFE} stash list)" ]`,
    60_000,
  );
  return r.exitCode === 0;
}

/** The remote SHA of a ref, or null when the remote does not have it. */
export async function lsRemote(
  box: ProviderSandbox,
  remoteUrl: string,
  remoteRef: string,
  token?: GitToken,
): Promise<string | null> {
  await writeToken(box, token);
  const host = hostOfUrl(remoteUrl);
  const pre = hostPrelude({ ...(token ? { token } : {}), ...(host ? { host } : {}) });
  const r = await hostSh(
    box,
    [...pre.script, `git ${pre.cred} ls-remote ${REMOTE} ${shq(remoteRef)}`].join("\n"),
    120_000,
    remoteUrl,
  );
  if (r.exitCode !== 0) throw new PushFailedError(`git ls-remote failed: ${r.stderrTail.trim().slice(-400)}`);
  const line = r.stdoutTail
    .trim()
    .split("\n")
    .find((l) => l.endsWith(`\t${remoteRef}`));
  return line ? (line.split("\t")[0] ?? null) : null;
}

/** Every form a delivered secret may take in a committed file (spec §9.3 step 4). */
export function secretPatterns(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v.length < 8) continue;
    out.add(v);
    out.add(encodeURIComponent(v));
    out.add(Buffer.from(v).toString("base64").replace(/=+$/, ""));
  }
  return [...out].filter((p) => !p.includes("\n"));
}

/**
 * The host's push (spec §2.8.2, §9.2). The agent's repo only reports the sha and where its objects live. A root
 * scratch repo borrows those objects, scans what the remote does not have yet for delivered secret values, and
 * pushes to the explicit URL with `--force-with-lease` against the sha the host expects (or, when it has none,
 * the sha the remote reports right now), then verifies with `ls-remote`.
 */
export async function hostPush(
  box: ProviderSandbox,
  o: {
    source: string;
    remoteRef: string;
    remoteUrl: string;
    /** The sha the host last pushed; `null` means the ref must not exist yet. */
    expectSha?: string | null;
    token?: GitToken;
    allowPushTo?: string[];
    /** Secret values delivered to this box; a hit refuses the push with SnapshotNotCleanError. */
    secrets?: readonly string[];
    target?: "push" | "checkpoint";
  },
): Promise<{ sha: string; pushed: boolean }> {
  const ref = o.remoteRef.startsWith("refs/") ? o.remoteRef : `refs/heads/${o.remoteRef}`;
  if (!isAllowedPushRef(ref, o.allowPushTo)) {
    throw new SandboxOutputRejectedError(
      `Refusing to push ${ref}: only refs/heads/selfbuilding/**, refs/selfbuilding/** and git.allowPushTo are pushed.`,
    );
  }
  const found = await agentSh(
    box,
    `git ${SAFE} rev-parse -q --verify ${shq(`${o.source}^{commit}`)} && git ${SAFE} rev-parse --path-format=absolute --git-common-dir`,
    60_000,
  );
  const [sha, commonDir] = found.stdoutTail.trim().split("\n");
  if (found.exitCode !== 0 || !sha || !/^[0-9a-f]{40,64}$/.test(sha) || !commonDir) {
    throw new PushFailedError(`Nothing to push: ${o.source} does not resolve in the workdir.`);
  }
  await writeToken(box, o.token);
  const patterns = secretPatterns(o.secrets ?? []);
  if (patterns.length > 0) {
    await box.writeFiles([{ path: SCAN_FILE, data: `${patterns.join("\n")}\n`, mode: 0o600, owner: "root" }]);
  }
  const host = hostOfUrl(o.remoteUrl);
  const pre = hostPrelude({ ...(o.token ? { token: o.token } : {}), ...(host ? { host } : {}) });
  const url = REMOTE;
  const leaseFor = (expect: string) => `--force-with-lease=${ref}:${expect}`;
  const r = await hostSh(
    box,
    [
      ...pre.script,
      'export GIT_DIR="$D/p.git"',
      'git init -q --bare "$GIT_DIR"',
      `printf '%s\\n' ${shq(`${commonDir}/objects`)} > "$GIT_DIR/objects/info/alternates"`,
      `git cat-file -e ${shq(`${sha}^{commit}`)}`,
      `remote=$(git ${pre.cred} ls-remote ${url})`,
      `current=$(printf '%s\\n' "$remote" | awk -v r=${shq(ref)} '$2 == r { print $1 }')`,
      ...(patterns.length > 0
        ? [
            // Only what the remote lacks leaves the box; the remote's own objects are not the agent's to leak.
            `have=$(printf '%s\\n' "$remote" | awk '{ print $1 }' | while read -r s; do git cat-file -e "$s" 2>/dev/null && printf '^%s\\n' "$s"; done || true)`,
            `if git rev-list --objects ${shq(sha)} $have | awk '{ print $1 }' | git cat-file --batch | grep -a -F -q -f ${shq(SCAN_FILE)}; then echo SELFBUILDING_SECRET_FOUND >&2; exit 3; fi`,
          ]
        : []),
      o.expectSha === undefined
        ? `lease=${shq(`--force-with-lease=${ref}:`)}"$current"`
        : `lease=${shq(leaseFor(o.expectSha ?? ""))}`,
      `git ${pre.cred} push -q "$lease" ${url} ${shq(`${sha}:${ref}`)}`,
      `git ${pre.cred} ls-remote ${url} ${shq(ref)}`,
    ].join("\n"),
    300_000,
    o.remoteUrl,
  );
  if (r.exitCode === 3 && r.stderrTail.includes("SELFBUILDING_SECRET_FOUND")) {
    throw new SnapshotNotCleanError({
      target: o.target ?? "push",
      locations: [`${sha} (outgoing objects for ${ref})`],
    });
  }
  if (r.exitCode !== 0)
    throw new PushFailedError(`git push to ${ref} was rejected: ${r.stderrTail.trim().slice(-600)}`);
  const remote = r.stdoutTail
    .trim()
    .split("\n")
    .find((l) => l.endsWith(`\t${ref}`))
    ?.split("\t")[0];
  return { sha, pushed: remote === sha };
}

/**
 * Commits every change in the workdir (tracked and untracked, ignored files excluded) onto `ref` with a private
 * index, so the agent's own index, HEAD and branch stay untouched (spec §3.11, §5.8). Runs as the agent user:
 * `git add` applies the repo's clean filters, which are the agent's code.
 */
export async function commitSnapshotRef(box: ProviderSandbox, ref: string, message: string): Promise<string> {
  const r = await agentSh(
    box,
    [
      "set -e",
      "index=$(mktemp /tmp/selfbuilding-checkpoint.XXXXXX)",
      'rm -f "$index"',
      `trap 'rm -f "$index"' EXIT`,
      `export GIT_INDEX_FILE="$index" GIT_AUTHOR_NAME=${shq(BOT_IDENTITY.name)} GIT_AUTHOR_EMAIL=${shq(BOT_IDENTITY.email)} GIT_COMMITTER_NAME=${shq(BOT_IDENTITY.name)} GIT_COMMITTER_EMAIL=${shq(BOT_IDENTITY.email)}`,
      `git ${SAFE} read-tree HEAD`,
      `git ${SAFE} add -A`,
      `tree=$(git ${SAFE} write-tree)`,
      `if [ "$tree" = "$(git ${SAFE} rev-parse 'HEAD^{tree}')" ]; then sha=$(git ${SAFE} rev-parse HEAD); else sha=$(git ${SAFE} commit-tree "$tree" -p HEAD -m ${shq(message)}); fi`,
      `git ${SAFE} update-ref ${shq(ref)} "$sha"`,
      `echo "$sha"`,
    ].join("\n"),
    120_000,
  );
  if (r.exitCode !== 0)
    throw new PushFailedError(`Writing checkpoint ${ref} failed: ${r.stderrTail.trim().slice(-400)}`);
  return r.stdoutTail.trim().split("\n").at(-1) ?? "";
}

/** `{ files, insertions, deletions }` of `base...head`. */
export async function diffStat(
  box: ProviderSandbox,
  base: string,
  head: string,
): Promise<{ files: number; insertions: number; deletions: number }> {
  const r = await agentSh(box, `git ${SAFE} diff ${NO_DRIVERS} --shortstat ${shq(`${base}...${head}`)}`, 60_000);
  const text = r.stdoutTail;
  const num = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?/),
    deletions: num(/(\d+) deletions?/),
  };
}

/** Commits ahead of base, oldest first. */
export async function commitsAhead(
  box: ProviderSandbox,
  base: string,
  head: string,
): Promise<{ sha: string; message: string }[]> {
  const r = await agentSh(
    box,
    `git ${SAFE} log ${NO_DRIVERS} --reverse --format='%H%x09%s' ${shq(`${base}..${head}`)}`,
    60_000,
  );
  if (r.exitCode !== 0) return [];
  return r.stdoutTail
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...rest] = line.split("\t");
      return { sha, message: rest.join("\t") };
    });
}

/** The full patch of `base...head`, capped at 5 MiB with the truncation stated (spec §6.12). */
export async function diffPatch(box: ProviderSandbox, base: string, head: string): Promise<string> {
  const r = await box.exec(`git ${SAFE} diff ${NO_DRIVERS} --binary ${shq(`${base}...${head}`)}`, {
    user: "agent",
    cwd: WORK,
    timeoutMs: 120_000,
    maxTailBytes: 5 * 1024 * 1024,
  });
  return r.truncated ? `${r.stdoutTail}\n[selfbuilding: diff truncated at 5 MiB]\n` : r.stdoutTail;
}
