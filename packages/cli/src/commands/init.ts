import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { CONFIG_FILE_NAMES } from "../project.js";
import {
  INIT_CHOICES,
  INIT_QUESTIONS,
  type InitAnswers,
  type InitQuestion,
  initFiles,
  type ProviderChoice,
  packagesFor,
} from "../templates.js";

export const INIT_HELP = `Usage: selfbuilding init [options]

Scaffolds selfbuilding.config.ts, factories/review-pr.ts, .agents/skills/, .env.example and
.selfbuilding/.gitignore in the current directory. Asks for any value not given as a flag; when stdin
is not a terminal, every flag is required and all of them are checked before anything is written.

Options:
  --harness <id>          ${INIT_CHOICES.harness.join(" | ")}
  --provider <id>         ${INIT_CHOICES.provider.join(" | ")}
  --host <id>             ${INIT_CHOICES.host.join(" | ")}
  --channel <id>          ${INIT_CHOICES.channel.join(" | ")}
  --template <id>         review-pr: one reviewer on a fresh sandbox
                          fork-review: two reviewers in parallel on different harnesses, one on a fork
                          of a checked-out sandbox and one on a sandbox from --review-provider
  --review-provider <id>  fork-review only: where the second reviewer runs (default: --provider)
  --force                 Overwrite an existing config and the example files
`;

const QUESTIONS = Object.keys(INIT_CHOICES) as InitQuestion[];

export async function initCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "init",
    argv,
    {
      harness: { type: "string" },
      provider: { type: "string" },
      host: { type: "string" },
      channel: { type: "string" },
      template: { type: "string" },
      "review-provider": { type: "string" },
      force: { type: "boolean" },
    },
    { min: 0, max: 0 },
  );
  const force = args.bool("force");
  const existing = CONFIG_FILE_NAMES.filter((name) => existsSync(path.join(ctx.cwd, name)));
  if (existing.length > 0 && !force) {
    ctx.stderr.write(`${existing.join(", ")} already exists. Pass --force to overwrite it.\n`);
    return EXIT.usage;
  }

  // Check every flag before asking or writing anything, and report every problem in one error.
  const problems: string[] = [];
  const given: Partial<Record<InitQuestion, string>> = {};
  for (const q of QUESTIONS) {
    const value = args.str(q);
    if (value === undefined) continue;
    if (!(INIT_CHOICES[q] as readonly string[]).includes(value)) {
      problems.push(`--${q} "${value}" is not one of ${INIT_CHOICES[q].join(", ")}`);
    } else given[q] = value;
  }
  const reviewProvider = args.str("review-provider");
  if (reviewProvider !== undefined && !(INIT_CHOICES.provider as readonly string[]).includes(reviewProvider)) {
    problems.push(`--review-provider "${reviewProvider}" is not one of ${INIT_CHOICES.provider.join(", ")}`);
  }
  if (reviewProvider !== undefined && given.template !== undefined && given.template !== "fork-review") {
    problems.push("--review-provider only applies to --template fork-review");
  }
  const missing = QUESTIONS.filter((q) => given[q] === undefined && args.str(q) === undefined);
  if (!ctx.isTTY && missing.length > 0) {
    problems.push(`stdin is not a terminal, so these flags are required: ${missing.map((q) => `--${q}`).join(", ")}`);
  }
  if (problems.length > 0) {
    throw new ConfigError(`selfbuilding init: ${problems.join("; ")}. Nothing was written.`);
  }

  for (const q of missing) {
    const answer = await ctx.prompt(INIT_QUESTIONS[q], INIT_CHOICES[q]);
    if (!(INIT_CHOICES[q] as readonly string[]).includes(answer)) {
      throw new ConfigError(`"${answer}" is not one of ${INIT_CHOICES[q].join(", ")}. Nothing was written.`);
    }
    given[q] = answer;
  }
  if (reviewProvider !== undefined && given.template !== "fork-review") {
    throw new ConfigError("--review-provider only applies to the fork-review template. Nothing was written.");
  }
  const answers = {
    ...given,
    ...(reviewProvider ? { reviewProvider: reviewProvider as ProviderChoice } : {}),
  } as InitAnswers;

  const written: string[] = [];
  const kept: string[] = [];
  for (const file of initFiles(answers)) {
    const target = path.join(ctx.cwd, file.path);
    if (existsSync(target) && !force && !file.guarded) {
      kept.push(file.path);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    written.push(file.path);
  }
  // A forced re-init with a different extension would leave two config files, which is a ConfigError.
  for (const stale of existing) {
    if (stale !== "selfbuilding.config.ts") {
      ctx.stderr.write(`warn: remove ${stale}; selfbuilding.config.ts replaces it.\n`);
    }
  }

  const pm = detectPackageManager(ctx.cwd);
  const add = pm === "npm" ? "npm i" : `${pm} add`;
  const lines = [
    `Wrote ${written.join(", ")}.`,
    ...(kept.length > 0 ? [`Kept existing ${kept.join(", ")} (use --force to overwrite).`] : []),
    "",
    "Next:",
    `  ${add} ${packagesFor(answers).join(" ")}`,
    `  ${add} -D selfbuilding`,
    "  cp .env.example .env    # then fill in the values",
    "  npx selfbuilding doctor --env-file .env",
    `  npx selfbuilding run factories/review-pr.ts --env-file .env --input '{"url":"https://github.com/<owner>/<repo>/pull/<n>"}'`,
  ];
  ctx.stderr.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
}

/** From `packageManager` in package.json, else the lockfile, else npm. */
export function detectPackageManager(dir: string): "pnpm" | "yarn" | "bun" | "npm" {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { packageManager?: unknown };
    if (typeof pkg.packageManager === "string") {
      const name = pkg.packageManager.split("@")[0];
      if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") return name;
    }
  } catch {
    // No package.json, or not JSON: fall through to the lockfiles.
  }
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}
