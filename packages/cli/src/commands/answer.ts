import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type AskAnswer,
  type AskChoice,
  type AskRecord,
  type AskResolution,
  type AskStore,
  ConfigError,
} from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { journalOf, loadProject } from "../project.js";
import { assertRunId, isAlive, readRunRecord } from "../state.js";

export const ANSWER_HELP = `Usage: selfbuilding answer <runId> [<askId|#n> [answer]] [options]

Answers an ask without a channel. With only a run id, lists the run's open asks.
The answer is a choice id (or its label), or free text when the ask allows it.

Options:
  --value <json|@file.json>  The answer for an ask with a form schema
  --config <path>            Config file (default: search upward)
  --env-file <path>          Load a dotenv file before the config is evaluated
  --json                     Print the result as one JSON line on stdout
`;

export async function answerCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "answer",
    argv,
    {
      value: { type: "string" },
      config: { type: "string" },
      "env-file": { type: "string" },
      json: { type: "boolean" },
    },
    { min: 1, max: 3 },
  );
  const [rawRunId, which, text] = args.positionals as [string, string | undefined, string | undefined];
  const runId = assertRunId(rawRunId);
  const json = args.bool("json");
  const project = await loadProject(ctx, {
    config: args.str("config"),
    envFile: args.str("env-file"),
    requireConfig: true,
  });
  const asks = journalOf(project).asks;
  if (!asks) {
    throw new ConfigError("The configured journal has no ask store, so asks cannot be answered from the CLI.");
  }

  if (which === undefined) {
    const open = await openAsks(asks, runId);
    if (json) ctx.stdout.write(`${JSON.stringify(open.map(summary))}\n`);
    else if (open.length === 0) ctx.stderr.write(`Run ${runId} has no open asks.\n`);
    else for (const ask of open) ctx.stderr.write(`${describe(ask)}\n`);
    return EXIT.ok;
  }

  const ask = await findAsk(asks, runId, which);
  if (!ask) {
    ctx.stderr.write(`Run ${runId} has no ask ${which}. List its open asks with selfbuilding answer ${runId}.\n`);
    return EXIT.usage;
  }
  if (ask.status !== "open") {
    ctx.stderr.write(`Ask #${ask.ordinal} is already ${ask.status}${byline(ask)}.\n`);
    return EXIT.failed;
  }
  if (text !== undefined && args.str("value") !== undefined) {
    throw new ConfigError("Pass the answer either as an argument or with --value, not both.");
  }
  const answer = await buildAnswer(ctx, ask, text, args.str("value"));
  const resolution: AskResolution = {
    askId: ask.askId,
    answer,
    choiceId: answer.kind === "choice" ? answer.choiceId : null,
    answeredBy: { kind: "human", channel: "cli", userId: ctx.user.id, displayName: ctx.user.name },
    answeredAt: new Date().toISOString(),
  };
  const result = await asks.resolve(ask.askId, resolution);
  if (!result.won) {
    ctx.stderr.write(`Ask #${ask.ordinal} was answered first by someone else${byline(result.current)}.\n`);
    return EXIT.failed;
  }

  const record = readRunRecord(project.paths, runId);
  const live = record?.pid !== undefined && !record.finishedAt && isAlive(record.pid);
  if (json) {
    ctx.stdout.write(`${JSON.stringify({ askId: ask.askId, ordinal: ask.ordinal, answer, resumeNeeded: !live })}\n`);
  } else {
    ctx.stderr.write(`Answered ask #${ask.ordinal}.\n`);
    if (!live) {
      // The answer is in the store; whichever process resumes the run reads it there and resumes the session.
      const parked = ask.cold ? " Its box is parked and the session resumes with this answer." : "";
      ctx.stderr.write(`The run is not running; continue it with selfbuilding resume ${runId}.${parked}\n`);
    }
  }
  return EXIT.ok;
}

async function openAsks(asks: AskStore, runId: string): Promise<AskRecord[]> {
  const out: AskRecord[] = [];
  for await (const ask of asks.open({ runId })) out.push(ask);
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

async function findAsk(asks: AskStore, runId: string, which: string): Promise<AskRecord | null> {
  if (/^#?\d+$/.test(which)) {
    const ordinal = Number(which.replace("#", ""));
    const open = (await openAsks(asks, runId)).find((a) => a.ordinal === ordinal);
    if (open) return open;
    // A bare number may also be a literal ask id.
    if (which.startsWith("#")) return null;
  }
  const record = await asks.get(which);
  return record && record.runId === runId ? record : null;
}

function choicesOf(ask: AskRecord): AskChoice[] {
  return (ask.spec.choices ?? []).map((c) => (typeof c === "string" ? { id: c, label: c } : c));
}

function freeTextAllowed(ask: AskRecord): boolean {
  return ask.spec.freeText ?? choicesOf(ask).length === 0;
}

async function buildAnswer(
  ctx: CliContext,
  ask: AskRecord,
  text: string | undefined,
  value: string | undefined,
): Promise<AskAnswer<unknown>> {
  if (value !== undefined) {
    if (!ask.spec.schema)
      throw new ConfigError(`Ask #${ask.ordinal} has no form schema; answer it with a choice or text.`);
    return { kind: "value", value: await validateValue(ask, parseValue(ctx, value)) };
  }
  const choices = choicesOf(ask);
  if (text === undefined) {
    throw new ConfigError(`Ask #${ask.ordinal} needs an answer. ${options(ask)}`);
  }
  const lower = text.toLowerCase();
  const choice = choices.find((c) => c.id === text) ?? choices.find((c) => c.label.toLowerCase() === lower);
  if (choice) return { kind: "choice", choiceId: choice.id };
  if (ask.spec.schema && !freeTextAllowed(ask)) {
    throw new ConfigError(
      `Ask #${ask.ordinal} takes a form value. Pass it with --value '<json>' or --value @file.json.`,
    );
  }
  if (!freeTextAllowed(ask)) throw new ConfigError(`"${text}" is not a choice of ask #${ask.ordinal}. ${options(ask)}`);
  return { kind: "text", text };
}

function parseValue(ctx: CliContext, raw: string): unknown {
  let text = raw;
  if (raw.startsWith("@")) {
    const file = path.resolve(ctx.cwd, raw.slice(1));
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new ConfigError(`--value ${raw}: no such file (looked for ${file}).`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`--value is not valid JSON: ${(error as Error).message}`);
  }
}

async function validateValue(ask: AskRecord, value: unknown): Promise<unknown> {
  const schema = ask.spec.schema;
  // Ask records read back from a file journal carry the schema as plain data, without a validator.
  if (!schema || typeof schema["~standard"]?.validate !== "function") return value;
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const problems = result.issues.map((i) => `${i.path?.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
    throw new ConfigError(`--value does not fit ask #${ask.ordinal}'s form: ${problems.join("; ")}`);
  }
  return result.value;
}

function options(ask: AskRecord): string {
  const choices = choicesOf(ask);
  const parts = [];
  if (choices.length > 0)
    parts.push(`Choices: ${choices.map((c) => (c.id === c.label ? c.id : `${c.id} (${c.label})`)).join(", ")}`);
  if (freeTextAllowed(ask)) parts.push("or any text");
  if (ask.spec.schema) parts.push("or a form value with --value");
  return `${parts.join(" ")}.`;
}

function byline(ask: AskRecord): string {
  const by = ask.resolution?.answeredBy;
  if (!by) return "";
  if (by.kind === "human") return ` by ${by.displayName} via ${by.channel}`;
  if (by.kind === "default") return ` by its default (${by.reason})`;
  return ` automatically by ${by.model}`;
}

function summary(ask: AskRecord) {
  return {
    askId: ask.askId,
    ordinal: ask.ordinal,
    callPath: ask.callPath,
    question: ask.spec.question,
    choices: choicesOf(ask).map((c) => c.id),
    freeText: freeTextAllowed(ask),
    form: ask.spec.schema !== undefined,
    expiresAt: ask.expiresAt,
    // Set once the ask went cold: the box is parked and the run may have exited (demo-path §6).
    ...(ask.cold ? { parkedSince: ask.cold.since } : {}),
  };
}

function describe(ask: AskRecord): string {
  const parked = ask.cold ? ` (parked since ${ask.cold.since})` : "";
  return `#${ask.ordinal} (${ask.askId}) ${ask.callPath}${parked}\n  ${ask.spec.question.replace(/\n/g, "\n  ")}\n  ${options(ask)}`;
}
