#!/usr/bin/env node
// @ts-check
// The scripted harness player. It runs inside the sandbox in place of a coding-agent CLI: it replays one scripted
// turn, runs shell steps for real, sends tool calls through the selfbuilding MCP server (or the tool socket), and
// prints a real harness's native stream format so the bundled parsers are exercised.
// Dependency-free on purpose: it is written into the sandbox as a single file.
//
// argv: <call key> <fresh|resume> [sessionId]
// The player lives at <root><home>/.scripted/player.mjs; each agent call's script sits beside it in <call key>/.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , callKey, mode = "fresh", sessionArg] = process.argv;
if (!callKey) {
  process.stderr.write("scripted-player: missing call key argument\n");
  process.exit(2);
}

const self = fileURLToPath(import.meta.url);
const stateDir = path.join(path.dirname(self), callKey);
/** @type {{ format: "claude-code" | "codex"; home: string; turns: any[][]; mcpServers: any[]; toolTransport: "mcp" | "socket"; toolSocket: string; model: string; costUsdPerTurn: number }} */
const config = JSON.parse(fs.readFileSync(path.join(stateDir, "script.json"), "utf8"));

// The sandbox root: "" in a real box, the box directory under a test provider.
const suffix = `${config.home}/.scripted/player.mjs`;
const root = self.endsWith(suffix) ? self.slice(0, -suffix.length) : "";

/** Maps canonical sandbox paths in a string onto this root. */
function mapPath(value) {
  if (!root || typeof value !== "string") return value;
  return value.replace(
    /(^|[\s'"=:;&|(<>`])(\/run\/selfbuilding|\/selfbuilding|\/tmp)(?=$|[/\s'";&|)<>`])/g,
    (match, lead, prefix, offset) => (value.startsWith(root, offset + lead.length) ? match : `${lead}${root}${prefix}`),
  );
}

const sessionId = mode === "resume" && sessionArg ? sessionArg : sessionArg || randomUUID();

// Turns count per session: a resume can arrive as a new launch attempt (a cold ask's answer, done-check feedback),
// whose script sits in a new call-key directory but continues the same session.
const readCount = (file) => Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "0") || 0;
const turnFile = path.join(stateDir, "turn");
const sessionDir = path.join(path.dirname(self), "sessions");
const sessionFile = path.join(sessionDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.turn`);
const turnIndex = mode === "resume" && fs.existsSync(sessionFile) ? readCount(sessionFile) : readCount(turnFile);
fs.writeFileSync(turnFile, String(turnIndex + 1));
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(sessionFile, String(turnIndex + 1));
const steps = config.turns[turnIndex] ?? [{ say: "(scripted harness: no script left for this turn)" }];
let seq = 0;
let accepted = 0;
let usage = { input: 0, output: 0 };

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// ---- native stream emitters -------------------------------------------------------------------------------------

const emit = config.format === "codex" ? codexEmitter() : claudeEmitter();

function claudeEmitter() {
  const toolName = (server, tool) => `mcp__${server}__${tool}`;
  return {
    init() {
      out({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: process.cwd(),
        model: config.model,
        tools: ["Bash", "Read", "Edit", "Write", ...config.mcpServers.map((s) => toolName(s.name, "submit_result"))],
        mcp_servers: config.mcpServers.map((s) => ({ name: s.name, status: "connected" })),
        permissionMode: "bypassPermissions",
        apiKeySource: "none",
      });
    },
    text(text) {
      out({
        type: "assistant",
        message: {
          id: `msg_${++seq}`,
          type: "message",
          role: "assistant",
          model: config.model,
          content: [{ type: "text", text }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
    },
    toolStart(id, kind, name, input) {
      const full = kind === "mcp" ? toolName("selfbuilding", name) : name;
      out({
        type: "assistant",
        message: {
          id: `msg_${++seq}`,
          type: "message",
          role: "assistant",
          model: config.model,
          content: [{ type: "tool_use", id, name: full, input }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
    },
    toolEnd(id, _kind, _name, output, isError) {
      out({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
    },
    raw(obj) {
      out(obj);
    },
    end(ok, text) {
      out({
        type: "result",
        subtype: ok ? "success" : "error_during_execution",
        is_error: !ok,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: seq,
        result: text,
        session_id: sessionId,
        total_cost_usd: config.costUsdPerTurn,
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
    },
    failure(_code, message) {
      this.end(false, message);
    },
  };
}

function codexEmitter() {
  return {
    init() {
      out({ type: "thread.started", thread_id: sessionId });
      out({ type: "turn.started" });
    },
    text(text) {
      out({ type: "item.completed", item: { id: `item_${seq++}`, type: "agent_message", text } });
    },
    toolStart(id, kind, name, input) {
      if (kind === "mcp") {
        out({
          type: "item.started",
          item: {
            id,
            type: "mcp_tool_call",
            server: "selfbuilding",
            tool: name,
            arguments: input,
            result: null,
            error: null,
            status: "in_progress",
          },
        });
      } else {
        out({
          type: "item.started",
          item: {
            id,
            type: "command_execution",
            command: input.command,
            aggregated_output: "",
            exit_code: null,
            status: "in_progress",
          },
        });
      }
    },
    toolEnd(id, kind, name, output, isError, extra) {
      if (kind === "mcp") {
        out({
          type: "item.completed",
          item: isError
            ? {
                id,
                type: "mcp_tool_call",
                server: "selfbuilding",
                tool: name,
                arguments: extra.input,
                result: null,
                error: { message: output },
                status: "failed",
              }
            : {
                id,
                type: "mcp_tool_call",
                server: "selfbuilding",
                tool: name,
                arguments: extra.input,
                result: { content: [{ type: "text", text: output }], structured_content: null },
                error: null,
                status: "completed",
              },
        });
      } else {
        out({
          type: "item.completed",
          item: {
            id,
            type: "command_execution",
            command: extra.input.command,
            aggregated_output: output,
            exit_code: extra.exitCode,
            status: isError ? "failed" : "completed",
          },
        });
      }
    },
    raw(obj) {
      out(obj);
    },
    end(ok, text) {
      if (ok)
        out({
          type: "turn.completed",
          usage: { input_tokens: usage.input, cached_input_tokens: 0, output_tokens: usage.output },
        });
      else out({ type: "turn.failed", error: { message: text } });
    },
    failure(_code, message) {
      out({ type: "error", message });
      this.end(false, message);
    },
  };
}

// ---- tool transport ----------------------------------------------------------------------------------------------

/** @returns {Promise<{ call(tool: string, input: unknown): Promise<{ text: string; isError: boolean; suspended: boolean }>; close(): void }>} */
async function connectTools() {
  if (config.toolTransport === "socket") return socketTransport();
  const server = config.mcpServers.find((s) => s.name === "selfbuilding") ?? config.mcpServers[0];
  if (server?.type !== "stdio") return socketTransport();
  return mcpTransport(server);
}

function mcpTransport(server) {
  const child = spawn(mapPath(server.command), (server.args ?? []).map(mapPath), {
    env: { ...process.env, ...Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, mapPath(v)])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  let nextId = 1;
  /** @type {Map<number, (msg: any) => void>} */
  const waiting = new Map();
  /** @type {Error | undefined} */
  let failed;
  child.on("error", (error) => {
    failed = error;
    for (const resolve of waiting.values()) resolve({ error: { message: String(error) } });
    waiting.clear();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = waiting.get(msg.id);
      if (resolve) {
        waiting.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      if (failed) return resolve({ error: { message: String(failed) } });
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "selfbuilding-scripted-harness", version: "1.0.0" },
  }).then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`));
  return {
    async call(tool, input) {
      await ready;
      const msg = await request("tools/call", { name: tool, arguments: input });
      if (msg.error) return { text: msg.error.message ?? "MCP error", isError: true, suspended: false };
      const result = msg.result ?? {};
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      const suspended = Boolean(result._meta?.suspended ?? result.structuredContent?.suspended);
      return { text, isError: Boolean(result.isError), suspended };
    },
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

function socketTransport() {
  const file = root + config.toolSocket;
  let nextId = 1;
  return {
    call(tool, input) {
      return new Promise((resolve) => {
        const id = nextId++;
        const socket = net.createConnection(file);
        let buffer = "";
        socket.on("error", (error) =>
          resolve({ text: `tool socket unavailable: ${error.message}`, isError: true, suspended: false }),
        );
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const msg = JSON.parse(buffer.slice(0, newline));
          socket.end();
          resolve({ text: msg.content ?? "", isError: Boolean(msg.isError), suspended: Boolean(msg.suspended) });
        });
        socket.on("connect", () => {
          socket.write(`${JSON.stringify({ id: 0, kind: "hello", pid: process.pid })}\n`);
          socket.write(`${JSON.stringify({ id, kind: "tool", tool, input })}\n`);
        });
      });
    },
    close() {},
  };
}

// ---- the turn ----------------------------------------------------------------------------------------------------

let stopping = false;
/** @type {"exit" | "ignore"} */
let onInterrupt = "exit";
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (onInterrupt === "ignore") return;
    stopping = true;
    // Like a real CLI interrupted mid-turn: no result line, exit 130.
    process.exit(130);
  });
}

function fail(message) {
  process.stderr.write(`scripted-player: ${message}\n`);
  process.exit(3);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  emit.init();
  /** @type {ReturnType<typeof connectTools> | undefined} */
  let toolsPromise;
  const toolsReady = () => (toolsPromise ??= connectTools());
  const closeTools = async () => (await toolsPromise)?.close();
  let lastText = "";
  let n = 0;
  for (const step of steps) {
    if (stopping) break;
    const id = config.format === "codex" ? `item_${seq++}` : `toolu_${String(++n).padStart(4, "0")}`;
    usage = { input: usage.input + 100, output: usage.output + 20 };
    if ("say" in step) {
      lastText = step.say;
      emit.text(step.say);
    } else if ("sh" in step) {
      const input = { command: step.sh, description: "scripted shell step" };
      emit.toolStart(id, "builtin", "Bash", input);
      const run = spawnSync("/bin/sh", ["-c", mapPath(step.sh)], {
        cwd: step.cwd ? mapPath(step.cwd) : process.cwd(),
        env: process.env,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const exitCode = run.status ?? 1;
      emit.toolEnd(id, "builtin", "Bash", output, exitCode !== 0, { input, exitCode });
      if (step.expectExit !== undefined && exitCode !== step.expectExit)
        fail(`shell step exited ${exitCode}, expected ${step.expectExit}: ${step.sh}`);
    } else if ("submit" in step || "tool" in step) {
      const tool = "submit" in step ? "submit_result" : step.tool;
      const input = "submit" in step ? step.submit : step.input;
      emit.toolStart(id, "mcp", tool, input);
      const client = await toolsReady();
      const reply = await client.call(tool, input);
      emit.toolEnd(id, "mcp", tool, reply.text, reply.isError, { input });
      if (tool === "submit_result" && !reply.isError) accepted++;
      const expected = step.expect;
      if (expected === "accepted" && reply.isError) fail(`expected ${tool} to be accepted, got: ${reply.text}`);
      if (expected === "rejected" && !reply.isError) fail(`expected ${tool} to be rejected, got: ${reply.text}`);
      if (expected === "suspended" && !reply.suspended)
        fail(`expected ${tool} to suspend the turn, got: ${reply.text}`);
      if (reply.suspended) {
        // A cold wait: the harness must end its turn now; the answer arrives as the next (resumed) turn.
        emit.text("Waiting for a human answer.");
        emit.end(true, "Waiting for a human answer.");
        await closeTools();
        return 0;
      }
    } else if ("crash" in step) {
      if (step.when === "after-submit" && accepted === 0) continue;
      if (step.when === "before-submit" && accepted > 0) continue;
      // Mid-turn: a tool call is in flight when the process dies.
      emit.toolStart(id, "builtin", "Bash", { command: "sleep 1" });
      if (step.crash === "exit") process.exit(step.code ?? 1);
      process.kill(process.pid, step.crash);
      await sleep(60_000);
    } else if ("hang" in step) {
      onInterrupt = step.hang === "ignore-sigint" ? "ignore" : "exit";
      emit.text("Working...");
      await new Promise(() => setInterval(() => undefined, 60_000));
    } else if ("sleep" in step) {
      await sleep(step.sleep);
    } else if ("event" in step) {
      emit.raw(step.event);
    } else if ("error" in step) {
      emit.failure(step.error.code, step.error.message);
      await closeTools();
      return 1;
    } else if ("usage" in step) {
      usage = { input: step.usage.inputTokens, output: step.usage.outputTokens };
    }
  }
  emit.end(true, lastText || (accepted > 0 ? "Result submitted." : "Done."));
  await closeTools();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`scripted-player: ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
