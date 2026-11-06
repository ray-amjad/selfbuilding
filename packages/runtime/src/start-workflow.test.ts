// start_workflow in selfbuilding-mcp (docs/spec/demo-path.md §9.1, §9.3): offered only with --start-workflow,
// forwarded over the tool socket, and the --standalone server that runs `selfbuilding start`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  type McpServerOptions,
  receiptText,
  START_WORKFLOW_INPUT_SCHEMA,
  standaloneForwarder,
  startMcpServer,
} from "./mcp-server.js";
import { validateJsonSchema } from "./schema.js";
import { type ToolName, ToolSocketServer } from "./tool-socket.js";

const dirs: string[] = [];
const servers: ToolSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbrt-wf-"));
  dirs.push(dir);
  return dir;
}

function client(opts: Omit<McpServerOptions, "input" | "output">) {
  const input = new PassThrough();
  const output = new PassThrough();
  startMcpServer({ ...opts, input, output, connectRetries: 1 });
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
  return { request, close: () => input.end() };
}

async function socket(dir: string, calls: { tool: ToolName; input: unknown }[]): Promise<string> {
  const socketPath = path.join(dir, "tools.sock");
  const server = new ToolSocketServer(socketPath, {
    hello: () => undefined,
    tool: async (tool, input) => {
      calls.push({ tool, input });
      return { content: `handled ${tool}`, isError: false };
    },
  });
  servers.push(server);
  await server.listen();
  return socketPath;
}

describe("start_workflow in selfbuilding-mcp", () => {
  it("is not offered, and not callable, without --start-workflow", async () => {
    const dir = tmp();
    const calls: { tool: ToolName; input: unknown }[] = [];
    const c = client({ socketPath: await socket(dir, calls), resultSchemaPath: path.join(dir, "none.json") });
    const list = await c.request("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "submit_result",
      "ask_human",
      "notify_human",
    ]);
    const call = await c.request("tools/call", { name: "start_workflow", arguments: { name: "x", script: "y" } });
    expect(call.error.message).toContain("Unknown tool: start_workflow");
    expect(calls).toEqual([]);
    c.close();
  });

  it("offers start_workflow and get_workflow_status with the spec's schema, and forwards both to the socket", async () => {
    const dir = tmp();
    const calls: { tool: ToolName; input: unknown }[] = [];
    const c = client({
      socketPath: await socket(dir, calls),
      resultSchemaPath: path.join(dir, "none.json"),
      startWorkflow: true,
    });
    const list = await c.request("tools/list");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["submit_result", "ask_human", "notify_human", "start_workflow", "get_workflow_status"]);
    const start = list.result.tools.find((t: { name: string }) => t.name === "start_workflow");
    expect(start.inputSchema).toEqual(START_WORKFLOW_INPUT_SCHEMA);
    expect(start.description).toContain("Returns at once with the run id");

    const args = { name: "triage", script: "export default async () => 1;", size: "small" };
    const reply = await c.request("tools/call", { name: "start_workflow", arguments: args });
    expect(reply.result).toMatchObject({ content: [{ type: "text", text: "handled start_workflow" }], isError: false });
    await c.request("tools/call", { name: "get_workflow_status", arguments: { runId: "ns_wf_x" } });
    expect(calls).toEqual([
      { tool: "start_workflow", input: args },
      { tool: "get_workflow_status", input: { runId: "ns_wf_x" } },
    ]);
    c.close();
  });

  it("the input schema rejects names, sizes of script and extra keys the spec forbids", () => {
    expect(validateJsonSchema(START_WORKFLOW_INPUT_SCHEMA, { name: "ok-name", script: "s" })).toEqual([]);
    expect(validateJsonSchema(START_WORKFLOW_INPUT_SCHEMA, { name: "Bad Name", script: "s" })).not.toEqual([]);
    expect(validateJsonSchema(START_WORKFLOW_INPUT_SCHEMA, { name: "a", script: "" })).not.toEqual([]);
    expect(validateJsonSchema(START_WORKFLOW_INPUT_SCHEMA, { name: "a", script: "s", budgetUsd: 0 })).not.toEqual([]);
    expect(validateJsonSchema(START_WORKFLOW_INPUT_SCHEMA, { name: "a", script: "s", extra: 1 })).not.toEqual([]);
  });

  it("formats the receipt as the spec's tool text", () => {
    expect(receiptText({ runId: "ns_wf_abc", host: "node", watch: "selfbuilding watch ns_wf_abc" })).toBe(
      "Started run ns_wf_abc on node. Follow it with: selfbuilding watch ns_wf_abc",
    );
    expect(
      receiptText({ runId: "r", host: "trigger", watch: "selfbuilding watch r", url: "https://cloud.example/r" }),
    ).toBe("Started run r on trigger. Follow it with: selfbuilding watch r (https://cloud.example/r)");
  });
});

describe("selfbuilding-mcp --standalone", () => {
  /** A stand-in `selfbuilding` that records its argv and the script it was handed, then prints a receipt. */
  function fakeCli(dir: string, exitCode = 0): string[] {
    const file = path.join(dir, "fake-cli.mjs");
    fs.writeFileSync(
      file,
      `import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify({ argv, script: fs.readFileSync(argv[1], "utf8") }));
if (${exitCode} !== 0) { process.stderr.write("start_workflow refused the launch: size allows sizes small"); process.exit(${exitCode}); }
process.stdout.write(JSON.stringify({ runId: "ns_wf_local", status: "started", host: "node", watch: "selfbuilding watch ns_wf_local" }) + "\\n");
`,
    );
    return [process.execPath, file];
  }

  it("serves only start_workflow and runs `selfbuilding start --detach --json` for each call", async () => {
    const dir = tmp();
    const c = client({
      socketPath: path.join(dir, "absent.sock"),
      resultSchemaPath: path.join(dir, "none.json"),
      standalone: standaloneForwarder({ cli: fakeCli(dir), cwd: dir }),
    });
    const list = await c.request("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["start_workflow"]);
    const reply = await c.request("tools/call", {
      name: "start_workflow",
      arguments: {
        name: "nightly",
        script: "export default async () => 2;",
        input: { a: 1 },
        size: "medium",
        afk: true,
      },
    });
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0].text).toBe(
      "Started run ns_wf_local on node. Follow it with: selfbuilding watch ns_wf_local",
    );
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8")) as { argv: string[]; script: string };
    expect(seen.script).toBe("export default async () => 2;");
    expect(seen.argv[0]).toBe("start");
    expect(seen.argv).toEqual(
      expect.arrayContaining([
        "--name",
        "nightly",
        "--detach",
        "--json",
        "--input",
        '{"a":1}',
        "--size",
        "medium",
        "--afk",
      ]),
    );
    c.close();
  });

  it("returns the CLI's refusal as an error result", async () => {
    const dir = tmp();
    const forward = standaloneForwarder({ cli: fakeCli(dir, 2), cwd: dir });
    const reply = await forward("start_workflow", { name: "n", script: "s" });
    expect(reply).toMatchObject({ isError: true });
    expect((reply as { content: string }).content).toContain("start_workflow refused the launch");
  });
});
