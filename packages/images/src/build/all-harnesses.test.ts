import type { ImageBuilder, ImageBuildResult, ProviderSizing } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import {
  buildSizeTable,
  IMAGE_HARNESSES,
  planImageBuilds,
  resolveBuildSizes,
  runImageBuilds,
  sizesHint,
} from "./index.js";

// The combined template in the build loop (docs/spec/release-prep.md §4.3).

const [small, medium, huge] = resolveBuildSizes(buildSizeTable({ huge: { vcpu: 64, memoryMiB: 262144 } }), [
  "small",
  "medium",
  "huge",
]) as [
  ReturnType<typeof resolveBuildSizes>[number],
  ReturnType<typeof resolveBuildSizes>[number],
  ReturnType<typeof resolveBuildSizes>[number],
];

const sizing: ProviderSizing = {
  kind: "template",
  forkSize: "inherit",
  resize: false,
  available: [],
  limits: { maxVcpu: 8 },
  templateFor: (b, s) => (s === "small" ? b : `${b}-${s}`),
};

const builder: ImageBuilder = {
  provider: "e2b",
  sizing,
  nameFor: (harness, size) => `selfbuilding-${harness}${size === "small" ? "" : `-${size}`}`,
  async build(req) {
    return { ok: true, provider: "e2b", harness: req.harness, size: req.size.name, name: req.name, durationMs: 1 };
  },
};

const ok = (harness: ImageBuildResult["harness"], size: string): ImageBuildResult => ({
  ok: true,
  provider: "e2b",
  harness,
  size,
  name: `selfbuilding-${harness}`,
  durationMs: 1,
});

describe("all-harnesses builds", () => {
  it("keeps IMAGE_HARNESSES to the two harnesses: all means each one separately", () => {
    expect(IMAGE_HARNESSES).toEqual(["claude-code", "codex"]);
  });

  it("names the combined template in the sizes hint", () => {
    expect(sizesHint("e2b", [ok("all-harnesses", "small")])).toBe(
      'Use template: "selfbuilding-all-harnesses" in e2b({ template }).',
    );
    expect(sizesHint("e2b", [ok("all-harnesses", "small"), ok("all-harnesses", "medium")])).toBe(
      'Add "medium" to e2b({ sizes }) and use template: "selfbuilding-all-harnesses".',
    );
    expect(sizesHint("e2b", [ok("codex", "medium")])).toBe('Add "medium" to e2b({ sizes }).');
    expect(sizesHint("e2b", [ok("codex", "small")])).toBeNull();
  });

  it("calls onStart before each triple it builds, not for refused ones", async () => {
    const started: string[] = [];
    const plan = planImageBuilds([builder], ["all-harnesses"], [small, medium, huge]);
    expect(plan.map((p) => p.name)).toEqual([
      "selfbuilding-all-harnesses",
      "selfbuilding-all-harnesses-medium",
      "selfbuilding-all-harnesses-huge",
    ]);
    for (const dryRun of [false, true]) {
      started.length = 0;
      const results = await runImageBuilds({ plan, version: "1", dryRun, onStart: (p) => started.push(p.name) });
      expect(results.map((r) => r.ok)).toEqual([true, true, false]);
      expect(started).toEqual(["selfbuilding-all-harnesses", "selfbuilding-all-harnesses-medium"]);
    }
  });
});
