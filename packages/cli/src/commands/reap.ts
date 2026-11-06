import { ConfigError, type ReapReport } from "@selfbuilding/core";
import { parseCommandArgs, parseDuration } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { deploymentOf, journalOf, loadProject } from "../project.js";
import { sleep } from "../sleep.js";

export const REAP_HELP = `Usage: selfbuilding reap [options]

Sweeps leaked sandboxes from what the providers list (never from events), expires overdue asks and sends
reminders. Exits 1 when a provider could not be listed: that is never reported as a clean sweep.

Options:
  --every <duration>  Sweep again every <duration> until interrupted (e.g. 2m)
  --provider <id>     Only sweep this provider (repeatable); default every configured provider
  --dry-run           Report the decisions, change nothing
  --config <path>     Config file (default: search upward)
  --env-file <path>   Load a dotenv file before the config is evaluated
  --json              Print each sweep's report as one JSON line on stdout
`;

export async function reapCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "reap",
    argv,
    {
      every: { type: "string" },
      provider: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      config: { type: "string" },
      "env-file": { type: "string" },
      json: { type: "boolean" },
    },
    { min: 0, max: 0 },
  );
  const every = args.str("every") === undefined ? null : parseDuration("--every", args.str("every") as string);
  const project = await loadProject(ctx, {
    config: args.str("config"),
    envFile: args.str("env-file"),
    requireConfig: true,
  });

  const wanted = args.list("provider");
  const known = project.providers.map((p) => p.id);
  const unknown = wanted.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new ConfigError(
      `--provider ${unknown.join(", ")}: not configured. Configured providers: ${known.join(", ") || "none"}.`,
    );
  }
  const providers = wanted.length > 0 ? project.providers.filter((p) => wanted.includes(p.id)) : project.providers;
  if (providers.length === 0) {
    throw new ConfigError(
      "No sandbox provider to sweep. Set sandbox in the config, or export a providers array from it for the extra providers your factories use.",
    );
  }
  const journal = journalOf(project);
  if (!journal.asks) {
    throw new ConfigError(
      "The configured journal has no ask store, and the reaper needs one so open asks keep their sandboxes. Use fileJournal() or a journal with an asks store.",
    );
  }
  const options = {
    providers,
    journal,
    asks: journal.asks,
    deployment: deploymentOf(project.config),
    ...(args.bool("dry-run") ? { dryRun: true } : {}),
  };

  let code: number = EXIT.ok;
  for (;;) {
    try {
      const report = await project.core.reap(options);
      print(ctx, report, args.bool("json"), args.bool("dry-run"));
      code = report.errors.length > 0 ? EXIT.failed : EXIT.ok;
    } catch (error) {
      // A scheduled sweep outlives one bad sweep; a one-off reports it.
      if (every === null) throw error;
      ctx.stderr.write(`Sweep failed: ${(error as Error).message}\n`);
      code = EXIT.failed;
    }
    if (every === null || ctx.interrupt.aborted) break;
    await sleep(every, ctx.interrupt);
    if (ctx.interrupt.aborted) break;
  }
  return code;
}

function print(ctx: CliContext, report: ReapReport, json: boolean, dryRun: boolean): void {
  if (json) {
    ctx.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const lines = [
    `${dryRun ? "Dry run: would have " : ""}killed ${report.killed}, parked ${report.parked}, held ${report.held}; ${report.leaked} leaked.`,
  ];
  for (const d of report.decisions) {
    if (d.action === "hold") lines.push(`  skip [${d.reason}] ${d.sandbox.provider}/${d.sandbox.name}`);
    else lines.push(`  ${d.action} ${d.sandbox.provider}/${d.sandbox.name} [${d.reason}]`);
  }
  for (const e of report.errors) {
    lines.push(`Could not sweep ${e.provider} (${e.code}): ${e.message}. Its sandboxes were not counted.`);
  }
  ctx.stderr.write(`${lines.join("\n")}\n`);
}
