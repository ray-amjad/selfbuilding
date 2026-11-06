import path from "node:path";
import { ConfigError, type InterruptedPolicy, type RunOptions } from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { loadFactory } from "../factory-file.js";
import {
  deploymentOf,
  findProjectRoot,
  journalOf,
  type LoadedProject,
  loadProject,
  resolveConfigPath,
  statePaths,
} from "../project.js";
import { assertRunId, isAlive, readRunRecord } from "../state.js";
import { executeRun } from "./run.js";

export const RESUME_HELP = `Usage: selfbuilding resume <runId> [options]

Resumes a run from its journal: finished calls replay, the rest run live. An interrupted call is never
re-run silently; choose what happens to it with --interrupted.

Options:
  --interrupted <callPath>=<policy>   fail | resume-session | restore-and-rerun | skip (repeatable).
                                       A bare fail or resume-session applies to every interrupted call.
  --config <path>                      Config file (default: the one the run started with)
  --env-file <path>                    Load a dotenv file before the config is evaluated
  --json                               NDJSON events on stdout; the last line is the RunOutcome
`;

const POLICIES: readonly InterruptedPolicy[] = ["fail", "resume-session", "restore-and-rerun", "skip"];

export function parseInterrupted(values: readonly string[]): RunOptions["onInterrupted"] | undefined {
  if (values.length === 0) return undefined;
  const perCall: Record<string, InterruptedPolicy> = {};
  let global: "fail" | "resume-session" | undefined;
  for (const value of values) {
    const at = value.lastIndexOf("=");
    const callPath = at === -1 ? undefined : value.slice(0, at);
    const policy = at === -1 ? value : value.slice(at + 1);
    if (!(POLICIES as readonly string[]).includes(policy)) {
      throw new ConfigError(`--interrupted ${value}: "${policy}" is not one of ${POLICIES.join(", ")}.`);
    }
    if (callPath === undefined) {
      if (policy !== "fail" && policy !== "resume-session") {
        throw new ConfigError(
          `--interrupted ${policy} needs a call path (<callPath>=${policy}); only fail and resume-session apply to every call.`,
        );
      }
      global = policy;
    } else if (callPath === "") {
      throw new ConfigError(`--interrupted ${value}: the call path before "=" is empty.`);
    } else {
      perCall[callPath] = policy as InterruptedPolicy;
    }
  }
  if (global && Object.keys(perCall).length > 0) {
    throw new ConfigError("--interrupted takes either one bare policy or <callPath>=<policy> pairs, not both.");
  }
  return global ?? perCall;
}

export async function resumeCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "resume",
    argv,
    {
      interrupted: { type: "string", multiple: true },
      config: { type: "string" },
      "env-file": { type: "string" },
      json: { type: "boolean" },
    },
    { min: 1, max: 1 },
  );
  const runId = assertRunId(args.positionals[0] as string);
  const onInterrupted = parseInterrupted(args.list("interrupted"));

  // The record lives next to the config the run started with; find it from here first.
  const configPath = resolveConfigPath(ctx, args.str("config"));
  const lookup = statePaths(configPath ? path.dirname(configPath) : findProjectRoot(ctx.cwd));
  const record = readRunRecord(lookup, runId);
  if (!record) {
    ctx.stderr.write(
      `No run ${runId} in ${lookup.runs}. selfbuilding resume continues runs started with selfbuilding run from this project.\n`,
    );
    return EXIT.usage;
  }
  if (record.pid && isAlive(record.pid) && !record.finishedAt) {
    ctx.stderr.write(
      `Run ${runId} is still running in process ${record.pid}. Watch it with selfbuilding watch ${runId}, or stop it with selfbuilding cancel ${runId}.\n`,
    );
    return EXIT.usage;
  }

  const project = await loadProject(ctx, {
    config: args.str("config") ?? record.configPath ?? undefined,
    envFile: args.str("env-file") ?? record.envFile,
    requireConfig: false,
  });
  const factory = await loadFactory(record.factoryFile, record.exportName);
  await sweepBeforeResume(ctx, project, args.bool("json"));
  return executeRun(ctx, project, factory, record, {
    json: args.bool("json"),
    ...(onInterrupted ? { onInterrupted } : {}),
  });
}

/** On plain Node the reaper runs inside `resume` (spec §7.8). It is a backstop, so a failure only warns. */
async function sweepBeforeResume(ctx: CliContext, project: LoadedProject, json: boolean): Promise<void> {
  const journal = journalOf(project);
  if (project.providers.length === 0 || !journal.asks) return;
  try {
    const report = await project.core.reap({
      providers: project.providers,
      journal,
      asks: journal.asks,
      deployment: deploymentOf(project.config),
    });
    if (!json && report.killed + report.parked > 0) {
      ctx.stderr.write(`Reaper: killed ${report.killed}, parked ${report.parked} leaked sandboxes before resuming.\n`);
    }
  } catch (error) {
    ctx.stderr.write(`warn: the reaper sweep before resume failed: ${(error as Error).message}\n`);
  }
}
