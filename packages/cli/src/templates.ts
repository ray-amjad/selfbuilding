// What `selfbuilding init` writes (spec §1.8). Pure: answers in, file contents out.

export const INIT_CHOICES = {
  harness: ["claude-code", "codex"],
  provider: ["docker", "impello", "e2b"],
  host: ["node", "trigger"],
  channel: ["none", "slack"],
  template: ["review-pr", "fork-review"],
} as const;

export type InitQuestion = keyof typeof INIT_CHOICES;
export type HarnessChoice = (typeof INIT_CHOICES.harness)[number];
export type ProviderChoice = (typeof INIT_CHOICES.provider)[number];

export interface InitAnswers {
  harness: HarnessChoice;
  provider: ProviderChoice;
  host: (typeof INIT_CHOICES.host)[number];
  channel: (typeof INIT_CHOICES.channel)[number];
  /**
   * `review-pr`: one reviewer on a fresh sandbox. `fork-review`: two reviewers in parallel on different
   * harnesses, one on a fork of a checked-out sandbox and one on a fresh sandbox from `reviewProvider`.
   */
  template: (typeof INIT_CHOICES.template)[number];
  /** fork-review only: where the second reviewer runs. Defaults to `provider`. */
  reviewProvider?: ProviderChoice;
}

export const INIT_QUESTIONS: Record<InitQuestion, string> = {
  harness: "Which coding agent runs your agents?",
  provider: "Where do sandboxes run?",
  host: "Which host runs your factories?",
  channel: "Where should agents ask a human?",
  template: "Which example factory?",
};

export interface InitFile {
  path: string;
  content: string;
  /** The config file is the one `--force` guards; the rest are kept when they exist. */
  guarded?: boolean;
}

interface Imports {
  lines: Map<string, Set<string>>;
}

function importsOf(): Imports {
  return { lines: new Map() };
}

function use(imports: Imports, from: string, ...names: string[]): void {
  const set = imports.lines.get(from) ?? new Set<string>();
  for (const name of names) set.add(name);
  imports.lines.set(from, set);
}

function render(imports: Imports): string {
  const order = [...imports.lines.keys()].sort((a, b) =>
    a.startsWith("node:") === b.startsWith("node:") ? a.localeCompare(b) : a.startsWith("node:") ? -1 : 1,
  );
  return order
    .map((from) => `import { ${[...(imports.lines.get(from) ?? [])].sort().join(", ")} } from "${from}";`)
    .join("\n");
}

const HARNESS_FN: Record<HarnessChoice, { fn: string; module: string }> = {
  "claude-code": { fn: "claudeCode", module: "@selfbuilding/harnesses/claude-code" },
  codex: { fn: "codex", module: "@selfbuilding/harnesses/codex" },
};

const PROVIDER_FN: Record<ProviderChoice, { fn: string; module: string; env?: string }> = {
  docker: { fn: "docker", module: "@selfbuilding/sandbox-docker" },
  impello: { fn: "impello", module: "@selfbuilding/sandbox-impello", env: "IMPELLO_API_KEY" },
  e2b: { fn: "e2b", module: "@selfbuilding/sandbox-e2b", env: "E2B_API_KEY" },
};

function otherHarness(h: HarnessChoice): HarnessChoice {
  return h === "claude-code" ? "codex" : "claude-code";
}

/** Subscription login first, API key as the fallback (BASIC-SCOPE: credentials). */
function harnessExpr(h: HarnessChoice, imports: Imports, env: Set<string>): string {
  const { fn, module } = HARNESS_FN[h];
  use(imports, module, fn);
  if (h === "claude-code") {
    use(imports, "@selfbuilding/core", "fromEnv");
    env.add("CLAUDE_CODE_OAUTH_TOKEN");
    env.add("ANTHROPIC_API_KEY");
    return `${fn}({
    credentials: [
      { kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") },
      { kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") },
    ],
  })`;
  }
  use(imports, "@selfbuilding/core", "fromEnv", "fromFile");
  use(imports, "node:os", "homedir");
  use(imports, "node:path", "join");
  env.add("OPENAI_API_KEY");
  return `${fn}({
    credentials: [
      { kind: "auth-file", value: fromFile(join(homedir(), ".codex", "auth.json")), leased: true },
      { kind: "api-key", value: fromEnv("OPENAI_API_KEY") },
    ],
  })`;
}

function providerExpr(p: ProviderChoice, harness: HarnessChoice, imports: Imports, env: Set<string>): string {
  const { fn, module, env: key } = PROVIDER_FN[p];
  use(imports, module, fn);
  if (!key) return `${fn}()`;
  use(imports, "@selfbuilding/core", "fromEnv");
  env.add(key);
  return `${fn}({ apiKey: fromEnv("${key}"), template: "selfbuilding-${harness}" })`;
}

export function configFile(a: InitAnswers, env: Set<string>): string {
  const imports = importsOf();
  use(imports, "@selfbuilding/core", "defineConfig", "fileJournal");
  const harness = harnessExpr(a.harness, imports, env);
  const sandbox = providerExpr(a.provider, a.harness, imports, env);

  const named: string[] = [];
  if (a.template === "fork-review") {
    const second = otherHarness(a.harness);
    const reviewProvider = a.reviewProvider ?? a.provider;
    named.push(
      `// The second reviewer: another harness, on a fresh sandbox from its own provider.
export const secondReviewer = ${harnessExpr(second, imports, env)};

export const reviewSandbox = ${providerExpr(reviewProvider, second, imports, env)};

// selfbuilding reap and cancel sweep these as well as \`sandbox\`.
export const providers = [reviewSandbox];`,
    );
  }

  const keys = [
    ...(a.host === "trigger" ? [`  deployment: "prod",`] : []),
    `  harness: ${harness},`,
    `  sandbox: ${sandbox},`,
    `  journal: fileJournal(".selfbuilding/journal"),`,
    `  // Several processes on one machine? journal: sqliteJournal(".selfbuilding/journal.db")`,
    `  budget: { usd: 20, wallClock: "2h" },`,
    `  concurrency: { sandboxes: 4 },`,
    `  skills: { sources: [{ root: ".agents/skills" }] },`,
  ];
  if (a.channel === "slack") {
    use(imports, "@selfbuilding/channel-slack", "slack");
    use(imports, "@selfbuilding/core", "fromEnv");
    env.add("SLACK_BOT_TOKEN");
    env.add("SLACK_SIGNING_SECRET");
    keys.push(`  hitl: {
    channels: [
      slack({
        channel: "#factory",
        botToken: fromEnv("SLACK_BOT_TOKEN"),
        signingSecret: fromEnv("SLACK_SIGNING_SECRET"),
      }),
    ],
  },`);
  }
  return `${render(imports)}

${named.length > 0 ? `${named.join("\n\n")}\n\n` : ""}export default defineConfig({
${keys.join("\n")}
});
`;
}

export function factoryFile(a: InitAnswers): string {
  if (a.template === "review-pr") {
    return `import { CodeReview } from "@selfbuilding/agents";
import { factory } from "@selfbuilding/core";
import { z } from "zod";

export default factory(
  { name: "review-pr", input: z.object({ url: z.url() }) },
  async ({ url }) => {
    const review = await CodeReview({ target: { kind: "pr", url } });
    return review.result;
  },
);
`;
  }
  return `import { CodeReview } from "@selfbuilding/agents";
import { factory, parallel, sandbox } from "@selfbuilding/core";
import { z } from "zod";
import { reviewSandbox, secondReviewer } from "../selfbuilding.config";

// Two independent reviews of one pull request, side by side: one on a fork of a sandbox that already has
// the repo checked out, one on another harness in a fresh sandbox from a second provider.
export default factory(
  { name: "review-pr", input: z.object({ url: z.url() }) },
  async ({ url }) => {
    const repo = repoOf(url);
    await using checkout = sandbox({ repo, label: "checkout" });
    const [fork] = await checkout.fork(1);

    const target = { kind: "pr" as const, url };
    const reviews = await parallel({
      onFork: () => CodeReview({ target }, { sandbox: fork ?? "fresh" }),
      onSecondProvider: () =>
        CodeReview({ target }, { sandbox: reviewSandbox, harness: secondReviewer }),
    });
    return reviews;
  },
);

function repoOf(url: string): string {
  const { host, pathname } = new URL(url);
  const [owner, name] = pathname.split("/").filter(Boolean);
  return \`\${host}/\${owner}/\${name}\`;
}
`;
}

export function triggerFile(): string {
  return `import { createTriggerHost } from "@selfbuilding/host-trigger";
import reviewPr from "../factories/review-pr";
import config from "../selfbuilding.config";

export const { factoryTask, agentTask, reaperTask } = createTriggerHost({
  config,
  factories: { reviewPr },
});
`;
}

export function envExample(env: Set<string>): string {
  const lines = [
    "# Variables selfbuilding.config.ts reads with fromEnv(). Copy to .env and fill in; never commit .env.",
    "# Run `selfbuilding doctor --env-file .env` to check them.",
    ...[...env].sort().map((name) => `${name}=`),
  ];
  return `${lines.join("\n")}\n`;
}

export const SELFBUILDING_GITIGNORE = `journal/
journal.db*
artifacts/
runs/
events/
`;

export function initFiles(a: InitAnswers): InitFile[] {
  const env = new Set<string>();
  const files: InitFile[] = [
    { path: "selfbuilding.config.ts", content: configFile(a, env), guarded: true },
    { path: "factories/review-pr.ts", content: factoryFile(a) },
    { path: ".agents/skills/.gitkeep", content: "" },
    { path: ".selfbuilding/.gitignore", content: SELFBUILDING_GITIGNORE },
  ];
  if (a.host === "trigger") files.push({ path: "trigger/selfbuilding.ts", content: triggerFile() });
  files.push({ path: ".env.example", content: envExample(env) });
  return files;
}

/** The packages the generated files import, for the next-steps hint. */
export function packagesFor(a: InitAnswers): string[] {
  const pkgs = new Set(["@selfbuilding/core", "@selfbuilding/agents", "@selfbuilding/harnesses", "zod"]);
  pkgs.add(PROVIDER_FN[a.provider].module);
  if (a.template === "fork-review") pkgs.add(PROVIDER_FN[a.reviewProvider ?? a.provider].module);
  if (a.channel === "slack") pkgs.add("@selfbuilding/channel-slack");
  if (a.host === "trigger") pkgs.add("@selfbuilding/host-trigger");
  return [...pkgs];
}
