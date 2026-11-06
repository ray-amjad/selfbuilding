import type { ArtifactStore, ExecResult, SandboxHandle } from "@selfbuilding/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// release-prep §7.2 #1 and #3, pinned on verifyFlows' own control flow with the engine mocked: the Slack post is
// mrkdwn, and evidence is read off a fork only for a Verify call that failed (the runtime collected the rest).

const core = vi.hoisted(() => ({
  posts: [] as string[],
  execs: [] as { box: string; cmd: string }[],
  verifyFails: false,
  stored: new Map<string, Uint8Array>(),
}));

vi.mock("@selfbuilding/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@selfbuilding/core")>();
  const store = {
    put: async (key: string, body: string | Uint8Array) => {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array);
      core.stored.set(`mem://${key}`, bytes);
      return { uri: `mem://${key}`, sha256: "0", bytes: bytes.length, contentType: "application/octet-stream" };
    },
    read: async (uri: string) => core.stored.get(uri) ?? new Uint8Array(),
    hydrate: async () => undefined,
    signedUrl: async (uri: string) => `https://signed.example/${encodeURIComponent(uri)}`,
  } as unknown as ArtifactStore;
  return {
    ...actual,
    factory: (_opts: unknown, body: (input: unknown) => Promise<unknown>) => (input: unknown) => body(input),
    sandbox: () => fakeBox("build"),
    phase: () => undefined,
    log: () => undefined,
    now: () => Date.parse("2026-11-04T00:00:00Z"),
    step: async (_name: string, fn: () => Promise<unknown>) => fn(),
    parallel: async (thunks: Record<string, () => Promise<unknown>>) =>
      Object.fromEntries(await Promise.all(Object.entries(thunks).map(async ([k, t]) => [k, await t()]))),
    pipeline: async (_opts: unknown, items: unknown[], stage: (item: unknown) => Promise<unknown>) =>
      Promise.all(items.map((i) => stage(i))),
    notify: async (text: string) => {
      core.posts.push(text);
      return { delivered: true, note: "Posted to the run thread." };
    },
    runArtifacts: () => ({ runId: "ns_unit", artifacts: store }),
    redactForRun: (s: string) => s,
  };
});

const { createVerifyFlows } = await import("./verify-flows.js");

function fakeBox(id: string): SandboxHandle {
  let forks = 0;
  const box = {
    id,
    callPath: "root",
    async exec(cmd: string): Promise<ExecResult> {
      core.execs.push({ box: id, cmd });
      if (cmd.includes("find . -type f")) {
        return { exitCode: 0, stdoutTail: "@@ the-flow\n./evidence.md\n", stderrTail: "", truncated: false };
      }
      if (cmd.includes("wc -c")) return { exitCode: 0, stdoutTail: "5\n", stderrTail: "", truncated: false };
      if (cmd.includes("base64")) {
        return { exitCode: 0, stdoutTail: Buffer.from("notes").toString("base64"), stderrTail: "", truncated: false };
      }
      return { exitCode: 0, stdoutTail: "", stderrTail: "", truncated: false };
    },
    async push() {
      return { name: "sb/the-change", sha: "abc" };
    },
    async fork(n: number) {
      return Array.from({ length: n }, () => fakeBox(`${id}/fork[${forks++}]`));
    },
    async dispose() {},
  };
  return box as unknown as SandboxHandle;
}

const result = <T>(value: T, files: { path: string; uri: string }[] = []) => ({
  result: value,
  runId: "ns_unit",
  callPath: "verify",
  artifacts: {
    files: files.map((f) => ({
      path: f.path,
      ref: { uri: f.uri, sha256: "0", bytes: 5, contentType: "text/markdown" },
    })),
  },
});

const EVIDENCE = "/selfbuilding/out/files/verify/the-flow/evidence.md";

const agents = {
  ImplementSpec: async () =>
    result({ status: "done", summary: "Did it.", prTitle: "Add the flow", prBody: "Body.", changes: [] }),
  CodeReview: {
    settled: async () => ({
      ok: true,
      value: result({ verdict: "approve", tier: "small", summary: "Fine.", findings: [] }),
    }),
  },
  FindFlows: { settled: async () => ({ ok: true, value: result({ flows: [] }) }) },
  Verify: {
    settled: async () =>
      core.verifyFails
        ? { ok: false, code: "harness_failed", error: new Error("the harness exited") }
        : {
            ok: true,
            value: result(
              {
                summary: "Checked.",
                flows: [{ name: "the flow", outcome: "verified", detail: "It works.", evidence: EVIDENCE }],
              },
              // The runtime names collected files relative to its attempt directory.
              [{ path: "artifacts/files/verify/the-flow/evidence.md", uri: "mem://runs/ns_unit/attempt/evidence.md" }],
            ),
          },
  },
};

const input = { repo: "acme/app", spec: "Add the flow.", flows: [{ name: "the flow", endState: "it works" }] };

async function runFlows() {
  // biome-ignore lint/suspicious/noExplicitAny: the agents are shape-only fakes; the engine is mocked.
  const f = createVerifyFlows({ agents: agents as any }) as unknown as (i: unknown) => Promise<any>;
  return f(input);
}

beforeEach(() => {
  core.posts.length = 0;
  core.execs.length = 0;
  core.verifyFails = false;
  core.stored.clear();
});

describe("verifyFlows: the Slack summary", () => {
  it("is posted as mrkdwn: bold, <url|text> links, no # headings or [text](url)", async () => {
    await runFlows();
    expect(core.posts).toHaveLength(1);
    const text = core.posts[0] ?? "";
    expect(text).toContain("*Verification: Add the flow*");
    expect(text).toContain("✅ *the flow*: verified");
    expect(text).toMatch(/<https:\/\/signed\.example\/[^|>]+\|evidence>/);
    expect(text).toMatch(/<https:\/\/signed\.example\/[^|>]+summary\.html\|Summary page>$/);
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toMatch(/\]\(/);
    expect(text).not.toContain("| --- |");
  });
});

describe("verifyFlows: evidence off the fork", () => {
  it("is not read again when the Verify call settled: the runtime already collected it", async () => {
    const out = await runFlows();
    expect(core.execs.filter((e) => e.box.includes("fork") && /find \.|base64|wc -c/.test(e.cmd))).toEqual([]);
    expect(out.flows[0].evidence).toMatchObject([{ path: EVIDENCE, uri: "mem://runs/ns_unit/attempt/evidence.md" }]);
  });

  it("is read for a failed Verify call, whose attempt collected nothing", async () => {
    core.verifyFails = true;
    const out = await runFlows();
    expect(core.execs.some((e) => e.box.includes("fork") && e.cmd.includes("find . -type f"))).toBe(true);
    expect(out.flows[0]).toMatchObject({ outcome: "unverifiable" });
    expect(out.flows[0].evidence.map((e: { path: string }) => e.path)).toEqual([EVIDENCE]);
    expect(new TextDecoder().decode(core.stored.get(out.flows[0].evidence[0].uri))).toBe("notes");
  });
});
