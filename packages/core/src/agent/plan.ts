import type { SkillDef } from "@selfbuilding/skills";
import type { z } from "zod";
import { AgentInputError, ConfigError, TimeoutOrderError } from "../errors/classes.js";
import { BOT_IDENTITY, remoteUrlFor } from "../sandbox/git.js";
import { SharedSandbox } from "../sandbox/handle.js";
import { canonicalJson, durationMs, sha256Hex } from "../sandbox/hash.js";
import { branchName } from "../sandbox/names.js";
import type { AgentCallOptions, Contract, PrOptions } from "../types/agent.js";
import type { Effort, JsonSchema } from "../types/common.js";
import type { Harness, McpServerSpec } from "../types/harness.js";
import type { GitSpec, ResolvedTimeouts, RuntimeDoneCheck } from "../types/runtime.js";
import type { SandboxProvider } from "../types/sandbox.js";
import type { SizeName } from "../types/sizes.js";
import type { AgentRunContext } from "./context.js";
import { jsonSchemaOf, wireOutputSchema } from "./contract.js";
import { DEFAULT_PROTECTED } from "./schemas.js";

// Resolves one call's options against the contract, factory defaults and config (spec §1.11 precedence), before any
// sandbox exists. Every usage error surfaces here.

/** What an Agent value is made of. Compiled skills and inline prompts both become one. */
export interface AgentDefinition<I, O> {
  /** The `Name` segment of the callPath: PascalCase skill name, or the inline agent's name. */
  name: string;
  /** The skill, when there is one. Inline agents have none. */
  skill?: SkillDef;
  /** SKILL.md body (plus `with()` appendBody), or the inline prompt. */
  body: string;
  /** Inline prompts are literal: no substitution (spec §3.4). */
  literal: boolean;
  contract: Contract<I, O>;
  /** Skill hash (+ patch) or sha256(prompt): the step-key target (spec §3.2). */
  hash: string;
  secrets: string[];
}

export interface CallPlan {
  agentName: string;
  callPath: string;
  stepKey: string;
  hostKey: string;
  harness: Harness;
  provider: SandboxProvider;
  handle?: SharedSandbox;
  input: unknown;
  repo?: string;
  git: GitSpec;
  timeouts: ResolvedTimeouts;
  hotWaitMs: number;
  maxSubmitAttempts: number;
  maxResumes: number;
  maxDoneRetries: number;
  retries: number;
  onDoneFailure: "throw" | "return";
  onInterrupted: "fail" | "resume-session";
  requireIsolation: boolean;
  keepOnFailure: false | string;
  pr: false | PrOptions;
  outputSchema: z.ZodType;
  wireSchema: z.ZodType;
  resultJsonSchema: JsonSchema;
  doneChecks: RuntimeDoneCheck[];
  testCommand?: string;
  branchRequirement: "required" | "optional" | "forbidden";
  protectedPaths: string[];
  budget?: { usd?: number };
  secrets: string[];
  effort?: Effort;
  maxResultBytes: number;
  checkpoint: "git" | "snapshot" | "none";
  skill: { name: string; hash: string };
  /** Unresolved size name for a fresh box; resolved against config and provider at create (demo-path §1). */
  size?: SizeName;
  /** Extra MCP servers after the `selfbuilding` one. */
  mcpServers?: McpServerSpec[];
  /** Stage a start grant for start_workflow (demo-path §9.3). */
  startWorkflow?: boolean;
}

const MIN = 60_000;

/** Resolves every timeout to ms and checks the chain (spec §6.11). */
export function resolveTimeouts(
  opts: AgentCallOptions,
  ctx: AgentRunContext,
  contract: Contract<unknown, unknown>,
  hotWaitMs: number,
): ResolvedTimeouts {
  const t = { ...ctx.config.timeouts, ...opts.timeouts };
  const callMs = durationMs(opts.timeout ?? contract.defaults.timeout ?? ctx.defaults.timeout, 2 * 60 * MIN);
  const resolved: ResolvedTimeouts = {
    callMs,
    idleMs: durationMs(t.idle, Math.max(15 * MIN, hotWaitMs + 5 * MIN)),
    setupMs: durationMs(t.setup, 20 * MIN),
    startMs: durationMs(t.start, 5 * MIN),
    bootMs: durationMs(t.boot, 30 * MIN),
    postSubmitGraceMs: durationMs(t.postSubmitGrace, 10_000),
    cancelGraceMs: durationMs(t.cancelGrace, 10_000),
    exitQuietMs: 60_000,
    mcpToolMs: hotWaitMs + 2 * MIN,
  };
  if (resolved.setupMs + resolved.startMs >= resolved.bootMs) {
    throw new TimeoutOrderError({ first: "timeouts.setup + timeouts.start", second: "timeouts.boot" });
  }
  if (resolved.postSubmitGraceMs >= resolved.idleMs) {
    throw new TimeoutOrderError({ first: "timeouts.postSubmitGrace", second: "timeouts.idle" });
  }
  if (resolved.idleMs <= hotWaitMs) throw new TimeoutOrderError({ first: "hitl.hotWait", second: "timeouts.idle" });
  return resolved;
}

/** "https://github.com/acme/api/pull/412" → "github.com/acme/api". */
export function repoFromPrUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const [owner, name] = u.pathname.split("/").filter(Boolean);
    return owner && name ? `${u.host}/${owner}/${name}` : undefined;
  } catch {
    return undefined;
  }
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/** Parses the call input with the contract's input schema (spec §2.4.3). */
export function parseInput<I>(def: AgentDefinition<I, unknown>, input: unknown): unknown {
  const parsed = def.contract.input.safeParse(input);
  if (!parsed.success) throw new AgentInputError({ agent: def.name, issues: issuesOf(parsed.error) });
  return parsed.data;
}

export { issuesOf };

/** callPaths already warned that their `size` is ignored on a shared handle, per handle. */
const sizeWarned = new WeakMap<SharedSandbox, Set<string>>();

/** A call on a shared handle runs on the handle's box, so its own `size` cannot apply (demo-path §1.2). */
function warnHandleSize(ctx: AgentRunContext, handle: SharedSandbox, callPath: string, size: SizeName): void {
  const seen = sizeWarned.get(handle) ?? new Set<string>();
  sizeWarned.set(handle, seen);
  if (seen.has(callPath)) return;
  seen.add(callPath);
  ctx.emit({
    type: "log",
    level: "warn",
    callPath,
    data: {
      scope: "size",
      message: `size "${size}" is ignored: this call runs on shared sandbox "${handle.id}", which is ${handle.size ? `"${handle.size}"` : "at the provider default"}. Set the size on sandbox({ size }) or fork(n, { size }).`,
    },
  });
}

/** Builds the call plan. `callPath` and `stepKey` are filled by the caller once the identity is known. */
export function resolvePlan(
  ctx: AgentRunContext,
  def: AgentDefinition<unknown, unknown>,
  input: unknown,
  parsedInput: unknown,
  opts: AgentCallOptions,
  callPath: string,
): Omit<CallPlan, "stepKey" | "hostKey"> {
  const contract = def.contract;
  const handle = SharedSandbox.is(opts.sandbox) ? opts.sandbox : undefined;
  if (
    opts.sandbox !== undefined &&
    opts.sandbox !== "fresh" &&
    !handle &&
    !(typeof opts.sandbox === "object" && "openOrCreate" in opts.sandbox)
  ) {
    throw new ConfigError(`${def.name}: sandbox must be "fresh", a provider value or a handle from sandbox().`);
  }
  const harness = opts.harness ?? contract.defaults.harness ?? ctx.defaults.harness ?? ctx.config.harness;
  const provider =
    handle?.resolveProvider() ??
    (opts.sandbox && opts.sandbox !== "fresh" ? (opts.sandbox as SandboxProvider) : undefined) ??
    ctx.defaults.sandbox ??
    ctx.config.sandbox;
  if (!harness || !provider) {
    const missing = [!harness && "no harness", !provider && "no sandbox"].filter(Boolean).join(" and ");
    throw new ConfigError(
      `${def.name} has ${missing}.\nPass them in call options, e.g. { harness: claudeCode({ model }), sandbox: docker() },\nor pass { config: await loadConfig({ cwd }) }.`,
    );
  }

  const target = (parsedInput as { target?: { kind?: string; url?: string; base?: string; head?: string } } | null)
    ?.target;
  const prRepo = target?.kind === "pr" && target.url ? repoFromPrUrl(target.url) : undefined;
  if (opts.repo && handle?.repo && opts.repo !== handle.repo) {
    throw new AgentInputError({
      agent: def.name,
      issues: [`repo "${opts.repo}" disagrees with the shared handle's repo "${handle.repo}"`],
    });
  }
  if (opts.repo && prRepo && opts.repo !== prRepo) {
    throw new AgentInputError({
      agent: def.name,
      issues: [`repo "${opts.repo}" disagrees with the PR target's repo "${prRepo}"`],
    });
  }
  if (handle && opts.git?.branch && opts.git.branch !== handle.branch) {
    throw new AgentInputError({
      agent: def.name,
      issues: [`git.branch "${opts.git.branch}" disagrees with the shared handle's branch "${handle.branch}"`],
    });
  }
  // A shared box's working branch starts from one base; a call that names another would silently build on it.
  const handleBase = handle && opts.git?.baseBranch ? handle.adoptBaseBranch(opts.git.baseBranch) : handle?.baseBranch;
  if (handle && opts.git?.baseBranch && handleBase !== undefined && opts.git.baseBranch !== handleBase) {
    throw new AgentInputError({
      agent: def.name,
      issues: [
        `git.baseBranch "${opts.git.baseBranch}" disagrees with the shared handle's base "${handleBase}"; pass baseBranch to sandbox() instead`,
      ],
    });
  }
  const repo = opts.repo ?? handle?.repo ?? prRepo ?? ctx.defaults.repo;
  if (contract.workspace.repo === "required" && !repo) {
    throw new AgentInputError({
      agent: def.name,
      issues: ["this agent needs a repo: pass { repo }, a PR review target, a shared handle, or factory defaults.repo"],
    });
  }
  if (contract.workspace.target === "review" && !target && !handle) {
    throw new AgentInputError({
      agent: def.name,
      issues: ["a review agent needs a `target` input or a shared handle"],
    });
  }

  const branchRequirement =
    typeof contract.artifacts.branch === "function"
      ? contract.artifacts.branch(parsedInput)
      : contract.artifacts.branch;
  const readOnly = branchRequirement === "forbidden";
  const hotWaitMs = durationMs(ctx.config.hitl?.hotWait, 10 * MIN);
  const timeouts = resolveTimeouts(opts, ctx, contract as Contract<unknown, unknown>, hotWaitMs);
  if (timeouts.callMs + 15 * MIN > provider.limits.maxLifetimeMs) {
    ctx.emit({
      type: "warning",
      level: "warn",
      callPath,
      data: {
        scope: "lifetime",
        message: `timeout + 15 min exceeds ${provider.id}'s maxLifetimeMs; the host extends the lifetime while the call runs`,
      },
    });
  }
  const baseBranch = opts.git?.baseBranch ?? handleBase ?? "main";
  const branch =
    handle?.branch ??
    opts.git?.branch ??
    (readOnly && target?.kind === "diff" && target.head ? target.head : branchName(ctx.runId, callPath));
  const identity =
    opts.git?.identity && opts.git.identity !== "agent"
      ? {
          authorName: opts.git.identity.name,
          authorEmail: opts.git.identity.email,
          committerName: BOT_IDENTITY.name,
          committerEmail: BOT_IDENTITY.email,
        }
      : {
          authorName: BOT_IDENTITY.name,
          authorEmail: BOT_IDENTITY.email,
          committerName: BOT_IDENTITY.name,
          committerEmail: BOT_IDENTITY.email,
        };
  const git: GitSpec = {
    mode: "remote",
    ...(repo ? { repo, remoteUrl: remoteUrlFor(repo) } : {}),
    branch,
    baseBranch,
    readOnly,
    commitLeftovers: opts.git?.commitLeftovers ?? true,
    identity,
    trailers: { run: ctx.runId, call: `${ctx.runId}.${callPath}`, agent: def.name },
    allowPushTo: [...(opts.git?.allowPushTo ?? [])],
  };
  // Review contracts read the target's diff from /selfbuilding/in/diff.patch (spec §2.3.1). The runtime resolves
  // these names after fetching, as remote branches first. A shared handle with no head reviews its checkout.
  if (contract.workspace.target === "review" && target?.kind === "diff" && target.base) {
    const head = target.head ?? (handle ? "HEAD" : undefined);
    if (head) git.review = { baseSha: target.base, headSha: head };
  }

  const testCommand =
    typeof contract.testCommand === "function" ? contract.testCommand(parsedInput) : contract.testCommand;
  const doneChecks: RuntimeDoneCheck[] = [];
  if (testCommand) doneChecks.push({ id: "tests", cmd: testCommand });
  for (const check of contract.done) {
    if (!("cmd" in check)) continue;
    const cmd = typeof check.cmd === "function" ? check.cmd(parsedInput) : check.cmd;
    if (cmd === undefined) continue;
    doneChecks.push({
      id: check.id,
      cmd,
      ...(check.cwd ? { cwd: check.cwd } : {}),
      ...(check.timeout !== undefined ? { timeoutMs: durationMs(check.timeout, 10 * MIN) } : {}),
      ...(check.expectExit !== undefined ? { expectExit: check.expectExit } : {}),
    });
  }
  const wireSchema = wireOutputSchema(contract.output);
  const pr: false | PrOptions =
    opts.pr === true || (opts.pr === undefined && contract.artifacts.pr === "required")
      ? {}
      : opts.pr
        ? opts.pr
        : false;
  const checkpoint = opts.checkpoint ?? "git";
  const budgetUsd = opts.budget?.usd ?? ctx.config.budget?.perAgent?.usd;
  const size = handle ? undefined : (opts.size ?? contract.defaults.size ?? ctx.defaults.size);
  if (handle && opts.size !== undefined && opts.size !== handle.size) warnHandleSize(ctx, handle, callPath, opts.size);
  const mcpServers = [...(contract.defaults.mcpServers ?? []), ...(opts.mcpServers ?? [])];
  const plan: Omit<CallPlan, "stepKey" | "hostKey"> = {
    agentName: def.name,
    callPath,
    harness,
    provider,
    ...(handle ? { handle } : {}),
    input,
    ...(repo ? { repo } : {}),
    git,
    timeouts,
    hotWaitMs,
    maxSubmitAttempts: opts.maxSubmitAttempts ?? contract.defaults.maxSubmitAttempts ?? 3,
    maxResumes: opts.maxResumes ?? contract.defaults.maxResumes ?? 1,
    maxDoneRetries: opts.maxDoneRetries ?? contract.defaults.maxDoneRetries ?? 2,
    retries: opts.retries ?? 0,
    onDoneFailure: opts.onDoneFailure ?? "throw",
    onInterrupted: interruptedPolicy(ctx, callPath, opts.onInterrupted),
    requireIsolation: opts.requireIsolation ?? false,
    keepOnFailure: opts.lifecycle?.keepOnFailure ?? false,
    pr,
    outputSchema: contract.output,
    wireSchema,
    resultJsonSchema: jsonSchemaOf(wireSchema, "output"),
    doneChecks,
    ...(testCommand ? { testCommand } : {}),
    branchRequirement,
    protectedPaths: [
      ...DEFAULT_PROTECTED.map((p) => p.pattern).filter((p) => !contract.protect.allow.includes(p)),
      ...contract.protect.extra,
    ],
    ...(budgetUsd !== undefined ? { budget: { usd: budgetUsd } } : {}),
    secrets: [...new Set([...def.secrets, ...(opts.secrets ?? [])])],
    ...((opts.effort ?? contract.defaults.effort ?? ctx.defaults.effort ?? ctx.config.effort)
      ? { effort: (opts.effort ?? contract.defaults.effort ?? ctx.defaults.effort ?? ctx.config.effort) as Effort }
      : {}),
    maxResultBytes: 262_144,
    checkpoint,
    skill: { name: def.skill?.name ?? def.name, hash: def.hash },
    ...(size !== undefined ? { size } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(opts.startWorkflow ? { startWorkflow: true } : {}),
  };
  return plan;
}

/** The run's per-callPath choice wins, then the call's own option, then the run-wide policy (RunState rule). */
export function interruptedPolicy(
  ctx: AgentRunContext,
  callPath: string,
  perCall?: "fail" | "resume-session",
): "fail" | "resume-session" {
  const policy = ctx.onInterrupted;
  if (policy !== undefined && typeof policy === "object" && policy[callPath] !== undefined) {
    return policy[callPath] === "resume-session" ? "resume-session" : "fail";
  }
  if (perCall !== undefined) return perCall;
  if (typeof policy === "string") return policy;
  return "fail";
}

/** The step-key identity of a call (spec §3.2): target, input, schema, exec and sandbox placement. */
export function stepIdentity(
  def: AgentDefinition<unknown, unknown>,
  plan: Omit<CallPlan, "stepKey" | "hostKey">,
  callPath: string,
) {
  return {
    callPath,
    target: def.hash,
    input: plan.input,
    schema: sha256Hex(canonicalJson(plan.resultJsonSchema)),
    exec: {
      harness: plan.harness.id,
      version: plan.harness.options.version ?? "tested",
      model: plan.harness.options.model ?? null,
      effort: plan.effort ?? null,
    },
    // A handle call is keyed on the last call that settled on the handle, which a replay restores exactly; a
    // version counter would only count live calls and drift on resume.
    sandbox: plan.handle
      ? { boxId: plan.handle.id, prevCheckpointStepKey: plan.handle.prevCheckpointStepKey }
      : { fresh: plan.provider.id },
  };
}
