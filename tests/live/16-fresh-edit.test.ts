// Live 16: an agent on a fresh box can edit an existing repo file and commit it. Found live: the root runtime's
// clone left every file root-owned, so a fresh-box agent got "Permission denied" (every builder ran on shared boxes).
import path from "node:path";
import { agent, factory, fileArtifacts, run } from "@selfbuilding/core";
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
  providers,
  recorder,
  tempDir,
  useBuiltRuntime,
} from "./support/live.js";

beforeAll(() => useBuiltRuntime());

const skip = needs(
  !providers.impello.ready && providers.impello.skip,
  !harnesses["claude-code"].ready && harnesses["claude-code"].skip,
  githubSkip,
);

describe.skipIf(skip !== "")(`live 16: fresh-box edit${skip ? ` (${skip})` : ""}`, () => {
  it("edits src/math.js and commits", async () => {
    const dir = await tempDir("sbl-fresh-edit-");
    const events = recorder();
    const Out = z.object({ ok: z.boolean(), detail: z.string() });
    const f = factory({ name: "fresh-edit", input: z.object({}) }, async () =>
      agent({
        name: "Edit",
        label: "edit",
        sandbox: "fresh",
        repo: PLAYGROUND,
        output: Out,
        prompt:
          "Append the line `// probe` to the end of src/math.js, then `git add -A && git commit -m probe`. Report ok=true only if both the edit and the commit succeeded; put any error text in detail. Run `ls -l src/math.js; id` and include the output in detail.",
      }),
    );
    const out = await run(
      f,
      {},
      {
        runId: liveRunId("fresh-edit"),
        config: {
          deployment: "live",
          sandbox: providers.impello.make("claude-code"),
          harness: harnesses["claude-code"].make(),
          git: github(),
          budget: budget(),
          artifacts: fileArtifacts(path.join(dir, "artifacts")),
        },
        events: [events.sink],
      },
    );
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    const r = out.output as { result: { ok: boolean; detail: string }; artifacts: { commits?: unknown[] } };
    expect(r.result.ok, r.result.detail).toBe(true);
    expect(r.artifacts.commits?.length ?? 0).toBeGreaterThan(0);
  });
});
