import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitSpec } from "@selfbuilding/core";

export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Env for every git command the supervisor runs: no prompts, no pager, no user or system config surprises. */
export function gitEnv(spec: GitSpec | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (spec) {
    env.GIT_AUTHOR_NAME = spec.identity.authorName;
    env.GIT_AUTHOR_EMAIL = spec.identity.authorEmail;
    env.GIT_COMMITTER_NAME = spec.identity.committerName;
    env.GIT_COMMITTER_EMAIL = spec.identity.committerEmail;
  }
  return { ...env, ...extra };
}

export class Git {
  constructor(
    readonly cwd: string,
    readonly env: Record<string, string>,
  ) {}

  run(args: string[], opts: { input?: string; env?: Record<string, string>; cwd?: string } = {}): GitRun {
    const cwd = opts.cwd ?? this.cwd;
    // The supervisor runs as root in a workspace the agent user owns; without this git refuses with "dubious
    // ownership". Command-line config counts as protected config, so git honours it here.
    const result = spawnSync("git", ["-c", `safe.directory=${cwd}`, ...args], {
      cwd,
      env: { ...this.env, ...opts.env },
      input: opts.input,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return {
      code: result.status ?? (result.error ? 127 : 1),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    };
  }

  /** Runs git and throws a plain description on failure; callers turn it into an outcome. */
  must(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
    const result = this.run(args, opts);
    if (result.code !== 0) throw new GitCommandFailure(args, result);
    return result.stdout.trim();
  }

  isRepo(): boolean {
    return fs.existsSync(path.join(this.cwd, ".git"));
  }

  head(): string | undefined {
    const result = this.run(["rev-parse", "--verify", "-q", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  resolve(ref: string): string | undefined {
    const result = this.run(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  currentBranch(): string | undefined {
    const result = this.run(["symbolic-ref", "--short", "-q", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /** Tracked or untracked, non-ignored changes. */
  dirty(): boolean {
    return this.run(["status", "--porcelain", "--untracked-files=all"]).stdout.trim().length > 0;
  }

  changedFiles(): string[] {
    return this.run(["status", "--porcelain", "--untracked-files=all", "-z"])
      .stdout.split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .filter(Boolean);
  }

  /** The tree of the working directory, including untracked non-ignored files, without touching the real index. */
  worktreeTree(): string | undefined {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-index-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(dir, "index") };
      const head = this.head();
      if (head && this.run(["read-tree", head], { env }).code !== 0) return undefined;
      if (this.run(["add", "-A", "."], { env }).code !== 0) return undefined;
      const tree = this.run(["write-tree"], { env });
      return tree.code === 0 ? tree.stdout.trim() : undefined;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  commitsAhead(base: string): number {
    const result = this.run(["rev-list", "--count", `${base}..HEAD`]);
    return result.code === 0 ? Number(result.stdout.trim()) || 0 : 0;
  }

  /** Commits every tracked and untracked change, excluding ignored files, as one commit. */
  commitAll(subject: string, trailers: GitSpec["trailers"]): string | undefined {
    if (!this.dirty()) return undefined;
    this.must(["add", "-A", "."]);
    const message = `${subject}\n\n${formatTrailers(trailers)}\n`;
    this.must(["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-F", "-"], { input: message });
    return this.head();
  }

  /** Resets HEAD to `headSha` and the working tree to exactly `treeSha` (spec §4.5.1, "revert"). */
  restoreTo(headSha: string, treeSha: string): void {
    this.must(["reset", "-q", "--hard", headSha]);
    this.must(["clean", "-q", "-fd"]);
    this.must(["read-tree", treeSha]);
    this.must(["checkout-index", "-a", "-f"]);
    this.must(["reset", "-q"]);
  }
}

export class GitCommandFailure {
  readonly message: string;
  constructor(
    readonly args: string[],
    readonly result: GitRun,
  ) {
    this.message = `git ${args.join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-2000)}`;
  }
}

export function formatTrailers(trailers: GitSpec["trailers"]): string {
  return [
    `Selfbuilding-Run: ${trailers.run}`,
    `Selfbuilding-Call: ${trailers.call}`,
    `Selfbuilding-Agent: ${trailers.agent}`,
  ].join("\n");
}

/** A prepare-commit-msg hook that adds the trailers to the agent's own commits. */
export function trailerHookScript(trailers: GitSpec["trailers"]): string {
  const args = [
    `Selfbuilding-Run: ${trailers.run}`,
    `Selfbuilding-Call: ${trailers.call}`,
    `Selfbuilding-Agent: ${trailers.agent}`,
  ]
    .map((t) => `--trailer ${quote(t)}`)
    .join(" ");
  return `#!/bin/sh\n# Installed by selfbuilding-runtime: adds the run trailers to every commit.\ngit interpret-trailers --in-place --if-exists addIfDifferent ${args} "$1" 2>/dev/null || true\n`;
}

/** The binary diff of two trees or commits. */
export function diffBinary(git: Git, from: string, to: string): string {
  return git.run(["diff", "--binary", from, to]).stdout;
}
