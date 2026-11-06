// The repository ruleset check (spec §9.2, "Branch protection is required"). A GitHub token cannot be limited to a
// branch prefix, so the App's write access is safe only when a ruleset stops it from creating, updating or deleting
// any branch outside refs/heads/selfbuilding/*. GitHub needs both "refs/heads/selfbuilding/**" and
// "refs/heads/selfbuilding/**/*" excluded before nested agent branches are free of the ruleset.

export interface RulesetSummary {
  id: number;
  name?: string;
  target?: string;
  enforcement?: string;
}

export interface RulesetDetail extends RulesetSummary {
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  rules?: { type: string }[];
  bypass_actors?: { actor_id?: number | null; actor_type?: string; bypass_mode?: string }[];
  /** As seen by the token that read the ruleset (the App's installation token here). */
  current_user_can_bypass?: "always" | "pull_requests_only" | "never";
}

export const REQUIRED_RULES = ["creation", "update", "deletion"] as const;

/** A nested branch like the ones agent calls push (selfbuilding/<runId>/<callPath>), asked about before any push. */
export const AGENT_BRANCH_PROBE = "selfbuilding/ruleset-check/call";

const ALL_BRANCHES = new Set(["~ALL", "refs/heads/**", "**"]);
const AGENT_BRANCHES = "refs/heads/selfbuilding/";

/** Why one ruleset does or does not limit the App, for error messages and tests. */
export function rulesetLimitsApp(ruleset: RulesetDetail, appId: number | string): { ok: boolean; reason: string } {
  if (ruleset.enforcement !== "active") return { ok: false, reason: `enforcement is ${ruleset.enforcement}` };
  if (ruleset.target !== undefined && ruleset.target !== "branch") return { ok: false, reason: "not a branch ruleset" };
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  if (!include.some((pattern) => ALL_BRANCHES.has(pattern))) {
    return { ok: false, reason: "does not target every branch (~ALL)" };
  }
  const leak = exclude.find((pattern) => !pattern.startsWith(AGENT_BRANCHES));
  if (leak !== undefined) return { ok: false, reason: `excludes ${leak}, which is outside ${AGENT_BRANCHES}*` };
  if (ruleset.current_user_can_bypass === "always") return { ok: false, reason: "the App can bypass it" };
  const appBypasses = (ruleset.bypass_actors ?? []).some(
    (actor) => actor.actor_type === "Integration" && String(actor.actor_id) === String(appId),
  );
  if (appBypasses) return { ok: false, reason: "the App is a bypass actor" };
  return { ok: true, reason: "limits the App" };
}

/** True when the qualifying rulesets, taken together, block creation, update and deletion outside selfbuilding/*. */
export function rulesetsProtect(rulesets: readonly RulesetDetail[], appId: number | string): boolean {
  const rules = new Set<string>();
  for (const ruleset of rulesets) {
    if (!rulesetLimitsApp(ruleset, appId).ok) continue;
    for (const rule of ruleset.rules ?? []) rules.add(rule.type);
  }
  return REQUIRED_RULES.every((rule) => rules.has(rule));
}
