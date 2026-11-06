import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigError, type SelfbuildingEvent } from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { formatEvent } from "../events.js";
import { EXIT, exitForStatus, isRunStatus } from "../exit.js";
import { formatWorkflowSummary, isScriptRun, workflowStatus } from "../launcher.js";
import { findProjectRoot, resolveConfigPath, statePaths } from "../project.js";
import { sleep } from "../sleep.js";
import { assertRunId, eventsPath, isAlive, readRunRecord } from "../state.js";

export const WATCH_HELP = `Usage: selfbuilding watch <runId> [options]

Tails a run's events until the run ends or the process driving it exits. Exits with the run's status code.
A workflow script run ends with a summary of its phase, agents, sizes and costs.

Options:
  --from <n>         Skip the first n events of the run's stream (to pick up where an earlier watch stopped)
  --config <path>    Config file that locates the project (default: search upward)
  --json             NDJSON events on stdout instead of the readable view on stderr
`;

/** Reads whole lines appended to a file since the last call. */
class LineTail {
  private offset = 0;
  private partial = "";
  constructor(private readonly file: string) {}

  read(): string[] {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size <= this.offset) return [];
    const fd = openSync(this.file, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.partial + buf.toString("utf8");
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      return lines.filter((line) => line.trim() !== "");
    } finally {
      closeSync(fd);
    }
  }
}

export async function watchCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "watch",
    argv,
    { from: { type: "string" }, config: { type: "string" }, json: { type: "boolean" } },
    { min: 1, max: 1 },
  );
  const runId = assertRunId(args.positionals[0] as string);
  const fromRaw = args.str("from");
  const from = fromRaw === undefined ? 0 : Number(fromRaw);
  if (!Number.isInteger(from) || from < 0) throw new ConfigError(`--from "${fromRaw}" must be a whole number >= 0.`);
  const json = args.bool("json");

  const configPath = resolveConfigPath(ctx, args.str("config"));
  const paths = statePaths(configPath ? path.dirname(configPath) : findProjectRoot(ctx.cwd));
  const file = eventsPath(paths, runId);
  if (!existsSync(file) && !readRunRecord(paths, runId)) {
    ctx.stderr.write(`No run ${runId} in ${paths.dir}. Watch runs started with selfbuilding run from this project.\n`);
    return EXIT.usage;
  }

  const tail = new LineTail(file);
  let seen = 0;
  let endStatus: unknown;
  const drain = () => {
    for (const line of tail.read()) {
      seen++;
      if (seen <= from) continue;
      let event: SelfbuildingEvent;
      try {
        event = JSON.parse(line) as SelfbuildingEvent;
      } catch {
        continue;
      }
      if (json) ctx.stdout.write(`${line}\n`);
      else {
        const text = formatEvent(event);
        if (text !== null) ctx.stderr.write(`${text}\n`);
      }
      if (event.type === "run.end" && event.callPath === "run") endStatus = event.data?.status ?? "ended";
    }
  };

  for (;;) {
    drain();
    if (endStatus !== undefined) break;
    const record = readRunRecord(paths, runId);
    const driving = record?.pid !== undefined && isAlive(record.pid) && !record.finishedAt;
    if (!driving) {
      // The process wrote its last event before it updated the record; one more read catches it.
      drain();
      endStatus = endStatus ?? record?.status;
      break;
    }
    if (ctx.interrupt.aborted) return EXIT.interrupted;
    await sleep(ctx.pollMs, ctx.interrupt);
    if (ctx.interrupt.aborted) return EXIT.interrupted;
  }
  // Workflow script runs (start_workflow, `selfbuilding start`) end with their phase, agents, sizes and costs.
  if (!json && isScriptRun(readRunRecord(paths, runId))) {
    const summary = workflowStatus(paths, runId);
    if (summary) ctx.stderr.write(`${formatWorkflowSummary(summary)}\n`);
  }
  if (!json && endStatus === undefined) ctx.stderr.write(`Run ${runId} is not running and has no recorded status.\n`);
  return isRunStatus(endStatus) ? exitForStatus(endStatus) : EXIT.ok;
}
