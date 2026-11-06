// A live host process for the restart case of live test 4 (demo-path §6): it runs the asking agent on a real
// provider and harness with a file journal, so the test can SIGKILL it while the ask is cold and start another on
// the same run id. The script is written next to the run's files with absolute imports. Credentials reach it only
// through the inherited environment, read when a call needs them; nothing here prints a value.
import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const url = (spec: string) => JSON.stringify(import.meta.resolve(spec));

function script(): string {
  return `
import { appendFileSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slack } from ${url("@selfbuilding/channel-slack")};
import { agent, factory, fileArtifacts, fileJournal, run, setRuntimeBundles } from ${url("@selfbuilding/core")};
import { claudeCode } from ${url("@selfbuilding/harnesses/claude-code")};
import { codex } from ${url("@selfbuilding/harnesses/codex")};
import { e2b } from ${url("@selfbuilding/sandbox-e2b")};
import { impello } from ${url("@selfbuilding/sandbox-impello")};
import { z } from ${url("zod")};

const cfg = JSON.parse(process.env.SBL_COLD ?? "{}");
const env = process.env;
const dist = path.join(path.dirname(fileURLToPath(${url("@selfbuilding/runtime/package.json")})), "dist");
setRuntimeBundles({
  runtime: readFileSync(path.join(dist, "selfbuilding-runtime.mjs")),
  mcp: readFileSync(path.join(dist, "selfbuilding-mcp.mjs")),
  nsReap: readFileSync(path.join(dist, "ns-reap.mjs")),
});
const fromEnv = (name) => async () => env[name];
const harness =
  cfg.harness === "codex"
    ? codex({
        credentials: [
          ...(env.CODEX_AUTH_FILE ? [{ kind: "auth-file", value: () => fs.readFile(env.CODEX_AUTH_FILE, "utf8"), leased: true }] : []),
          ...(env.OPENAI_API_KEY ? [{ kind: "api-key", value: fromEnv("OPENAI_API_KEY") }] : []),
        ],
      })
    : claudeCode({
        credentials: [
          ...(env.CLAUDE_CODE_OAUTH_TOKEN ? [{ kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") }] : []),
          ...(env.ANTHROPIC_API_KEY ? [{ kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") }] : []),
        ],
      });
const tpl = (base) => base ?? (cfg.harness === "codex" ? "selfbuilding-codex" : "selfbuilding-claude-code");
const sandbox =
  cfg.provider === "e2b"
    ? e2b({ apiKey: env.E2B_API_KEY ?? "", template: tpl(cfg.harness === "codex" ? env.E2B_CODEX_TEMPLATE : env.E2B_TEMPLATE) })
    : impello({ apiKey: env.IMPELLO_API_KEY ?? "", template: tpl(cfg.harness === "codex" ? env.IMPELLO_CODEX_TEMPLATE : env.IMPELLO_TEMPLATE) });
const Asker = factory({ name: "live-asker", input: z.object({}) }, async () => {
  const r = await agent({
    name: "asker",
    label: "asker",
    output: z.object({ decision: z.string() }),
    prompt: 'Use the ask_human tool to ask "Ship the migration tonight?" with the choices "ship" and "hold". Then submit { "decision": <the answer> }.',
  });
  return r.result;
});
const sink = (e) => appendFileSync(path.join(cfg.dir, "events-" + cfg.tag + ".jsonl"), JSON.stringify(e) + "\\n");
const out = await run(Asker, {}, {
  runId: cfg.runId,
  config: {
    deployment: "live",
    sandbox,
    harness,
    events: [sink],
    hitl: { channels: [slack({ channel: env.SLACK_CHANNEL })], approvers: [{ slack: env.SELFBUILDING_LIVE_APPROVER }], timeout: "30m", hotWait: "1s" },
    artifacts: fileArtifacts(path.join(cfg.dir, "artifacts")),
  },
  journal: fileJournal(path.join(cfg.dir, "journal")),
});
process.stdout.write("RESULT " + JSON.stringify({ status: out.status, output: out.output ?? null }) + "\\n");
process.exit(0);
`;
}

export interface ColdHost {
  child: ChildProcess;
  result: Promise<{ status: string; output: unknown } | null>;
  stderr(): string;
}

/** Writes the host script into `dir` and starts one host process for `runId`. */
export async function startColdHost(cfg: {
  dir: string;
  runId: string;
  tag: string;
  provider: "impello" | "e2b";
  harness: "claude-code" | "codex";
}): Promise<ColdHost> {
  const file = path.join(cfg.dir, "cold-host.mjs");
  await writeFile(file, script());
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, SBL_COLD: JSON.stringify(cfg) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const result = new Promise<{ status: string; output: unknown } | null>((resolve) => {
    child.on("exit", () => {
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      resolve(line ? JSON.parse(line.slice("RESULT ".length)) : null);
    });
  });
  return { child, result, stderr: () => stderr };
}
