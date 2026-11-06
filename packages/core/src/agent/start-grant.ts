import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ConfigError, WorkflowGuardError } from "../errors/classes.js";
import { durationMs } from "../sandbox/hash.js";
import type { SelfbuildingConfig } from "../types/config.js";
import { SANDBOX_PATHS } from "../types/runtime.js";
import { BUILT_IN_SIZES, type MachineSize, type SizeName } from "../types/sizes.js";
import type {
  ScriptCaps,
  StartGrantPayload,
  StartWorkflowCaller,
  StartWorkflowPolicy,
  StartWorkflowRequest,
} from "../types/workflow.js";

// start_workflow grants and guards (docs/spec/demo-path.md §9.3, §9.4). Owner: start-workflow. Core mints grants
// when it stages a call; @selfbuilding/hooks verifies them and the CLI applies the same guards to local callers.

export const DEFAULT_START_SECRET = "SELFBUILDING_START_SECRET";

export type ResolvedStartPolicy = Required<Omit<StartWorkflowPolicy, "url">> & { url?: string };

export function resolveStartPolicy(policy: StartWorkflowPolicy | undefined): ResolvedStartPolicy {
  const p = policy ?? {};
  return {
    enabled: p.enabled ?? false,
    ...(p.url !== undefined ? { url: p.url } : {}),
    secretName: p.secretName ?? DEFAULT_START_SECRET,
    maxConcurrentRuns: p.maxConcurrentRuns ?? 2,
    maxConcurrentSandboxes: p.maxConcurrentSandboxes ?? 4,
    maxSandboxesPerRun: p.maxSandboxesPerRun ?? 2,
    allowedSizes: p.allowedSizes ?? ["small"],
    maxBudgetUsd: p.maxBudgetUsd ?? 10,
    maxScriptBytes: p.maxScriptBytes ?? 262_144,
    maxDepth: p.maxDepth ?? 1,
    grantTtl: p.grantTtl ?? "2h",
  };
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

function mac(secret: string, body: string): Buffer {
  // The domain prefix keeps a grant from verifying as any other HMAC the same secret might sign.
  return createHmac("sha256", secret).update("selfbuilding.start-grant.v1:").update(body).digest();
}

/** Mints a start grant for one agent call: `<base64url(payload)>.<base64url(hmac)>`. */
export function signStartGrant(secret: string, payload: StartGrantPayload): string {
  if (!secret) throw new ConfigError("signStartGrant needs a non-empty secret (SELFBUILDING_START_SECRET).");
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(mac(secret, body))}`;
}

/** The grant's claims when its signature is valid and it has not expired; otherwise null. */
export function verifyStartGrant(secret: string, grant: string, nowMs: number = Date.now()): StartGrantPayload | null {
  if (!secret) return null;
  const dot = grant.indexOf(".");
  if (dot <= 0 || dot !== grant.lastIndexOf(".")) return null;
  const body = grant.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(grant.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const want = mac(secret, body);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const p = payload as Partial<StartGrantPayload> | null;
  if (
    !p ||
    typeof p.runId !== "string" ||
    typeof p.callPath !== "string" ||
    typeof p.depth !== "number" ||
    typeof p.exp !== "number" ||
    (p.budgetUsd !== undefined && typeof p.budgetUsd !== "number")
  ) {
    return null;
  }
  if (p.exp <= nowMs) return null;
  return p as StartGrantPayload;
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function base32(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * The launched run's id, fixed before anything starts so a retried tool call converges on the same run:
 * `ns_wf_` + base32(sha256(caller + callPath + (idempotencyKey ?? sha256(script + input)))) cut to 26.
 */
export function workflowRunId(caller: StartWorkflowCaller, req: StartWorkflowRequest): string {
  const who = caller.kind === "agent" ? `${caller.runId}\u0000${caller.callPath}` : `local:${caller.user}\u0000`;
  const key = req.idempotencyKey ?? sha256(`${req.script}\u0000${JSON.stringify(req.input ?? {})}`).toString("hex");
  return `ns_wf_${base32(sha256(`${who}\u0000${key}`)).slice(0, 26)}`;
}

/** The size table guards and caps read: the built-ins merged with the config's own names. */
function sizesOf(config: Pick<SelfbuildingConfig, "sizes"> | undefined): Record<string, MachineSize> {
  return { ...(config?.sizes ?? {}), ...BUILT_IN_SIZES };
}

/**
 * Checks a request against the policy, first refusal wins (demo-path §9.4). The grant is checked by the caller
 * (the HTTP handler); local callers skip `disabled`, `grant` and `depth`. Throws WorkflowGuardError.
 */
export function checkStartGuards(
  policy: ResolvedStartPolicy,
  req: StartWorkflowRequest,
  caller: StartWorkflowCaller,
  active: { runs: number; sandboxes: number },
  extra: { budgetUsd?: number } = {},
): void {
  const refuse = (rule: WorkflowGuardError["rule"], limit: string, requested: string): never => {
    throw new WorkflowGuardError({ rule, limit, requested });
  };
  if (caller.kind === "agent") {
    if (!policy.enabled) refuse("disabled", "no agent-launched runs", "one");
    if (caller.depth > policy.maxDepth) refuse("depth", `depth ${policy.maxDepth}`, `depth ${caller.depth}`);
  }
  const bytes = Buffer.byteLength(req.script ?? "");
  if (bytes > policy.maxScriptBytes) refuse("script_bytes", `${policy.maxScriptBytes} bytes`, `${bytes} bytes`);
  const size = req.size ?? "small";
  if (!policy.allowedSizes.includes(size)) refuse("size", `sizes ${policy.allowedSizes.join(", ")}`, `"${size}"`);
  const maxBudget = Math.min(policy.maxBudgetUsd, extra.budgetUsd ?? Number.POSITIVE_INFINITY);
  const budget = req.budgetUsd ?? maxBudget;
  if (budget > maxBudget) refuse("budget", `$${maxBudget}`, `$${budget}`);
  const sandboxes = req.maxSandboxes ?? policy.maxSandboxesPerRun;
  if (sandboxes > policy.maxSandboxesPerRun) {
    refuse("sandboxes_per_run", `${policy.maxSandboxesPerRun} sandboxes`, `${sandboxes} sandboxes`);
  }
  if (active.runs >= policy.maxConcurrentRuns) {
    refuse("concurrent_runs", `${policy.maxConcurrentRuns} runs at once`, `run ${active.runs + 1}`);
  }
  if (active.sandboxes + sandboxes > policy.maxConcurrentSandboxes) {
    refuse(
      "concurrent_sandboxes",
      `${policy.maxConcurrentSandboxes} sandboxes at once`,
      `${active.sandboxes} live + ${sandboxes} more`,
    );
  }
}

/**
 * The caps a launched run gets, so the script cannot exceed what was approved: its sandboxes, its budget, and only
 * sizes no bigger than the requested one.
 */
export function startWorkflowCaps(
  policy: ResolvedStartPolicy,
  req: StartWorkflowRequest,
  config?: Pick<SelfbuildingConfig, "sizes">,
  extra: { budgetUsd?: number } = {},
): ScriptCaps {
  const table = sizesOf(config);
  const requested: SizeName = req.size ?? "small";
  const top = table[requested];
  const allowedSizes = top
    ? Object.entries(table)
        .filter(([, s]) => s.vcpu <= top.vcpu && s.memoryMiB <= top.memoryMiB)
        .map(([name]) => name)
        .sort()
    : [requested];
  return {
    maxSandboxes: req.maxSandboxes ?? policy.maxSandboxesPerRun,
    allowedSizes,
    budgetUsd: req.budgetUsd ?? Math.min(policy.maxBudgetUsd, extra.budgetUsd ?? Number.POSITIVE_INFINITY),
  };
}

// Runs started by start_workflow, by run id, so grants minted inside them carry depth + 1. Filled by whatever
// starts such a run in this process (the run-script factory reads `ScriptRunInput.launchedBy`).
const launchDepths = new Map<string, number>();

/** Records that `runId` was launched by `caller`; grants minted inside it get `caller.depth + 1`. */
export function noteLaunchedBy(runId: string, caller: StartWorkflowCaller | undefined): void {
  if (caller?.kind === "agent") launchDepths.set(runId, caller.depth);
}

/**
 * Records a run's launch depth learned from elsewhere: a dispatched call's spec, or the Trigger agent child's
 * payload, since the child is another process and must still mint grants at the parent run's depth + 1.
 */
export function noteLaunchDepth(runId: string, depth: number): void {
  if (Number.isInteger(depth) && depth >= 0) launchDepths.set(runId, depth);
}

/** The launch depth of a run: 0 for a run a person started. */
export function launchDepthOf(runId: string): number {
  const known = launchDepths.get(runId);
  if (known !== undefined) return known;
  // A run whose launcher was in another process: agent-launched ids are recognisable, so depth is at least 1.
  return runId.startsWith("ns_wf_") ? 1 : 0;
}

export interface StagedStartGrant {
  /** Root-only 0600, read by the supervisor and never by the agent. */
  file: { path: string; data: string; mode: number; owner: "root" };
  /** RuntimeSpec.startWorkflow. */
  spec: { url: string };
  /** The grant, so the run's redactor scrubs it. */
  grant: string;
}

/**
 * The grant for one agent call that passed `startWorkflow: true` (demo-path §9.3). Refuses with ConfigError when
 * the policy is not enabled, has no URL, or its secret is not resolvable.
 */
export async function stageStartGrant(
  config: SelfbuildingConfig,
  call: { runId: string; callPath: string; agentName: string; budgetUsd?: number },
  nowMs: number = Date.now(),
): Promise<StagedStartGrant> {
  const policy = resolveStartPolicy(config.startWorkflow);
  if (!policy.enabled) {
    throw new ConfigError(
      `${call.agentName} passed startWorkflow: true but the config's startWorkflow.enabled is not true. Enable it, or drop the option.`,
    );
  }
  if (!policy.url) {
    throw new ConfigError(
      "startWorkflow.url is not set. Set it to the public URL of the host's createStartWorkflowHandler().",
    );
  }
  if (!config.secrets) {
    throw new ConfigError(
      `start_workflow grants are signed with the secret ${policy.secretName}, but no secret source is configured.`,
    );
  }
  const secret = (await config.secrets.resolve([policy.secretName]))[policy.secretName];
  if (!secret) throw new ConfigError(`The secret ${policy.secretName} resolved empty; start grants need it.`);
  const grant = signStartGrant(secret, {
    runId: call.runId,
    callPath: call.callPath,
    depth: launchDepthOf(call.runId) + 1,
    exp: nowMs + durationMs(policy.grantTtl, 2 * 3_600_000),
    ...(call.budgetUsd !== undefined ? { budgetUsd: call.budgetUsd } : {}),
  });
  return {
    file: { path: SANDBOX_PATHS.startGrant, data: grant, mode: 0o600, owner: "root" },
    spec: { url: policy.url },
    grant,
  };
}
