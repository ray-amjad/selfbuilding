import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BROWSER_LAUNCH_CHECK, BROWSER_MCP_SERVER, codexImage, dockerImageRef, PLAYWRIGHT_MCP_BIN } from "./index.js";

// Runs against a locally built Codex image: SELFBUILDING_E2E_DOCKER=1 and `selfbuilding/codex:<version>` present
// (build it with `selfbuilding images build --provider docker --harness codex`). Skips otherwise.
const ref = process.env.SELFBUILDING_BROWSER_IMAGE ?? dockerImageRef(codexImage);
const present =
  process.env.SELFBUILDING_E2E_DOCKER === "1" &&
  spawnSync("docker", ["image", "inspect", ref], { stdio: "ignore" }).status === 0;

function dockerRun(args: string[], timeout = 120_000): { status: number | null; out: string } {
  const result = spawnSync("docker", ["run", "--rm", "--user", "agent", ...args], { encoding: "utf8", timeout });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Sends JSON-RPC requests one at a time over the server's stdio and resolves each by id. */
function rpc(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  const waiting = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line.startsWith("{")) continue;
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  return {
    request(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

describe.skipIf(!present)(`browser in ${ref}`, () => {
  it("launches headless Chromium as the agent user with a bare env", () => {
    const { status, out } = dockerRun([ref, "sh", "-c", BROWSER_LAUNCH_CHECK]);
    expect(status, out).toBe(0);
  });

  it("the browser MCP server prints its version", () => {
    const { status, out } = dockerRun(["--entrypoint", PLAYWRIGHT_MCP_BIN, ref, "--version"]);
    expect(status, out).toBe(0);
    expect(out.trim()).not.toBe("");
  });

  it("has sqlite3 and the manifest names the browser", () => {
    const { status, out } = dockerRun([
      ref,
      "sh",
      "-c",
      "sqlite3 --version && cat /opt/selfbuilding/image-manifest.json",
    ]);
    expect(status, out).toBe(0);
    expect(out).toContain('"browser":{"engine":"chromium"');
  });

  it("the browser MCP server navigates a page headless", async () => {
    if (BROWSER_MCP_SERVER.type !== "stdio") throw new Error("BROWSER_MCP_SERVER must be stdio");
    const child = spawn("docker", [
      "run",
      "--rm",
      "-i",
      "--user",
      "agent",
      "--entrypoint",
      BROWSER_MCP_SERVER.command,
      ref,
      ...(BROWSER_MCP_SERVER.args ?? []),
    ]);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
    });
    try {
      const client = rpc(child);
      const init = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "selfbuilding-image-test", version: "0" },
      });
      expect(init.error, stderr).toBeUndefined();
      client.notify("notifications/initialized");
      const nav = await client.request("tools/call", {
        name: "browser_navigate",
        arguments: { url: "data:text/html,<title>selfbuilding</title><h1>browser ok</h1>" },
      });
      expect(nav.error, stderr).toBeUndefined();
      expect(JSON.stringify(nav.result), stderr).toContain("browser ok");
    } finally {
      child.stdin.end();
      child.kill();
    }
  }, 180_000);
});
