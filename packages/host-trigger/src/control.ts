import type { AgentCallback, DeploymentId, Json, ResultStore, SandboxProvider } from "@selfbuilding/core";
import { SELFBUILDING_LABELS } from "@selfbuilding/core";
import { readRunRecord } from "./journal.js";
import { unsafeSegment, WAIT_GRACE_MS, wakeTokenKey } from "./keys.js";
import { isTerminalStatus, type TriggerSdk } from "./sdk.js";

// Operations that act on a run from outside its own wait: the reaper's repairs and cancellation (spec §7.8, §7.9).

export type HostRunStatus = "running" | "waiting" | "terminal" | "not-found";

function isNotFound(error: unknown): boolean {
  const e = error as { status?: unknown; message?: unknown } | null;
  if (e && e.status === 404) return true;
  return typeof e?.message === "string" && /not found|unknown run/i.test(e.message);
}

export async function hostRunStatus(sdk: TriggerSdk, hostRunId: string): Promise<HostRunStatus> {
  try {
    const run = await sdk.retrieveRun(hostRunId);
    if (isTerminalStatus(run.status)) return "terminal";
    return run.status === "WAITING" ? "waiting" : "running";
  } catch (error) {
    if (isNotFound(error)) return "not-found";
    throw error;
  }
}

/**
 * Completes the launch's armed token with the callback, then ticks the parent so it reconciles. The token comes
 * from its idempotency key, so this finds the one the child is waiting on (spec §7.8: `wait.completeToken`).
 */
export async function deliverCallback(sdk: TriggerSdk, store: ResultStore, cb: AgentCallback): Promise<void> {
  const token = await sdk.createToken({
    idempotencyKey: wakeTokenKey(cb.runId, cb.launchId, cb.rearm),
    timeoutMs: WAIT_GRACE_MS,
    tags: [cb.runId],
  });
  await sdk.completeToken(token.id, cb as unknown as Json);
  const parent = (await readRunRecord(store, cb.runId))?.hostRunIds.at(-1);
  if (parent) await sdk.sendWake(parent, { kind: "tick" }).catch(() => {});
}

export interface KillReport {
  killed: number;
  alreadyGone: number;
  /** A provider whose listing failed is reported, never counted as "0 killed". */
  errors: { provider: string; message: string }[];
}

/** Kills a run's sandboxes by label on every provider; `match` narrows it to one step. */
export async function killRunSandboxes(
  providers: readonly SandboxProvider[],
  deployment: DeploymentId,
  runId: string,
  match: (labels: Record<string, string>) => boolean = () => true,
): Promise<KillReport> {
  const report: KillReport = { killed: 0, alreadyGone: 0, errors: [] };
  for (const provider of providers) {
    try {
      for await (const ref of provider.list({ deployment, runId })) {
        if (ref.labels[SELFBUILDING_LABELS.run] !== undefined && ref.labels[SELFBUILDING_LABELS.run] !== runId)
          continue;
        if (!match(ref.labels)) continue;
        const result = await provider.kill(ref);
        if (result.path === "killed") report.killed += 1;
        else report.alreadyGone += 1;
      }
    } catch (error) {
      report.errors.push({ provider: provider.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

/** Cancels every registered child under a prefix that has not finished. Returns the child run ids it cancelled. */
export async function cancelChildren(
  sdk: TriggerSdk,
  store: ResultStore,
  prefix: string,
  keep: (name: string) => boolean = () => false,
): Promise<{ name: string; childRunId: string }[]> {
  const cancelled: { name: string; childRunId: string }[] = [];
  for await (const key of store.list(prefix)) {
    const name = unsafeSegment(key.slice(prefix.length, -".json".length));
    if (keep(name)) continue;
    const row = await store.get<{ childRunId: string }>(key);
    if (!row) continue;
    const run = await sdk.retrieveRun(row.childRunId).catch(() => null);
    if (!run || isTerminalStatus(run.status)) continue;
    await sdk.cancelRun(row.childRunId);
    cancelled.push({ name, childRunId: row.childRunId });
  }
  return cancelled;
}
