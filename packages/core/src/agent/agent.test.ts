import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createLocalRemote,
  makeSkill,
  memoryJournal,
  scriptedHarness,
  type TmpdirProvider,
  tempDir,
  testContext,
  tmpdirProvider,
  useFakeRuntime,
} from "../../test/agent-kit/kit.js";
import type { AgentRunContext } from "./context.js";
import { setAgentContextResolver } from "./context.js";

const loadSkill = vi.hoisted(() => vi.fn());
vi.mock("@selfbuilding/skills", () => ({ loadSkill }));

const { Agent, agent, defineContract } = await import("./index.js");
const { AGENT_TUNABLES } = await import("./lifecycle.js");

let provider: TmpdirProvider;
let remote: { bareDir: string };
let workDir: string;

beforeAll(async () => {
  AGENT_TUNABLES.waitSliceMs = 2_000;
  workDir = await tempDir();
  provider = tmpdirProvider({});
  remote = await createLocalRemote(workDir, {
    files: { "README.md": "# playground\n", "src/a.ts": "export const a = 1;\n" },
  });
});

afterAll(async () => {
  await provider.close();
  await fs.rm(workDir, { recursive: true, force: true });
});

let ctx: AgentRunContext;
let events: { type: string; callPath: string; data?: Record<string, unknown> }[];

async function useContext(opts: { journal?: ReturnType<typeof memoryJournal>; runId?: string } = {}) {
  const made = await testContext(
    { sandbox: provider, harness: scriptedHarness([]), deployment: "test" },
    { ...(opts.journal ? { journal: opts.journal } : {}), ...(opts.runId ? { runId: opts.runId } : {}) },
  );
  ctx = made.ctx;
  events = made.events;
  setAgentContextResolver(() => ctx);
}

beforeEach(async () => {
  await useContext();
});

afterEach(() => {
  setAgentContextResolver(undefined);
});

function git(dir: string, args: string) {
  return import("node:child_process").then(({ execSync }) =>
    execSync(`git ${args}`, { cwd: dir, encoding: "utf8" }).trim(),
  );
}

async function liveBoxes(): Promise<number> {
  let n = 0;
  for await (const ref of provider.list({ deployment: "test", runId: ctx.runId })) if (ref.state !== "stopped") n++;
  return n;
}

const Review = z.object({ verdict: z.enum(["approve", "request_changes"]), summary: z.string() });

describe("Agent.fromSkill", () => {
  it("compiles a skill into a typed callable with JSON schemas", async () => {
    loadSkill.mockResolvedValueOnce(await makeSkill("code-review"));
    const CodeReview = await Agent.fromSkill("/skills/code-review", {
      output: Review,
      workspace: { repo: "optional" },
    });
    expect(CodeReview.name).toBe("CodeReview");
    expect(CodeReview.outputJsonSchema.type).toBe("object");
    expect(CodeReview.inputJsonSchema.properties).toHaveProperty("task");
    expect(typeof CodeReview.settled).toBe("function");
  });

  it("rejects relative paths with ConfigError and wraps loader failures as SkillLoadError", async () => {
    await expect(Agent.fromSkill("skills/x")).rejects.toMatchObject({ code: "config" });
    loadSkill.mockRejectedValueOnce(Object.assign(new Error("SKILL.md missing"), { code: "skill_invalid" }));
    await expect(Agent.fromSkill("/nope")).rejects.toMatchObject({ code: "skill_load", name: "SkillLoadError" });
  });

  it("refuses reserved input keys", () => {
    expect(() => defineContract({ input: z.object({ repo: z.string() }) })).toThrow(/reserved/);
  });
});

describe("agent calls on a fresh sandbox", () => {
  it("runs launch → wait → collect → accept and kills the box", async () => {
    useFakeRuntime({ "Review#0": [{ result: { verdict: "approve", summary: "looks fine" } }] });
    const res = await agent({
      name: "Review",
      prompt: "Review the change.",
      input: { focus: "auth" },
      output: Review,
    });
    expect(res.result).toEqual({ verdict: "approve", summary: "looks fine" });
    expect(res.callPath).toBe("Review#0");
    expect(res.replayed).toBe(false);
    expect(res.stepKey).toHaveLength(26);
    expect(res.integrity).toBe("same-user");
    expect(res.harness.id).toBe("scripted");
    expect(res.usage.usd).toBeCloseTo(0.01);
    expect(await res.artifacts.transcript.text()).toContain('"agent.outcome"');
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["agent.started", "agent.launched", "agent.finished"]),
    );
    expect(await liveBoxes()).toBe(0);
  });
});

describe("usage errors", () => {
  it("rejects invalid input with AgentInputError before any sandbox exists", async () => {
    loadSkill.mockResolvedValueOnce(await makeSkill("triage"));
    const Triage = await Agent.fromSkill("/skills/triage", {
      input: z.object({ issue: z.number() }),
      workspace: { repo: "optional" },
    });
    const bad = { issue: "x" } as unknown as { issue: number };
    await expect(Triage(bad)).rejects.toMatchObject({ code: "input_invalid" });
    await expect(Triage.settled(bad)).rejects.toMatchObject({ code: "input_invalid" });
    expect(await liveBoxes()).toBe(0);
  });

  it("needs a harness and a sandbox from some source", async () => {
    setAgentContextResolver(undefined);
    await expect(agent({ name: "x", prompt: "p", output: Review })).rejects.toThrow(/no harness and no sandbox/);
  });
});

describe("failures and the value form", () => {
  it("throws the runtime's reason as a registered error, and settled() returns it", async () => {
    useFakeRuntime({ "*": [{ status: "failed", reason: "no_result", message: "never submitted" }] });
    const err = await agent({ name: "Quiet", prompt: "p", output: Review }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "no_result", message: "never submitted" });
    const settled = await agent.settled({ name: "Quiet", prompt: "p", output: Review });
    expect(settled).toMatchObject({ ok: false });
    expect(await liveBoxes()).toBe(0);
  });

  it("resumes with the host's issues when the authoritative parse fails", async () => {
    const Strict = z.object({ n: z.number().min(10, "n must be at least 10") });
    useFakeRuntime({ "Count#0": [{ result: { n: 1 } }, { result: { n: 11 } }] });
    const res = await agent({ name: "Count", prompt: "count", output: Strict });
    expect(res.result).toEqual({ n: 11 });
    expect(res.attempts.resumes).toBe(1);
  });

  it("wraps non-object outputs as { value } on the wire and unwraps them", async () => {
    useFakeRuntime({ "List#0": [{ result: { value: ["a", "b"] } }] });
    const res = await agent({ name: "List", prompt: "list", output: z.array(z.string()) });
    expect(res.result).toEqual(["a", "b"]);
  });

  it("uploads files the outcome names", async () => {
    useFakeRuntime({
      "Files#0": [{ result: { verdict: "approve", summary: "s" }, files: { "out/report.txt": "hello" } }],
    });
    const res = await agent({ name: "Files", prompt: "p", output: Review });
    expect(res.artifacts.files?.map((f) => f.path)).toEqual(["out/report.txt"]);
  });

  it("uploads a binary file byte for byte", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
    useFakeRuntime({
      "Shot#0": [
        { result: { verdict: "approve", summary: "s" }, binaryFiles: { "out/flow.png": png.toString("base64") } },
      ],
    });
    const res = await agent({ name: "Shot", prompt: "p", output: Review });
    const ref = res.artifacts.files?.find((f) => f.path === "out/flow.png")?.ref;
    expect(ref).toBeDefined();
    expect(Buffer.from(await ctx.artifacts.read(ref?.uri as string))).toEqual(png);
  });

  it("retries an artifact upload the store refuses for a moment instead of failing the call", async () => {
    const saved = AGENT_TUNABLES.uploadRetryMs;
    AGENT_TUNABLES.uploadRetryMs = [1, 1, 1];
    const real = ctx.artifacts;
    let refusals = 2;
    ctx = {
      ...ctx,
      artifacts: {
        ...real,
        put: async (key, body, opts) => {
          if (refusals-- > 0) throw new Error("503 Service Unavailable");
          return real.put(key, body, opts);
        },
      },
    };
    try {
      useFakeRuntime({
        "Flaky#0": [{ result: { verdict: "approve", summary: "s" }, files: { "out/report.txt": "hello" } }],
      });
      const res = await agent({ name: "Flaky", prompt: "p", output: Review });
      expect(res.artifacts.files?.map((f) => f.path)).toEqual(["out/report.txt"]);
    } finally {
      AGENT_TUNABLES.uploadRetryMs = saved;
    }
  });

  it("rejects artifact paths that escape the attempt dir", async () => {
    useFakeRuntime({ "Bad#0": [{ result: { verdict: "approve", summary: "s" }, files: { "../evil.txt": "x" } }] });
    await expect(agent({ name: "Bad", prompt: "p", output: Review })).rejects.toMatchObject({
      code: "artifact_failed",
    });
  });
});

describe("done checks", () => {
  const Out = z.object({ status: z.enum(["done", "blocked"]), summary: z.string(), count: z.number() });
  type O = z.infer<typeof Out>;

  async function counter(assert: (r: O) => true | string) {
    loadSkill.mockResolvedValueOnce(await makeSkill("counter"));
    return Agent.fromSkill("/skills/counter", {
      output: Out,
      workspace: { repo: "optional" },
      done: [{ id: "positive", assert }],
    });
  }

  it("feeds a failed assert back as a new turn and passes on the retry", async () => {
    const Counter = await counter((r) => r.count > 0 || "count must be positive");
    useFakeRuntime({
      "Counter#0": [
        { result: { status: "done", summary: "s", count: 0 } },
        { result: { status: "done", summary: "s", count: 2 } },
      ],
    });
    const res = await Counter({ task: "count" });
    expect(res.attempts.doneRetries).toBe(1);
    expect(res.checks).toContainEqual({ id: "positive", ok: true, verified: true });
  });

  it("throws DoneCheckFailedError when retries run out", async () => {
    const Counter = await counter((r) => r.count > 0 || "count must be positive");
    useFakeRuntime({ "Counter#0": [{ result: { status: "done", summary: "s", count: 0 } }] });
    await expect(Counter({ task: "count" }, { maxDoneRetries: 0 })).rejects.toMatchObject({
      code: "done_check_failed",
    });
  });

  it("returns doneFailed with onDoneFailure: 'return'", async () => {
    const Counter = await counter((r) => r.count > 0 || "nope");
    useFakeRuntime({ "Counter#0": [{ result: { status: "done", summary: "s", count: 0 } }] });
    const res = await Counter({ task: "count" }, { maxDoneRetries: 0, onDoneFailure: "return" });
    expect(res.doneFailed).toEqual({ id: "positive", output: "nope" });
  });

  it("skips checks when the agent honestly reports blocked", async () => {
    const assert = vi.fn((_r: O): true | string => "never");
    const Counter = await counter(assert);
    useFakeRuntime({ "Counter#0": [{ result: { status: "blocked", summary: "no access", count: 0 } }] });
    const res = await Counter({ task: "count" });
    expect(res.result.status).toBe("blocked");
    expect(assert).not.toHaveBeenCalled();
  });
});

describe("git work", () => {
  it("pushes the agent's commit from the host to the call's branch", async () => {
    useFakeRuntime({
      "Impl#0": [{ result: { status: "done", summary: "s" }, commit: { file: "b.txt", content: "b\n" } }],
    });
    const res = await agent({
      name: "Impl",
      prompt: "change things",
      output: z.object({ status: z.string(), summary: z.string() }),
      repo: remote.bareDir,
    });
    const branch = res.artifacts.branch;
    expect(branch?.pushed).toBe(true);
    expect(await git(remote.bareDir, `rev-parse ${branch?.name}`)).toBe(branch?.headSha);
  });
});

describe("shared sandboxes, forks and cross-provider review", () => {
  it("runs exec on a lazy shared handle and refuses use after dispose", async () => {
    useFakeRuntime({});
    const { sandbox } = await import("../sandbox/index.js");
    const box = sandbox({ label: "work" });
    const r = await box.exec("echo hi > note.txt && cat note.txt");
    expect(r.stdoutTail.trim()).toBe("hi");
    await box.dispose();
    expect(await liveBoxes()).toBe(0);
  });

  it("forks a shared box into independent children", async () => {
    useFakeRuntime({});
    const { sandbox } = await import("../sandbox/index.js");
    await using box = sandbox({ label: "parent" });
    await box.exec("echo base > f.txt");
    const kids = await box.fork(2);
    expect(kids).toHaveLength(2);
    const [a, b] = kids;
    await a?.exec("echo a > f.txt");
    expect((await b?.exec("cat f.txt"))?.stdoutTail.trim()).toBe("base");
    expect((await a?.exec("cat f.txt"))?.stdoutTail.trim()).toBe("a");
    for (const k of kids) await k?.dispose();
  });

  it("reviews on a different provider than the one that built", async () => {
    const other = tmpdirProvider({ id: "tmpdir-review" });
    try {
      useFakeRuntime({
        "Build#0": [{ result: { verdict: "approve", summary: "built" } }],
        "Check#0": [{ result: { verdict: "request_changes", summary: "fix it" } }],
      });
      const built = await agent({ name: "Build", prompt: "build", output: Review });
      const reviewed = await agent({ name: "Check", prompt: "review", output: Review, sandbox: other });
      expect(built.result.summary).toBe("built");
      expect(reviewed.result.verdict).toBe("request_changes");
    } finally {
      await other.close();
    }
  });
});

describe("journal replay", () => {
  it("replays a finished call on a rerun of the same run without a sandbox, and reruns an edited prompt", async () => {
    const journal = memoryJournal();
    await useContext({ journal, runId: "ns_replay" });
    useFakeRuntime({ "*": [{ result: { verdict: "approve", summary: "first" } }] });
    const first = await agent({ name: "Review", prompt: "Review it.", output: Review });
    expect(first.replayed).toBe(false);

    await useContext({ journal, runId: "ns_replay" });
    useFakeRuntime({ "*": [{ result: { verdict: "request_changes", summary: "second" } }] });
    const again = await agent({ name: "Review", prompt: "Review it.", output: Review });
    expect(again.replayed).toBe(true);
    expect(again.result.summary).toBe("first");
    expect(events.some((e) => e.type === "agent.launched")).toBe(false);

    await useContext({ journal, runId: "ns_replay" });
    const edited = await agent({ name: "Review", prompt: "Review it carefully.", output: Review });
    expect(edited.replayed).toBe(false);
    expect(edited.result.summary).toBe("second");
  });
});
