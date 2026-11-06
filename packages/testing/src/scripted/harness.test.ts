import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { type McpServerSpec, type ProviderSandbox, SANDBOX_PATHS, type ToolSocketRequest } from "@selfbuilding/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toGoldenJsonl } from "../golden.js";
import { tmpdirProvider } from "../tmpdir/provider.js";
import { canonicalPaths, scriptCallKey, scriptedHarness } from "./harness.js";
import { scripted } from "./steps.js";
import { openTestBox, runHarnessTurn } from "./turn.js";

// A stand-in for selfbuilding-mcp: a stdio MCP server that accepts submit_result only with status "done", logs
// every call, and moves ask_human to a cold wait when asked to.
const FAKE_MCP = `
import fs from "node:fs";
const log = (process.env.SELFBUILDING_FS_ROOT ?? "") + "/selfbuilding/out/tool-calls.jsonl";
let buf = "";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    if (msg.method !== "tools/call") continue;
    const { name, arguments: args } = msg.params;
    fs.appendFileSync(log, JSON.stringify({ name, args }) + "\\n");
    if (name === "submit_result") {
      const ok = args && args.status === "done";
      send({ id: msg.id, result: ok
        ? { content: [{ type: "text", text: "Accepted. Stop now." }] }
        : { isError: true, content: [{ type: "text", text: "status: must be \\"done\\"" }] } });
    } else if (name === "ask_human") {
      send({ id: msg.id, result: args.cold
        ? { content: [{ type: "text", text: "A human will answer later. End your turn." }], _meta: { suspended: true } }
        : { content: [{ type: "text", text: "approve" }] } });
    } else {
      send({ id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    }
  }
});
`;

const MCP: McpServerSpec[] = [
  { name: "selfbuilding", type: "stdio", command: "node", args: [`${SANDBOX_PATHS.bin}/fake-mcp.mjs`] },
];

const provider = tmpdirProvider();
afterAll(() => provider.close());

async function box(): Promise<ProviderSandbox> {
  const handle = await openTestBox(provider);
  await handle.writeFiles([{ path: `${SANDBOX_PATHS.bin}/fake-mcp.mjs`, data: FAKE_MCP }]);
  await handle.exec(`git init -q ${SANDBOX_PATHS.workdir}`);
  return handle;
}

const toolCalls = async (handle: ProviderSandbox) =>
  new TextDecoder()
    .decode(await handle.readFile(`${SANDBOX_PATHS.out}/tool-calls.jsonl`))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { name: string; args: unknown });

describe("scriptedHarness: pure plan", () => {
  it("prepares the player and a per-call script, and invokes through a root-aware launcher", () => {
    const harness = scriptedHarness([scripted.submit({ status: "done" })], { format: "codex" });
    expect(harness.capabilities).toMatchObject({
      streamFormat: "codex",
      stopAfterSubmit: "kill",
      preassignSessionId: false,
    });
    const paths = canonicalPaths();
    const call = { runId: "r", callPath: "root/1/review", attempt: 2 };
    const plan = harness.prepare({ ...call, paths, skills: [], mcpServers: MCP, hotWaitMs: 1000 });
    expect(plan.files.map((f) => f.path)).toEqual([
      `${paths.home}/.scripted/player.mjs`,
      `${paths.home}/.scripted/${scriptCallKey(call)}/script.json`,
    ]);
    expect(plan.mcpToolTimeoutMs).toBe(121_000);
    const script = JSON.parse(plan.files[1]?.content ?? "{}");
    expect(script.turns).toEqual([[{ submit: { status: "done" }, expect: "accepted" }]]);
    const inv = harness.invoke({ ...call, paths, promptFile: `${paths.in}/prompt.md` });
    expect(inv.argv[0]).toBe("/bin/sh");
    expect(inv.argv.slice(3)).toEqual(["scripted-harness", scriptCallKey(call), "fresh", ""]);
    expect(inv.cwd).toBe(paths.workdir);
    expect(inv.stdinFile).toBe(`${paths.in}/prompt.md`);
    expect(harness.resume).toBeTypeOf("function");
    expect(scriptedHarness([], { resumable: false }).resume).toBeUndefined();
  });

  it("chooses a script per call when given a function", () => {
    const harness = scriptedHarness(({ callPath }) =>
      callPath.endsWith("review") ? [scripted.submit({ verdict: "approve" })] : [scripted.say("build")],
    );
    const paths = canonicalPaths();
    const turns = (callPath: string) =>
      JSON.parse(
        harness.prepare({ runId: "r", callPath, attempt: 1, paths, skills: [], mcpServers: [], hotWaitMs: 0 }).files[1]
          ?.content ?? "{}",
      ).turns;
    expect(turns("root/2/review")[0][0]).toMatchObject({ submit: { verdict: "approve" } });
    expect(turns("root/1/build")[0][0]).toEqual({ say: "build" });
  });
});

describe("scriptedHarness: played in a tmpdir box", () => {
  let handle: ProviderSandbox;
  beforeAll(async () => {
    handle = await box();
  });

  it("runs shell steps for real and submits through the MCP server (Claude format)", async () => {
    const harness = scriptedHarness([
      scripted.say("Implementing."),
      scripted.sh("echo 'export const y = 2;' > y.ts && git add y.ts"),
      ...scripted.invalidThenValid({ status: "bogus" }, { status: "done", summary: "ok" }),
    ]);
    const turn = await runHarnessTurn(handle, harness, {
      mcpServers: MCP,
      callPath: "root/1/build",
      sessionId: "11111111-2222-3333-4444-555555555555",
    });
    expect(turn.exitCode, turn.stderr).toBe(0);
    expect(turn.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(await handle.exec(`git -C ${SANDBOX_PATHS.workdir} diff --cached --name-only`)).toMatchObject({
      stdoutTail: "y.ts\n",
    });
    expect((await toolCalls(handle)).map((c) => c.args)).toEqual([
      { status: "bogus" },
      { status: "done", summary: "ok" },
    ]);
    const completed = turn.events.filter((e) => e.type === "tool.completed");
    expect(completed.map((e) => e.type === "tool.completed" && e.ok)).toEqual([true, false, true]);
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "end_turn" });
    const roots = [provider.boxRoot(handle.ref)];
    await expect(toGoldenJsonl(turn.lines.join("\n"), { roots })).toMatchFileSnapshot(
      "__golden__/claude-code-invalid-then-valid.jsonl",
    );
    await expect(toGoldenJsonl(turn.events)).toMatchFileSnapshot(
      "__golden__/claude-code-invalid-then-valid.events.jsonl",
    );
  });

  it("prints the Codex stream when asked, and fails loudly when an expectation is not met", async () => {
    const harness = scriptedHarness([scripted.submit({ status: "bogus" }, "accepted")], { format: "codex" });
    const turn = await runHarnessTurn(handle, harness, { mcpServers: MCP, callPath: "root/2/review" });
    expect(turn.exitCode).toBe(3);
    expect(turn.stderr).toContain("expected submit_result to be accepted");
    expect(JSON.parse(turn.lines[0] ?? "{}").type).toBe("thread.started");
    expect(turn.events.find((e) => e.type === "tool.completed")).toMatchObject({ name: "submit_result", ok: false });
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "error" });
  });

  it("plays the Codex format end to end into a golden stream", async () => {
    const harness = scriptedHarness(
      [scripted.say("Reviewing."), scripted.sh("git status --short"), scripted.submit({ status: "done" })],
      { format: "codex" },
    );
    // A fresh box, so the golden stream does not depend on what earlier cases left in the tree.
    const turn = await runHarnessTurn(await box(), harness, { mcpServers: MCP, callPath: "root/3/review" });
    expect(turn.exitCode, turn.stderr).toBe(0);
    await expect(toGoldenJsonl(turn.events)).toMatchFileSnapshot("__golden__/codex-review.events.jsonl");
  });

  it("ends the turn when ask_human moves to a cold wait, and plays the next turn on resume", async () => {
    const harness = scriptedHarness(
      [scripted.askHuman({ question: "Ship it?", cold: true }, "suspended"), scripted.say("unreachable")],
      {
        turns: [[scripted.say("Answer received."), scripted.submit({ status: "done" })]],
      },
    );
    const first = await runHarnessTurn(handle, harness, { mcpServers: MCP, callPath: "root/4/ask" });
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.events.filter((e) => e.type === "message").map((e) => e.type === "message" && e.text)).toEqual([
      "Waiting for a human answer.",
    ]);
    const second = await runHarnessTurn(handle, harness, {
      mcpServers: MCP,
      callPath: "root/4/ask",
      resumeSessionId: first.sessionId as string,
    });
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.events.find((e) => e.type === "message")).toMatchObject({ text: "Answer received." });
    const third = await runHarnessTurn(handle, harness, {
      mcpServers: MCP,
      callPath: "root/4/ask",
      resumeSessionId: "x",
    });
    expect(third.events.find((e) => e.type === "message")).toMatchObject({
      text: expect.stringContaining("no script left"),
    });
  });

  it("crashes mid-turn with a tool call in flight", async () => {
    const harness = scriptedHarness([scripted.submit({ status: "done" }), scripted.crash("SIGKILL", "after-submit")]);
    const turn = await runHarnessTurn(handle, harness, { mcpServers: MCP, callPath: "root/5/crash" });
    expect(turn.exitCode).toBe(137);
    expect(turn.lines.some((line) => JSON.parse(line).type === "result")).toBe(false);
    expect(turn.events.at(-2)).toMatchObject({ type: "error", failure: { code: "harness_crash" } });
  });

  it("skips a conditional crash whose condition does not hold", async () => {
    const harness = scriptedHarness([scripted.crash("SIGKILL", "after-submit"), scripted.say("survived")]);
    const turn = await runHarnessTurn(handle, harness, { callPath: "root/6/no-crash" });
    expect(turn.exitCode).toBe(0);
  });

  it("emits a native error and exits 1", async () => {
    const harness = scriptedHarness([scripted.error("rate_limit", "API Error: 429 rate_limit_error")]);
    const turn = await runHarnessTurn(handle, harness, { callPath: "root/7/error" });
    expect(turn.exitCode).toBe(1);
    expect(turn.events).toContainEqual({
      type: "error",
      failure: { code: "rate_limit", retryable: true, message: "API Error: 429 rate_limit_error" },
    });
  });

  it("hangs until cancelled, then exits like an interrupted CLI", async () => {
    const harness = scriptedHarness([scripted.hangUntilCancelled()]);
    const paths = canonicalPaths();
    const call = { runId: "r", callPath: "root/8/hang", attempt: 1 };
    const plan = harness.prepare({ ...call, paths, skills: [], mcpServers: [], hotWaitMs: 0 });
    await handle.writeFiles(plan.files.map((f) => ({ path: f.path, data: f.content, mode: f.mode })));
    const inv = harness.invoke({ ...call, paths, promptFile: "/dev/null" });
    const quoted = inv.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const proc = await handle.spawn(quoted);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await handle.exec(`kill -INT -${proc.pgid}`);
    const lines: string[] = [];
    const done = await handle.attach(proc, { fromOffset: 0, onLine: (_s, line) => lines.push(line) });
    expect(done).toMatchObject({ state: "exited", exitCode: 130 });
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["system", "assistant"]);
  });

  it("reaches the supervisor over the tool socket transport", async () => {
    const socketPath = path.join(provider.boxRoot(handle.ref), SANDBOX_PATHS.toolSocket);
    fs.rmSync(socketPath, { force: true });
    const seen: ToolSocketRequest[] = [];
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const req = JSON.parse(buf.slice(0, i)) as ToolSocketRequest;
          buf = buf.slice(i + 1);
          seen.push(req);
          if (req.kind === "tool")
            socket.write(`${JSON.stringify({ id: req.id, content: "Accepted.", isError: false })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const harness = scriptedHarness(
        [scripted.notifyHuman({ text: "started" }), scripted.submit({ status: "done" })],
        {
          toolTransport: "socket",
        },
      );
      const turn = await runHarnessTurn(handle, harness, { callPath: "root/9/socket" });
      expect(turn.exitCode, turn.stderr).toBe(0);
      expect(seen.filter((r) => r.kind === "tool").map((r) => r.kind === "tool" && r.tool)).toEqual([
        "notify_human",
        "submit_result",
      ]);
      expect(seen.some((r) => r.kind === "hello")).toBe(true);
    } finally {
      server.close();
    }
  });
});
