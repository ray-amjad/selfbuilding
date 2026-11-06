import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness, HarnessEvent, Invocation, PathsContext } from "@selfbuilding/core";
import { type FakeAnthropic, type FakeTurn, startFakeAnthropic } from "./fake-anthropic.js";

// Plays the adapter's real plan (prepare, auth, invoke) through the installed Claude Code CLI against the localhost
// fake API, doing by hand what the runtime does in a sandbox: write the files, read the secret file into the child's
// env, redirect stdin from the prompt file and parse stdout.

export const STUB = fileURLToPath(new URL("./mcp-stub.mjs", import.meta.url));
/** Obviously fake credentials in the real shapes; the fake API never checks them. */
export const FAKE_KEY = "sk-ant-api03-offline-fake-key";
export const FAKE_OAUTH_TOKEN = "sk-ant-oat01-offline-fake-token";

export interface RealBox {
  root: string;
  paths: PathsContext;
  resultFile: string;
  close(): void;
}

export function openRealBox(): RealBox {
  const root = mkdtempSync(join(tmpdir(), "sbcc-"));
  const at = (p: string) => join(root, p);
  const paths: PathsContext = {
    workdir: at("/selfbuilding/work"),
    home: at("/selfbuilding/home"),
    in: at("/selfbuilding/in"),
    out: at("/selfbuilding/state/calls/call/1"),
    bin: at("/selfbuilding/bin"),
    skills: at("/selfbuilding/skills"),
    secrets: at("/run/selfbuilding/secrets"),
    state: at("/selfbuilding/state"),
    run: at("/run/selfbuilding"),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return {
    root,
    paths,
    resultFile: join(paths.out, "submissions.jsonl"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RealTurn {
  exitCode: number | null;
  signal: string | null;
  lines: string[];
  stderr: string;
  events: HarnessEvent[];
  invocation: Invocation;
  api: FakeAnthropic;
}

export interface RealTurnOptions {
  script: FakeTurn[];
  prompt?: string;
  resumeSessionId?: string;
  sessionId?: string;
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
  budgetUsd?: number;
  /** Default "api-key". */
  credential?: "api-key" | "oauth-token";
}

const call = { runId: "run-e2e", callPath: "root/1/agent", attempt: 1 };

export async function runRealClaudeTurn(box: RealBox, harness: Harness, opts: RealTurnOptions): Promise<RealTurn> {
  const api = await startFakeAnthropic(opts.script, harness.toolName("selfbuilding", "submit_result"));
  const plan = harness.prepare({
    ...call,
    paths: box.paths,
    skills: [],
    mcpServers: [
      {
        name: "selfbuilding",
        type: "stdio",
        command: process.execPath,
        args: [STUB],
        env: { STUB_RESULT_FILE: box.resultFile },
      },
    ],
    hotWaitMs: 60_000,
  });
  const credential =
    opts.credential === "oauth-token"
      ? ({ kind: "oauth-token", value: FAKE_OAUTH_TOKEN } as const)
      : ({ kind: "api-key", value: FAKE_KEY } as const);
  const auth = harness.auth(credential, { paths: box.paths, values: {} });
  for (const file of [...plan.files, ...auth.files]) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    chmodSync(file.path, file.mode);
  }
  const promptFile = join(box.paths.in, "prompt.md");
  writeFileSync(promptFile, opts.prompt ?? "Submit the result.");
  const ctx = {
    ...call,
    paths: box.paths,
    promptFile,
    ...(plan.mcpToolTimeoutMs === null ? {} : { mcpToolTimeoutMs: plan.mcpToolTimeoutMs }),
    ...(opts.budgetUsd === undefined ? {} : { budgetUsd: opts.budgetUsd }),
  };
  const invocation =
    opts.resumeSessionId === undefined
      ? harness.invoke(opts.sessionId === undefined ? ctx : { ...ctx, sessionId: opts.sessionId })
      : (harness.resume?.({ ...ctx, sessionId: opts.resumeSessionId }) as Invocation);

  const secretEnv: Record<string, string> = {};
  for (const [name, file] of Object.entries(auth.secretEnv ?? {})) secretEnv[name] = readFileSync(file, "utf8");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...invocation.env,
    ...secretEnv,
    ANTHROPIC_BASE_URL: api.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "2",
    TZ: "UTC",
    ...opts.extraEnv,
  };
  for (const name of auth.stripEnv) if (name !== "ANTHROPIC_BASE_URL") delete env[name];

  const [bin, ...args] = invocation.argv as [string, ...string[]];
  const child = spawn(bin, args, { cwd: invocation.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(readFileSync(invocation.stdinFile ?? promptFile));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const timer = setTimeout(() => child.kill("SIGINT"), opts.timeoutMs ?? 90_000);
  const [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve) =>
    child.on("close", (code, sig) => resolve([code, sig])),
  );
  clearTimeout(timer);
  await api.close();

  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const parser = harness.createParser(call);
  const events = lines.flatMap((line) => parser.line(line));
  events.push(...parser.end({ code: exitCode, signal }));
  return { exitCode, signal, lines, stderr, events, invocation, api };
}

/** Turns a recorded stream into a fixture: box paths become canonical and per-machine fields are dropped. */
export function toFixture(lines: string[], root: string): string {
  const drop = new Set(["messaging_socket_path", "memory_paths", "uuid", "timestamp", "request_id"]);
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return value.split(root).join("");
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !drop.has(key))
          .map(([key, v]) => [key, scrub(v)]),
      );
    }
    return value;
  };
  const encodedRoot = root.replace(/[^A-Za-z0-9]/g, "-");
  return `${lines
    .map((line) =>
      JSON.stringify(scrub(JSON.parse(line)))
        .split(encodedRoot)
        .join(""),
    )
    .join("\n")}\n`;
}
