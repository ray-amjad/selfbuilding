import {
  checkStartGuards,
  isSelfbuildingError,
  resolveStartPolicy,
  type StartWorkflowCaller,
  type StartWorkflowPolicy,
  type StartWorkflowReceipt,
  type StartWorkflowRequest,
  signStartGrant as signGrant,
  startWorkflowCaps,
  verifyStartGrant,
  WorkflowGuardError,
  type WorkflowLauncher,
  workflowRunId,
} from "@selfbuilding/core";
import type { FetchHandler } from "./hitl.js";

// The host side of start_workflow (docs/spec/demo-path.md §9). Owner: start-workflow.

/** The header carrying the start grant. */
export const START_GRANT_HEADER = "authorization";

export interface StartWorkflowHandlerOptions {
  /** HMAC key the host signs start grants with (secret name SELFBUILDING_START_SECRET). */
  secret: string;
  launcher: WorkflowLauncher;
  policy: StartWorkflowPolicy;
  /** Injected clock for tests. */
  now?: () => number;
  /** Compiles the script before launching; default `launcher.checkScript`. Throws ScriptInvalidError. */
  checkScript?: (source: string) => Promise<void>;
  /** One message per launch (Slack, a log line). A throw here never fails the launch. */
  notify?: (text: string, launch: { receipt: StartWorkflowReceipt; request: StartWorkflowRequest }) => Promise<void>;
  /** Larger bodies get 413. Default: the policy's maxScriptBytes plus 64 KiB for the input. */
  maxBodyBytes?: number;
}

/** Mints a start grant for one agent call: `<base64url(payload)>.<base64url(hmac)>`. */
export function signStartGrant(
  secret: string,
  payload: { runId: string; callPath: string; depth: number; exp: number; budgetUsd?: number },
): string {
  return signGrant(secret, payload);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function refusal(error: unknown): Response {
  if (isSelfbuildingError(error)) {
    const status =
      error.code === "workflow_guard"
        ? (error as WorkflowGuardError).rule === "grant"
          ? 401
          : 403
        : error.code === "script_invalid"
          ? 400
          : 500;
    return json(status, { error: error.toJSON() });
  }
  return json(500, { error: { code: "internal", message: `start_workflow failed on the host: ${String(error)}` } });
}

function launchMessage(req: StartWorkflowRequest, caller: StartWorkflowCaller, receipt: StartWorkflowReceipt): string {
  const who = caller.kind === "agent" ? `${caller.runId} (${caller.callPath})` : caller.user;
  const budget = req.budgetUsd !== undefined ? `$${req.budgetUsd}` : "the default budget";
  return `Workflow "${req.name}" started as ${receipt.runId}, launched by ${who}; size ${req.size ?? "small"}, ${budget}. Follow it with: ${receipt.watch}`;
}

function existsMessage(req: StartWorkflowRequest, caller: StartWorkflowCaller, receipt: StartWorkflowReceipt): string {
  const who = caller.kind === "agent" ? `${caller.runId} (${caller.callPath})` : caller.user;
  return `Workflow "${req.name}" already running as ${receipt.runId}, launched by ${who}. Follow it with: ${receipt.watch}`;
}

/**
 * `POST` with `Authorization: Bearer <grant>` and a StartWorkflowRequest body launches a run; `GET ?runId=` with
 * the same header reads its status. Checks run in the order of demo-path §9.4; the first refusal answers.
 */
export function createStartWorkflowHandler(opts: StartWorkflowHandlerOptions): FetchHandler {
  const policy = resolveStartPolicy(opts.policy);
  const now = opts.now ?? Date.now;
  const maxBody = opts.maxBodyBytes ?? policy.maxScriptBytes + 65_536;
  const check = opts.checkScript ?? opts.launcher.checkScript?.bind(opts.launcher);

  return async (request) => {
    try {
      if (!policy.enabled) throw guard("disabled", "no agent-launched runs", "one");
      const header = request.headers.get(START_GRANT_HEADER) ?? "";
      const grant = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
      const claims = grant ? verifyStartGrant(opts.secret, grant, now()) : null;
      if (!claims) throw guard("grant", "a valid, unexpired start grant", grant ? "a grant that failed" : "none");
      const caller: StartWorkflowCaller = {
        kind: "agent",
        runId: claims.runId,
        callPath: claims.callPath,
        depth: claims.depth,
      };

      if (request.method === "GET") {
        const runId = new URL(request.url).searchParams.get("runId");
        if (!runId) return json(400, { error: { code: "usage", message: "GET needs ?runId=<id>." } });
        const status = (await opts.launcher.status?.(runId)) ?? null;
        // A grant reads only the runs its own run launched: a local launch, or one with no recorded caller, is
        // nobody's to read through a grant (release-prep §7.1 #1).
        if (status?.launchedBy?.kind !== "agent" || status.launchedBy.runId !== caller.runId) {
          return json(404, { error: { code: "not_found", message: `No workflow run ${runId} launched by this run.` } });
        }
        return json(200, status);
      }
      if (request.method !== "POST") return json(405, { error: { code: "usage", message: "Use POST or GET." } });

      const raw = await request.text();
      if (Buffer.byteLength(raw) > maxBody) {
        throw guard("script_bytes", `${policy.maxScriptBytes} bytes`, `${Buffer.byteLength(raw)} bytes of request`);
      }
      let req: StartWorkflowRequest;
      try {
        req = JSON.parse(raw) as StartWorkflowRequest;
      } catch {
        return json(400, { error: { code: "usage", message: "The body is not JSON." } });
      }
      if (!req || typeof req.name !== "string" || typeof req.script !== "string") {
        return json(400, { error: { code: "usage", message: "The body needs `name` and `script` strings." } });
      }

      const budget = claims.budgetUsd !== undefined ? { budgetUsd: claims.budgetUsd } : {};
      // A retried tool call converges on the run it already started, even when the caps are now full. The run
      // keeps the options it started with: the launcher is not called again, so a retry can neither re-trigger
      // it nor swap in a new size, sandbox count or script (release-prep §7.1 #2).
      // A launch that never reached its host (failed trigger, or a crash before it) is not a run yet: it takes
      // the full path, so start() can recover it.
      const runId = workflowRunId(caller, req);
      const existing = await opts.launcher.status?.(runId);
      if (existing && !existing.untriggered) {
        const receipt: StartWorkflowReceipt = {
          runId,
          status: "exists",
          host: opts.launcher.host,
          watch: `selfbuilding watch ${runId}`,
        };
        if (opts.notify) {
          await opts.notify(existsMessage(req, caller, receipt), { receipt, request: req }).catch(() => undefined);
        }
        return json(200, receipt);
      }
      const active = { ...(await opts.launcher.active()) };
      // An unsettled untriggered record already counts in `active`; it must not be refused for its own slot.
      if (existing && !existing.finishedAt) {
        active.runs = Math.max(0, active.runs - 1);
        active.sandboxes = Math.max(0, active.sandboxes - existing.sandboxes);
      }
      checkStartGuards(policy, req, caller, active, budget);
      await check?.(req.script);
      const capped: StartWorkflowRequest = { ...req, ...pick(startWorkflowCaps(policy, req, undefined, budget)) };
      const receipt = await opts.launcher.start(capped, caller);
      if (opts.notify) {
        await opts.notify(launchMessage(req, caller, receipt), { receipt, request: req }).catch(() => undefined);
      }
      return json(200, receipt);
    } catch (error) {
      return refusal(error);
    }
  };
}

function guard(rule: WorkflowGuardError["rule"], limit: string, requested: string): WorkflowGuardError {
  return new WorkflowGuardError({ rule, limit, requested });
}

function pick(caps: { maxSandboxes?: number; budgetUsd?: number }): Partial<StartWorkflowRequest> {
  return {
    ...(caps.maxSandboxes !== undefined ? { maxSandboxes: caps.maxSandboxes } : {}),
    ...(caps.budgetUsd !== undefined ? { budgetUsd: caps.budgetUsd } : {}),
  };
}
