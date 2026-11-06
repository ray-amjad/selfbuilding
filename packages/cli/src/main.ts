import { createInterface } from "node:readline/promises";
import { ANSWER_HELP, answerCommand } from "./commands/answer.js";
import { CANCEL_HELP, cancelCommand } from "./commands/cancel.js";
import { DOCTOR_HELP, doctorCommand } from "./commands/doctor.js";
import { IMAGES_HELP, imagesCommand } from "./commands/images.js";
import { INIT_HELP, initCommand } from "./commands/init.js";
import { JOURNAL_HELP, journalCommand } from "./commands/journal.js";
import { REAP_HELP, reapCommand } from "./commands/reap.js";
import { RESUME_HELP, resumeCommand } from "./commands/resume.js";
import { RUN_HELP, runCommand } from "./commands/run.js";
import { START_HELP, startCommand } from "./commands/start.js";
import { WATCH_HELP, watchCommand } from "./commands/watch.js";
import { type CliContext, defaultUser, type Prompt } from "./context.js";
import { EXIT } from "./exit.js";

export type { CliContext, CoreApi } from "./context.js";
export { EXIT, type ExitCode } from "./exit.js";

export const COMMANDS = [
  "init",
  "doctor",
  "run",
  "resume",
  "watch",
  "cancel",
  "reap",
  "answer",
  "images",
  "start",
  "journal",
] as const;
export type CommandName = (typeof COMMANDS)[number];

const HANDLERS: Record<CommandName, { run: (ctx: CliContext, argv: string[]) => Promise<number>; help: string }> = {
  init: { run: initCommand, help: INIT_HELP },
  doctor: { run: doctorCommand, help: DOCTOR_HELP },
  run: { run: runCommand, help: RUN_HELP },
  resume: { run: resumeCommand, help: RESUME_HELP },
  watch: { run: watchCommand, help: WATCH_HELP },
  cancel: { run: cancelCommand, help: CANCEL_HELP },
  reap: { run: reapCommand, help: REAP_HELP },
  answer: { run: answerCommand, help: ANSWER_HELP },
  images: { run: imagesCommand, help: IMAGES_HELP },
  start: { run: startCommand, help: START_HELP },
  journal: { run: journalCommand, help: JOURNAL_HELP },
};

const USAGE = `Usage: selfbuilding <command> [options]

Commands:
  init                      Scaffold a config, an example factory and .env.example
  doctor                    Check the config and every credential; list everything missing at once
  run <file>                Start a run of a factory file
  resume <runId>            Resume a run from its journal
  watch <runId>             Tail a run's events
  cancel <runId>            Cancel a run and kill its sandboxes
  reap                      Sweep leaked sandboxes and overdue asks
  answer <runId> [<ask>]    Answer an ask without a channel
  images build              Build provider images or templates per harness and size
  start <script>            Start a workflow script and follow it
  journal import <dir> <db> Copy a file journal into a SQLite journal file

Run selfbuilding <command> --help for a command's options.

Exit codes: 0 ok, 1 failed, 2 usage or config error, 3 partial, 4 budget exhausted,
5 needs attention, 6 waiting on an ask, 7 aborted, 130 interrupted.
`;

function ttyPrompt(ctx: Pick<CliContext, "stdin" | "stderr">): Prompt {
  return async (question, choices) => {
    const rl = createInterface({ input: ctx.stdin, output: ctx.stderr as NodeJS.WritableStream });
    try {
      for (;;) {
        const raw = (await rl.question(`${question} (${choices.join(" / ")}) [${choices[0]}] `)).trim();
        const answer = raw === "" ? (choices[0] as string) : raw;
        const byNumber = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
        const picked = byNumber ?? choices.find((c) => c === answer);
        if (picked) return picked;
        ctx.stderr.write(`Pick one of: ${choices.join(", ")}\n`);
      }
    } finally {
      rl.close();
    }
  };
}

export function defaultContext(overrides: Partial<CliContext> = {}): CliContext {
  const base = {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    stdin: overrides.stdin ?? process.stdin,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    isTTY: overrides.isTTY ?? Boolean((process.stdin as { isTTY?: boolean }).isTTY),
    interrupt: overrides.interrupt ?? new AbortController().signal,
    pollMs: overrides.pollMs ?? 500,
    user: overrides.user ?? defaultUser(),
  };
  return {
    ...base,
    prompt: overrides.prompt ?? ttyPrompt(base),
    ...(overrides.core ? { core: overrides.core } : {}),
  };
}

/** Runs one CLI invocation and resolves its exit code. Never throws for usage, config or run failures. */
export async function main(argv: string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const ctx = defaultContext(overrides);
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    (command ? ctx.stdout : ctx.stderr).write(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === "--version" || command === "-v") {
    ctx.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    ctx.stderr.write(`Unknown command "${command}". Commands: ${COMMANDS.join(", ")}\n`);
    return EXIT.usage;
  }
  const handler = HANDLERS[command as CommandName];
  if (rest.includes("--help") || rest.includes("-h")) {
    ctx.stdout.write(handler.help);
    return EXIT.ok;
  }
  try {
    return await handler.run(ctx, rest);
  } catch (error) {
    return reportError(ctx, error);
  }
}

declare const __SELFBUILDING_VERSION__: string | undefined;
const VERSION = typeof __SELFBUILDING_VERSION__ === "string" ? __SELFBUILDING_VERSION__ : "0.0.0";

function reportError(ctx: CliContext, error: unknown): number {
  const e = error as { kind?: unknown; code?: unknown; message?: unknown; name?: unknown };
  const message = typeof e?.message === "string" ? e.message : String(error);
  // Usage errors (bad flags, bad config, run id conflicts) mean nothing ran. Switch on `kind`, not
  // `instanceof`: the project's copy of @selfbuilding/core may not be ours.
  if (e?.kind === "usage") {
    ctx.stderr.write(`${message}\n`);
    return EXIT.usage;
  }
  const label =
    typeof e?.code === "string"
      ? ` [${e.code}]`
      : typeof e?.name === "string" && e.name !== "Error"
        ? ` [${e.name}]`
        : "";
  ctx.stderr.write(`error${label}: ${message}\n`);
  return EXIT.failed;
}
