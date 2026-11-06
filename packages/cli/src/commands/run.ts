import path from "node:path";
import type { EventSink, Factory, RunOptions, RunOutcome } from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { humanSink, jsonlFileSink, ndjsonSink } from "../events.js";
import { EXIT, type ExitCode, exitForStatus } from "../exit.js";
import { loadFactory, readInput } from "../factory-file.js";
import { journalOf, type LoadedProject, loadProject } from "../project.js";
import {
  assertRunId,
  eventsPath,
  newRunId,
  type RunRecord,
  readCancelRequest,
  readRunRecord,
  writeRunRecord,
} from "../state.js";

export const RUN_HELP = `Usage: selfbuilding run <factory-file> [options]

Starts a run of a factory. With an existing --run-id, finished calls replay from the journal.

Options:
  --input <json|@file|->   Factory input: inline JSON, @path/to/file.json, or - for stdin (default {})
  --export <name>          Use this named export instead of the default export
  --run-id <id>            Run id (default: a new ns_<ulid>)
  --afk                    Every ask resolves by its policy; nobody is asked
  --config <path>          Config file (default: search upward for selfbuilding.config.ts)
  --env-file <path>        Load a dotenv file before the config is evaluated
  --json                   NDJSON events on stdout; the last line is the RunOutcome
`;

export async function runCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "run",
    argv,
    {
      input: { type: "string" },
      export: { type: "string" },
      "run-id": { type: "string" },
      afk: { type: "boolean" },
      config: { type: "string" },
      "env-file": { type: "string" },
      json: { type: "boolean" },
    },
    { min: 1, max: 1 },
  );
  const runId = assertRunId(args.str("run-id") ?? newRunId());
  const factoryFile = path.resolve(ctx.cwd, args.positionals[0] as string);
  const input = await readInput(ctx, args.str("input"));
  const envFile = args.str("env-file");
  const project = await loadProject(ctx, { config: args.str("config"), envFile, requireConfig: false });
  const exportName = args.str("export");
  const factory = await loadFactory(factoryFile, exportName);

  const previous = readRunRecord(project.paths, runId);
  const now = new Date().toISOString();
  const record: RunRecord = {
    v: 1,
    runId,
    factoryFile,
    ...(exportName ? { exportName } : {}),
    input,
    configPath: project.configPath,
    ...(envFile ? { envFile: path.resolve(ctx.cwd, envFile) } : {}),
    ...(args.bool("afk") ? { afk: true } : {}),
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
  };
  return executeRun(ctx, project, factory, record, { json: args.bool("json") });
}

export interface ExecuteOptions {
  json: boolean;
  onInterrupted?: RunOptions["onInterrupted"];
}

/**
 * Drives one process's share of a run: wires the event sinks, the SIGINT and `cancel` signals and the run
 * record, calls `run()`, and maps the outcome to an exit code. `run` and `resume` both end here.
 */
export async function executeRun(
  ctx: CliContext,
  project: LoadedProject,
  factory: Factory<unknown, unknown>,
  record: RunRecord,
  opts: ExecuteOptions,
): Promise<number> {
  const { config, paths } = project;
  const file = jsonlFileSink(eventsPath(paths, record.runId));
  const events: EventSink[] = [
    ...(config.events ?? []),
    file.sink,
    opts.json ? ndjsonSink(ctx.stdout) : humanSink(ctx.stderr),
  ];

  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    controller.abort(new Error("Interrupted by SIGINT"));
  };
  const checkCancel = () => {
    const request = readCancelRequest(paths, record.runId);
    if (request && !controller.signal.aborted) {
      controller.abort(new Error(`Cancelled: ${request.reason}`));
    }
  };
  // A cancel written while nothing was running still applies: the run starts aborted and settles as aborted.
  checkCancel();
  if (ctx.interrupt.aborted) onInterrupt();
  ctx.interrupt.addEventListener("abort", onInterrupt, { once: true });
  const poll = setInterval(checkCancel, ctx.pollMs);
  poll.unref?.();

  const { finishedAt: _finished, status: _status, ...fresh } = record;
  writeRunRecord(paths, { ...fresh, pid: process.pid });

  const runOptions: RunOptions = {
    runId: record.runId,
    config,
    journal: journalOf(project),
    artifacts: config.artifacts ?? project.core.fileArtifacts(paths.artifacts),
    events,
    signal: controller.signal,
    ...(record.afk ? { hitl: { ...config.hitl, mode: "afk" as const } } : {}),
    ...(ctx.env.SELFBUILDING_STRICT === "1" ? { strict: true } : {}),
    ...(opts.onInterrupted ? { onInterrupted: opts.onInterrupted } : {}),
  };

  let outcome: RunOutcome<unknown> | undefined;
  try {
    outcome = await project.core.run(factory, record.input, runOptions);
    return report(ctx, outcome, opts.json, interrupted);
  } finally {
    clearInterval(poll);
    ctx.interrupt.removeEventListener("abort", onInterrupt);
    file.close();
    const { pid: _pid, ...rest } = record;
    writeRunRecord(paths, {
      ...rest,
      ...(outcome ? { status: outcome.status } : {}),
      finishedAt: new Date().toISOString(),
    });
  }
}

function report(ctx: CliContext, outcome: RunOutcome<unknown>, json: boolean, interrupted: boolean): ExitCode {
  if (json) {
    // The events were already streamed line by line; repeating them in the last line would double the output.
    const { events: _events, ...rest } = outcome;
    ctx.stdout.write(`${JSON.stringify(rest)}\n`);
  } else {
    const cost = outcome.usage?.usd;
    const replayed = outcome.replayedUsd > 0 ? `, $${outcome.replayedUsd.toFixed(2)} replayed` : "";
    ctx.stderr.write(
      `Run ${outcome.runId} ${outcome.status}${typeof cost === "number" ? ` ($${cost.toFixed(2)}${replayed})` : ""}.\n`,
    );
    const hint = NEXT_STEP[outcome.status]?.(outcome.runId);
    if (hint) ctx.stderr.write(`${hint}\n`);
    if (outcome.output !== null && outcome.output !== undefined) {
      ctx.stdout.write(`${JSON.stringify(outcome.output, null, 2)}\n`);
    }
  }
  if (interrupted && outcome.status !== "ok") return EXIT.interrupted;
  return exitForStatus(outcome.status);
}

const NEXT_STEP: Partial<Record<RunOutcome<unknown>["status"], (runId: string) => string>> = {
  waiting: (id) =>
    `The run is parked on an ask. Answer it (selfbuilding answer ${id} '#1' <answer>), then selfbuilding resume ${id}.`,
  needs_attention: (id) =>
    `A call was interrupted. Choose what to do with it: selfbuilding resume ${id} --interrupted <callPath>=fail|resume-session|restore-and-rerun|skip.`,
  failed: (id) => `Fix the cause, then selfbuilding resume ${id}; finished calls replay from the journal.`,
  budget_exhausted: (id) => `Raise the budget, then selfbuilding resume ${id}.`,
};
