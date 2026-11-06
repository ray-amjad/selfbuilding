import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { branchName, ConfigError, type GitToken, type ProviderSandbox, PushFailedError } from "@selfbuilding/core";
import {
  commitToBranch,
  createLocalRemote,
  type GitHubEmulator,
  isolatedEnv,
  type LocalRemote,
  mirrorRefs,
  openTestBox,
  startGitHubEmulator,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubApp } from "./app.js";
import { openOrUpdatePr, prBody } from "./pulls.js";
import {
  assertPushAllowed,
  callBranchName,
  isPushAllowed,
  PUSH_TOKEN_PATH,
  pushBranch,
  pushScript,
  shellQuote,
  verifyPush,
} from "./push.js";

describe("callBranchName", () => {
  it("names the same branch core gives an agent call", () => {
    for (const scope of ["review#0", "pipeline#0/[Issue 412]/implement#0", "root/Review--Codex", "x".repeat(200)]) {
      expect(callBranchName("ns_1", scope)).toBe(branchName("ns_1", scope));
    }
  });

  it("follows the spec's slug rule", () => {
    expect(callBranchName("ns_01jb7kq4x9m2ra", "pipeline#0/[issue-412]/stage#1/ImplementSpec#0")).toBe(
      "selfbuilding/ns_01jb7kq4x9m2ra/pipeline-0-issue-412-stage-1-implementspec-0",
    );
    expect(callBranchName("ns_1", "root/Review--Codex")).toBe("selfbuilding/ns_1/review-codex");
    expect(callBranchName("ns_1", "build")).toBe("selfbuilding/ns_1/build");
  });

  it("caps long scopes at 53 characters plus a 6-hex hash, deterministically", () => {
    const scope = `pipeline#0/${"x".repeat(80)}/ImplementSpec#0`;
    const name = callBranchName("ns_1", scope);
    const slug = name.slice("selfbuilding/ns_1/".length);
    expect(slug).toMatch(/^pipeline-0-x+-[0-9a-f]{6}$/);
    expect(slug).toHaveLength(60);
    expect(callBranchName("ns_1", scope)).toBe(name);
    expect(callBranchName("ns_1", `${scope}#1`)).not.toBe(name);
  });

  it("rejects run ids and scopes that cannot name a branch", () => {
    expect(() => callBranchName("ns 1", "x")).toThrow(ConfigError);
    expect(() => callBranchName("ns_1", "##")).toThrow(/no letters or digits/);
  });
});

describe("push allowlist", () => {
  it("allows only selfbuilding branches, checkpoint refs and listed refs", () => {
    expect(isPushAllowed("selfbuilding/ns_1/build")).toBe(true);
    expect(isPushAllowed("refs/heads/selfbuilding/ns_1/build")).toBe(true);
    expect(isPushAllowed("refs/selfbuilding/ns_1/box/3")).toBe(true);
    expect(isPushAllowed("main")).toBe(false);
    expect(isPushAllowed("refs/heads/selfbuildingx/a")).toBe(false);
    expect(isPushAllowed("refs/tags/v1")).toBe(false);
    expect(isPushAllowed("release/next", ["release/next"])).toBe(true);
    expect(isPushAllowed("refs/heads/release/next", ["release/next"])).toBe(true);
  });

  it("rejects malformed refs even under the prefix", () => {
    for (const bad of [
      "selfbuilding/../main",
      "selfbuilding/a b",
      "selfbuilding/a;rm",
      "selfbuilding/a:b",
      "-selfbuilding/x",
      "selfbuilding/x.lock",
      "selfbuilding//x",
      "selfbuilding/.hidden",
    ]) {
      expect(isPushAllowed(bad), bad).toBe(false);
    }
  });

  it("assertPushAllowed explains the refusal and checks sources", () => {
    expect(() => assertPushAllowed([{ src: "HEAD", dst: "main" }])).toThrow(/refs\/heads\/main.*allowPushTo/);
    expect(() => assertPushAllowed([])).toThrow(/Nothing to push/);
    expect(() => assertPushAllowed([{ src: "--upload-pack=x", dst: "selfbuilding/r/x" }])).toThrow(/local rev/);
    expect(() => assertPushAllowed([{ src: "HEAD", dst: "selfbuilding/r/x" }])).not.toThrow();
  });
});

describe("pushScript", () => {
  it("pushes to the explicit URL from a clean scratch repo, leases, and deletes the token on exit", () => {
    const script = pushScript({ refs: [{ src: "HEAD", dst: "selfbuilding/r/x" }], url: "https://github.com/a/b.git" });
    expect(script).toContain(`rm -f '\\''/run/selfbuilding/secrets/git-push-token'\\''; rm -rf "$D"`);
    expect(script).toContain('export GIT_DIR="$D/p.git" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1');
    expect(script).toContain(`[ "$l" = 'host=github.com' ] && ok=1`);
    expect(script).toContain(
      `push --porcelain "--force-with-lease=refs/heads/selfbuilding/r/x:$e0" 'https://github.com/a/b.git' "$s0:refs/heads/selfbuilding/r/x"`,
    );
    expect(script).not.toMatch(/push[^\n]*'origin'/);
  });

  it("uses explicit leases when given", () => {
    const script = pushScript({
      refs: [
        { src: "HEAD", dst: "selfbuilding/r/x", expect: "" },
        { src: "abc", dst: "refs/selfbuilding/r/box/1", expect: "def" },
      ],
      url: "/tmp/remote/remote.git",
    });
    expect(script).toContain(
      "--force-with-lease='refs/heads/selfbuilding/r/x:' --force-with-lease='refs/selfbuilding/r/box/1:def' '/tmp/remote/remote.git'",
    );
  });

  it("quotes for sh", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

// ─── In a real (tmpdir) box against a local bare remote ───

const provider = tmpdirProvider();
afterAll(() => provider.close());

const identity = {
  GIT_AUTHOR_NAME: "Selfbuilding Bot",
  GIT_AUTHOR_EMAIL: "bot@selfbuilding.test",
  GIT_COMMITTER_NAME: "Selfbuilding Bot",
  GIT_COMMITTER_EMAIL: "bot@selfbuilding.test",
};

interface Fixture {
  box: ProviderSandbox;
  /** Host path of the bare remote, inside the box's /tmp. */
  bareDir: string;
  /** Host path of the box's push token file. */
  tokenFile: string;
  remoteEnv: Record<string, string>;
  remote: LocalRemote;
}

/** A box with /selfbuilding/work cloned from a bare remote that lives at /tmp/remote/remote.git inside the box. */
async function boxWithClone(): Promise<Fixture> {
  const box = await openTestBox(provider, `push-${Math.random().toString(36).slice(2)}`);
  const root = provider.boxRoot(box.ref);
  const remote = await createLocalRemote(path.join(root, "tmp", "remote"));
  const sh = async (cmd: string) => {
    const r = await box.exec(cmd, { cwd: "/selfbuilding/work", env: identity });
    if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderrTail}`);
    return r.stdoutTail.trim();
  };
  await sh("git clone -q /tmp/remote/remote.git .");
  return {
    box,
    bareDir: remote.bareDir,
    tokenFile: path.join(root, PUSH_TOKEN_PATH),
    remoteEnv: remote.env,
    remote,
  };
}

async function agentCommits(box: ProviderSandbox, branch: string, file: string, content: string): Promise<string> {
  const r = await box.exec(
    `git checkout -q -B ${shellQuote(branch)} && printf %s ${shellQuote(content)} > ${shellQuote(file)} && git add -A && git commit -q -m ${shellQuote(`update ${file}`)} && git rev-parse HEAD`,
    { cwd: "/selfbuilding/work", env: identity },
  );
  if (r.exitCode !== 0) throw new Error(r.stderrTail);
  return r.stdoutTail.trim();
}

function fakeBroker(value = "ghs_fake_push_token") {
  const revoked: string[] = [];
  const minted: string[] = [];
  return {
    revoked,
    minted,
    broker: {
      async pushToken(req: { launchId: string }): Promise<GitToken> {
        minted.push(req.launchId);
        return { value, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: "write" } };
      },
      async revoke(token: GitToken) {
        revoked.push(token.value);
      },
    },
  };
}

const request = { repo: "github.com/acme/playground", runId: "ns_run1", callPath: "ImplementSpec#0", launchId: "l1" };
/** The box-local bare remote every fixture clones from. */
const url = "/tmp/remote/remote.git";

describe("pushBranch and verifyPush in a tmpdir box", () => {
  it("pushes the call branch, deletes and revokes the token, and verifies with ls-remote", async () => {
    const f = await boxWithClone();
    const branch = callBranchName("ns_run1", "ImplementSpec#0");
    const head = await agentCommits(f.box, branch, "src/math.js", "export const multiply = (a, b) => a * b;\n");
    const fake = fakeBroker();

    const result = await pushBranch(f.box, { url, broker: fake.broker, request, refs: [{ src: "HEAD", dst: branch }] });
    expect(result).toEqual({ pushed: true, refs: [{ ref: `refs/heads/${branch}`, sha: head, remoteSha: head }] });
    expect(fake.minted).toEqual(["l1"]);
    expect(fake.revoked).toEqual(["ghs_fake_push_token"]);
    expect(existsSync(f.tokenFile)).toBe(false);

    // A second round on the same branch (a fixer after review) fast-forwards under the lease.
    const fix = await agentCommits(f.box, branch, "FIX.md", "fixed\n");
    const again = await pushBranch(f.box, { url, broker: fake.broker, request, refs: [{ src: "HEAD", dst: branch }] });
    expect(again.refs[0]?.remoteSha).toBe(fix);
  });

  it("writes the token as a 0600 file for exactly the push", async () => {
    const f = await boxWithClone();
    const branch = "selfbuilding/ns_run1/mode";
    await agentCommits(f.box, branch, "a.txt", "a");
    const seen: { mode: number; content: string }[] = [];
    const spy = {
      exec: async (cmd: string, o?: Parameters<ProviderSandbox["exec"]>[1]) => {
        if (cmd.includes(" push ")) {
          const stat = await fs.stat(f.tokenFile);
          seen.push({ mode: stat.mode & 0o777, content: await fs.readFile(f.tokenFile, "utf8") });
        }
        return f.box.exec(cmd, o);
      },
      writeFiles: f.box.writeFiles.bind(f.box),
    };
    await pushBranch(spy, { url, broker: fakeBroker("tok-123").broker, request, refs: [{ src: "HEAD", dst: branch }] });
    expect(seen).toEqual([{ mode: 0o600, content: "tok-123" }]);
    expect(existsSync(f.tokenFile)).toBe(false);
  });

  it("refuses a ref outside the allowlist before minting a token", async () => {
    const f = await boxWithClone();
    const fake = fakeBroker();
    await expect(
      pushBranch(f.box, { url, broker: fake.broker, request, refs: [{ src: "HEAD", dst: "main" }] }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(fake.minted).toEqual([]);
  });

  it("fails with PushFailedError when the remote rejects, still deleting the token and never echoing it", async () => {
    const f = await boxWithClone();
    // The remote's own hook (not the box's) rejects the push. The token is printed by it to prove redaction.
    const hook = path.join(f.bareDir, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\necho 'denied for ghs_secret_value' >&2\nexit 1\n", { mode: 0o755 });
    const branch = "selfbuilding/ns_run1/rejected";
    await agentCommits(f.box, branch, "a.txt", "a");
    const fake = fakeBroker("ghs_secret_value");
    const error = await pushBranch(f.box, {
      url,
      broker: fake.broker,
      request,
      refs: [{ src: "HEAD", dst: branch }],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushFailedError);
    expect((error as PushFailedError).message).toContain("denied for [redacted]");
    expect((error as PushFailedError).message).not.toContain("ghs_secret_value");
    expect((error as PushFailedError).recovery?.branch).toBe(`refs/heads/${branch}`);
    expect(existsSync(f.tokenFile)).toBe(false);
    expect(fake.revoked).toEqual(["ghs_secret_value"]);
  });

  it("never sends the token where the box's repo config points: pushurl and insteadOf are ignored", async () => {
    const f = await boxWithClone();
    const branch = "selfbuilding/ns_run1/redirect";
    const head = await agentCommits(f.box, branch, "a.txt", "a");
    const root = provider.boxRoot(f.box.ref);
    const made = await f.box.exec(
      [
        "git init -q --bare /tmp/decoy.git",
        "git config remote.origin.pushurl /tmp/decoy.git",
        "git config url./tmp/decoy.git.insteadOf /tmp/remote/remote.git",
      ].join(" && "),
      { cwd: "/selfbuilding/work" },
    );
    expect(made.exitCode).toBe(0);
    const result = await pushBranch(f.box, {
      url,
      broker: fakeBroker().broker,
      request,
      refs: [{ src: "HEAD", dst: branch }],
    });
    expect(result.refs[0]?.remoteSha).toBe(head);
    expect(await fs.readdir(path.join(root, "tmp", "decoy.git", "refs", "heads"))).toEqual([]);
  });

  it("never runs an agent-planted pre-push hook during the host push", async () => {
    const f = await boxWithClone();
    const branch = "selfbuilding/ns_run1/hooks";
    await agentCommits(f.box, branch, "a.txt", "a");
    const planted = await f.box.exec(
      [
        "printf '#!/bin/sh\\ntouch /tmp/pwned-hook\\n' > .git/hooks/pre-push",
        "chmod +x .git/hooks/pre-push",
        "git config credential.helper '!touch /tmp/pwned-helper; echo'",
      ].join(" && "),
      { cwd: "/selfbuilding/work" },
    );
    expect(planted.exitCode).toBe(0);
    await pushBranch(f.box, { url, broker: fakeBroker().broker, request, refs: [{ src: "HEAD", dst: branch }] });
    const root = provider.boxRoot(f.box.ref);
    expect(existsSync(path.join(root, "tmp", "pwned-hook"))).toBe(false);
    expect(existsSync(path.join(root, "tmp", "pwned-helper"))).toBe(false);
  });

  it("verifyPush reports pushed: false when the remote differs from local HEAD", async () => {
    const f = await boxWithClone();
    const branch = "selfbuilding/ns_run1/verify";
    await agentCommits(f.box, branch, "a.txt", "a");
    const absent = await verifyPush(f.box, { url, refs: [{ src: "HEAD", dst: branch }] });
    expect(absent.pushed).toBe(false);
    expect(absent.refs[0]?.remoteSha).toBeNull();

    await pushBranch(f.box, { url, broker: fakeBroker().broker, request, refs: [{ src: "HEAD", dst: branch }] });
    const local = await agentCommits(f.box, branch, "b.txt", "b");
    const stale = await verifyPush(f.box, { url, refs: [{ src: "HEAD", dst: branch }] });
    expect(stale.pushed).toBe(false);
    expect(stale.refs[0]?.sha).toBe(local);
    expect(stale.refs[0]?.remoteSha).not.toBe(local);
    await expect(verifyPush(f.box, { url, refs: [{ src: "no-such-rev", dst: branch }] })).rejects.toBeInstanceOf(
      PushFailedError,
    );
  });

  it("a lease refuses to overwrite a branch someone else moved", async () => {
    const f = await boxWithClone();
    const branch = "selfbuilding/ns_run1/lease";
    await agentCommits(f.box, branch, "a.txt", "a");
    await pushBranch(f.box, { url, broker: fakeBroker().broker, request, refs: [{ src: "HEAD", dst: branch }] });
    // Someone else moves the remote branch; the box's remote-tracking ref is now stale.
    const theirs = await commitToBranch(f.remote, { branch, from: branch, files: { "theirs.txt": "x" } });
    await agentCommits(f.box, branch, "b.txt", "b");
    await expect(
      pushBranch(f.box, { url, broker: fakeBroker().broker, request, refs: [{ src: "HEAD", dst: branch }] }),
    ).rejects.toThrow(/stale info|rejected/);
    // "Must not exist" refuses a branch that does.
    await expect(
      pushBranch(f.box, {
        url,
        broker: fakeBroker().broker,
        request,
        refs: [{ src: "HEAD", dst: branch, expect: "" }],
      }),
    ).rejects.toBeInstanceOf(PushFailedError);
    const remoteHead = await f.box.exec(`git ls-remote origin refs/heads/${branch}`, { cwd: "/selfbuilding/work" });
    expect(remoteHead.stdoutTail.split("\t")[0]).toBe(theirs);
  });
});

describe("implement → push → PR as the App (emulated GitHub)", () => {
  let gh: GitHubEmulator;
  beforeAll(async () => {
    gh = await startGitHubEmulator();
  });
  afterAll(() => gh.close());

  it("mints a real push token, pushes the call branch, mirrors it and opens the PR with the notes", async () => {
    const f = await boxWithClone();
    await mirrorRefs(gh, { gitDir: f.bareDir, refs: ["main"], env: f.remoteEnv });
    const broker = githubApp({
      appId: gh.app.appId,
      privateKey: gh.appPrivateKey,
      apiUrl: gh.url,
      requireRuleset: false,
    });
    const repo = `github.com/${gh.owner}/${gh.repo}`;
    const branch = callBranchName("ns_run1", "ImplementSpec#0");
    await agentCommits(f.box, branch, "src/math.js", "export const multiply = (a, b) => a * b;\n");

    const push = await pushBranch(f.box, {
      url,
      broker,
      request: { ...request, repo },
      refs: [{ src: "HEAD", dst: branch }],
    });
    expect(push.pushed).toBe(true);
    expect(existsSync(f.tokenFile)).toBe(false);
    // The emulator has no smart HTTP: copy what landed in the bare remote, as the test kit documents.
    await mirrorRefs(gh, { gitDir: f.bareDir, refs: [branch], env: isolatedEnv(path.dirname(f.bareDir)) });

    const pr = await openOrUpdatePr(broker, {
      repo,
      head: branch,
      base: "main",
      title: "ImplementSpec: add multiply",
      body: prBody({
        summary: "Adds multiply().",
        implementationNotes: "- Chose a plain function.",
        trailers: { run: "ns_run1", call: "ns_run1.ImplementSpec#0", agent: "ImplementSpec" },
      }),
      draft: true,
      push: { pushed: push.pushed, refs: push.refs },
    });
    expect(pr.created).toBe(true);
    const fetched = await gh.api<{ body: string; user: { login: string }; head: { ref: string } }>(
      `/repos/${gh.owner}/${gh.repo}/pulls/${pr.number}`,
    );
    expect(fetched.user.login).toBe(`${gh.app.slug}[bot]`);
    expect(fetched.head.ref).toBe(branch);
    expect(fetched.body).toContain("## Implementation notes");
    expect(fetched.body).toContain("Selfbuilding-Run: ns_run1");
  });
});
