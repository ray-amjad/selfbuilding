import type { DoneCheck } from "@selfbuilding/core";
import type { FindFlowsResult, FlowKind } from "./schemas.js";

// Done checks for findFlows (demo-path §4.3). Owner: verify-flows.

const KIND_ORDER: Record<FlowKind, number> = { new: 0, changed: 1, regression: 2 };

/** What is wrong with a findFlows result, as sentences the agent can act on. Empty when it is consistent. */
export function findFlowsProblems(r: FindFlowsResult): string[] {
  const problems: string[] = [];
  if (r.noRunnableSurface && r.flows.length > 0) {
    problems.push("noRunnableSurface is true but flows is not empty: return an empty list, or set it to false");
  }
  if (!r.noRunnableSurface && r.flows.length === 0) {
    problems.push(
      "flows is empty but noRunnableSurface is false: list the flows the diff reaches, or set noRunnableSurface to true and say why in skipped",
    );
  }
  for (let i = 1; i < r.flows.length; i++) {
    const prev = r.flows[i - 1];
    const cur = r.flows[i];
    if (prev && cur && KIND_ORDER[cur.kind] < KIND_ORDER[prev.kind]) {
      problems.push(
        `flow "${cur.name}" (${cur.kind}) comes after "${prev.name}" (${prev.kind}): order new, changed, regression`,
      );
      break;
    }
  }
  const slugs = new Map<string, string>();
  for (const f of r.flows) {
    const slug = flowSlug(f.name);
    const other = slugs.get(slug);
    if (other !== undefined)
      problems.push(`flows "${other}" and "${f.name}" have the same name once slugged: merge them or rename one`);
    else slugs.set(slug, f.name);
  }
  return problems;
}

export const findFlowsConsistentCheck = {
  id: "find-flows-consistent",
  assert(r: FindFlowsResult): true | string {
    const problems = findFlowsProblems(r);
    return problems.length === 0 ? true : `${problems.join("; ")}.`;
  },
} satisfies DoneCheck<unknown, FindFlowsResult>;

/**
 * A flow's directory name under /selfbuilding/out/files/verify/ (demo-path §4.2): lowercased, every run of
 * characters outside [a-z0-9] turned into one "-", trimmed of "-", at most 48 characters. "flow" when nothing is left.
 */
export function flowSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "flow";
}
