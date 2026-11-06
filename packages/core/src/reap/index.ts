import { errorCode } from "../agent/errors.js";
import { SELFBUILDING_LABELS } from "../sandbox/names.js";
import { probeTurnLock } from "../sandbox/runtime-client.js";
import type { AskRecord } from "../types/ask.js";
import type { JournalEntry } from "../types/orchestration.js";
import type { ReapDecision, ReapOptions, ReapReport } from "../types/reap.js";
import type { SandboxProvider, SandboxRef } from "../types/sandbox.js";

/** Boxes with no owner row younger than this are left alone: their create may still be landing (spec §5.9). */
export const ORPHAN_AGE_MS = 15 * 60_000;
/**
 * A call whose box is this far past its lifetime has lost its orchestrator (the dead-run closer, spec §5.9): the
 * box is stopped, never deleted, so a resume can still collect from it. Providers without a vendor TTL (Docker)
 * would otherwise run it forever.
 */
export const DEAD_RUN_GRACE_MS = 15 * 60_000;

type Owner =
  | { kind: "unknown"; reason: string }
  | { kind: "orphan" }
  | { kind: "run-terminal" }
  | { kind: "live"; row: JournalEntry; askOpen: boolean }
  | { kind: "terminal"; row: JournalEntry };

interface RunView {
  entries: JournalEntry[];
  asks: AskRecord[];
}

/**
 * Sweeps leaked sandboxes from the state of the world, never from events (spec §5.9, §7.8). Only positive evidence
 * destroys: an outage, an unknown owner or a BUSY/UNKNOWN turn lock always holds the box.
 */
export async function reap(opts: ReapOptions): Promise<ReapReport> {
  const report: ReapReport = { killed: 0, parked: 0, held: 0, leaked: 0, errors: [], decisions: [] };
  const runs = new Map<string, Promise<RunView | null>>();
  const viewOf = (runId: string): Promise<RunView | null> => {
    let view = runs.get(runId);
    if (!view) {
      view = (async () => {
        try {
          const entries: JournalEntry[] = [];
          for await (const entry of opts.journal.list(runId)) entries.push(entry);
          const asks: AskRecord[] = [];
          for await (const ask of opts.asks.open({ runId })) asks.push(ask);
          return { entries, asks };
        } catch {
          return null;
        }
      })();
      runs.set(runId, view);
    }
    return view;
  };

  for (const provider of opts.providers) {
    const refs: SandboxRef[] = [];
    try {
      for await (const ref of provider.list({ deployment: opts.deployment })) refs.push(ref);
    } catch (error) {
      // A listing outage is reported as such, never as "nothing running" (spec §6.14).
      report.errors.push({
        provider: provider.id,
        code: errorCode(error) ?? "sandbox_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const owners = new Map<SandboxRef, Owner>();
    for (const ref of refs) {
      if (ref.deployment === opts.deployment) owners.set(ref, await ownerOf(opts, ref, viewOf));
    }
    const kept = keptByName(refs, owners);
    for (const ref of refs) {
      const owner = owners.get(ref);
      if (!owner) continue;
      const name = ref.labels[SELFBUILDING_LABELS.name] ?? ref.name;
      const duplicate = kept.get(name) !== ref;
      const decision = decide(ref, owner, duplicate ? duplicateKind(ref, owner, kept.get(name)) : null);
      if (decision.action === "kill" && owner.kind !== "terminal") report.leaked++;
      await act(opts, provider, ref, decision, report);
    }
  }
  return report;
}

async function ownerOf(
  opts: ReapOptions,
  ref: SandboxRef,
  viewOf: (runId: string) => Promise<RunView | null>,
): Promise<Owner> {
  const runId = ref.labels[SELFBUILDING_LABELS.run];
  if (!runId) return { kind: "unknown", reason: "owner-unknown" };
  if (opts.host) {
    const hostRun = ref.labels[SELFBUILDING_LABELS.hostRun];
    if (!hostRun || !opts.host.runStatus) return { kind: "unknown", reason: "owner-unknown" };
    try {
      const status = await opts.host.runStatus(hostRun);
      if (status === "terminal" || status === "not-found") return { kind: "run-terminal" };
    } catch {
      return { kind: "unknown", reason: "owner-unknown" };
    }
  }
  const view = await viewOf(runId);
  if (!view) return { kind: "unknown", reason: "owner-unknown" };
  const runRow = view.entries.find((e) => e.kind === "run");
  const stepKey = ref.labels[SELFBUILDING_LABELS.step];
  const name = ref.labels[SELFBUILDING_LABELS.name] ?? ref.name;
  const row = view.entries.find((e) => (stepKey ? e.stepKey === stepKey : e.stepKey === name));
  if (!row) {
    if (runRow && runRow.status !== "started") return { kind: "run-terminal" };
    return opts.host ? { kind: "unknown", reason: "owner-unknown" } : { kind: "orphan" };
  }
  if (row.status === "started") {
    const askOpen = view.asks.some((a) => a.status === "open" && a.callPath === row.callPath);
    if (runRow && runRow.status !== "started" && !askOpen) return { kind: "run-terminal" };
    return { kind: "live", row, askOpen };
  }
  return { kind: "terminal", row };
}

/** A ghost a provider left behind after rebuilding a box under the same name (Docker renames it `.ghost-*`). */
function isGhost(ref: SandboxRef): boolean {
  return ref.name.includes(".ghost-") || String(ref.meta?.container ?? "").includes(".ghost-");
}

function journaledRefId(owner: Owner | undefined): string | undefined {
  if (owner?.kind !== "live" && owner?.kind !== "terminal") return undefined;
  return (owner.row.sandbox?.ref as SandboxRef | undefined)?.id;
}

/**
 * Which box of a name is the real one: the box the journal row points to, else the oldest box that is not a
 * known ghost, else the oldest. Keeping the oldest blindly would keep a ghost and kill the box that replaced it.
 */
function keptByName(refs: SandboxRef[], owners: Map<SandboxRef, Owner>): Map<string, SandboxRef> {
  const groups = new Map<string, SandboxRef[]>();
  for (const ref of refs) {
    if (!owners.has(ref)) continue;
    const name = ref.labels[SELFBUILDING_LABELS.name] ?? ref.name;
    groups.set(name, [...(groups.get(name) ?? []), ref]);
  }
  const kept = new Map<string, SandboxRef>();
  for (const [name, group] of groups) {
    const byAge = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const journaled = group.find((r) => journaledRefId(owners.get(r)) === r.id);
    kept.set(name, journaled ?? byAge.find((r) => !isGhost(r)) ?? (byAge[0] as SandboxRef));
  }
  return kept;
}

/** "superseded" when there is positive evidence this box is not the call's box; plain "duplicate" otherwise. */
function duplicateKind(ref: SandboxRef, owner: Owner, kept: SandboxRef | undefined): "superseded" | "duplicate" {
  if (isGhost(ref)) return "superseded";
  const journaled = journaledRefId(owner);
  return journaled !== undefined && journaled !== ref.id && journaled === kept?.id ? "superseded" : "duplicate";
}

function pastDeadline(ref: SandboxRef): boolean {
  const expiresAt = Date.parse(ref.labels[SELFBUILDING_LABELS.expiresAt] ?? "");
  return Number.isFinite(expiresAt) && Date.now() > expiresAt + DEAD_RUN_GRACE_MS;
}

/**
 * The table of spec §5.9 step 4, top to bottom; the first matching row applies. Owner rows that protect a box
 * (unknown, an open ask, a live call) come before the duplicate rule; only a box positively superseded by another
 * (a ghost, or not the box the journal names) is killed ahead of them.
 */
function decide(ref: SandboxRef, owner: Owner, duplicate: "superseded" | "duplicate" | null): ReapDecision {
  const at = (action: ReapDecision["action"], reason: string): ReapDecision => ({ sandbox: ref, action, reason });
  if (owner.kind === "unknown") return at("hold", owner.reason);
  if (duplicate === "superseded") return at("kill", "duplicate");
  if (owner.kind === "live") {
    if (owner.askOpen) return at(ref.state === "running" ? "extend" : "hold", "ask-open");
    if (pastDeadline(ref) && ref.state === "running") return at("pause", "call-past-deadline");
    return at("hold", "call-live");
  }
  if (duplicate) return at("kill", "duplicate");
  switch (owner.kind) {
    case "terminal":
      return at("kill", "call-terminal");
    case "run-terminal":
      return at("kill", "run-terminal");
    case "orphan": {
      const age = Date.now() - Date.parse(ref.createdAt);
      return age >= ORPHAN_AGE_MS ? at("kill", "orphan") : at("hold", "orphan-young");
    }
  }
}

async function act(
  opts: ReapOptions,
  provider: SandboxProvider,
  ref: SandboxRef,
  decision: ReapDecision,
  report: ReapReport,
): Promise<void> {
  report.decisions.push(decision);
  if (decision.action === "pause") {
    // Stopped only when no turn runs; never deleted, since nothing acked its outcome.
    const lock = await provider
      .open(ref, { lifetimeMs: 5 * 60_000 })
      .then((box) => probeTurnLock(box))
      .catch(() => "UNKNOWN" as const);
    if (lock !== "FREE") {
      report.decisions[report.decisions.length - 1] = {
        ...decision,
        action: "hold",
        reason: `turn-lock-${lock.toLowerCase()}`,
      };
      report.held++;
      return;
    }
    if (opts.dryRun) return;
    try {
      const outcome = await provider.pause(ref);
      if (outcome.confirmed) report.parked++;
      else {
        report.errors.push({
          provider: provider.id,
          code: "sandbox_unavailable",
          message: `pause of ${ref.id} was refused (${outcome.reason}); the box keeps running`,
        });
      }
    } catch (error) {
      report.errors.push({
        provider: provider.id,
        code: errorCode(error) ?? "sandbox_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (decision.action === "hold" || decision.action === "extend") {
    report.held++;
    if (decision.action === "extend" && !opts.dryRun) {
      try {
        const box = await provider.open(ref, { lifetimeMs: 15 * 60_000 });
        await box.extendLifetime(Date.now() + 15 * 60_000);
      } catch (error) {
        report.errors.push({
          provider: provider.id,
          code: errorCode(error) ?? "sandbox_unavailable",
          message: String(error),
        });
      }
    }
    return;
  }
  if (decision.action !== "kill") return;
  // Paused boxes are never probed (probing would wake them); a paused box runs no turn.
  if (ref.state !== "paused" && ref.state !== "stopped") {
    let lock: "FREE" | "BUSY" | "UNKNOWN" = "UNKNOWN";
    try {
      const box = await provider.open(ref, { lifetimeMs: 5 * 60_000 });
      lock = await probeTurnLock(box);
    } catch (error) {
      if (errorCode(error) === "sandbox_not_found") {
        decision.reason = `${decision.reason} (already gone)`;
        return;
      }
      lock = "UNKNOWN";
    }
    if (lock !== "FREE") {
      report.decisions[report.decisions.length - 1] = {
        ...decision,
        action: "hold",
        reason: `turn-lock-${lock.toLowerCase()}`,
      };
      report.held++;
      return;
    }
  }
  if (opts.dryRun) return;
  try {
    await provider.kill(ref);
    report.killed++;
  } catch (error) {
    report.errors.push({
      provider: provider.id,
      code: errorCode(error) ?? "sandbox_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
