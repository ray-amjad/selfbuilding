import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A localhost stand-in for the Messages API, so the real Claude Code CLI can be driven end to end with no model and
// no network. Only requests from the main conversation (those offering the submit tool) consume the script; any
// side request the CLI makes (titles, summaries) gets a short text answer.

export type FakeTurn =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown; text?: string }
  | {
      kind: "error";
      status: number;
      type: string;
      message: string;
      retryAfterS?: number;
      headers?: Record<string, string>;
    };

export interface FakeRequest {
  path: string;
  main: boolean;
  body: Record<string, unknown>;
}

export interface FakeAnthropic {
  url: string;
  requests: FakeRequest[];
  /** Main-conversation requests answered so far. */
  mainCalls(): number;
  close(): Promise<void>;
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

let counter = 0;

function streamTurn(res: ServerResponse, model: string, turn: Exclude<FakeTurn, { kind: "error" }>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_fake" });
  counter += 1;
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_fake_${counter}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 20 },
    },
  });
  let index = 0;
  const text = turn.kind === "text" ? turn.text : turn.text;
  if (text) {
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  if (turn.kind === "tool") {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_fake_${counter}`, name: turn.name, input: {} },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: turn.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 25 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startFakeAnthropic(script: FakeTurn[], mainTool: string): Promise<FakeAnthropic> {
  const queue = [...script];
  const requests: FakeRequest[] = [];
  let main = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const tools = Array.isArray(body.tools) ? (body.tools as { name?: string }[]) : [];
      const isMain = path === "/v1/messages" && tools.some((t) => t.name === mainTool);
      requests.push({ path, main: isMain, body });
      if (path === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (path !== "/v1/messages") {
        res
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no route ${path}` } }));
        return;
      }
      const model = typeof body.model === "string" ? body.model : "claude-fake";
      if (!isMain) {
        streamTurn(res, model, { kind: "text", text: "ok" });
        return;
      }
      main += 1;
      const turn = queue.shift() ?? { kind: "text", text: "Nothing left to do." };
      if (turn.kind === "error") {
        res
          .writeHead(turn.status, {
            "content-type": "application/json",
            ...(turn.retryAfterS === undefined ? {} : { "retry-after": String(turn.retryAfterS) }),
            ...turn.headers,
          })
          .end(JSON.stringify({ type: "error", error: { type: turn.type, message: turn.message } }));
        return;
      }
      streamTurn(res, model, turn);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    mainCalls: () => main,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
