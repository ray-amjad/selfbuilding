// Live 9 (docs/spec/demo-path.md §4.2): Verify on the playground's Next.js Notes app with real Codex, a real browser
// and a real database. On `main`, "add a note" is verified; on the planted-bug branch the page still shows the note
// but no row is stored, so the checker must return broken. Runs once per configured provider.
import path from "node:path";
import { Verify, VerifyResult, verifyFlowPaths } from "@selfbuilding/agents";
import { factory, fileArtifacts, fileJournal, run } from "@selfbuilding/core";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  budget,
  github,
  githubSkip,
  harnesses,
  liveRunId,
  needs,
  PLAYGROUND,
  recorder,
  tempDir,
  useBuiltRuntime,
} from "./support/live.js";
import {
  VERIFY_SIZE,
  verifyProvider,
  verifyTargets,
  WEB_BROKEN_BRANCH,
  WEB_MAIN_BRANCH,
} from "./support/verify-agent.js";

const ADD_A_NOTE = {
  name: "add a note",
  endState:
    'After the "Add note" form is submitted with a title, the page shows the flash "Note added" and the note first in the list, and the note is still listed after a reload.',
  rows: ["notes: one new row with the submitted title and done = 0"],
};

const VerifyWeb = factory(
  { name: "verify-web", input: z.object({ repo: z.string(), branch: z.string() }) },
  async ({ repo, branch }) => {
    const v = await Verify(
      {
        change: "The Notes app's add-a-note form: a note added from the form is listed and stored.",
        flows: [ADD_A_NOTE],
      },
      {
        repo,
        git: { baseBranch: branch },
        label: "verify",
        harness: harnesses.codex.make(),
        ...(VERIFY_SIZE ? { size: VERIFY_SIZE } : {}),
      },
    );
    return { result: v.result, files: v.artifacts.files.map((f) => f.path) };
  },
);

beforeAll(() => useBuiltRuntime());

describe("live 9: Verify on the playground web app", () => {
  for (const t of verifyTargets) {
    for (const [branch, expected] of [
      [WEB_MAIN_BRANCH, "verified"],
      [WEB_BROKEN_BRANCH, "broken"],
    ] as const) {
      const skip = needs(t.skip, githubSkip);
      it.skipIf(skip !== "")(
        `${t.name}: ${branch} → ${expected}${skip ? ` (skipped: ${skip})` : ""}`,
        async () => {
          const dir = await tempDir("sbl-verify-web-");
          const events = recorder();
          const out = await run(
            VerifyWeb,
            { repo: PLAYGROUND, branch },
            {
              runId: liveRunId(`verify_${t.provider}_${expected}`),
              config: {
                deployment: "live",
                sandbox: verifyProvider(t.provider),
                harness: harnesses.codex.make(),
                git: github(),
                budget: budget(),
                artifacts: fileArtifacts(path.join(dir, "artifacts")),
              },
              journal: fileJournal(path.join(dir, "journal")),
              events: [events.sink],
            },
          );
          expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
          const result = VerifyResult.parse((out.output as { result: unknown }).result);
          const flow = result.flows.find((f) => f.name === ADD_A_NOTE.name);
          expect(flow, result.summary).toBeDefined();
          expect(flow?.outcome, flow?.detail).toBe(expected);

          // The evidence layout: the flow's evidence.md, its screenshots, the checker's database read and verdict.
          const paths = verifyFlowPaths(ADD_A_NOTE.name);
          expect(flow?.evidence).toBe(paths.evidence);
          const extra = flow?.evidenceFiles ?? [];
          expect(extra.some((f) => f.startsWith(`${paths.screenshots}/`) && f.endsWith(".png"))).toBe(true);
          expect(extra).toEqual(expect.arrayContaining([paths.setup, paths.claim, paths.verdict, paths.db]));
          // On the planted bug the page looks right, so the verifier's claim may be verified; the checker lowers it.
          if (expected === "broken") expect(["verified", "broken"]).toContain(flow?.claim);
        },
        45 * 60_000,
      );
    }
  }
});
