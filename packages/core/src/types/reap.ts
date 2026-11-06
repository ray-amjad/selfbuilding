import type { AskStore } from "./ask.js";
import type { DeploymentId } from "./common.js";
import type { DurableHost } from "./host.js";
import type { JournalStore } from "./orchestration.js";
import type { SandboxProvider, SandboxRef } from "./sandbox.js";

export interface ReapOptions {
  /** Every provider the deployment uses. */
  providers: SandboxProvider[];
  /** Or the host memo reader on hosted deployments. */
  journal: JournalStore;
  /** Open asks hold their boxes. */
  asks: AskStore;
  /** Required on hosted deployments. */
  host?: DurableHost;
  deployment: DeploymentId;
  /** Report decisions, change nothing. */
  dryRun?: boolean;
}

export interface ReapDecision {
  sandbox: SandboxRef;
  action: "kill" | "pause" | "hold" | "extend" | "cancel-sentinel" | "callback";
  /** e.g. "owner-unknown", "orphan", "run-terminal". Every hold logs `skip [reason]`. */
  reason: string;
}

/** "0 killed" with errors is reported as such, never as a clean sweep. */
export interface ReapReport {
  killed: number;
  parked: number;
  held: number;
  leaked: number;
  errors: { provider: string; code: string; message: string }[];
  decisions: ReapDecision[];
}
