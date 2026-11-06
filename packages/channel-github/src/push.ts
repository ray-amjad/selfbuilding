import { createHash } from "node:crypto";
import {
  ConfigError,
  type ExecResult,
  type GitCredentialBroker,
  type GitPushTokenRequest,
  PushFailedError,
  type WriteFileEntry,
} from "@selfbuilding/core";

// Host-side push and push verification (spec §6.13, §9.2 steps 5 and 6). The host runs these inside the box after
// the agent's processes are gone; the write token exists only for the length of one exec.

export const PUSH_TOKEN_PATH = "/run/selfbuilding/secrets/git-push-token";
/** A fixed helper an image may provide; by default the push writes its own host-checking helper instead. */
export const PUSH_CREDENTIAL_HELPER = "/selfbuilding/bin/git-credential-selfbuilding-push";
export const DEFAULT_WORKDIR = "/selfbuilding/work";

const AGENT_BRANCH_PREFIX = "refs/heads/selfbuilding/";
const CHECKPOINT_PREFIX = "refs/selfbuilding/";

/**
 * `selfbuilding/<runId>/<scope-slug>`, the branch for one call or shared handle (spec §6.13). The slug is lowercase,
 * every run of [^a-z0-9] becomes "-", it is trimmed, and a leading "root/" is dropped; past 60 characters it is
 * the first 53, "-", and 6 hex characters of sha256(scope). Deterministic, so retries and resumes reuse the branch.
 */
export function callBranchName(runId: string, scope: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new ConfigError(`"${runId}" is not a run id. Run ids are letters, digits, "_" and "-".`);
  }
  const slug = scope
    .replace(/^root\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new ConfigError(`The scope "${scope}" has no letters or digits to name a branch with.`);
  const fitted =
    slug.length > 60 ? `${slug.slice(0, 53)}-${createHash("sha256").update(scope).digest("hex").slice(0, 6)}` : slug;
  return `selfbuilding/${runId}/${fitted}`;
}

/** One ref to push: `src` is a local rev, `dst` a branch name or full ref on the remote. */
export interface PushRef {
  src: string;
  dst: string;
  /**
   * Lease: the sha the remote ref must have now, or "" for "must not exist". Default: the remote-tracking ref,
   * as plain `--force-with-lease` does.
   */
  expect?: string;
}

function fullRef(dst: string): string {
  return dst.startsWith("refs/") ? dst : `refs/heads/${dst}`;
}

// git check-ref-format rules on a narrower charset (callBranchName only ever produces these characters), plus no
// leading "-" so a ref can never be read as an option.
function isWellFormedRef(ref: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  if (ref.startsWith("-") || ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return false;
  if (ref.includes("..") || ref.includes("//")) return false;
  return ref.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

/** True when the host may push `dst`: refs/heads/selfbuilding/**, refs/selfbuilding/**, or a listed ref. */
export function isPushAllowed(dst: string, allowPushTo: readonly string[] = []): boolean {
  const ref = fullRef(dst);
  if (!isWellFormedRef(ref)) return false;
  if (ref.startsWith(AGENT_BRANCH_PREFIX) || ref.startsWith(CHECKPOINT_PREFIX)) return true;
  return allowPushTo.some((allowed) => fullRef(allowed) === ref);
}

/** Refuses, before anything contacts the remote, every ref outside the push allowlist (spec §6.13). */
export function assertPushAllowed(refs: readonly PushRef[], allowPushTo: readonly string[] = []): void {
  if (refs.length === 0) throw new ConfigError("Nothing to push: pass at least one ref.");
  for (const { src, dst } of refs) {
    if (!/^[A-Za-z0-9_./^~@{}-]+$/.test(src) || src.startsWith("-")) {
      throw new ConfigError(`"${src}" is not a valid local rev to push.`);
    }
    if (!isPushAllowed(dst, allowPushTo)) {
      throw new ConfigError(
        `Refusing to push ${fullRef(dst)}: the host pushes only refs/heads/selfbuilding/** and refs/selfbuilding/**. Name the branch with callBranchName(), or list the ref in git.allowPushTo.`,
      );
    }
  }
}

/** Single-quotes a value for /bin/sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface PushScriptOptions {
  refs: readonly PushRef[];
  /** Default "/selfbuilding/work". */
  cwd?: string;
  /**
   * The remote URL pushed to. Always explicit: a remote name would be resolved through the box's own repo config
   * (url, pushurl, insteadOf), which the agent can rewrite to send the token elsewhere.
   */
  url: string;
  tokenPath?: string;
  /** Answers only for the URL's host (spec §9.2). Default: a helper the script writes into its own scratch dir. */
  helperPath?: string;
}

function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? undefined : u.host;
  } catch {
    return undefined;
  }
}

/**
 * The one exec that pushes (spec §9.2 step 5). The agent's repo only resolves each ref's sha and where its objects
 * live. A root-only scratch repo borrows those objects and pushes to the explicit URL with global, system and repo
 * config out of reach, a credential helper that answers only for the URL's host, and `--force-with-lease`. The
 * token file is removed on exit whether the push worked or not.
 */
export function pushScript(opts: PushScriptOptions): string {
  const tokenPath = opts.tokenPath ?? PUSH_TOKEN_PATH;
  const host = hostOf(opts.url);
  const git = "git -c safe.directory=* -c core.hooksPath=/dev/null -c core.fsmonitor=false";
  const lines = [
    "umask 077",
    "D=$(mktemp -d /tmp/selfbuilding-push.XXXXXX) || exit 97",
    `trap ${shellQuote(`rm -f ${shellQuote(tokenPath)}; rm -rf "$D"`)} EXIT`,
    `cd ${shellQuote(opts.cwd ?? DEFAULT_WORKDIR)} || exit 97`,
    `objects="$(${git} rev-parse --path-format=absolute --git-common-dir)/objects" || exit 97`,
  ];
  const leases: string[] = [];
  const refspecs: string[] = [];
  opts.refs.forEach((r, i) => {
    const ref = fullRef(r.dst);
    lines.push(`s${i}=$(${git} rev-parse --verify --end-of-options ${shellQuote(`${r.src}^{commit}`)}) || exit 97`);
    if (r.expect === undefined) {
      // Plain --force-with-lease: the box's remote-tracking ref, or "must not exist" without one.
      const tracking = `refs/remotes/origin/${ref.replace(/^refs\/heads\//, "")}`;
      lines.push(`e${i}=$(${git} rev-parse -q --verify ${shellQuote(tracking)} || true)`);
      leases.push(`"--force-with-lease=${ref}:$e${i}"`);
    } else {
      leases.push(`--force-with-lease=${shellQuote(`${ref}:${r.expect}`)}`);
    }
    refspecs.push(`"$s${i}:${ref}"`);
  });
  lines.push(
    'export GIT_DIR="$D/p.git" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 HOME="$D"',
    'git init -q --bare "$GIT_DIR" || exit 97',
    `printf '%s\\n' "$objects" > "$GIT_DIR/objects/info/alternates"`,
  );
  let helper = opts.helperPath ? shellQuote(opts.helperPath) : '"$D/helper"';
  if (!opts.helperPath) {
    lines.push(
      `cat > "$D/helper" <<'SELFBUILDING_HELPER'
#!/bin/sh
[ "$1" = get ] || exit 0
ok=${host ? "" : "1"}
while IFS= read -r l; do [ "$l" = ${shellQuote(`host=${host ?? ""}`)} ] && ok=1; done
[ -n "$ok" ] || exit 0
echo username=x-access-token
printf 'password=%s\\n' "$(cat ${shellQuote(tokenPath)})"
SELFBUILDING_HELPER`,
      'chmod 700 "$D/helper"',
    );
  } else {
    helper = shellQuote(opts.helperPath);
  }
  lines.push(
    [
      "git -c credential.helper=",
      `-c credential.helper=${helper}`,
      `push --porcelain ${leases.join(" ")} ${shellQuote(opts.url)} ${refspecs.join(" ")}`,
    ].join(" "),
    "rc=$?",
    "unset GIT_DIR",
    // Keeps the box's own lease source in step with what the host pushed.
    ...opts.refs.map(
      (r, i) =>
        `[ $rc -eq 0 ] && ${git} update-ref ${shellQuote(`refs/remotes/origin/${fullRef(r.dst).replace(/^refs\/heads\//, "")}`)} "$s${i}"`,
    ),
    "exit $rc",
  );
  return lines.join("\n");
}

/** What the host needs from a box to push: the provider's exec and writeFiles (a `ProviderSandbox` fits). */
export interface PushTarget {
  exec(
    cmd: string,
    o?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; user?: "agent" | "root" },
  ): Promise<Pick<ExecResult, "exitCode" | "stdoutTail" | "stderrTail">>;
  writeFiles(files: WriteFileEntry[]): Promise<void>;
}

export interface PushedRef {
  /** Full ref on the remote. */
  ref: string;
  /** Local sha of `src`. */
  sha: string;
  /** What `ls-remote` reported; null when the ref is absent. */
  remoteSha: string | null;
}

export interface PushVerification {
  /** True only when every remote ref equals its local sha (spec §6.13). */
  pushed: boolean;
  refs: PushedRef[];
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
/** ls-remote with no config but git's own: the box's repo config cannot point it at another server. */
const CLEAN_ENV = { ...GIT_ENV, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** `git ls-remote` of the explicit URL against local `rev-parse` for every ref. `pushed: true` only on an exact match. */
export async function verifyPush(
  box: Pick<PushTarget, "exec">,
  opts: { refs: readonly PushRef[]; cwd?: string; url: string },
): Promise<PushVerification> {
  const cwd = opts.cwd ?? DEFAULT_WORKDIR;
  const remote = opts.url;
  const out: PushedRef[] = [];
  for (const r of opts.refs) {
    const ref = fullRef(r.dst);
    const local = await box.exec(
      `git -c safe.directory=* -c core.fsmonitor=false rev-parse --verify --end-of-options ${shellQuote(`${r.src}^{commit}`)}`,
      { cwd, env: GIT_ENV },
    );
    if (local.exitCode !== 0) {
      throw new PushFailedError(`Cannot verify the push: ${r.src} does not name a commit in ${cwd}.`);
    }
    const listed = await box.exec(`git ls-remote ${shellQuote(remote)} ${shellQuote(ref)}`, {
      cwd: "/",
      env: CLEAN_ENV,
    });
    if (listed.exitCode !== 0) {
      throw new PushFailedError(
        `Cannot verify the push: git ls-remote ${remote} failed (${listed.stderrTail.trim().slice(-300)}). The read credential may have expired.`,
        { recovery: { branch: ref, headSha: local.stdoutTail.trim() } },
      );
    }
    const line = listed.stdoutTail.split("\n").find((l) => l.split("\t")[1] === ref);
    out.push({ ref, sha: local.stdoutTail.trim(), remoteSha: line?.split("\t")[0] ?? null });
  }
  return { pushed: out.every((r) => r.remoteSha === r.sha), refs: out };
}

export interface PushBranchOptions extends PushScriptOptions {
  broker: Pick<GitCredentialBroker, "pushToken" | "revoke">;
  request: GitPushTokenRequest;
  allowPushTo?: readonly string[];
  /** Default 120 s. */
  timeoutMs?: number;
}

function redact(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join("[redacted]");
}

/**
 * The host's push (spec §9.2 steps 3, 5 and 6): checks the allowlist, mints a write token, writes it as a 0600
 * file, pushes in one exec that deletes the file, revokes the token where the broker can, then verifies with
 * `ls-remote`. Throws `PushFailedError` when the push fails or the remote does not match.
 *
 * The caller has already confirmed the harness process tree is gone and run the exact-value scan (steps 1, 2, 4).
 */
export async function pushBranch(box: PushTarget, opts: PushBranchOptions): Promise<PushVerification> {
  assertPushAllowed(opts.refs, opts.allowPushTo);
  const tokenPath = opts.tokenPath ?? PUSH_TOKEN_PATH;
  const token = await opts.broker.pushToken(opts.request);
  let result: Pick<ExecResult, "exitCode" | "stdoutTail" | "stderrTail">;
  try {
    // Root's: no agent process that outlived its turn can read the write token during the push.
    await box.writeFiles([{ path: tokenPath, data: token.value, mode: 0o600, owner: "root" }]);
    result = await box.exec(pushScript({ ...opts, tokenPath }), {
      env: GIT_ENV,
      timeoutMs: opts.timeoutMs ?? 120_000,
      user: "root",
    });
  } finally {
    // The script's trap already removed it; this covers an exec that never ran or was killed.
    await box.exec(`rm -f ${shellQuote(tokenPath)}`, { user: "root" }).catch(() => undefined);
    await opts.broker.revoke?.(token).catch(() => undefined);
  }
  const recovery = { branch: fullRef(opts.refs[0]?.dst ?? "") };
  if (result.exitCode !== 0) {
    const stderr = redact(`${result.stderrTail}\n${result.stdoutTail}`.trim(), token.value).slice(-1000);
    throw new PushFailedError(`git push exited ${result.exitCode}: ${stderr}`, { recovery });
  }
  const verified = await verifyPush(box, opts);
  if (!verified.pushed) {
    const stale = verified.refs
      .filter((r) => r.remoteSha !== r.sha)
      .map((r) => `${r.ref} is ${r.remoteSha ?? "absent"}, local ${r.sha}`);
    throw new PushFailedError(`The push reported success but the remote does not match: ${stale.join("; ")}.`, {
      recovery,
    });
  }
  return verified;
}
