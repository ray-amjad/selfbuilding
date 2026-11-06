import type { AgentRunContext } from "../agent/context.js";
import type { JournalEntry } from "../types/orchestration.js";
import type { SandboxRef } from "../types/sandbox.js";

// The sandbox registry row (spec §6.14 "Create path"): written to the journal before create, so the reaper can tell
// an owned box from an orphan. Plain Node only; hosted runs answer the same question from the host's run status.

export async function writeSandboxRow(
  ctx: AgentRunContext,
  row: { name: string; scope: string; status: JournalEntry["status"]; ref?: SandboxRef; size?: string },
): Promise<void> {
  const journal = ctx.journal;
  if (!journal) return;
  const existing = await journal.store.get(ctx.runId, row.name);
  const now = new Date().toISOString();
  const size = row.size ?? existing?.sandbox?.size;
  const entry: JournalEntry = {
    runId: ctx.runId,
    stepKey: row.name,
    callPath: row.scope,
    kind: "sandbox",
    status: row.status,
    launchId: `${row.name}_e${ctx.epoch}_l0`,
    sandbox: {
      boxId: row.scope,
      ...(row.ref ? { ref: row.ref } : existing?.sandbox?.ref ? { ref: existing.sandbox.ref } : {}),
      ...(size ? { size } : {}),
    },
    attempt: existing?.attempt ?? 1,
    startedAt: existing?.startedAt ?? now,
    ...(row.status === "started" ? {} : { finishedAt: now }),
  };
  await journal.store.put(entry, { lease: journal.lease, expectStatus: existing ? existing.status : null });
}
