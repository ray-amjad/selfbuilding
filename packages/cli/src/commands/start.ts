import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ConfigError,
  checkStartGuards,
  type ResultStore,
  resolveStartPolicy,
  type StartWorkflowCaller,
  type StartWorkflowRequest,
  startWorkflowCaps,
  type WorkflowLauncher,
  workflowRunId,
} from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { readInput } from "../factory-file.js";
import { nodeWorkflowLauncher } from "../launcher.js";
import { createLoader, type LoadedProject, loadProject } from "../project.js";
import { watchCommand } from "./watch.js";

// `selfbuilding start` (docs/spec/demo-path.md §9.5). Owner: start-workflow.

export const START_HELP = `Usage: selfbuilding start <script> [options]

Starts a workflow script as a run of the deployed run-script factory, then follows it like watch.

Options:
  --name <name>          Run name (default: the script's file name)
  --input <json|@file>   The script's input (default {})
  --host <node|trigger>  Where it runs (default: node; trigger needs TRIGGER_SECRET_KEY)
  --size <name>          The largest size the script may ask for (default small)
  --max-sandboxes <n>    Live sandboxes at once (default 2)
  --budget <usd>         Run budget (default 10)
  --afk                  No humans: every ask resolves by its AFK policy
  --idempotency-key <k>  Starting again with the same key returns the first run instead of a new one
  --detach               Print the run id and exit instead of following
  --config <path>        Config file (default: search upward)
  --env-file <path>      Load a dotenv file before the config is evaluated
  --json                 Print the receipt (and with follow, each event) as JSON lines
`;

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

function nameFrom(file: string): string {
  const base = path
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48);
  return base || "script";
}

function positiveNumber(flag: string, raw: string | undefined, integer: boolean): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new ConfigError(`--${flag} "${raw}" must be a ${integer ? "whole number" : "number"} above 0.`);
  }
  return n;
}

/** Trigger.dev launches go through the project's own @selfbuilding/host-trigger, which the CLI does not bundle. */
async function triggerLauncher(ctx: CliContext, project: LoadedProject): Promise<WorkflowLauncher> {
  if (!ctx.env.TRIGGER_SECRET_KEY) {
    throw new ConfigError("--host trigger needs TRIGGER_SECRET_KEY in the environment (or in --env-file).");
  }
  let mod: {
    triggerWorkflowLauncher: (o: object) => WorkflowLauncher;
    realTriggerSdk: () => unknown;
    fileResultStore: (root: string) => ResultStore;
  };
  try {
    mod = (await createLoader(project.root).import("@selfbuilding/host-trigger")) as typeof mod;
  } catch (error) {
    throw new ConfigError(
      `--host trigger needs @selfbuilding/host-trigger and @trigger.dev/sdk installed in ${project.root}: ${(error as Error).message}`,
    );
  }
  return mod.triggerWorkflowLauncher({
    trigger: mod.realTriggerSdk(),
    store: mod.fileResultStore(path.join(project.paths.dir, "trigger-launches")),
    config: project.config,
  });
}

export async function startCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "start",
    argv,
    {
      name: { type: "string" },
      input: { type: "string" },
      host: { type: "string" },
      size: { type: "string" },
      "max-sandboxes": { type: "string" },
      budget: { type: "string" },
      afk: { type: "boolean" },
      "idempotency-key": { type: "string" },
      detach: { type: "boolean" },
      config: { type: "string" },
      "env-file": { type: "string" },
      json: { type: "boolean" },
    },
    { min: 1, max: 1 },
  );
  const scriptFile = path.resolve(ctx.cwd, args.positionals[0] as string);
  if (!existsSync(scriptFile)) throw new ConfigError(`Script file ${scriptFile} does not exist.`);
  const script = readFileSync(scriptFile, "utf8");
  const name = args.str("name") ?? nameFrom(scriptFile);
  if (!NAME.test(name)) throw new ConfigError(`--name "${name}" must match ${NAME.source}.`);
  const host = args.str("host") ?? "node";
  if (host !== "node" && host !== "trigger") throw new ConfigError(`--host "${host}" must be node or trigger.`);
  const input = await readInput(ctx, args.str("input"));
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError("--input must be a JSON object.");
  }
  const maxSandboxes = positiveNumber("max-sandboxes", args.str("max-sandboxes"), true);
  const budgetUsd = positiveNumber("budget", args.str("budget"), false);
  const size = args.str("size");
  const idempotencyKey = args.str("idempotency-key");
  const envFile = args.str("env-file");
  const json = args.bool("json");

  const project = await loadProject(ctx, { config: args.str("config"), envFile, requireConfig: false });
  const policy = resolveStartPolicy(project.config.startWorkflow);
  const request: StartWorkflowRequest = {
    name,
    script,
    input: input as StartWorkflowRequest["input"] & object,
    ...(size ? { size } : {}),
    ...(maxSandboxes !== undefined ? { maxSandboxes } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(args.bool("afk") ? { afk: true } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  const caller: StartWorkflowCaller = { kind: "local", user: ctx.user.id };
  const launcher =
    host === "trigger"
      ? await triggerLauncher(ctx, project)
      : nodeWorkflowLauncher({
          cwd: project.root,
          config: project.config,
          configPath: project.configPath,
          ...(envFile ? { envFile: path.resolve(ctx.cwd, envFile) } : {}),
          ...(ctx.env.SELFBUILDING_CLI_ENTRY ? { cliEntry: ctx.env.SELFBUILDING_CLI_ENTRY } : {}),
        });

  // Local callers skip disabled, grant and depth; every other guard applies (demo-path §9.5).
  const existing = await launcher.status?.(workflowRunId(caller, request));
  if (!existing) {
    checkStartGuards(policy, request, caller, await launcher.active());
    await launcher.checkScript?.(script);
  }
  const caps = startWorkflowCaps(policy, request, project.config);
  const receipt = await launcher.start(
    {
      ...request,
      ...(caps.maxSandboxes !== undefined ? { maxSandboxes: caps.maxSandboxes } : {}),
      ...(caps.budgetUsd !== undefined ? { budgetUsd: caps.budgetUsd } : {}),
    },
    caller,
  );
  if (json) ctx.stdout.write(`${JSON.stringify(receipt)}\n`);
  else {
    ctx.stderr.write(
      `${receipt.status === "exists" ? "Already running" : "Started"} run ${receipt.runId} on ${receipt.host}. Follow it with: ${receipt.watch}${receipt.url ? ` (${receipt.url})` : ""}\n`,
    );
  }
  if (args.bool("detach") || receipt.host !== "node") return 0;
  return watchCommand(ctx, [
    receipt.runId,
    ...(project.configPath ? ["--config", project.configPath] : []),
    ...(json ? ["--json"] : []),
  ]);
}
