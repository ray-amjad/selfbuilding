import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ToolSocketRequest, ToolSocketResponse } from "@selfbuilding/core";

export type ToolName = Extract<ToolSocketRequest, { kind: "tool" }>["tool"];
export type ToolReply = Omit<ToolSocketResponse, "id">;

export interface ToolSocketHandlers {
  hello(pid: number): void;
  tool(tool: ToolName, input: unknown): Promise<ToolReply>;
}

const TOOLS = new Set<string>(["submit_result", "ask_human", "notify_human", "start_workflow", "get_workflow_status"]);
/** One request line is at most the result cap (1 MiB) plus JSON framing. */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** sun_path is 108 bytes on Linux, including the terminator. */
export const MAX_SOCKET_PATH = 107;

/**
 * The tool socket (spec §6.3): NDJSON over a Unix socket. `hello` gets no reply, because a client may send it on the
 * same connection right before its first tool call and wait for exactly one line back.
 */
export class ToolSocketServer {
  #server: net.Server | undefined;
  readonly #sockets = new Set<net.Socket>();

  constructor(
    readonly file: string,
    private readonly handlers: ToolSocketHandlers,
  ) {}

  async listen(): Promise<void> {
    if (Buffer.byteLength(this.file) > MAX_SOCKET_PATH) {
      throw new RangeError(`tool socket path is longer than ${MAX_SOCKET_PATH} bytes: ${this.file}`);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.rmSync(this.file, { force: true });
    const server = net.createServer((socket) => this.#connection(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.file, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // The agent user connects; it may not replace the socket because /run/selfbuilding is not writable to it.
    fs.chmodSync(this.file, 0o666);
  }

  #connection(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line) void this.#request(socket, line);
      }
    });
  }

  async #request(socket: net.Socket, line: string): Promise<void> {
    let request: Partial<ToolSocketRequest> & Record<string, unknown>;
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      return;
    }
    const id = typeof request.id === "number" ? request.id : 0;
    if (request.kind === "hello") {
      this.handlers.hello(typeof request.pid === "number" ? request.pid : 0);
      return;
    }
    let reply: ToolReply;
    if (request.kind !== "tool" || typeof request.tool !== "string" || !TOOLS.has(request.tool)) {
      reply = { content: `Unknown request. Tools: ${[...TOOLS].join(", ")}.`, isError: true };
    } else {
      try {
        reply = await this.handlers.tool(request.tool as ToolName, request.input);
      } catch (error) {
        reply = {
          content: `The selfbuilding runtime failed to handle ${request.tool}: ${String(error)}`,
          isError: true,
        };
      }
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...reply } satisfies ToolSocketResponse)}\n`);
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(this.file, { force: true });
  }
}
