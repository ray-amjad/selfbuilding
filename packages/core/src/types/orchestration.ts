import type { z } from "zod";
import type { ArtifactStore, Usage } from "./artifacts.js";
import type { AskStore, HitlOptions, NotifyOptions } from "./ask.js";
import type { Budget } from "./budget.js";
import type { Duration, Effort } from "./common.js";
import type { SelfbuildingConfig } from "./config.js";
import type { EventSink, SelfbuildingEvent } from "./events.js";
import type { Harness } from "./harness.js";
import type { DurableHost, ResultStore } from "./host.js";
import type { Checkpoint, SandboxProvider, SandboxRef } from "./sandbox.js";
import type { SizeName } from "./sizes.js";

// Factories, runs, primitives and the journal (spec §1.8, §3).

export interface ConcurrencyOptions {
  /** Live sandboxes, not agents. Default min(4, provider.limits.maxConcurrent). */
  sandboxes?: number;
  /** May lower the provider's create rate. */
  createsPerMinute?: number;
}

export interface FactoryOptions<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  input: I;
  output?: O;
  defaults?: {
    harness?: Harness;
    sandbox?: SandboxProvider;
    effort?: Effort;
    repo?: string;
    timeout?: Duration;
    size?: SizeName;
  };
  budget?: Budget;
  concurrency?: ConcurrencyOptions;
  hitl?: HitlOptions;
}

/**
 * A factory: callable from another factory body (one level deep) and passed to `run()` or a host.
 * Calling it outside a running factory throws NoActiveRunError.
 */
export interface Factory<I, O> {
  (input: I): Promise<O>;
  readonly name: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema?: z.ZodType<O>;
  readonly options: FactoryOptions<z.ZodType<I>, z.ZodType<O>>;
  /** The body as written, for hosts. Do not call directly; use run(). */
  readonly body: (input: I) => Promise<O>;
}

export type InterruptedPolicy = "fail" | "resume-session" | "restore-and-rerun" | "skip";

export interface RunOptions {
  runId?: string;
  config?: SelfbuildingConfig;
  /** Ignored on durable hosts. */
  journal?: JournalStore;
  artifacts?: ArtifactStore;
  budget?: Budget;
  concurrency?: ConcurrencyOptions;
  hitl?: HitlOptions;
  notify?: NotifyOptions;
  events?: EventSink[];
  strict?: boolean;
  /** callPaths to force live; an entry ending in "/" is a prefix. */
  refresh?: string[];
  /** Default "fail"; per-callPath overrides accept the shared-handle policies too. */
  onInterrupted?: "fail" | "resume-session" | Record<string, InterruptedPolicy>;
  signal?: AbortSignal;
  /** The durable host driving this run. Absent: the built-in plain Node host. Hosted adapters pass their own. */
  host?: DurableHost;
}

export type RunStatus = "ok" | "partial" | "failed" | "budget_exhausted" | "aborted" | "needs_attention" | "waiting";

export interface RunOutcome<O> {
  runId: string;
  status: RunStatus;
  output: O | null;
  usage: Usage;
  /** The original cost of calls served from the journal. */
  replayedUsd: number;
  events: SelfbuildingEvent[];
}

export interface StageContext<T> {
  item: T;
  index: number;
  key: string;
}

export type Stage<In, Out, T> = (prev: In, ctx: StageContext<T>) => Promise<Out | null>;

export interface PipelineOptions<T> {
  /** The item's [key] segment; default: the index. Must be unique. */
  key?: (item: T) => string;
  /** Items active at once; default: limited only by concurrency.sandboxes. */
  maxInFlight?: number;
  label?: string;
}

/** The loose argument form behind the typed `pipeline()` overloads. */
export type PipelineArgs =
  | [items: readonly unknown[], ...stages: Stage<unknown, unknown, unknown>[]]
  | [opts: PipelineOptions<unknown>, items: readonly unknown[], ...stages: Stage<unknown, unknown, unknown>[]];

export type ThunkList = readonly (() => Promise<unknown>)[];
export type ThunkRecord = Record<string, () => Promise<unknown>>;

export type LogLevel = "debug" | "info" | "warn" | "error";

// Journal (spec §3.9). The one JournalStore interface, with a fenced lease.

export interface JournalEntry {
  runId: string;
  stepKey: string;
  callPath: string;
  kind: "agent" | "step" | "exec" | "sandbox" | "clock" | "charge" | "run";
  status: "started" | "ok" | "failed";
  /** Feeds the chain head (spec §3.2). */
  launchId: string;
  /** AgentResult (blobs by reference), step value, exec result. */
  value?: unknown;
  sandbox?: { boxId: string; ref?: SandboxRef; harnessSessionId?: string; pid?: number; size?: string };
  /** Set when the harness process launched. */
  harnessStartedAt?: string;
  /** Shared-handle calls only. */
  checkpointAfter?: Checkpoint;
  /** kind "charge". */
  charge?: { usd: number; tokens: number; turn: number; cumulative: true };
  attempt: number;
  startedAt: string;
  finishedAt?: string;
}

/** `leaseEpoch` strictly increases per runId. */
export interface Lease {
  owner: string;
  leaseEpoch: number;
  expiresAt: string;
  /** The run the lease fences. Set by the store, so `renew` and `assertLease` need no separate run id. */
  runId?: string;
}

export interface JournalStore {
  get(runId: string, stepKey: string): Promise<JournalEntry | null>;
  list(runId: string): AsyncIterable<JournalEntry>;
  /** Single writer. */
  lease(runId: string, owner: string, ttl: Duration): Promise<Lease | null>;
  /** null: lost. */
  renew(lease: Lease): Promise<Lease | null>;
  /** Throws LeaseLostError. */
  assertLease(lease: Lease): Promise<void>;
  /** Compare-and-set, fenced by the lease. `expectStatus: null` means "must not exist". */
  put(entry: JournalEntry, opts: { lease: Lease; expectStatus?: JournalEntry["status"] | null }): Promise<boolean>;
  /** The ask store backed by the same storage (spec §8.3: asks default to the journal's backing store). */
  readonly asks?: AskStore;
  /** Outcome, fence and accept records kept beside the journal, so a resumed process can reattach (spec §7.10). */
  readonly results?: ResultStore;
  /** Gives the lease up early on a clean exit, so a resume need not wait for it to expire. */
  release?(lease: Lease): Promise<void>;
}

/** Options of `sqliteJournal(path, opts?)` (release-prep §1). */
export interface SqliteJournalOptions {
  /** How long a write waits for another process's lock before failing. Default 5000 ms (SQLite `busy_timeout`). */
  busyTimeoutMs?: number;
}
