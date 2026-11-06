import type { RunStatus } from "@selfbuilding/core";

/** Exit codes (spec §1.12). Changing one is a breaking CLI change. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  partial: 3,
  budgetExhausted: 4,
  needsAttention: 5,
  waiting: 6,
  aborted: 7,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const BY_STATUS: Record<RunStatus, ExitCode> = {
  ok: EXIT.ok,
  failed: EXIT.failed,
  partial: EXIT.partial,
  budget_exhausted: EXIT.budgetExhausted,
  needs_attention: EXIT.needsAttention,
  waiting: EXIT.waiting,
  aborted: EXIT.aborted,
};

export function exitForStatus(status: RunStatus): ExitCode {
  return BY_STATUS[status];
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && Object.hasOwn(BY_STATUS, value);
}
