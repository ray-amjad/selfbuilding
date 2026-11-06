// Agent calls, shared handles, forks and asks inside run(): the engine ↔ agent ↔ ask seams, offline, on tmpdir
// boxes and the fake runtime from the agent test kit.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLocalRemote,
  scriptedHarness,
  type TmpdirProvider,
  tempDir,
  tmpdirProvider,
  useFakeRuntime,
} from "../../test/agent-kit/kit.js";
import { AGENT_TUNABLES } from "../agent/lifecycle.js";
import { agent, ask, factory, fileJournal, parallel, run, sandbox } from "../index.js";
import type { SelfbuildingEvent } from "../types/events.js";

const Review = z.object({ verdict: z.enum(["approve", "request_changes"]), summary: z.string() });

let dir: string;
let build: TmpdirProvider;
let review: TmpdirProvider;
let repo: string;

beforeAll(async () => {
  AGENT_TUNABLES.waitSliceMs = 2_000;
  dir = await tempDir("sbc-run-");
  build = tmpdirProvider({ root: path.join(dir, "build") });
  review = tmpdirProvider({ id: "tmpdir-review", root: path.join(dir, "review") });
  // A file URL keeps the remote on the host: the tmpdir provider re-roots bare /tmp paths into the box.
  repo = `file://${(await createLocalRemote(dir, { files: { "README.md": "# playground\n" } })).bareDir}`;
});

afterAll(async () => {
  await build.close();
  await review.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function live(provider: TmpdirProvider, runId: string): Promise<number> {
  let n = 0;
  for await (const ref of provider.list({ deployment: "test", runId })) if (ref.state !== "stopped") n++;
  return n;
}

const config = () => ({ deployment: "test", sandbox: build, harness: scriptedHarness([]) });

const ForkReview = factory({ name: "fork-review", input: z.object({ repo: z.string() }) }, async ({ repo }) => {
  await using box = sandbox({ label: "work", repo });
  await box.exec("echo built > out.txt");
  const forks = await box.fork(2);
  try {
    // Each fork is handed to one parallel() child, which claims it; the third reviewer gets its own provider.
    const verdicts = await parallel({
      claude: () =>
        agent({ name: "Review", prompt: "review a", output: Review, sandbox: forks[0] ?? "fresh", label: "fork-a" }),
      codex: () =>
        agent({
          name: "Review",
          prompt: "review b",
          output: Review,
          sandbox: forks[1] ?? "fresh",
          harness: scriptedHarness([], { format: "codex" }),
          label: "fork-b",
        }),
      other: () => agent({ name: "Review", prompt: "review c", output: Review, sandbox: review, repo, label: "other" }),
    });
    return {
      verdicts: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v?.result.verdict ?? null])),
      replayed: Object.values(verdicts).map((v) => v?.replayed ?? null),
    };
  } finally {
    await Promise.all(forks.map((f) => f?.dispose()));
  }
});

describe("agents inside run()", () => {
  it("reviews on forks and on a second provider in parallel, then replays all of it on resume", async () => {
    useFakeRuntime({ "*": [{ result: { verdict: "approve", summary: "ok" } }] });
    const journal = fileJournal(path.join(dir, "journal"));
    const events: SelfbuildingEvent[] = [];
    const first = await run(
      ForkReview,
      { repo },
      { runId: "ns_forkreview", config: config(), journal, events: [(e) => events.push(e)] },
    );
    expect(first.status).toBe("ok");
    expect((first.output as { verdicts: unknown } | null)?.verdicts).toEqual({
      claude: "approve",
      codex: "approve",
      other: "approve",
    });
    const launched = events.filter((e) => e.type === "agent.launched").map((e) => e.callPath);
    expect(launched.sort()).toEqual([
      "parallel#0/[claude]/fork-a",
      "parallel#0/[codex]/fork-b",
      "parallel#0/[other]/other",
    ]);
    expect(await live(build, "ns_forkreview")).toBe(0);
    expect(await live(review, "ns_forkreview")).toBe(0);
    expect(events.some((e) => e.type === "sandbox.created" && JSON.stringify(e.data).includes("tmpdir-review"))).toBe(
      true,
    );

    const again: SelfbuildingEvent[] = [];
    const second = await run(
      ForkReview,
      { repo },
      { runId: "ns_forkreview", config: config(), journal, events: [(e) => again.push(e)] },
    );
    expect(second.status).toBe("ok");
    expect((second.output as { replayed: unknown } | null)?.replayed).toEqual([true, true, true]);
    expect(again.some((e) => e.type === "agent.launched")).toBe(false);
  });

  it("refuses a shared handle used from a parallel() child that did not create it", async () => {
    useFakeRuntime({});
    const Misuse = factory({ name: "misuse", input: z.object({}) }, async () => {
      await using box = sandbox({ label: "shared" });
      await parallel([() => box.exec("true")]);
      return null;
    });
    await expect(run(Misuse, {}, { config: config(), events: [] })).rejects.toMatchObject({
      name: "SandboxHandleScopeError",
    });
  });

  it("answers a factory ask() with its default when nobody is reachable", async () => {
    const Gate = factory({ name: "gate", input: z.object({}) }, async () => {
      const res = await ask({
        question: "Merge it?",
        choices: ["merge", "hold"],
        default: "hold",
        onTimeout: "default",
      });
      return res.choiceId;
    });
    const out = await run(Gate, {}, { config: config(), events: [] });
    expect(out.status).toBe("ok");
    expect(out.output).toBe("hold");
  });
});
