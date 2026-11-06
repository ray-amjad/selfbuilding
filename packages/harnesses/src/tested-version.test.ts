import { describe, expect, it } from "vitest";
import { claudeCode } from "./claude-code/index.js";
import { codex } from "./codex/index.js";

// A box whose image lacks the harness installs `testedVersion` on first use, so every harness must expose one.
describe("tested versions", () => {
  it.each([
    ["claude-code", claudeCode()],
    ["codex", codex()],
  ])("%s exposes an exact testedVersion its install plan accepts", (_id, harness) => {
    expect(harness.testedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(harness.install(harness.testedVersion as string).version).toBe(harness.testedVersion);
  });
});
