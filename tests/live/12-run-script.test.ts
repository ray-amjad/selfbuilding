// Live 12 (docs/spec/demo-path.md §8): a workflow script, run by the deployed `run-script` factory, drives a real
// harness in a real sandbox. Two inline agents read the playground on a shared box and on a fork in parallel; the
// script combines their answers. Running the same run id again replays every call from the journal.
import path from "node:path";
import { fileArtifacts, fileJournal, run } from "@selfbuilding/core";
import { createScriptFactory } from "@selfbuilding/script";
import { beforeAll, describe, expect, it } from "vitest";
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
  targets,
  tempDir,
  useBuiltRuntime,
} from "./support/live.js";

beforeAll(() => useBuiltRuntime());

const WORKFLOW = `export default async function main(input, sb) {
  const output = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
  };
  sb.phase("read");
  const box = sb.sandbox({ label: "read", repo: input.repo });
  // Concurrent calls each get their own fork: a shared handle is refused inside a parallel() child.
  const [fork, other] = await box.fork(2);
  const [readme, math] = await sb.parallel([
    () => sb.agent({ name: "Readme", prompt: "Read README.md and answer with its first heading, without the leading #.", output }, { sandbox: other, harness: input.harness, label: "readme" }),
    () => sb.agent({ name: "Math", prompt: "Read src/math.js and answer with the name of the first exported function.", output }, { sandbox: fork, harness: input.harness, label: "math" }),
  ]);
  await fork.dispose();
  await other.dispose();
  const id = sb.uuid();
  return { readme: readme ? readme.result.answer : null, math: math ? math.result.answer : null, id, replayed: [readme && readme.replayed, math && math.replayed] };
}`;

describe("live 12: run-script", () => {
  for (const t of targets) {
    const skip = needs(t.skip, githubSkip);
    it.skipIf(skip !== "")(`${t.name}${skip ? ` (skipped: ${skip})` : ""}`, async () => {
      const dir = await tempDir("sbl-script-");
      const runId = liveRunId("script");
      const f = createScriptFactory({
        agents: {},
        harnesses: { [t.harness]: harnesses[t.harness].make() },
        caps: { maxAgentCalls: 4, maxSandboxes: 3, budgetUsd: budget().usd ?? 5, wallClock: "45m" },
      });
      const go = async () => {
        const events = recorder();
        const out = await run(
          f,
          { source: WORKFLOW, name: "live-read", input: { repo: PLAYGROUND, harness: t.harness } },
          {
            runId,
            config: {
              deployment: "live",
              sandbox: providers[t.provider].make(t.harness),
              harness: harnesses[t.harness].make(),
              git: github(),
              budget: budget(),
              artifacts: fileArtifacts(path.join(dir, "artifacts")),
            },
            journal: fileJournal(path.join(dir, "journal")),
            events: [events.sink],
          },
        );
        return { out, events };
      };

      const first = await go();
      expect(first.out.status, JSON.stringify(first.events.of("error").map((e) => e.data))).toBe("ok");
      const o = first.out.output as { readme: string; math: string; id: string; replayed: boolean[] };
      expect(o.readme.toLowerCase()).toContain("playground");
      expect(o.math).toContain("add");
      expect(o.replayed).toEqual([false, false]);
      expect(first.events.launched().sort()).toEqual(["parallel#0/[0]/readme", "parallel#0/[1]/math"]);

      const second = await go();
      expect(second.out.status).toBe("ok");
      expect(second.events.launched()).toEqual([]);
      expect(second.out.output).toEqual({ ...o, replayed: [true, true] });
    });
  }
});
