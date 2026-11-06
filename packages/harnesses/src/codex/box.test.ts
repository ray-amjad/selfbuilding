import { readFileSync } from "node:fs";
import {
  type HarnessCredential,
  type Invocation,
  type McpServerSpec,
  type ProviderSandbox,
  SANDBOX_PATHS,
} from "@selfbuilding/core";
import {
  canonicalPaths,
  openTestBox,
  runHarnessTurn,
  scripted,
  scriptedHarness,
  tmpdirProvider,
  toGoldenJsonl,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codex } from "./index.js";
import { createCodexParser } from "./parser.js";

// The adapter's plans executed for real in tmpdir boxes, with a stand-in `codex` binary that records how it was
// called and replays a recorded stream. No model, no network, no credentials.

const BIN = `${SANDBOX_PATHS.bin}/codex`;
const OUT = `${SANDBOX_PATHS.out}/fake-codex`;

const FAKE_CODEX = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; exit 0; fi
root="\${SELFBUILDING_FS_ROOT:-}"
out="$root${OUT}"
mkdir -p "$out"
: > "$out/argv.txt"
for a in "$@"; do printf '%s\\n' "$a" >> "$out/argv.txt"; done
cat > "$out/stdin.txt"
if [ ! -d "$root$CODEX_HOME" ]; then
  echo "Error finding codex home: CODEX_HOME points to \\"$CODEX_HOME\\", but that path does not exist" >&2
  exit 1
fi
if [ -f "$root$CODEX_HOME/auth.json" ]; then stat -c %a "$root$CODEX_HOME/auth.json" > "$out/auth-mode.txt"; fi
cat "$out/stream.jsonl"
exit "$(cat "$out/exit-code" 2>/dev/null || echo 0)"
`;

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), "utf8");

const provider = tmpdirProvider();
afterAll(() => provider.close());

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const commandOf = (inv: Invocation) =>
  `${inv.argv.map(quote).join(" ")}${inv.stdinFile ? ` < ${inv.stdinFile}` : " < /dev/null"}`;

async function fakeBox(stream: string, exitCode = 0): Promise<ProviderSandbox> {
  const box = await openTestBox(provider, `codex-${Math.random().toString(36).slice(2, 8)}`);
  await box.writeFiles([
    { path: BIN, data: FAKE_CODEX, mode: 0o755 },
    { path: `${OUT}/stream.jsonl`, data: stream },
    { path: `${OUT}/exit-code`, data: String(exitCode) },
  ]);
  return box;
}

const recordedArgv = async (box: ProviderSandbox) => {
  const root = provider.boxRoot(box.ref);
  return decode(await box.readFile(`${OUT}/argv.txt`))
    .trimEnd()
    .split("\n")
    .map((arg) => arg.split(root).join(""));
};

const harness = codex({ binary: BIN, model: "gpt-fake" });

describe("codex in a box: fresh and resumed turns", () => {
  it("runs a fresh turn: CODEX_HOME exists, prompt on stdin, the stream parses to the golden events", async () => {
    const box = await fakeBox(fixture("success"));
    const turn = await runHarnessTurn(box, harness, { prompt: "Review the diff." });
    expect(turn.exitCode, turn.stderr).toBe(0);
    expect(turn.sessionId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    expect(decode(await box.readFile(`${OUT}/stdin.txt`))).toBe("Review the diff.");
    const argv = await recordedArgv(box);
    expect(argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(argv.at(-1)).toBe("-");
    await expect(toGoldenJsonl(turn.events)).toMatchFileSnapshot("__golden__/success.events.jsonl");
  });

  it("without prepare(), Codex refuses to start: CODEX_HOME must exist", async () => {
    const box = await fakeBox(fixture("success"));
    const paths = canonicalPaths();
    const inv = harness.invoke({ runId: "r", callPath: "root/1/x", attempt: 1, paths, promptFile: "/dev/null" });
    const result = await box.exec(commandOf(inv), { cwd: inv.cwd, env: inv.env });
    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).toContain("Error finding codex home");
  });

  it("resumes by thread id with `exec resume <id>` and reads the follow-up message from stdin", async () => {
    const box = await fakeBox(fixture("resume"));
    const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    const turn = await runHarnessTurn(box, harness, { prompt: "Continue.", resumeSessionId: id });
    expect(turn.exitCode, turn.stderr).toBe(0);
    expect(turn.sessionId).toBe(id);
    expect((await recordedArgv(box)).slice(0, 3)).toEqual(["exec", "resume", id]);
    expect(decode(await box.readFile(`${OUT}/stdin.txt`))).toBe("Continue.");
  });

  it("delivers a leased auth.json as a 0600 file the CLI can read", async () => {
    const box = await fakeBox(fixture("success"));
    const cred: HarnessCredential = { kind: "auth-file", value: "unused", leased: true };
    const login = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt-fake", account_id: "a" } });
    const auth = harness.auth(cred, { paths: canonicalPaths(), values: { AUTH_FILE: login } });
    await box.writeFiles(auth.files.map((f) => ({ path: f.path, data: f.content, mode: f.mode })));
    const turn = await runHarnessTurn(box, harness);
    expect(turn.exitCode, turn.stderr).toBe(0);
    expect(decode(await box.readFile(`${OUT}/auth-mode.txt`)).trim()).toBe("600");
    // The copy-back reads the same path after the call.
    expect(decode(await box.readFile(auth.leasedFile?.path ?? ""))).toBe(login);
  });

  it("reports a failed turn and the exit code it ended with", async () => {
    const box = await fakeBox(fixture("failure-usage-limit"), 1);
    const turn = await runHarnessTurn(box, harness);
    expect(turn.exitCode).toBe(1);
    expect(turn.events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "error" });
  });
});

describe("codex in a box: the system prompt is prepended on stdin", () => {
  let box: ProviderSandbox;
  const paths = canonicalPaths();
  const ctx = { runId: "r", callPath: "root/1/review", attempt: 1, paths, promptFile: `${paths.in}/prompt.md` };

  beforeAll(async () => {
    box = await fakeBox(fixture("success"));
    const plan = harness.prepare({ ...ctx, skills: [], mcpServers: [], hotWaitMs: 0 });
    await box.writeFiles([
      ...plan.files.map((f) => ({ path: f.path, data: f.content, mode: f.mode })),
      { path: `${paths.in}/system.md`, data: "SYSTEM: call submit_result." },
      { path: `${paths.in}/prompt.md`, data: "# Skill: review\nDo it." },
    ]);
  });

  it("feeds system text, a blank line, then the prompt; the codex exit code passes through", async () => {
    const inv = harness.invoke({ ...ctx, systemFile: `${paths.in}/system.md` });
    const result = await box.exec(commandOf(inv), { cwd: inv.cwd, env: inv.env });
    expect(result.exitCode, result.stderrTail).toBe(0);
    expect(decode(await box.readFile(`${OUT}/stdin.txt`))).toBe(
      "SYSTEM: call submit_result.\n\n# Skill: review\nDo it.",
    );
    expect((await recordedArgv(box))[0]).toBe("exec");
  });

  it("refuses to run without the system file instead of dropping it silently", async () => {
    const inv = harness.invoke({ ...ctx, systemFile: `${paths.in}/missing.md` });
    const result = await box.exec(commandOf(inv), { cwd: inv.cwd, env: inv.env });
    expect(result.exitCode).toBe(66);
    expect(result.stderrTail).toContain("system prompt file");
  });
});

describe("codex in a box: MCP env files and session transfer", () => {
  it("a stdio server's env reaches the server through the 0600 env file, not argv", async () => {
    const box = await fakeBox("");
    const paths = canonicalPaths();
    const server: McpServerSpec = {
      name: "db",
      type: "stdio",
      command: "/bin/sh",
      args: ["-c", 'printf "%s" "$DB_TOKEN"'],
      env: { DB_TOKEN: "fake 'tok' $HOME" },
    };
    const plan = harness.prepare({
      runId: "r",
      callPath: "c",
      attempt: 1,
      paths,
      skills: [],
      mcpServers: [server],
      hotWaitMs: 0,
    });
    await box.writeFiles(plan.files.map((f) => ({ path: f.path, data: f.content, mode: f.mode })));
    const argv = harness.invoke({
      runId: "r",
      callPath: "c",
      attempt: 1,
      paths,
      promptFile: "/dev/null",
      mcpServers: [server],
    }).argv;
    const command = JSON.parse((argv.find((a) => a.startsWith("mcp_servers.db.command=")) ?? "").split("=")[1] ?? "");
    const args = JSON.parse((argv.find((a) => a.startsWith("mcp_servers.db.args=")) ?? "").replace(/^[^=]*=/, ""));
    const result = await box.exec([command, ...args].map(quote).join(" "));
    expect(result.exitCode, result.stderrTail).toBe(0);
    expect(result.stdoutTail).toBe("fake 'tok' $HOME");
  });

  it("captures a session in one box and restores it into another, at the same path", async () => {
    const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    const paths = canonicalPaths();
    const rel = `.codex/sessions/2026/11/01/rollout-2026-11-01T10-00-00-${id}.jsonl`;
    const source = await fakeBox("");
    await source.writeFiles([
      { path: `${paths.home}/${rel}`, data: '{"type":"session_meta"}\n' },
      { path: `${paths.home}/.codex/sessions/2026/11/01/rollout-2026-11-01T09-00-00-other.jsonl`, data: "{}\n" },
    ]);
    const transfer = harness.sessionArtifacts?.(id, paths);
    if (!transfer) throw new Error("codex must support session transfer");
    for (const cmd of transfer.capture) {
      const result = await source.exec(cmd.argv.map(quote).join(" "));
      expect(result.exitCode, result.stderrTail).toBe(0);
    }
    const captured = `${paths.state}/sessions/codex/${id}/${rel}`;
    const data = await source.readFile(captured);

    const target = await fakeBox("");
    await target.writeFiles([{ path: captured, data }]);
    for (const cmd of transfer.restore) {
      const result = await target.exec(cmd.argv.map(quote).join(" "));
      expect(result.exitCode, result.stderrTail).toBe(0);
    }
    expect(decode(await target.readFile(`${paths.home}/${rel}`))).toBe('{"type":"session_meta"}\n');
    await expect(
      target.readFile(`${paths.home}/.codex/sessions/2026/11/01/rollout-2026-11-01T09-00-00-other.jsonl`),
    ).rejects.toThrow();
  });

  it("capture fails loudly when the session file is not there", async () => {
    const box = await fakeBox("");
    const transfer = harness.sessionArtifacts?.("0199a000-0000-7000-8000-000000000000", canonicalPaths());
    const result = await box.exec((transfer?.capture[0]?.argv ?? []).map(quote).join(" "));
    expect(result.exitCode).toBe(66);
  });
});

describe("codex parser against the scripted harness's Codex stream", () => {
  // A minimal stdio MCP server standing in for selfbuilding-mcp: accepts submit_result when status is "done".
  const FAKE_MCP = `
let buf = "";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    if (msg.method === "tools/call") {
      const ok = msg.params.arguments && msg.params.arguments.status === "done";
      send({ id: msg.id, result: ok ? { content: [{ type: "text", text: "Accepted. Stop now." }] } : { isError: true, content: [{ type: "text", text: "status: must be \\"done\\"" }] } });
    }
  }
});
`;

  it("reads the kit's Codex review stream exactly as the kit's golden describes it", async () => {
    const box = await openTestBox(provider, "codex-scripted");
    await box.writeFiles([{ path: `${SANDBOX_PATHS.bin}/fake-mcp.mjs`, data: FAKE_MCP }]);
    await box.exec(`git init -q ${SANDBOX_PATHS.workdir}`);
    const scriptedCodex = scriptedHarness(
      [scripted.say("Reviewing."), scripted.sh("git status --short"), scripted.submit({ status: "done" })],
      { format: "codex", parser: createCodexParser },
    );
    const turn = await runHarnessTurn(box, scriptedCodex, {
      mcpServers: [
        { name: "selfbuilding", type: "stdio", command: "node", args: [`${SANDBOX_PATHS.bin}/fake-mcp.mjs`] },
      ],
      callPath: "root/3/review",
    });
    expect(turn.exitCode, turn.stderr).toBe(0);
    const kitGolden = readFileSync(
      new URL("../../../testing/src/scripted/__golden__/codex-review.events.jsonl", import.meta.url),
      "utf8",
    );
    expect(toGoldenJsonl(turn.events).trim()).toBe(kitGolden.trim());
  });

  it("a failed scripted turn: one error, classified by this adapter", async () => {
    const box = await openTestBox(provider, "codex-scripted-error");
    const scriptedCodex = scriptedHarness(
      [scripted.error("quota", "You've hit your usage limit. Try again in 5 minutes.")],
      {
        format: "codex",
        parser: createCodexParser,
      },
    );
    const turn = await runHarnessTurn(box, scriptedCodex, { callPath: "root/4/quota" });
    expect(turn.exitCode).toBe(1);
    expect(turn.events.filter((e) => e.type === "error")).toEqual([
      {
        type: "error",
        failure: {
          code: "quota",
          retryable: false,
          retryAfterMs: 300_000,
          message: "You've hit your usage limit. Try again in 5 minutes.",
        },
      },
    ]);
  });
});
