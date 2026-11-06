// The main example in docs/guides/writing-a-workflow-script.md runs as written, offline: fake agents, the tmpdir
// provider and the default two-sandbox cap `selfbuilding start` gives a script.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "@selfbuilding/core";
import { createLocalRemote, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeAgents, runSource, tempDir } from "../test/kit.js";

const GUIDE = fileURLToPath(new URL("../../../docs/guides/writing-a-workflow-script.md", import.meta.url));

let dir: string;
let boxes: TmpdirProvider;
let repo: string;
let source: string;

beforeAll(async () => {
  dir = await tempDir("sbs-guide-");
  boxes = tmpdirProvider({ root: path.join(dir, "boxes") });
  repo = `file://${(await createLocalRemote(dir, { files: { "README.md": "# playground\n" } })).bareDir}`;
  const text = await fs.readFile(GUIDE, "utf8");
  const block = /```js\n(\/\/ review-and-verify\.mjs\n[\s\S]*?)```/.exec(text)?.[1];
  if (!block) throw new Error("the guide's review-and-verify.mjs example is missing");
  source = block;
});

afterAll(async () => {
  await boxes.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const harnesses = { "claude-code": {}, codex: {} } as unknown as Record<string, Harness>;

function agents(flows: number, findFails = false) {
  return fakeAgents({
    ImplementSpec: { produce: () => ({ status: "done", summary: "added a" }) },
    CodeReview: { produce: () => ({ verdict: "approve", findings: [] }) },
    FindFlows: findFails
      ? { fail: true }
      : { produce: () => ({ flows: Array.from({ length: flows }, (_, i) => ({ name: `flow ${i}` })) }) },
    Verify: {
      produce: (input) => ({ flows: [{ outcome: `ok ${(input as { flows: { name: string }[] }).flows[0]?.name}` }] }),
    },
  });
}

describe("the writing-a-workflow-script guide's example", () => {
  for (const [label, flows, findFails, expected] of [
    ["several flows", 4, false, ["ok flow 0", "ok flow 1", "ok flow 2", "ok flow 3"]],
    ["no flows", 0, false, []],
    ["FindFlows failing", 0, true, []],
  ] as const) {
    it(`runs within two sandboxes with ${label}`, async () => {
      const fakes = agents(flows, findFails);
      const out = await runSource(source, {
        dir,
        input: { repo, spec: "add a" },
        caps: { maxSandboxes: 2, allowedSizes: ["small", "medium"] },
        config: { sandbox: boxes },
        script: { agents: fakes.agents, harnesses },
      });
      // A failed sb.parallel item is null in the output and makes the run partial, not failed.
      expect(out.status).toBe(findFails ? "partial" : "ok");
      expect(out.output).toEqual({ review: "approve", flows: expected });
    });
  }
});
