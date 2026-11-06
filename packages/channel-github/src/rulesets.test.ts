import { describe, expect, it } from "vitest";
import { type RulesetDetail, rulesetLimitsApp, rulesetsProtect } from "./rulesets.js";

const APP = 4242;
const full: RulesetDetail = {
  id: 1,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/selfbuilding/**"] } },
  rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }],
  bypass_actors: [],
};

describe("rulesetLimitsApp / rulesetsProtect", () => {
  it("accepts one active ruleset on every branch except selfbuilding/** with creation, update and deletion", () => {
    expect(rulesetLimitsApp(full, APP)).toEqual({ ok: true, reason: "limits the App" });
    expect(rulesetsProtect([full], APP)).toBe(true);
    expect(
      rulesetsProtect([{ ...full, conditions: { ref_name: { include: ["refs/heads/**"], exclude: [] } } }], APP),
    ).toBe(true);
  });

  it("combines rules from several qualifying rulesets", () => {
    const a = { ...full, id: 1, rules: [{ type: "creation" }, { type: "deletion" }] };
    const b = { ...full, id: 2, rules: [{ type: "update" }] };
    expect(rulesetsProtect([a], APP)).toBe(false);
    expect(rulesetsProtect([a, b], APP)).toBe(true);
  });

  it.each([
    ["evaluate mode", { enforcement: "evaluate" }, /enforcement/],
    ["a tag ruleset", { target: "tag" }, /branch ruleset/],
    [
      "the default branch only",
      { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } },
      /every branch/,
    ],
    [
      "an exclusion outside selfbuilding/",
      {
        conditions: {
          ref_name: { include: ["~ALL"], exclude: ["refs/heads/selfbuilding/**", "refs/heads/release/*"] },
        },
      },
      /release/,
    ],
    ["the App as a bypass actor", { bypass_actors: [{ actor_id: APP, actor_type: "Integration" }] }, /bypass actor/],
    ["a bypass the token reports", { current_user_can_bypass: "always" as const }, /can bypass/],
  ])("rejects %s", (_name, patch, reason) => {
    const ruleset = { ...full, ...patch } as RulesetDetail;
    const verdict = rulesetLimitsApp(ruleset, APP);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(reason);
    expect(rulesetsProtect([ruleset], APP)).toBe(false);
  });

  it("ignores a bypass for a different App", () => {
    const other = { ...full, bypass_actors: [{ actor_id: 7, actor_type: "Integration" }] };
    expect(rulesetsProtect([other], APP)).toBe(true);
  });

  it("is false with no rulesets", () => {
    expect(rulesetsProtect([], APP)).toBe(false);
  });
});
