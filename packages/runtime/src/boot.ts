import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type BootPhase,
  type ErrorCode,
  type HookSpec,
  type ReadyEvent,
  RUNTIME_ENV,
  RUNTIME_EXIT,
  type RuntimeSpec,
  SANDBOX_PATHS,
} from "@selfbuilding/core";
import type { EventSpool } from "./events.js";
import { exists, readText, tailFile, writeAtomic, writeJsonAtomic } from "./fsutil.js";
import { Git, GitCommandFailure, trailerHookScript } from "./git.js";
import type { RuntimeLog } from "./log.js";
import type { AttemptLayout, Layout } from "./paths.js";
import { runCommand } from "./proc.js";
import type { Redactor } from "./redact.js";
import { RUNTIME_VERSION } from "./version.js";

export interface Failure {
  reason: ErrorCode;
  message: string;
  /** The process exit code for failures the host must treat specially (RUNTIME_EXIT). */
  exitCode?: number;
  phase?: BootPhase;
}

export interface BootContext {
  layout: Layout;
  attempt: AttemptLayout;
  spec: RuntimeSpec;
  events: EventSpool;
  log: RuntimeLog;
  redactor: Redactor;
  /** Base env for hooks and checks: no secrets. */
  baseEnv: Record<string, string>;
  /** Milliseconds left of timeouts.boot. */
  bootLeftMs: () => number;
  signal: AbortSignal;
  /** The running bundle, for the stamp check. */
  bundlePath?: string;
}

export interface BootResult {
  baseSha: string;
  harnessVersion: string;
  isolation: "isolated" | "same-user";
  agentUid: number;
  agentGid: number;
  containment: "ns-reap" | "process-group";
  hooksDir: string;
}

class PhaseFailure {
  constructor(readonly failure: Failure) {}
}

function fail(reason: ErrorCode, message: string, exitCode?: number): never {
  throw new PhaseFailure({ reason, message, ...(exitCode === undefined ? {} : { exitCode }) });
}

/** Where the supervisor keeps the read-only git hooks it installs for the agent. */
export function hooksDirFor(layout: Layout): string {
  return layout.host(`${SANDBOX_PATHS.state}/githooks`);
}

/** The base sha of the attempt, kept so later launches of the same attempt agree on it. */
function baseFile(attempt: AttemptLayout): string {
  return attempt.file("git-base");
}

function sha256File(file: string): string | undefined {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

export async function boot(
  ctx: BootContext,
): Promise<{ ok: true; value: BootResult } | { ok: false; failure: Failure }> {
  const result: Partial<BootResult> = {};
  const { events, spec } = ctx;
  const started = Date.now();
  const run = async (phase: BootPhase, fn: () => Promise<string | undefined> | string | undefined) => {
    if (ctx.signal.aborted) fail("aborted", "Cancelled during boot.");
    if (ctx.bootLeftMs() <= 0) fail("boot", `Boot phase "${phase}" did not finish within timeouts.boot.`);
    const phaseStart = Date.now();
    events.emit("boot", { phase, status: "started" });
    try {
      const detail = await fn();
      events.emit("boot", {
        phase,
        status: "completed",
        elapsedMs: Date.now() - phaseStart,
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      const failure =
        error instanceof PhaseFailure
          ? error.failure
          : error instanceof GitCommandFailure
            ? { reason: "boot" as const, message: error.message }
            : { reason: "boot" as const, message: String((error as Error)?.stack ?? error) };
      failure.phase = phase;
      events.emit(
        "boot",
        {
          phase,
          status: "failed",
          elapsedMs: Date.now() - phaseStart,
          detail: failure.message,
          reason: failure.reason,
        },
        { level: "error" },
      );
      throw new PhaseFailure(failure);
    }
  };

  try {
    await run("runtime", () => runtimePhase(ctx, result));
    await run("sync", () => syncPhase(ctx, result));
    await run("setup", () => hookPhase(ctx, "setup"));
    await run("start", () => hookPhase(ctx, "start"));
    await run("skills", () => skillsPhase(ctx));
    await run("harness", () => harnessPhase(ctx, result));
    await run("ready", () => {
      const ready: ReadyEvent = {
        runtimeVersion: RUNTIME_VERSION,
        harness: spec.harness,
        harnessVersion: result.harnessVersion as string,
        isolation: result.isolation as "isolated" | "same-user",
        baseSha: result.baseSha as string,
        bootMode: spec.bootMode,
        supervisorUid: process.getuid?.() ?? 0,
        agentUid: result.agentUid as number,
      };
      events.emit("ready", { ...ready, containment: result.containment, elapsedMs: Date.now() - started });
      if (spec.requireIsolation && ready.isolation === "same-user") {
        fail(
          "result_integrity",
          "requireIsolation is set but this sandbox runs the agent as the supervisor's user, so result.json cannot be protected.",
        );
      }
      return undefined;
    });
  } catch (error) {
    if (error instanceof PhaseFailure) return { ok: false, failure: error.failure };
    throw error;
  }
  return { ok: true, value: result as BootResult };
}

function runtimePhase(ctx: BootContext, result: Partial<BootResult>): string | undefined {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20)
    fail(
      "config",
      `Node ${process.versions.node} is too old for the runtime; it needs 20 or later.`,
      RUNTIME_EXIT.config,
    );
  // The stamp is written last by the host, so a missing or different one means a partial or stale upload.
  if (ctx.bundlePath && path.basename(ctx.bundlePath) === "selfbuilding-runtime.mjs") {
    const stamp = readText(ctx.layout.host(SANDBOX_PATHS.runtimeVersion))?.trim();
    const actual = sha256File(ctx.bundlePath);
    if (!stamp || stamp !== actual) {
      fail(
        "boot",
        `The runtime bundle does not match ${SANDBOX_PATHS.runtimeVersion} (stamp ${stamp ?? "missing"}); re-provision the runtime.`,
        RUNTIME_EXIT.generationMismatch,
      );
    }
  }
  if (exists(ctx.layout.nsReap)) result.containment = "ns-reap";
  else {
    result.containment = "process-group";
    ctx.events.emit(
      "warning",
      { scope: "containment", message: `${SANDBOX_PATHS.nsReap} is missing; falling back to a process-group kill.` },
      { level: "warn" },
    );
  }
  return `node ${process.versions.node}`;
}

/**
 * Git config that answers credential prompts from the read token file core writes for remote repos. Given on the
 * command line only, so the token never lands in the repo's config, and absent when there is no token.
 */
function readTokenArgs(ctx: BootContext): string[] {
  const file = ctx.layout.host(SANDBOX_PATHS.gitReadToken);
  if (!exists(file)) return [];
  const quoted = `'${file.replaceAll("'", `'\\''`)}'`;
  const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf 'password=%s\\n' "$(cat ${quoted})"; }; f`;
  return ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];
}

function syncPhase(ctx: BootContext, result: Partial<BootResult>): string {
  const { spec, layout } = ctx;
  const g = spec.git;
  const git = new Git(layout.workdir, ctx.baseEnv);
  fs.mkdirSync(layout.workdir, { recursive: true });
  const source =
    g.mode === "local"
      ? g.bundlePath
        ? layout.map(g.bundlePath)
        : undefined
      : g.remoteUrl
        ? layout.map(g.remoteUrl)
        : undefined;
  if (!git.isRepo()) {
    if (!source) {
      // A call with no repo still works in git, so diffs, done checks and the branch rules behave the same.
      git.must(["init", "-q", "-b", g.baseBranch]);
      git.must(["commit", "-q", "--allow-empty", "-m", "Empty workspace"], {
        env: {
          GIT_AUTHOR_NAME: g.identity.authorName,
          GIT_AUTHOR_EMAIL: g.identity.authorEmail,
          GIT_COMMITTER_NAME: g.identity.committerName,
          GIT_COMMITTER_EMAIL: g.identity.committerEmail,
        },
      });
    } else {
      git.must(["init", "-q"]);
      if (g.mode === "remote") git.must(["remote", "add", "origin", source]);
    }
  } else if (g.mode === "remote" && source) {
    if (git.run(["remote", "get-url", "origin"]).code === 0) git.must(["remote", "set-url", "origin", source]);
    else git.must(["remote", "add", "origin", source]);
  }
  if (source) {
    const from = g.mode === "local" ? source : "origin";
    // A full fetch, not a partial clone: a partial clone fetches file contents lazily on checkout and diff, and
    // those later fetches have no token (the agent user can never read it).
    git.must([...readTokenArgs(ctx), "fetch", "-q", from, "+refs/heads/*:refs/remotes/origin/*"]);
  }
  const remoteBase = git.resolve(`refs/remotes/origin/${g.baseBranch}`) ?? git.resolve(`refs/heads/${g.baseBranch}`);
  const savedBase = readText(baseFile(ctx.attempt))?.trim();
  // Review targets name branches or carry commit shas. The base is the remote's; the head is the box's own branch
  // when it has one (a fork or shared handle may be ahead of the remote), else the remote's.
  const remoteRef = (ref: string) => git.resolve(`refs/remotes/origin/${ref}`) ?? git.resolve(ref);
  const reviewHead = (ref: string) => git.resolve(`refs/heads/${ref}`) ?? remoteRef(ref);
  let reviewBase: string | undefined;
  if (g.readOnly && g.review) {
    reviewBase = remoteRef(g.review.baseSha);
    if (!reviewBase) fail("boot", `The review base ${g.review.baseSha} was not found after fetching.`);
  }
  let baseSha = reviewBase ?? g.baseSha ?? savedBase ?? remoteBase;
  if (!baseSha) fail("boot", `The base branch "${g.baseBranch}" was not found in the repository.`);

  if (g.readOnly && g.review && reviewBase) {
    const head = reviewHead(g.review.headSha);
    if (!head) fail("boot", `The review head ${g.review.headSha} was not found after fetching.`);
    if (git.dirty()) git.must(["reset", "-q", "--hard"]);
    git.must(["checkout", "-q", "--detach", head]);
    // Three dots: the change since the branch left its base, as a pull request shows it (spec §2.3.1).
    const diff = git.run(["diff", "--binary", `${reviewBase}...${head}`]);
    if (diff.code !== 0) fail("boot", `Could not diff ${reviewBase}...${head}: ${diff.stderr.trim()}`);
    writeAtomic(path.join(layout.inDir, "diff.patch"), diff.stdout);
  } else if (git.resolve(`refs/heads/${g.branch}`)) {
    if (git.currentBranch() !== g.branch) git.must(["checkout", "-q", g.branch]);
  } else if (git.resolve(`refs/remotes/origin/${g.branch}`)) {
    git.must(["checkout", "-q", "-B", g.branch, `refs/remotes/origin/${g.branch}`]);
  } else {
    git.must(["checkout", "-q", "-B", g.branch, baseSha]);
  }
  baseSha = git.resolve(baseSha) ?? baseSha;
  writeAtomic(baseFile(ctx.attempt), baseSha);
  // The runtime clones as root, so the checkout is root's; a call that writes needs the agent to own it (found live:
  // a fresh-box agent got "Permission denied" on every repo file). Review calls stay root-owned, so they cannot edit.
  const chown = workdirChownArgs(layout.workdir, Boolean(g.readOnly));
  if (chown) {
    const r = spawnSync("chown", chown, { encoding: "utf8" });
    if (r.status !== 0) fail("boot", `Could not give the working tree to the agent: ${(r.stderr ?? "").trim()}`);
  }
  result.baseSha = baseSha;

  // Commit trailers for the agent's own commits, from a hooks dir the agent cannot write (spec §6.13).
  const hooksDir = hooksDirFor(layout);
  fs.mkdirSync(hooksDir, { recursive: true });
  writeAtomic(path.join(hooksDir, "prepare-commit-msg"), trailerHookScript(g.trailers), 0o755);
  result.hooksDir = hooksDir;
  return `${g.readOnly ? "detached" : g.branch} on ${baseSha.slice(0, 12)}`;
}

function hookCommand(
  ctx: BootContext,
  hook: "setup" | "start",
): { command: string; spec: HookSpec; hash: string } | undefined {
  const fromCode = ctx.spec.hooks?.[hook];
  if (fromCode) return { command: fromCode.command, spec: fromCode, hash: sha256(`code:${fromCode.command}`) };
  const script = path.join(ctx.layout.workdir, ".selfbuilding", `${hook}.sh`);
  const content = readText(script);
  if (content === undefined) return undefined;
  return {
    command: `bash .selfbuilding/${hook}.sh`,
    spec: { command: `bash .selfbuilding/${hook}.sh` },
    hash: sha256(`file:${content}`),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function hookPhase(ctx: BootContext, hook: "setup" | "start"): Promise<string> {
  const mode = ctx.spec.bootMode;
  if (mode === "reuse") return "skipped: reattaching to a running box is not a boot";
  if (hook === "setup" && mode !== "fresh" && mode !== "build") return `skipped: boot mode ${mode}`;
  const resolved = hookCommand(ctx, hook);
  if (!resolved) return "no hook";
  if (hook === "setup" && readText(ctx.layout.setupDone)?.trim() === resolved.hash)
    return "skipped: setup.done matches";
  const limit = resolved.spec.timeoutMs ?? (hook === "setup" ? ctx.spec.timeouts.setupMs : ctx.spec.timeouts.startMs);
  const logFile = path.join(ctx.attempt.hooks, `${hook}-${mode}.log`);
  const run = await runCommand(ctx.layout.mapCommand(resolved.command), {
    cwd: ctx.layout.workdir,
    env: {
      ...ctx.baseEnv,
      [RUNTIME_ENV.bootMode]: mode,
      [RUNTIME_ENV.runId]: ctx.spec.runId,
      [RUNTIME_ENV.hook]: hook,
    },
    timeoutMs: Math.max(1, Math.min(limit, ctx.bootLeftMs())),
    logFile,
    signal: ctx.signal,
  });
  const tail = ctx.redactor.text(tailFile(logFile, 4096));
  ctx.events.emit("sandbox.hook", { hook, bootMode: mode, exitCode: run.code, timedOut: run.timedOut, log: tail });
  if (run.cancelled) fail("aborted", `Cancelled during the ${hook} hook.`);
  if (run.timedOut)
    fail(
      "boot",
      `The ${hook} hook did not finish within timeouts.${hook}. Its log is in the call's artifacts.\n${tail}`,
    );
  if (run.code !== 0) {
    const message = `The ${hook} hook exited ${run.code ?? run.signal}.\n${tail}`;
    if (hook === "setup" && resolved.spec.allowFailure && mode === "fresh") {
      ctx.events.emit("warning", { scope: "setup", message }, { level: "warn" });
      return `failed (allowed): exit ${run.code}`;
    }
    fail("boot", message);
  }
  if (hook === "setup") writeAtomic(ctx.layout.setupDone, resolved.hash);
  return `exit 0`;
}

function skillsPhase(ctx: BootContext): string {
  const { names, linkDirs } = ctx.spec.skills;
  if (names.length === 0) return "no skills";
  const excludes: string[] = [];
  for (const name of names) {
    const source = ctx.layout.host(`${SANDBOX_PATHS.skills}/${name}`);
    if (!exists(source)) fail("boot", `Skill "${name}" is missing from ${SANDBOX_PATHS.skills}.`);
    for (const dir of linkDirs) {
      const linkParent = path.join(ctx.layout.workdir, dir);
      const link = path.join(linkParent, name);
      const relative = path.relative(ctx.layout.workdir, link);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        fail("config", `Skill link dir escapes the workdir: ${dir}`);
      fs.mkdirSync(linkParent, { recursive: true });
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(source, link);
      excludes.push(`/${relative}`);
    }
  }
  const exclude = path.join(ctx.layout.workdir, ".git", "info", "exclude");
  if (exists(path.dirname(exclude)) || exists(path.join(ctx.layout.workdir, ".git"))) {
    const current = readText(exclude) ?? "";
    const missing = excludes.filter((line) => !current.split("\n").includes(line));
    if (missing.length > 0) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    }
  }
  return `${names.length} skill(s) linked into ${linkDirs.join(", ") || "nothing"}`;
}

/** Repairs a session JSONL file whose last line a kill truncated (spec §6.8). */
export function repairSessionFiles(home: string, sessionId: string, maxDepth = 6): string[] {
  const repaired: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        const text = fs.readFileSync(full, "utf8");
        if (text.length === 0 || text.endsWith("\n")) continue;
        const cut = text.lastIndexOf("\n");
        fs.writeFileSync(full, cut >= 0 ? text.slice(0, cut + 1) : "");
        repaired.push(full);
      }
    }
  };
  walk(home, 0);
  return repaired;
}

function harnessPhase(ctx: BootContext, result: Partial<BootResult>): string {
  const { spec, layout } = ctx;
  writeJsonAtomic(layout.host(SANDBOX_PATHS.contract), spec.resultSchema);
  const argv = spec.plan.versionArgv;
  let version = spec.harnessVersion;
  if (argv.length > 0) {
    const probe = spawnSync(argv[0] as string, argv.slice(1), {
      cwd: layout.workdir,
      env: { ...ctx.baseEnv, HOME: layout.home },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (probe.error || probe.status !== 0) {
      const detail = probe.error
        ? String(probe.error)
        : `exit ${probe.status}: ${(probe.stderr || probe.stdout).trim().slice(-500)}`;
      fail("harness_start", `The harness version command failed (${argv.join(" ")}): ${detail}`, RUNTIME_EXIT.config);
    }
    const found = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(probe.stdout)?.[0];
    if (found) version = found;
    if (found && found !== spec.harnessVersion) {
      ctx.events.emit(
        "warning",
        {
          scope: "harness-version",
          message: `Requested ${spec.harness} ${spec.harnessVersion}, the image has ${found}.`,
        },
        { level: "warn" },
      );
    }
  }
  result.harnessVersion = version;
  if (spec.resumeSessionId) {
    const repaired = repairSessionFiles(layout.home, spec.resumeSessionId);
    if (repaired.length > 0) ctx.events.emit("session.repaired", { files: repaired.length });
  }
  const stat = fs.statSync(layout.workdir);
  const uid = process.getuid?.() ?? 0;
  result.agentUid = stat.uid;
  result.agentGid = stat.gid;
  result.isolation = uid === 0 && stat.uid !== 0 ? "isolated" : "same-user";
  return `${spec.harness} ${version}`;
}

/**
 * `chown` arguments that give a writable call's working tree (with its .git) to the workdir's owner, the agent user,
 * or null when nothing needs to change: a read-only call, a runtime not running as root, or a root-owned workdir.
 */
export function workdirChownArgs(
  workdir: string,
  readOnly: boolean,
  st: { uid: number; gid: number } = fs.statSync(workdir),
  runtimeUid: number = process.getuid?.() ?? 0,
): string[] | null {
  if (readOnly || runtimeUid !== 0 || st.uid === 0) return null;
  return ["-R", "-h", `${st.uid}:${st.gid}`, workdir];
}
