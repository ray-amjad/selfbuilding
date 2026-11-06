// A host process for live acceptance 3, killed and restarted by the test. It runs a three-agent factory with a real
// harness in a real sandbox, journalling to disk, so the next process resumes what this one left.
//
// SBL_CRASH (JSON): { dir, runId, tag, provider: "impello" | "e2b", harness: "claude-code" | "codex" }
import { appendFileSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agent, factory, fileArtifacts, fileJournal, run, setRuntimeBundles } from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { codex } from "@selfbuilding/harnesses/codex";
import { e2b } from "@selfbuilding/sandbox-e2b";
import { impello } from "@selfbuilding/sandbox-impello";
import { z } from "zod";

const cfg = JSON.parse(process.env.SBL_CRASH ?? "{}");
const env = process.env;
const dist = path.join(path.dirname(fileURLToPath(import.meta.resolve("@selfbuilding/runtime/package.json"))), "dist");
setRuntimeBundles({
  runtime: readFileSync(path.join(dist, "selfbuilding-runtime.mjs")),
  mcp: readFileSync(path.join(dist, "selfbuilding-mcp.mjs")),
  nsReap: readFileSync(path.join(dist, "ns-reap.mjs")),
});

const sink = (e) => appendFileSync(path.join(cfg.dir, `events-${cfg.tag}.jsonl`), `${JSON.stringify(e)}\n`);
const fromEnv = (name) => async () => env[name] ?? "";

const harness =
  cfg.harness === "codex"
    ? codex({
        credentials: env.CODEX_AUTH_FILE
          ? { kind: "auth-file", value: () => fs.readFile(env.CODEX_AUTH_FILE, "utf8"), leased: true }
          : { kind: "api-key", value: fromEnv("OPENAI_API_KEY") },
      })
    : claudeCode({
        credentials: env.CLAUDE_CODE_OAUTH_TOKEN
          ? { kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") }
          : { kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") },
      });
const template = (base) => base ?? (cfg.harness === "codex" ? "selfbuilding-codex" : "selfbuilding-claude-code");
const provider =
  cfg.provider === "e2b"
    ? e2b({
        apiKey: env.E2B_API_KEY ?? "",
        template: template(cfg.harness === "codex" ? env.E2B_CODEX_TEMPLATE : env.E2B_TEMPLATE),
      })
    : impello({
        apiKey: env.IMPELLO_API_KEY ?? "",
        template: template(cfg.harness === "codex" ? env.IMPELLO_CODEX_TEMPLATE : env.IMPELLO_TEMPLATE),
      });

const Out = z.object({ word: z.string() });
const steps = [
  ["a", 'Submit the result { "word": "alpha" } and nothing else.'],
  // Long enough for the test to kill the host while the box keeps working.
  ["b", 'Run the shell command `sleep 120` and wait for it to finish. Then submit { "word": "bravo" }.'],
  ["c", 'Submit the result { "word": "charlie" } and nothing else.'],
];
const Resume = factory({ name: "live-resume", input: z.object({}) }, async () => {
  const out = [];
  for (const [label, prompt] of steps) {
    const r = await agent({ name: label, prompt, output: Out, label });
    out.push({ label, word: r.result.word, replayed: r.replayed });
  }
  return out;
});

const result = await run(
  Resume,
  {},
  {
    runId: cfg.runId,
    config: {
      deployment: "live",
      sandbox: provider,
      harness,
      events: [sink],
      budget: { usd: 3 },
      artifacts: fileArtifacts(path.join(cfg.dir, "artifacts")),
    },
    journal: fileJournal(path.join(cfg.dir, "journal")),
  },
);
process.stdout.write(`RESULT ${JSON.stringify({ status: result.status, output: result.output })}\n`);
process.exit(0);
