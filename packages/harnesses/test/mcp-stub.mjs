// A minimal stdio MCP server standing in for selfbuilding-mcp: newline-delimited JSON-RPC with one tool,
// submit_result, which accepts { status: "done" } and rejects anything else, like the supervisor's schema check.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const resultFile = process.env.STUB_RESULT_FILE;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const tool = {
  name: "submit_result",
  description: "Submit the final result of the task.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string" }, summary: { type: "string" } },
    required: ["status"],
  },
};

function call(params) {
  const args = params?.arguments ?? {};
  if (params?.name !== "submit_result") {
    return { content: [{ type: "text", text: `unknown tool ${params?.name}` }], isError: true };
  }
  if (args.status !== "done") {
    return { content: [{ type: "text", text: 'status: must be "done"' }], isError: true };
  }
  if (resultFile) appendFileSync(resultFile, `${JSON.stringify(args)}\n`);
  return { content: [{ type: "text", text: "Accepted. Stop now." }], isError: false };
}

createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "selfbuilding", version: "0.0.0" },
        },
      });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [tool] } });
      break;
    case "tools/call":
      send({ jsonrpc: "2.0", id: message.id, result: call(message.params) });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  }
});
