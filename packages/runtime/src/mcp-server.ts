import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { JsonSchema, ToolSocketResponse } from "@selfbuilding/core";
import { RUNTIME_VERSION } from "./version.js";

// selfbuilding-mcp (spec §2.6, §6.3): a stateless stdio MCP server. Newline-delimited JSON-RPC 2.0 on stdin/stdout;
// every tool call is forwarded over the tool socket and the supervisor's answer is returned unchanged.

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const ASK_HUMAN_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    question: { type: "string", description: "The question, at most 2,000 characters." },
    title: { type: "string", description: "A short heading, at most 120 characters." },
    context: { type: "string", description: "Background the human needs, at most 4,000 characters." },
    choices: {
      type: "array",
      maxItems: 5,
      items: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" } },
            required: ["id", "label"],
          },
        ],
      },
    },
    freeText: { type: "boolean" },
    schema: { type: "object", description: "A flat JSON Schema for a form answer." },
    default: { description: "A choice id, or a value valid for `schema`." },
    risk: { type: "string", enum: ["low", "high"] },
  },
  required: ["question"],
};

export const NOTIFY_HUMAN_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    message: { type: "string", description: "The note to post into the run thread." },
    level: { type: "string", enum: ["info", "warning"] },
  },
  required: ["message"],
};

export const START_WORKFLOW_DESCRIPTION =
  "Start a workflow script as a new durable run on the host. Returns at once with the run id; the run is followed in Slack and with `selfbuilding watch <runId>`.";

/** demo-path §9.1, verbatim. */
export const START_WORKFLOW_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["name", "script"],
  additionalProperties: false,
  properties: {
    name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,47}$" },
    script: {
      type: "string",
      minLength: 1,
      maxLength: 262144,
      description: "ES module source; default export async (input, sb) => JSON",
    },
    input: { type: "object" },
    size: { type: "string", description: "Largest size the script will ask for. Default small." },
    maxSandboxes: { type: "integer", minimum: 1 },
    budgetUsd: { type: "number", exclusiveMinimum: 0 },
    afk: { type: "boolean" },
    idempotencyKey: { type: "string", maxLength: 128 },
  },
};

export const GET_WORKFLOW_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["runId"],
  additionalProperties: false,
  properties: { runId: { type: "string", description: "The run id start_workflow returned." } },
};

/** Answers a tool call without the tool socket (the `--standalone` server). */
export type ToolForwarder = (tool: string, input: unknown) => Promise<ToolSocketResponse | Error>;

export interface McpServerOptions {
  socketPath: string;
  /** Read on every tools/list, so a contract written after start-up is still seen. */
  resultSchemaPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Connection attempts before a tool call reports the runtime unreachable. */
  connectRetries?: number;
  /** Offer start_workflow and get_workflow_status (the call was staged with a start grant, demo-path §9.3). */
  startWorkflow?: boolean;
  /**
   * Laptop mode: serve only start_workflow and answer it with `forward` instead of the tool socket (demo-path §9.3).
   * There is no supervisor, so nothing connects to the socket.
   */
  standalone?: ToolForwarder;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function readSchema(file: string): JsonSchema {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonSchema;
  } catch {
    // fall through
  }
  return { type: "object" };
}

/** A connection to the tool socket that reconnects on demand and matches replies to requests by id. */
class SocketClient {
  #socket: net.Socket | undefined;
  #connecting: Promise<net.Socket> | undefined;
  #nextId = 1;
  #buffer = "";
  readonly #waiting = new Map<number, (reply: ToolSocketResponse | Error) => void>();

  constructor(
    private readonly file: string,
    private readonly retries: number,
  ) {}

  connect(): Promise<net.Socket> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #open(): Promise<net.Socket> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(this.file);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        socket.on("error", () => socket.destroy());
        socket.on("close", () => this.#fail(new Error("tool socket closed")));
        socket.on("data", (chunk: Buffer) => this.#data(chunk));
        socket.write(`${JSON.stringify({ id: 0, kind: "hello", pid: process.pid })}\n`);
        this.#socket = socket;
        return socket;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * 2 ** attempt)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  #data(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      try {
        const reply = JSON.parse(line) as ToolSocketResponse;
        const resolve = this.#waiting.get(reply.id);
        if (resolve) {
          this.#waiting.delete(reply.id);
          resolve(reply);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  #fail(error: Error): void {
    this.#socket = undefined;
    this.#buffer = "";
    for (const resolve of this.#waiting.values()) resolve(error);
    this.#waiting.clear();
  }

  async call(tool: string, input: unknown): Promise<ToolSocketResponse | Error> {
    let socket: net.Socket;
    try {
      socket = await this.connect();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      socket.write(`${JSON.stringify({ id, kind: "tool", tool, input })}\n`);
    });
  }

  close(): void {
    this.#socket?.end();
  }
}

export function startMcpServer(opts: McpServerOptions): { done: Promise<void> } {
  const client = new SocketClient(opts.socketPath, opts.connectRetries ?? 5);
  // Connect early, so the supervisor sees `hello` as soon as the harness starts this server.
  if (!opts.standalone) client.connect().catch(() => undefined);
  const forward: ToolForwarder = opts.standalone ?? ((tool, input) => client.call(tool, input));

  const send = (message: Record<string, unknown>) => {
    opts.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const baseTools = () => [
    {
      name: "submit_result",
      description:
        "Submit the final result of your task. The input must match the result schema. If it is rejected, fix the listed issues and call again; do not redo the work. Once accepted, stop.",
      inputSchema: readSchema(opts.resultSchemaPath),
    },
    {
      name: "ask_human",
      description:
        "Ask a human a question whose answer changes what you do next. Blocks until answered, or tells you to end your turn and wait to be resumed with the answer.",
      inputSchema: ASK_HUMAN_INPUT_SCHEMA,
    },
    {
      name: "notify_human",
      description: "Post an FYI note to the humans following this run. Does not wait for a reply.",
      inputSchema: NOTIFY_HUMAN_INPUT_SCHEMA,
    },
  ];

  const workflowTools = [
    { name: "start_workflow", description: START_WORKFLOW_DESCRIPTION, inputSchema: START_WORKFLOW_INPUT_SCHEMA },
    {
      name: "get_workflow_status",
      description:
        "Read what a run you started with start_workflow is doing: its status, phase, agents with their sizes, and cost so far.",
      inputSchema: GET_WORKFLOW_STATUS_INPUT_SCHEMA,
    },
  ];

  const tools = () => {
    if (opts.standalone) return workflowTools.filter((t) => t.name === "start_workflow");
    return [...baseTools(), ...(opts.startWorkflow ? workflowTools : [])];
  };
  const toolNames = () => new Set(tools().map((t) => t.name));
  const handle = async (msg: RpcMessage): Promise<void> => {
    const hasId = msg.id !== undefined && msg.id !== null;
    switch (msg.method) {
      case "initialize": {
        const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : undefined;
        const protocolVersion =
          requested && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        send({
          id: msg.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "selfbuilding", version: RUNTIME_VERSION },
          },
        });
        return;
      }
      case "ping":
        if (hasId) send({ id: msg.id, result: {} });
        return;
      case "tools/list":
        send({ id: msg.id, result: { tools: tools() } });
        return;
      case "tools/call": {
        const name = typeof msg.params?.name === "string" ? msg.params.name : "";
        if (!toolNames().has(name)) {
          send({ id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
          return;
        }
        const reply = await forward(name, msg.params?.arguments ?? {});
        if (reply instanceof Error) {
          send({
            id: msg.id,
            result: {
              content: [
                { type: "text", text: `The selfbuilding runtime is not reachable (${reply.message}). Try again.` },
              ],
              isError: true,
            },
          });
          return;
        }
        send({
          id: msg.id,
          result: {
            content: [{ type: "text", text: reply.content }],
            isError: reply.isError,
            ...(reply.suspended ? { structuredContent: { suspended: true }, _meta: { suspended: true } } : {}),
          },
        });
        return;
      }
      default:
        if (msg.method?.startsWith("notifications/")) return;
        if (hasId) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  };

  const done = new Promise<void>((resolve) => {
    let buffer = "";
    const pending = new Set<Promise<void>>();
    opts.input.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let msg: RpcMessage;
        try {
          msg = JSON.parse(line) as RpcMessage;
        } catch {
          send({ id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }
        const work = handle(msg).catch((error: unknown) => {
          if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: String(error) } });
        });
        pending.add(work);
        void work.finally(() => pending.delete(work));
      }
    });
    opts.input.on("end", () => {
      void Promise.allSettled([...pending]).then(() => {
        client.close();
        resolve();
      });
    });
  });
  return { done };
}

/** The tool result text of a launch (demo-path §9.1). */
export function receiptText(receipt: { runId: string; host: string; watch: string; url?: string }): string {
  return `Started run ${receipt.runId} on ${receipt.host}. Follow it with: ${receipt.watch}${receipt.url ? ` (${receipt.url})` : ""}`;
}

function runCli(cli: string[], args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli[0] as string, [...cli.slice(1), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ code: status ?? 1, stdout, stderr }));
  });
}

/**
 * The `--standalone` forwarder: each start_workflow call runs `selfbuilding start <file> --detach --json` on this
 * machine as a local caller, so every guard but `disabled`, `grant` and `depth` applies (demo-path §9.3, §9.5).
 */
export function standaloneForwarder(opts: { cli?: string[]; cwd?: string } = {}): ToolForwarder {
  const cli = opts.cli ?? ["selfbuilding"];
  return async (tool, input) => {
    if (tool !== "start_workflow") return { id: 0, content: `Unknown tool: ${tool}`, isError: true };
    const req = (input ?? {}) as Record<string, unknown>;
    if (typeof req.script !== "string" || typeof req.name !== "string") {
      return { id: 0, content: "start_workflow needs `name` and `script` strings.", isError: true };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfbuilding-start-"));
    const file = path.join(dir, "script.js");
    fs.writeFileSync(file, req.script);
    const args = ["start", file, "--name", req.name, "--detach", "--json"];
    if (req.input !== undefined) args.push("--input", JSON.stringify(req.input));
    if (typeof req.size === "string") args.push("--size", req.size);
    if (typeof req.maxSandboxes === "number") args.push("--max-sandboxes", String(req.maxSandboxes));
    if (typeof req.budgetUsd === "number") args.push("--budget", String(req.budgetUsd));
    if (typeof req.idempotencyKey === "string") args.push("--idempotency-key", req.idempotencyKey);
    if (req.afk === true) args.push("--afk");
    try {
      const { code, stdout, stderr } = await runCli(cli, args, opts.cwd ?? process.cwd());
      const last = stdout.trim().split("\n").pop() ?? "";
      if (code !== 0) {
        return { id: 0, content: stderr.trim() || last || `selfbuilding start exited ${code}`, isError: true };
      }
      const receipt = JSON.parse(last) as { runId: string; host: string; watch: string; url?: string };
      return { id: 0, content: receiptText(receipt), isError: false };
    } catch (error) {
      return { id: 0, content: `selfbuilding start failed: ${(error as Error).message}`, isError: true };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
