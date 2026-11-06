import type { SandboxProvider } from "@selfbuilding/core";
import { parseCommandArgs, parseDuration } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { deploymentOf, journalOf, loadProject } from "../project.js";
import { sleep } from "../sleep.js";
import { assertRunId, isAlive, readRunRecord, writeCancelRequest, writeRunRecord } from "../state.js";

export const CANCEL_HELP = `Usage: selfbuilding cancel <runId> [options]

Cancels a run. A process still driving the run is told to stop and given time to save work; then every
sandbox labelled with the run is killed and its open asks are cancelled. Reports the counts, and says so
when a provider could not be listed instead of reporting "0 killed".

Options:
  --reason <text>    Recorded with the cancel (default "cancelled from the CLI")
  --wait <duration>  How long to let a running process stop on its own first (default 30s)
  --config <path>    Config file (default: search upward)
  --env-file <path>  Load a dotenv file before the config is evaluated
  --json             Print the result as one JSON line on stdout
`;

export interface CancelReport {
  runId: string;
  /** The process that was driving the run, and whether it stopped within --wait. */
  process: { pid: number; stopped: boolean } | null;
  killed: number;
  alreadyGone: number;
  asksCancelled: number;
  /** Providers whose listing failed: the counts above do not cover them. */
  listingFailed: { provider: string; message: string }[];
  killFailed: { provider: string; sandbox: string; message: string }[];
}

export async function cancelCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "cancel",
    argv,
    {
      reason: { type: "string" },
      wait: { type: "string" },
      config: { type: "string" },
      "env-file": { type: "string" },
      json: { type: "boolean" },
    },
    { min: 1, max: 1 },
  );
  const runId = assertRunId(args.positionals[0] as string);
  const reason = args.str("reason") ?? "cancelled from the CLI";
  const waitMs = parseDuration("--wait", args.str("wait") ?? "30s");
  const project = await loadProject(ctx, {
    config: args.str("config"),
    envFile: args.str("env-file"),
    requireConfig: true,
  });
  const { paths } = project;

  // Durable before any remote action, so a crash mid-cancel, or a later resume, still ends the run as aborted.
  writeCancelRequest(paths, runId, { reason, at: new Date().toISOString(), by: ctx.user.id });

  const report: CancelReport = {
    runId,
    process: null,
    killed: 0,
    alreadyGone: 0,
    asksCancelled: 0,
    listingFailed: [],
    killFailed: [],
  };

  const record = readRunRecord(paths, runId);
  if (record?.pid && !record.finishedAt && isAlive(record.pid)) {
    if (!args.bool("json"))
      ctx.stderr.write(`Asked process ${record.pid} to stop run ${runId}; waiting up to ${waitMs / 1000}s.\n`);
    const deadline = Date.now() + waitMs;
    let stopped = false;
    while (Date.now() < deadline && !ctx.interrupt.aborted) {
      const now = readRunRecord(paths, runId);
      if (!now?.pid || now.finishedAt || !isAlive(now.pid)) {
        stopped = true;
        break;
      }
      await sleep(Math.min(ctx.pollMs, Math.max(1, deadline - Date.now())), ctx.interrupt);
    }
    report.process = { pid: record.pid, stopped };
  } else if (record && !record.finishedAt) {
    // The process that drove the run is gone; nothing else will mark it.
    const { pid: _pid, ...rest } = record;
    writeRunRecord(paths, { ...rest, status: "aborted", finishedAt: new Date().toISOString() });
  } else if (record?.status === "waiting") {
    writeRunRecord(paths, { ...record, status: "aborted" });
  }

  const journal = journalOf(project);
  if (journal.asks) {
    try {
      for await (const ask of journal.asks.open({ runId })) {
        await journal.asks.setStatus(ask.askId, "cancelled");
        report.asksCancelled++;
      }
    } catch (error) {
      ctx.stderr.write(`warn: could not cancel the run's open asks: ${(error as Error).message}\n`);
    }
  }

  const deployment = deploymentOf(project.config);
  for (const provider of project.providers) await sweep(provider, deployment, runId, report);

  print(ctx, report, args.bool("json"), project.providers.length);
  return report.listingFailed.length > 0 || report.killFailed.length > 0 ? EXIT.failed : EXIT.ok;
}

async function sweep(
  provider: SandboxProvider,
  deployment: string,
  runId: string,
  report: CancelReport,
): Promise<void> {
  const refs = [];
  try {
    for await (const ref of provider.list({ deployment, runId })) {
      // A provider that ignores the run filter must not cost another run its sandboxes.
      if (ref.key.runId === runId || ref.labels["selfbuilding.run"] === runId) refs.push(ref);
    }
  } catch (error) {
    report.listingFailed.push({ provider: provider.id, message: (error as Error).message });
    return;
  }
  for (const ref of refs) {
    try {
      const { path } = await provider.kill(ref);
      if (path === "killed") report.killed++;
      else report.alreadyGone++;
    } catch (error) {
      report.killFailed.push({ provider: provider.id, sandbox: ref.name, message: (error as Error).message });
    }
  }
}

function print(ctx: CliContext, report: CancelReport, json: boolean, providerCount: number): void {
  if (json) {
    ctx.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const lines: string[] = [];
  if (report.process) {
    lines.push(
      report.process.stopped
        ? `Process ${report.process.pid} stopped the run.`
        : `Process ${report.process.pid} did not stop in time; its sandboxes were killed anyway.`,
    );
  }
  if (providerCount === 0) {
    lines.push("No sandbox provider is configured, so no sandboxes were listed. Set sandbox in the config.");
  } else {
    const gone = report.alreadyGone > 0 ? ` (${report.alreadyGone} already gone)` : "";
    lines.push(
      `Cancelled run ${report.runId}: killed ${report.killed} sandbox${report.killed === 1 ? "" : "es"}${gone}.`,
    );
  }
  if (report.asksCancelled > 0)
    lines.push(`Cancelled ${report.asksCancelled} open ask${report.asksCancelled === 1 ? "" : "s"}.`);
  for (const f of report.listingFailed) {
    lines.push(
      `Could not list sandboxes on ${f.provider} (${f.message}); the count above does not cover it. Run selfbuilding reap later.`,
    );
  }
  for (const f of report.killFailed) lines.push(`Could not kill ${f.sandbox} on ${f.provider}: ${f.message}`);
  ctx.stderr.write(`${lines.join("\n")}\n`);
}
