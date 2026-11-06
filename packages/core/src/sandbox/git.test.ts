import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderSandbox } from "../types/sandbox.js";
import { scratchFetch, syncWorkdir } from "./git.js";

// Regression: shipChange failed at checkout with "detected dubious ownership in repository at
// '/tmp/selfbuilding-git.XXXX/s.git'". The scratch repo is root's and the agent user fetches from it; the local
// fetch runs upload-pack in the scratch repo with GIT_CONFIG_PARAMETERS cleared, so `-c safe.directory=*` on the
// outer git does not reach it. Git's own test switch makes every repo look foreign, which reproduces the owner
// mismatch without root.

let dir: string;
let bare: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-scratch-"));
  bare = path.join(dir, "s.git");
  const seed = path.join(dir, "seed");
  git(dir, "init", "-q", "--bare", bare);
  git(dir, "init", "-q", seed);
  git(seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "seed");
  git(seed, "push", "-q", bare, "HEAD:refs/remotes/origin/main");
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function freshClone(): Promise<string> {
  const work = await fs.mkdtemp(path.join(dir, "work-"));
  git(work, "init", "-q");
  return work;
}

const foreignOwner = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_TERMINAL_PROMPT: "0" };

describe("the agent's fetch from the root-owned scratch repo", () => {
  // Documents git's behaviour, not ours: some git versions (2.43, in the sandbox images) drop the outer -c for the
  // local upload-pack, newer ones keep it. Where this git keeps it there is no failure to show, so it is skipped;
  // the next test is the regression check and runs everywhere.
  it("a plain -c safe.directory on the outer git is refused (the live failure)", async (ctx) => {
    const work = await freshClone();
    const r = spawnSync(
      "sh",
      ["-c", `git -c safe.directory='*' fetch -q '${bare}' '+refs/remotes/origin/*:refs/remotes/origin/*'`],
      { cwd: work, env: foreignOwner, encoding: "utf8" },
    );
    if (r.status === 0) ctx.skip();
    expect(r.stderr).toMatch(/dubious ownership/);
  });

  it("scratchFetch passes safe.directory for that exact path to upload-pack, and the fetch succeeds", async () => {
    const work = await freshClone();
    const cmd = scratchFetch(bare);
    expect(cmd).toContain(`--upload-pack='git -c safe.directory='\\''${bare}'\\'' upload-pack'`);
    const r = spawnSync("sh", ["-c", cmd], { cwd: work, env: foreignOwner, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(git(work, "rev-parse", "refs/remotes/origin/main")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("syncWorkdir's agent-side checkout fetches the scratch repo through scratchFetch", async () => {
    const scripts: { user: string | undefined; script: string }[] = [];
    const box = {
      writeFiles: async () => undefined,
      exec: async (script: string, opts: { user?: "agent" | "root" }) => {
        scripts.push({ user: opts.user, script });
        const first = scripts.length === 1;
        return {
          exitCode: 0,
          stdoutTail: first ? "/tmp/selfbuilding-git.abc123 main\n" : `${"a".repeat(40)} ${"b".repeat(40)}\n`,
          stderrTail: "",
          truncated: false,
        };
      },
    } as unknown as ProviderSandbox;
    await syncWorkdir(box, { remoteUrl: "https://github.com/acme/api.git", branch: "selfbuilding/r/work" });
    const agentScript = scripts.find((s) => s.user === "agent")?.script ?? "";
    expect(agentScript).toContain(scratchFetch("/tmp/selfbuilding-git.abc123/s.git"));
  });
});
