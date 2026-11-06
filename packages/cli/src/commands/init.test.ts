import { readdirSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, makeProject, type TestProject } from "../../test/helpers.js";
import { EXIT } from "../exit.js";
import { INIT_CHOICES, type InitAnswers, initFiles } from "../templates.js";
import { detectPackageManager } from "./init.js";

const ALL = [
  "--harness",
  "claude-code",
  "--provider",
  "docker",
  "--host",
  "node",
  "--channel",
  "none",
  "--template",
  "review-pr",
];

let project: TestProject;
beforeEach(() => {
  project = makeProject();
});
afterEach(() => project.cleanup());

function written(): string[] {
  return readdirSync(project.root).filter((f) => f !== ".git" && f !== "node_modules");
}

describe("selfbuilding init", () => {
  it("writes the scaffold from flags", async () => {
    const r = await cli(["init", ...ALL], { cwd: project.root });
    expect(r.code).toBe(EXIT.ok);
    for (const file of [
      "selfbuilding.config.ts",
      "factories/review-pr.ts",
      ".agents/skills/.gitkeep",
      ".env.example",
      ".selfbuilding/.gitignore",
    ]) {
      expect(project.exists(file), file).toBe(true);
    }
    const config = project.read("selfbuilding.config.ts");
    expect(config).toContain('import { claudeCode } from "@selfbuilding/harnesses/claude-code";');
    expect(config).toContain("sandbox: docker(),");
    expect(config).toContain('journal: fileJournal(".selfbuilding/journal")');
    expect(config).toContain('skills: { sources: [{ root: ".agents/skills" }] }');
    expect(project.read("factories/review-pr.ts")).toContain('CodeReview({ target: { kind: "pr", url } })');
    expect(project.read(".selfbuilding/.gitignore")).toBe("journal/\njournal.db*\nartifacts/\nruns/\nevents/\n");
    expect(project.read(".env.example")).toContain("ANTHROPIC_API_KEY=\nCLAUDE_CODE_OAUTH_TOKEN=");
    expect(project.exists("trigger/selfbuilding.ts")).toBe(false);
    expect(r.stderr).toContain("npm i @selfbuilding/core");
    expect(r.stderr).toContain("selfbuilding doctor");
  });

  it("without a terminal, lists every missing flag in one error and writes nothing", async () => {
    const r = await cli(["init", "--harness", "claude-code"], { cwd: project.root });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("--provider, --host, --channel, --template");
    expect(r.stderr).toContain("Nothing was written");
    expect(written()).toEqual([]);
  });

  it("reports every invalid value and every missing flag together", async () => {
    const r = await cli(["init", "--harness", "gpt", "--provider", "vm", "--host", "node"], { cwd: project.root });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('--harness "gpt" is not one of claude-code, codex');
    expect(r.stderr).toContain('--provider "vm" is not one of docker, impello, e2b');
    expect(r.stderr).toContain("--channel, --template");
    expect(written()).toEqual([]);
  });

  it("refuses to overwrite a config without --force, and overwrites with it", async () => {
    project.write("selfbuilding.config.ts", "// mine\n");
    project.write("factories/review-pr.ts", "// my factory\n");
    const refused = await cli(["init", ...ALL], { cwd: project.root });
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("already exists. Pass --force");
    expect(project.read("selfbuilding.config.ts")).toBe("// mine\n");

    const forced = await cli(["init", ...ALL, "--force"], { cwd: project.root });
    expect(forced.code).toBe(EXIT.ok);
    expect(project.read("selfbuilding.config.ts")).toContain("defineConfig");
    expect(project.read("factories/review-pr.ts")).toContain("CodeReview");
  });

  it("keeps existing example files when there is no config yet", async () => {
    project.write("factories/review-pr.ts", "// my factory\n");
    project.write(".env.example", "MINE=\n");
    const r = await cli(["init", ...ALL], { cwd: project.root });
    expect(r.code).toBe(EXIT.ok);
    expect(project.read("factories/review-pr.ts")).toBe("// my factory\n");
    expect(project.read(".env.example")).toBe("MINE=\n");
    expect(r.stderr).toContain("Kept existing factories/review-pr.ts, .env.example");
  });

  it("asks for missing values on a terminal", async () => {
    const asked: string[] = [];
    const r = await cli(["init", "--harness", "codex", "--provider", "e2b"], {
      cwd: project.root,
      isTTY: true,
      prompt: async (question, choices) => {
        asked.push(question);
        return choices[choices.length - 1] as string;
      },
    });
    expect(r.code).toBe(EXIT.ok);
    expect(asked).toHaveLength(3);
    const config = project.read("selfbuilding.config.ts");
    expect(config).toContain('import { codex } from "@selfbuilding/harnesses/codex";');
    expect(config).toContain('e2b({ apiKey: fromEnv("E2B_API_KEY"), template: "selfbuilding-codex" })');
    expect(config).toContain('deployment: "prod"');
    expect(config).toContain("slack({");
    expect(project.exists("trigger/selfbuilding.ts")).toBe(true);
    expect(project.read(".env.example")).toContain("SLACK_BOT_TOKEN=");
  });

  it("scaffolds a forked, cross-provider review with its second provider swept by reap", async () => {
    const r = await cli(
      [
        "init",
        "--harness",
        "claude-code",
        "--provider",
        "impello",
        "--host",
        "node",
        "--channel",
        "none",
        "--template",
        "fork-review",
        "--review-provider",
        "e2b",
      ],
      { cwd: project.root },
    );
    expect(r.code).toBe(EXIT.ok);
    const config = project.read("selfbuilding.config.ts");
    expect(config).toContain("export const secondReviewer = codex(");
    expect(config).toContain(
      'export const reviewSandbox = e2b({ apiKey: fromEnv("E2B_API_KEY"), template: "selfbuilding-codex" })',
    );
    expect(config).toContain("export const providers = [reviewSandbox];");
    const factory = project.read("factories/review-pr.ts");
    expect(factory).toContain("checkout.fork(1)");
    expect(factory).toContain("parallel({");
    expect(factory).toContain("harness: secondReviewer");
    expect(project.read(".env.example")).toMatch(/E2B_API_KEY=\nIMPELLO_API_KEY=\nOPENAI_API_KEY=/);
    expect(r.stderr).toContain("@selfbuilding/sandbox-e2b");
  });

  it("rejects --review-provider without the fork-review template", async () => {
    const r = await cli(["init", ...ALL, "--review-provider", "e2b"], { cwd: project.root });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("--review-provider only applies to --template fork-review");
    expect(written()).toEqual([]);
  });

  it("names the package manager the project uses", async () => {
    project.write("pnpm-lock.yaml", "");
    expect(detectPackageManager(project.root)).toBe("pnpm");
    project.write("package.json", JSON.stringify({ packageManager: "yarn@4.0.0" }));
    expect(detectPackageManager(project.root)).toBe("yarn");
    const r = await cli(["init", ...ALL], { cwd: project.root });
    expect(r.stderr).toContain("yarn add -D selfbuilding");
  });
});

describe("init templates", () => {
  // Every combination must at least parse as TypeScript; the adapters they import are typed elsewhere.
  const combos: InitAnswers[] = [];
  for (const harness of INIT_CHOICES.harness)
    for (const provider of INIT_CHOICES.provider)
      for (const host of INIT_CHOICES.host)
        for (const channel of INIT_CHOICES.channel)
          for (const template of INIT_CHOICES.template) combos.push({ harness, provider, host, channel, template });

  it.each(combos.map((c) => [Object.values(c).join("/"), c] as const))("%s parses", (_name, answers) => {
    for (const file of initFiles(answers)) {
      if (!file.path.endsWith(".ts")) continue;
      const out = ts.transpileModule(file.content, {
        fileName: file.path,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      expect(out.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) ?? []).toEqual([]);
    }
  });

  it("lists only fromEnv names in .env.example, never values", () => {
    const files = initFiles({
      harness: "codex",
      provider: "impello",
      host: "node",
      channel: "slack",
      template: "review-pr",
    });
    const env = files.find((f) => f.path === ".env.example")?.content ?? "";
    const vars = env.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(vars).toEqual(["IMPELLO_API_KEY=", "OPENAI_API_KEY=", "SLACK_BOT_TOKEN=", "SLACK_SIGNING_SECRET="]);
  });
});
