import { loadSkill } from "@selfbuilding/skills";
import { describe, expect, it, vi } from "vitest";

// Agent.fromSkill and the harness factories belong to other packages; the mocks record what this package asks
// of them.
const seen = vi.hoisted(() => ({ fromSkill: [] as { dir: string; contract: Record<string, unknown> }[] }));

vi.mock("@selfbuilding/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@selfbuilding/core")>();
  return {
    ...actual,
    Agent: {
      async fromSkill(dir: string, contract: Record<string, unknown>) {
        seen.fromSkill.push({ dir, contract });
        const skill = await loadSkill(dir, { strict: true, importSidecar: false });
        return Object.assign(async () => ({}), { skill, contract, settled: async () => ({ ok: true }) });
      },
    },
    factory: (opts: { name: string }, body: unknown) => Object.assign(async () => ({}), { options: opts, body }),
  };
});
vi.mock("@selfbuilding/harnesses/claude-code", () => ({ claudeCode: () => ({ id: "claude-code" }) }));
vi.mock("@selfbuilding/harnesses/codex", () => ({ codex: () => ({ id: "codex" }) }));

const agents = await import("./index.js");

describe("@selfbuilding/agents", () => {
  it("compiles the three built-in skills at import time, from the package's own skill folders", () => {
    expect(seen.fromSkill.map((c) => c.dir.split("/").at(-1))).toEqual([
      "implement-spec",
      "code-review",
      "verify",
      "find-flows",
    ]);
    expect(agents.ImplementSpec.skill.name).toBe("implement-spec");
    expect(agents.CodeReview.skill.name).toBe("code-review");
    expect(agents.Verify.skill.name).toBe("verify");
  });

  it("runs ImplementSpec on Claude Code and Verify on Codex by default; CodeReview has no default harness", () => {
    const [implement, review, verify] = seen.fromSkill;
    expect(implement?.contract.defaults).toEqual({ harness: { id: "claude-code" } });
    expect(review?.contract.defaults).toBeUndefined();
    expect(verify?.contract.defaults).toEqual({
      timeout: "1h",
      size: "medium",
      mcpServers: [agents.VERIFY_BROWSER_SERVER],
      harness: { id: "codex" },
    });
    expect(review?.contract).toMatchObject({ workspace: { target: "review" }, artifacts: { branch: "forbidden" } });
    expect(implement?.contract).toMatchObject({ artifacts: { branch: "required" } });
    expect(
      (implement?.contract.testCommand as ((i: { testCommand?: string }) => string | undefined) | undefined)?.({
        testCommand: "pnpm test",
      }),
    ).toBe("pnpm test");
  });

  it("exports the shipChange factory, the schemas and the default pack", () => {
    expect((agents.shipChange as unknown as { options: { name: string } }).options.name).toBe("ship-change");
    expect(agents.defaultPack.dirs).toHaveLength(4);
    expect(agents.CodeReviewResult.shape.verdict.options).toEqual(["approve", "request_changes", "comment"]);
    expect(agents.VerifyOutcome.options).toEqual(["verified", "broken", "could_not_boot", "unverifiable"]);
  });

  it("runs FindFlows read-only on Claude Code and exports the verifyFlows factory", () => {
    const find = seen.fromSkill.find((c) => c.dir.endsWith("find-flows"));
    expect(find?.contract.defaults).toEqual({ harness: { id: "claude-code" } });
    expect(find?.contract).toMatchObject({
      workspace: { target: "review" },
      artifacts: { branch: "forbidden", pr: "forbidden" },
    });
    expect(agents.FindFlows.skill.name).toBe("find-flows");
    expect((agents.verifyFlows as unknown as { options: { name: string } }).options.name).toBe("verify-flows");
  });
});
