import { z } from "zod";

/** The default input when a skill has no contract (spec §2.4.4). */
export const DefaultInput = z.object({
  task: z.string().describe("What to do, in plain language"),
  args: z.string().optional().describe("Free-form arguments, available as $ARGUMENTS"),
  context: z.record(z.string(), z.string()).optional(),
});
export type DefaultInput = z.input<typeof DefaultInput>;

/** The default result when a skill has no contract (spec §2.4.4). */
export const DefaultResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string().min(1).max(4000),
  findings: z
    .array(
      z.object({
        title: z.string(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
      }),
    )
    .optional(),
  nextSteps: z.array(z.string()).optional(),
});
export type DefaultResult = z.infer<typeof DefaultResult>;

/** What a review agent reads (spec §2.4.3). A `pr` target supplies the repo, base and head. */
export const ReviewTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), url: z.url() }),
  z.object({ kind: z.literal("diff"), base: z.string(), head: z.string().optional() }),
]);
export type ReviewTarget = z.infer<typeof ReviewTarget>;

/** Paths restored from the base commit while done checks run (spec §2.7.4). */
export const DEFAULT_PROTECTED: readonly {
  pattern: string;
  restore: "whole-file" | "keys" | "tables";
  keys?: readonly string[];
}[] = [
  { pattern: "**/package.json", restore: "keys", keys: ["scripts", "jest", "vitest", "mocha", "ava"] },
  { pattern: "vitest.config.*", restore: "whole-file" },
  { pattern: "vitest.workspace.*", restore: "whole-file" },
  { pattern: "jest.config.*", restore: "whole-file" },
  { pattern: "playwright.config.*", restore: "whole-file" },
  { pattern: "karma.conf.*", restore: "whole-file" },
  { pattern: ".mocharc*", restore: "whole-file" },
  { pattern: "pytest.ini", restore: "whole-file" },
  { pattern: "tox.ini", restore: "whole-file" },
  { pattern: "conftest.py", restore: "whole-file" },
  { pattern: "pyproject.toml", restore: "tables", keys: ["tool.pytest*"] },
  { pattern: "setup.cfg", restore: "tables", keys: ["tool:pytest"] },
  { pattern: ".selfbuilding/**", restore: "whole-file" },
  { pattern: ".github/workflows/**", restore: "whole-file" },
];
