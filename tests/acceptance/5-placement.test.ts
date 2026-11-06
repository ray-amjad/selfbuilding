// Acceptance 5 (docs/BASIC-SCOPE.md): placement through agent calls inside run(): fresh boxes are isolated, a shared
// handle carries one working tree between agents (and refuses a second concurrent call), work hands off by typed
// result and by git branch, snapshot() and fork() copy a point in time, and a reviewer on another provider sees the
// builder's branch.
//
// Each agent proves what it sees with real shell steps in its box (`expectExit` fails the turn on a mismatch), so a
// placement mistake fails the run.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { agent, factory, fileArtifacts, run, type SandboxHandle, sandbox } from "@selfbuilding/core";
import { describePlacement } from "@selfbuilding/sandbox-conformance";
import {
  createLocalRemote,
  type ScriptCall,
  type ScriptStep,
  scripted,
  type TmpdirProvider,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, scriptedCodex, tempDir, useBuiltRuntime } from "./support/kit.js";

let dir: string;
let primary: TmpdirProvider;
let secondary: TmpdirProvider;
let repo: string;

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-place-");
  primary = tmpdirProvider({ id: "tmpdir-primary", root: path.join(dir, "primary") });
  secondary = tmpdirProvider({ id: "tmpdir-secondary", root: path.join(dir, "secondary") });
  repo = (await createLocalRemote(path.join(dir, "remote"), { files: { "README.md": "# placement\n" } })).url;
});

afterAll(async () => {
  await primary?.close();
  await secondary?.close();
});

const Ok = z.object({ ok: z.literal(true) });
const ok = scripted.submit({ ok: true });
const must = (cmd: string) => scripted.sh(cmd, { expectExit: 0 });

/** Scripts keyed by agent label; every one ends by submitting `{ ok: true }`. */
function byLabel(scripts: Record<string, ScriptStep[]>) {
  return (call: ScriptCall): ScriptStep[] => {
    const label = call.callPath.split("/").at(-1) ?? "";
    const steps = scripts[label];
    if (!steps) throw new Error(`no script for ${call.callPath}`);
    return [...steps, ok];
  };
}

const call = (label: string, sandboxOpt: "fresh" | SandboxHandle | TmpdirProvider, extra: object = {}) =>
  agent({ name: label, prompt: `Placement step ${label}.`, output: Ok, label, sandbox: sandboxOpt, repo, ...extra });

async function runFactory(
  name: string,
  body: () => Promise<unknown>,
  scripts: Record<string, ScriptStep[]>,
  harness = scriptedClaude(byLabel(scripts)),
) {
  const events = recorder();
  const out = await run(
    factory({ name, input: z.object({}) }, body),
    {},
    {
      config: {
        deployment: "acceptance",
        sandbox: primary,
        harness,
        artifacts: fileArtifacts(path.join(dir, "artifacts")),
      },
      events: [events.sink],
    },
  );
  return { out, events };
}

const expectOk = (r: Awaited<ReturnType<typeof runFactory>>) =>
  expect(r.out.status, JSON.stringify(r.events.of("error").map((e) => e.data))).toBe("ok");

describe("acceptance 5: placement", () => {
  it("fresh: each agent gets its own box, so B cannot see A's uncommitted file", async () => {
    const r = await runFactory(
      "fresh",
      async () => {
        await call("a", "fresh");
        await call("b", "fresh");
        return null;
      },
      {
        a: [must("echo draft > scratch.txt && test -e scratch.txt")],
        b: [must("test ! -e scratch.txt && test -e README.md")],
      },
    );
    expectOk(r);
    const boxes = r.events.of("agent.launched").map((e) => (e.data as { sandbox: string }).sandbox);
    expect(new Set(boxes).size).toBe(2);
  });

  it("shared handle: B sees A's working tree, and a second concurrent call on the handle is refused", async () => {
    let concurrent: string[] = [];
    const r = await runFactory(
      "shared",
      async () => {
        await using box = sandbox({ label: "work", repo });
        await call("a", box);
        await call("b", box);
        const settled = await Promise.allSettled([call("c", box), call("d", box)]);
        concurrent = settled.map((s) => (s.status === "fulfilled" ? "ok" : (s.reason as Error).name));
        return null;
      },
      {
        a: [must("echo shared > notes.txt")],
        b: [must("grep -q shared notes.txt")],
        c: [scripted.sh("sleep 0.5")],
        d: [],
      },
    );
    expectOk(r);
    expect(concurrent.sort()).toEqual(["SandboxBusyError", "ok"]);
    const boxes = r.events.of("agent.launched").map((e) => (e.data as { sandbox: string }).sandbox);
    expect(new Set(boxes).size).toBe(1);
  });

  it("shared handle on another base: the working branch starts from the call's git.baseBranch, not the default branch", async () => {
    // A second branch with unrelated history, like a fixture branch that is not the repo's default.
    const remote = await createLocalRemote(path.join(dir, "remote-bases"), { files: { "README.md": "# main\n" } });
    const seed = path.join(dir, "seed-side");
    await fs.mkdir(seed, { recursive: true });
    const g = (...args: string[]) => execFileSync("git", args, { cwd: seed, env: { ...process.env, ...remote.env } });
    g("init", "-q", "--initial-branch=side");
    await fs.writeFile(path.join(seed, "SIDE.md"), "side\n");
    g("add", "-A");
    g("commit", "-q", "-m", "side");
    g("push", "-q", remote.bareDir, "HEAD:refs/heads/side");
    let mismatch = "";
    const r = await runFactory(
      "shared-base",
      async () => {
        await using box = sandbox({ label: "work", repo: remote.url });
        await call("a", box, { repo: remote.url, git: { baseBranch: "side" } });
        await call("b", box, { repo: remote.url });
        try {
          await call("c", box, { repo: remote.url, git: { baseBranch: "main" } });
        } catch (error) {
          mismatch = (error as Error).message;
        }
        return null;
      },
      {
        a: [must("test -e SIDE.md && test ! -e README.md")],
        b: [must("test -e SIDE.md")],
        c: [],
      },
    );
    expectOk(r);
    expect(mismatch).toContain('disagrees with the shared handle\'s base "side"');
  });

  it("handoff by typed result: B receives A's result as its input", async () => {
    const Token = z.object({ token: z.string() });
    let received: unknown;
    const harness = scriptedClaude((c) => {
      const label = c.callPath.split("/").at(-1);
      if (label === "a") return [scripted.submit({ token: "tok-7f3a" })];
      // The input is rendered into B's prompt.
      return [must("grep -rq tok-7f3a /selfbuilding/in"), ok];
    });
    const r = await runFactory(
      "typed",
      async () => {
        const a = await agent({ name: "a", prompt: "Make a token.", output: Token, label: "a", repo });
        const b = await agent({ name: "b", prompt: "Use the token.", input: a.result, output: Ok, label: "b", repo });
        received = b.result;
        return a.result;
      },
      {},
      harness,
    );
    expectOk(r);
    expect(r.out.output).toEqual({ token: "tok-7f3a" });
    expect(received).toEqual({ ok: true });
  });

  it("handoff by git branch: B checks out the branch A pushed to the shared remote", async () => {
    let branch: string | undefined;
    const r = await runFactory(
      "branch",
      async () => {
        const a = await call("a", "fresh");
        branch = a.artifacts.branch?.name;
        if (!branch) throw new Error("A pushed no branch");
        await call("b", "fresh", { git: { branch } });
        return null;
      },
      {
        a: [must("echo 'export const built = true;' > built.js && git add -A && git commit -qm 'Build it'")],
        b: [must("grep -q built built.js && git log --format=%s | grep -q 'Build it'")],
      },
    );
    expectOk(r);
    expect(branch).toMatch(/^selfbuilding\//);
  });

  it("snapshot: B starts from A's snapshot, and A's later writes do not show up in B", async () => {
    const r = await runFactory(
      "snapshot",
      async () => {
        await using box = sandbox({ label: "work", repo });
        await call("a", box);
        const snap = await box.snapshot();
        await call("a-later", box);
        await using from = sandbox({ label: "restored", repo, from: snap });
        await call("b", from);
        return null;
      },
      {
        a: [must("echo v1 > state.txt")],
        "a-later": [must("echo v2 > state.txt && echo late > later.txt")],
        b: [must("grep -q v1 state.txt && test ! -e later.txt")],
      },
    );
    expectOk(r);
  });

  it("fork: reviewers on forks see the build, and the build box does not see the forks' writes", async () => {
    const r = await runFactory(
      "fork",
      async () => {
        await using box = sandbox({ label: "work", repo });
        await call("build", box);
        const forks = await box.fork(2);
        try {
          await box.exec("echo after-fork > after.txt");
          await Promise.all(forks.map((f, i) => call(`review-${i}`, f ?? "fresh")));
        } finally {
          await Promise.all(forks.map((f) => f?.dispose()));
        }
        await call("check", box);
        return null;
      },
      {
        build: [must("echo built > built.txt && git add -A && git commit -qm build")],
        "review-0": [must("grep -q built built.txt && test ! -e after.txt && echo mine > fork0.txt")],
        "review-1": [must("grep -q built built.txt && test ! -e after.txt && test ! -e fork0.txt")],
        check: [must("test -e after.txt && test ! -e fork0.txt")],
      },
    );
    expectOk(r);
    expect(r.events.of("sandbox.forked").map((e) => (e.data as { ok: number }).ok)).toEqual([2]);
  });

  it("cross-provider review: a Codex reviewer on another provider reviews the branch built on the first", async () => {
    let reviewHarness: string | undefined;
    const claude = scriptedClaude(
      byLabel({ build: [must("echo 'export const x = 1;' > x.js && git add -A && git commit -qm 'Add x'")] }),
    );
    const codex = scriptedCodex(
      byLabel({ review: [must("grep -q 'export const x' x.js && git log --format=%s | grep -q 'Add x'")] }),
    );
    const r = await runFactory(
      "cross",
      async () => {
        await using box = sandbox({ label: "work", repo });
        await call("build", box, { harness: claude });
        const pushed = await box.push();
        const review = await call("review", secondary, { harness: codex, git: { branch: pushed.name } });
        reviewHarness = review.harness.id;
        return null;
      },
      {},
      claude,
    );
    expectOk(r);
    expect(reviewHarness).toBe("scripted-codex");
    const launched = r.events.of("agent.launched");
    const created = r.events.of("sandbox.created").map((e) => JSON.stringify(e.data));
    expect(launched).toHaveLength(2);
    expect(created.some((d) => d.includes('"provider":"tmpdir-secondary"'))).toBe(true);
  });
});

// The provider-level placement suite on the same providers, offline.
describePlacement("tmpdir primary, tmpdir secondary", () => ({ primary, secondary }), { timeoutMs: 60_000 });
