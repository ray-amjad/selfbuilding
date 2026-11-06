// Acceptance 10 (demo-path §6): a cold wait survives a host restart. The host process is SIGKILLed while an
// agent's ask is cold (box parked, session kept), the answer is written to the ask store while nothing runs, and a
// fresh process resuming the same run id resumes the parked session with that answer. The ask store is the only
// truth: nothing about the answer lives in the dead process.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AskRecord,
  type AskStore,
  agent,
  answerAsk,
  ask,
  factory,
  fileArtifacts,
  fileAskStore,
  fileJournal,
  memoryChannel,
  run,
} from "@selfbuilding/core";
import { scripted, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type HostProcess, kill, LEASE_EXPIRY_MS, launched, readEvents, sleep } from "./support/crash.js";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

const dirs: string[] = [];
const hosts: HostProcess[] = [];
afterAll(async () => {
  // A host still running after a failed case would hold its boxes open.
  for (const h of hosts) if (h.child.exitCode === null) h.child.kill("SIGKILL");
  await Promise.all(dirs.map((d) => tmpdirProvider({ root: path.join(d, "boxes") }).close()));
});

const url = (spec: string) => import.meta.resolve(spec);

/**
 * A host process for this file. It runs one asking agent on the plain Node host with a file journal, tmpdir boxes
 * and an in-memory channel, and prints `RESULT {status, output, posts}`. Written next to the run's files with
 * absolute imports, so it resolves the workspace packages from anywhere.
 */
function hostScript(): string {
  return `
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agent, factory, fileArtifacts, fileJournal, memoryChannel, run, setRuntimeBundles } from ${JSON.stringify(url("@selfbuilding/core"))};
import { scripted, scriptedHarness, tmpdirProvider } from ${JSON.stringify(url("@selfbuilding/testing"))};
import { claudeCode } from ${JSON.stringify(url("@selfbuilding/harnesses/claude-code"))};
import { z } from ${JSON.stringify(url("zod"))};

const cfg = JSON.parse(process.env.SBA_CRASH ?? "{}");
const dist = path.join(path.dirname(fileURLToPath(${JSON.stringify(url("@selfbuilding/runtime/package.json"))})), "dist");
setRuntimeBundles({
  runtime: readFileSync(path.join(dist, "selfbuilding-runtime.mjs")),
  mcp: readFileSync(path.join(dist, "selfbuilding-mcp.mjs")),
  nsReap: readFileSync(path.join(dist, "ns-reap.mjs")),
});
const sink = (e) => appendFileSync(path.join(cfg.dir, "events-" + cfg.tag + ".jsonl"), JSON.stringify(e) + "\\n");
const real = claudeCode();
const harness = {
  ...scriptedHarness(
    [scripted.askHuman({ question: "Ship the migration tonight?", choices: ["ship", "hold"], default: "hold" }, "suspended")],
    {
      format: "claude-code",
      parser: (ctx) => real.createParser(ctx),
      turns: [[
        scripted.sh("grep -rqi 'answer to your question #1.*ship' /selfbuilding/in", { expectExit: 0 }),
        scripted.submit({ decision: "resumed after the restart" }),
      ]],
    },
  ),
  id: "scripted-claude-code",
};
const AskingAgent = factory({ name: "asking-agent", input: z.object({}) }, async () => {
  const r = await agent({ name: "asker", prompt: "Ask whether to ship, then submit.", output: z.object({ decision: z.string() }), label: "asker" });
  return r.result;
});
const channel = memoryChannel();
const out = await run(AskingAgent, {}, {
  runId: cfg.runId,
  config: {
    deployment: "acceptance",
    sandbox: tmpdirProvider({ root: path.join(cfg.dir, "boxes") }),
    harness,
    artifacts: fileArtifacts(path.join(cfg.dir, "artifacts")),
    events: [sink],
    hitl: { channels: [channel], approvers: [{ slack: channel.user.userId }], hotWait: "1s", timeout: "1h", onTimeout: "fail" },
  },
  journal: fileJournal(path.join(cfg.dir, "journal")),
});
process.stdout.write("RESULT " + JSON.stringify({ status: out.status, output: out.output ?? null, posts: channel.posts.length }) + "\\n");
process.exit(0);
`;
}

interface Result {
  status: string;
  output: unknown;
  posts: number;
}

/** Starts the host script; `done` resolves with its RESULT line, or null when it was killed. */
function startHost(
  script: string,
  cfg: { dir: string; runId: string; tag: string },
): HostProcess & {
  result: Promise<Result | null>;
} {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, SBA_CRASH: JSON.stringify(cfg) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const result = new Promise<Result | null>((resolve) => {
    child.on("exit", () => {
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      resolve(line ? (JSON.parse(line.slice("RESULT ".length)) as Result) : null);
    });
  });
  const host = { child, done: result as never, result, stderr: () => stderr };
  hosts.push(host);
  return host;
}

async function setup(prefix: string) {
  const dir = await tempDir(prefix);
  dirs.push(dir);
  const script = path.join(dir, "host.mjs");
  await writeFile(script, hostScript());
  return { dir, script, asks: fileAskStore(path.join(dir, "journal", "asks")) };
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function onlyAsk(asks: ReturnType<typeof fileAskStore>, runId: string): Promise<AskRecord[]> {
  const out: AskRecord[] = [];
  for await (const r of asks.list?.({ runId }) ?? []) out.push(r);
  return out;
}

const answer = (asks: AskStore, askId: string, choiceId = "ship") =>
  answerAsk({
    store: asks,
    askId,
    answer: { kind: "choice", choiceId },
    answeredBy: { kind: "human", channel: "cli", userId: "ray", displayName: "Ray" },
  });

describe("acceptance 10: a cold wait survives a host restart (plain Node)", () => {
  it.concurrent("the answer arrives while the host is down; the restarted run resumes the parked session with it", async () => {
    const runId = "ns_accept_cold_restart_down";
    const { dir, script, asks } = await setup("sba-cold-down-");
    const host = (tag: string) => startHost(script, { dir, runId, tag });

    const first = host("r1");
    const cold = await waitFor("the ask to go cold", async () => {
      const [r] = await onlyAsk(asks, runId);
      return r?.cold ? r : null;
    });
    await kill(first);
    expect(cold.status).toBe("open");
    expect(cold.cold?.sessionId).toBeTruthy();

    // Nothing is running: the answer goes to the store alone.
    expect((await answer(asks, cold.askId)).status).toBe("answered");
    await sleep(LEASE_EXPIRY_MS);

    const second = host("r2");
    const result = await second.result;
    const r2 = readEvents(dir, "r2");
    expect(result?.status, `${JSON.stringify(result)}\n${second.stderr().slice(-3000)}`).toBe("ok");
    expect(result?.output).toEqual({ decision: "resumed after the restart" });
    // Nothing re-posted; one resumed launch of the same session.
    expect(result?.posts).toBe(0);
    expect(launched(r2)).toEqual(["asker"]);
    const sessions = [...readEvents(dir, "r1"), ...r2]
      .filter((e) => e.type === "harness.session.started")
      .map((e) => (e.data as { sessionId?: string }).sessionId);
    expect(new Set(sessions).size).toBe(1);
    expect(await onlyAsk(asks, runId)).toHaveLength(1);
  });

  it.concurrent("the ask is still open at restart: the wait resumes without a re-post and the next answer resumes the session", async () => {
    const runId = "ns_accept_cold_restart_open";
    const { dir, script, asks } = await setup("sba-cold-open-");
    const host = (tag: string) => startHost(script, { dir, runId, tag });

    const first = host("r1");
    const cold = await waitFor("the ask to go cold", async () => {
      const [r] = await onlyAsk(asks, runId);
      return r?.cold ? r : null;
    });
    await kill(first);
    await sleep(LEASE_EXPIRY_MS);

    const second = host("r2");
    // The restarted run finds the open ask and waits on it again; its box is parked once more.
    await waitFor("the restarted run to wait on the ask", async () =>
      readEvents(dir, "r2").some((e) => e.type === "sandbox.parked"),
    );
    expect((await answer(asks, cold.askId)).status).toBe("answered");
    const result = await second.result;
    expect(result?.status, `${JSON.stringify(result)}\n${second.stderr().slice(-3000)}`).toBe("ok");
    expect(result?.output).toEqual({ decision: "resumed after the restart" });
    expect(result?.posts).toBe(0);
    expect(await onlyAsk(asks, runId)).toHaveLength(1);
  });
});

describe("acceptance 10: waiting for a human is not active time", () => {
  it("a long ask wait does not count against the run's wall-clock budget", async () => {
    useBuiltRuntime();
    const dir = await tempDir("sba-cold-clock-");
    dirs.push(dir);
    const journal = fileJournal(path.join(dir, "journal"));
    const asks = journal.asks;
    if (!asks) throw new Error("fileJournal must provide an ask store");
    const channel = memoryChannel();
    const events = recorder();
    const Gate = factory({ name: "gate-then-build", input: z.object({}) }, async () => {
      const go = await ask({ question: "Build it?", choices: ["yes", "no"] });
      const r = await agent({ name: "builder", prompt: "Build.", output: z.object({ built: z.boolean() }) });
      return { go: go.choiceId, built: r.result.built };
    });
    const running = run(
      Gate,
      {},
      {
        runId: "ns_accept_clock",
        config: {
          deployment: "acceptance",
          sandbox: tmpdirProvider({ root: path.join(dir, "boxes") }),
          harness: scriptedClaude([scripted.submit({ built: true })]),
          artifacts: fileArtifacts(path.join(dir, "artifacts")),
          hitl: { channels: [channel], approvers: [{ slack: channel.user.userId }] },
          // Shorter than the time the human takes: only the wait keeps the next call inside the budget.
          budget: { wallClock: "3s" },
        },
        journal,
        events: [events.sink],
      },
    );
    running.catch(() => {});
    await channel.waitForPosts(1);
    const askId = channel.posts[0]?.record.askId as string;
    await sleep(4_000);
    expect((await answer(asks, askId, "yes")).status).toBe("answered");
    const out = await running;
    expect(out.status, JSON.stringify(events.of("budget.exceeded").map((e) => e.data))).toBe("ok");
    expect(out.output).toEqual({ go: "yes", built: true });
  });
});
