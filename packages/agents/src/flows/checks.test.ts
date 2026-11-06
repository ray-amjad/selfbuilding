import { describe, expect, it } from "vitest";
import { findFlowsConsistentCheck, findFlowsProblems, flowSlug } from "./checks.js";
import { FindFlowsResult, type FoundFlow } from "./schemas.js";

const flow = (name: string, kind: FoundFlow["kind"]): FoundFlow => ({
  name,
  kind,
  entry: "/",
  endState: "it shows",
  why: "the diff touches it",
});

describe("flowSlug", () => {
  it("follows the evidence layout rule: lowercase, runs of other characters to one dash, trimmed, 48 at most", () => {
    expect(flowSlug("Add a note")).toBe("add-a-note");
    expect(flowSlug("  Mark a note DONE!! ")).toBe("mark-a-note-done");
    expect(flowSlug(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
    expect(flowSlug("x".repeat(100))).toHaveLength(48);
    expect(flowSlug("!!!")).toBe("flow");
  });
});

describe("findFlows done check", () => {
  const ok = {
    summary: "s",
    flows: [flow("mark a note done", "new"), flow("add a note", "regression")],
    noRunnableSurface: false,
    skipped: [],
  };

  it("accepts an ordered, unique list and an honest empty one", () => {
    expect(FindFlowsResult.parse(ok)).toBeTruthy();
    expect(findFlowsConsistentCheck.assert(ok)).toBe(true);
    expect(findFlowsProblems({ ...ok, flows: [], noRunnableSurface: true })).toEqual([]);
  });

  it("rejects a list out of order, duplicate names and a noRunnableSurface that disagrees with the list", () => {
    expect(findFlowsProblems({ ...ok, flows: [flow("a", "regression"), flow("b", "new")] })[0]).toMatch(
      /order new, changed, regression/,
    );
    expect(findFlowsProblems({ ...ok, flows: [flow("Add note", "new"), flow("add  note", "new")] })[0]).toMatch(
      /same name/,
    );
    expect(findFlowsProblems({ ...ok, noRunnableSurface: true })[0]).toMatch(/noRunnableSurface is true/);
    expect(findFlowsProblems({ ...ok, flows: [] })[0]).toMatch(/flows is empty/);
    expect(findFlowsConsistentCheck.assert({ ...ok, flows: [] })).toMatch(/\.$/);
  });
});
