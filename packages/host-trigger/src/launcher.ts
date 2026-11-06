import {
  type Json,
  type ResultStore,
  resolveStartPolicy,
  type ScriptRunInput,
  type SelfbuildingConfig,
  type StartWorkflowCaller,
  type StartWorkflowReceipt,
  type StartWorkflowRequest,
  startWorkflowCaps,
  type WorkflowLauncher,
  type WorkflowRunStatus,
  workflowRunId,
} from "@selfbuilding/core";
import { FACTORY_TASK_ID } from "./keys.js";
import type { FactoryRunLimits, FactoryTaskPayload } from "./parent.js";
import { isTerminalStatus, type TriggerSdk } from "./sdk.js";

// start_workflow on Trigger.dev (docs/spec/demo-path.md §9.4). Owner: start-workflow.

/** Every agent-launched run carries this tag. */
export const AGENT_LAUNCHED_TAG = "selfbuilding:agent-launched";
/** The deployed factory start_workflow launches (`SCRIPT_FACTORY_NAME` in @selfbuilding/script). */
const SCRIPT_FACTORY = "run-script";

export interface TriggerWorkflowLauncherOptions {
  trigger: TriggerSdk;
  /** Where launches are recorded, so `active()` and `status()` work without listing Trigger runs. */
  store: ResultStore;
  /** For the size table the launched run's caps are cut from. */
  config?: Pick<SelfbuildingConfig, "sizes" | "startWorkflow">;
  /** A dashboard link for the receipt. */
  dashboardUrl?: (hostRunId: string) => string;
}

interface LaunchRecord {
  runId: string;
  name: string;
  size: string;
  maxSandboxes: number;
  launchedBy: StartWorkflowCaller;
  startedAt: string;
  afk?: boolean;
  hostRunId?: string;
  finishedAt?: string;
  status?: WorkflowRunStatus["status"];
}

const keyOf = (runId: string) => `workflows/${runId}`;

/** A record that never got its host run id: the trigger failed, or the process died before it was written. */
const UNTRIGGERED_TTL_MS = 10 * 60_000;
const asJson = (record: LaunchRecord): Json => record as unknown as Json;

async function readRecord(store: ResultStore, runId: string): Promise<{ value: LaunchRecord; version: string } | null> {
  const got = await store.getVersioned<Json>(keyOf(runId));
  return got ? { value: got.value as unknown as LaunchRecord, version: got.version } : null;
}

function runStatusOf(trigger: string, output: unknown): WorkflowRunStatus["status"] {
  if (!isTerminalStatus(trigger)) return "running";
  const status = (output as { status?: unknown } | undefined)?.status;
  if (trigger === "COMPLETED" && typeof status === "string") return status as WorkflowRunStatus["status"];
  return trigger === "CANCELED" ? "aborted" : "failed";
}

/** The engine limits a launched run gets, so its sandbox slots and budget match what start_workflow approved. */
function runLimits(caps: ReturnType<typeof startWorkflowCaps>): FactoryRunLimits {
  return {
    ...(caps.maxSandboxes !== undefined ? { sandboxes: caps.maxSandboxes } : {}),
    ...(caps.budgetUsd !== undefined ? { budgetUsd: caps.budgetUsd } : {}),
  };
}

/** Launches the `run-script` factory as a Trigger.dev task run, with the run id fixed up front. */
export function triggerWorkflowLauncher(opts: TriggerWorkflowLauncherOptions): WorkflowLauncher {
  const { trigger, store } = opts;
  const policy = resolveStartPolicy(opts.config?.startWorkflow);

  const refresh = async (record: LaunchRecord): Promise<LaunchRecord> => {
    if (record.finishedAt) return record;
    if (!record.hostRunId) {
      // Left behind by a trigger that never happened; it must not hold a run and its sandboxes for ever.
      if (trigger.now() - Date.parse(record.startedAt) < UNTRIGGERED_TTL_MS) return record;
      return markFailed(record);
    }
    const view = await trigger.retrieveRun(record.hostRunId);
    const status = runStatusOf(view.status, view.output);
    if (status === "running") return record;
    const done: LaunchRecord = { ...record, status, finishedAt: new Date(trigger.now()).toISOString() };
    const current = await readRecord(store, record.runId);
    if (current) await store.replace(keyOf(record.runId), asJson(done), current.version);
    return done;
  };

  const markFailed = async (record: LaunchRecord): Promise<LaunchRecord> => {
    const done: LaunchRecord = { ...record, status: "failed", finishedAt: new Date(trigger.now()).toISOString() };
    const current = await readRecord(store, record.runId);
    if (current && !current.value.hostRunId && !current.value.finishedAt) {
      await store.replace(keyOf(record.runId), asJson(done), current.version);
    }
    return done;
  };

  return {
    host: "trigger",

    async start(req: StartWorkflowRequest, caller: StartWorkflowCaller): Promise<StartWorkflowReceipt> {
      const runId = workflowRunId(caller, req);
      const caps = startWorkflowCaps(policy, req, opts.config);
      const record: LaunchRecord = {
        runId,
        name: req.name,
        size: req.size ?? "small",
        maxSandboxes: caps.maxSandboxes ?? policy.maxSandboxesPerRun,
        launchedBy: caller,
        startedAt: new Date(trigger.now()).toISOString(),
        ...(req.afk ? { afk: true } : {}),
      };
      let fresh = await store.createIfAbsent(keyOf(runId), asJson(record));
      if (!fresh) {
        // A launch whose trigger failed earlier is started again, not reported as an existing run.
        const prior = await readRecord(store, runId);
        if (prior && !prior.value.hostRunId && prior.value.status === "failed") {
          fresh = await store.replace(keyOf(runId), asJson(record), prior.version);
        }
      }
      const input: ScriptRunInput = {
        source: req.script,
        input: req.input ?? {},
        name: req.name,
        caps,
        launchedBy: caller,
      };
      // Same idempotency key as the run id: a retry after a crash between record and trigger reattaches.
      let handle: { id: string };
      try {
        handle = await trigger.trigger(
          FACTORY_TASK_ID,
          {
            factory: SCRIPT_FACTORY,
            input: input as unknown as Json,
            runId,
            limits: runLimits(caps),
            ...(req.afk ? { afk: true } : {}),
          } satisfies FactoryTaskPayload as unknown as Json,
          { idempotencyKey: runId, tags: [AGENT_LAUNCHED_TAG] },
        );
      } catch (error) {
        await markFailed(record).catch(() => undefined);
        throw error;
      }
      const current = await readRecord(store, runId);
      if (current && !current.value.hostRunId) {
        await store.replace(keyOf(runId), asJson({ ...current.value, hostRunId: handle.id }), current.version);
      }
      return {
        runId,
        status: fresh ? "started" : "exists",
        host: "trigger",
        watch: `selfbuilding watch ${runId}`,
        ...(opts.dashboardUrl ? { url: opts.dashboardUrl(handle.id) } : {}),
      };
    },

    async active(): Promise<{ runs: number; sandboxes: number }> {
      let runs = 0;
      let sandboxes = 0;
      for await (const key of store.list("workflows/")) {
        const record = (await store.get<Json>(key)) as unknown as LaunchRecord | null;
        if (!record || record.finishedAt) continue;
        const now = await refresh(record);
        if (now.finishedAt) continue;
        runs++;
        // The run's sandbox cap, not its live count: Trigger.dev does not tell us how many boxes a task holds.
        sandboxes += now.maxSandboxes;
      }
      return { runs, sandboxes };
    },

    async status(runId: string): Promise<WorkflowRunStatus | null> {
      const stored = (await store.get<Json>(keyOf(runId))) as unknown as LaunchRecord | null;
      if (!stored) return null;
      const record = await refresh(stored);
      return {
        runId,
        status: record.status ?? "running",
        name: record.name,
        agents: [],
        sandboxes: record.finishedAt ? 0 : record.maxSandboxes,
        launchedBy: record.launchedBy,
        startedAt: record.startedAt,
        ...(record.afk ? { afk: true } : {}),
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        ...(record.hostRunId ? {} : { untriggered: true as const }),
      };
    },
  };
}
