import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpServer } from "./mcp-server.js";
import { type ToolName, ToolSocketServer } from "./tool-socket.js";

const dirs: string[] = [];
const servers: ToolSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbrt-mcp-"));
  dirs.push(dir);
  return dir;
}

/** A JSON-RPC client over in-memory streams. */
function client(socketPath: string, schemaPath: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const { done } = startMcpServer({ socketPath, resultSchemaPath: schemaPath, input, output, connectRetries: 1 });
  let buffer = "";
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let i = buffer.indexOf("\n");
    while (i >= 0) {
      const msg = JSON.parse(buffer.slice(0, i)) as { id: number };
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
      i = buffer.indexOf("\n");
    }
  });
  let id = 0;
  const request = (method: string, params?: unknown) =>
    // biome-ignore lint/suspicious/noExplicitAny: replies are JSON inspected ad hoc by the assertions.
    new Promise<Record<string, any>>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  return { request, close: () => input.end(), done };
}

describe("selfbuilding-mcp", () => {
  it("initialises, lists the three tools with the result schema, and forwards calls to the tool socket", async () => {
    const dir = tmp();
    const socketPath = path.join(dir, "tools.sock");
    const schemaPath = path.join(dir, "result.schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["verdict"] }));
    const calls: { tool: ToolName; input: unknown }[] = [];
    const hellos: number[] = [];
    const server = new ToolSocketServer(socketPath, {
      hello: (pid) => hellos.push(pid),
      tool: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === "ask_human") return { content: "Your question #1 is waiting.", isError: false, suspended: true };
        return { content: "Accepted. Stop now; do not make further changes.", isError: false };
      },
    });
    servers.push(server);
    await server.listen();

    const c = client(socketPath, schemaPath);
    const init = await c.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "selfbuilding" },
      capabilities: { tools: {} },
    });
    const list = await c.request("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "submit_result",
      "ask_human",
      "notify_human",
    ]);
    expect(list.result.tools[0].inputSchema).toEqual({ type: "object", required: ["verdict"] });

    const submit = await c.request("tools/call", { name: "submit_result", arguments: { verdict: "approve" } });
    expect(submit.result).toEqual({
      content: [{ type: "text", text: "Accepted. Stop now; do not make further changes." }],
      isError: false,
    });
    const ask = await c.request("tools/call", { name: "ask_human", arguments: { question: "?" } });
    expect(ask.result._meta).toEqual({ suspended: true });
    expect(ask.result.structuredContent).toEqual({ suspended: true });
    expect(calls).toEqual([
      { tool: "submit_result", input: { verdict: "approve" } },
      { tool: "ask_human", input: { question: "?" } },
    ]);
    expect(hellos).toEqual([process.pid]);

    const unknown = await c.request("tools/call", { name: "rm_rf", arguments: {} });
    expect(unknown.error.code).toBe(-32602);
    const missing = await c.request("resources/list");
    expect(missing.error.code).toBe(-32601);
    expect((await c.request("ping")).result).toEqual({});
    c.close();
    await c.done;
  });

  it("reports an unreachable runtime as a tool error instead of failing the protocol", async () => {
    const dir = tmp();
    const c = client(path.join(dir, "absent.sock"), path.join(dir, "absent.json"));
    const list = await c.request("tools/list");
    expect(list.result.tools[0].inputSchema).toEqual({ type: "object" });
    const call = await c.request("tools/call", { name: "submit_result", arguments: {} });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("not reachable");
    c.close();
    await c.done;
  });
});

describe("tool socket", () => {
  it("answers hello with nothing, then answers tool requests by id, and rejects unknown kinds", async () => {
    const dir = tmp();
    const file = path.join(dir, "tools.sock");
    const server = new ToolSocketServer(file, {
      hello: () => undefined,
      tool: async (tool) => ({ content: `ok ${tool}`, isError: false }),
    });
    servers.push(server);
    await server.listen();
    const replies = await new Promise<string[]>((resolve) => {
      const socket = net.createConnection(file);
      const lines: string[] = [];
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let i = buffer.indexOf("\n");
        while (i >= 0) {
          lines.push(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          i = buffer.indexOf("\n");
        }
        if (lines.length === 2) {
          socket.end();
          resolve(lines);
        }
      });
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: 0, kind: "hello", pid: 1 })}\n`);
        socket.write(`${JSON.stringify({ id: 7, kind: "tool", tool: "notify_human", input: {} })}\n`);
        socket.write(`${JSON.stringify({ id: 8, kind: "tool", tool: "shell", input: {} })}\n`);
      });
    });
    const parsed = replies.map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
    expect(parsed[0]).toEqual({ id: 7, content: "ok notify_human", isError: false });
    expect(parsed[1]).toMatchObject({ id: 8, isError: true });
  });

  it("refuses a socket path longer than the sun_path limit", async () => {
    const server = new ToolSocketServer(`/tmp/${"x".repeat(120)}/tools.sock`, {
      hello: () => undefined,
      tool: async () => ({ content: "", isError: false }),
    });
    await expect(server.listen()).rejects.toThrow(/longer than/);
  });
});
