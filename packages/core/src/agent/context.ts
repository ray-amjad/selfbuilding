import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { nodeHost } from "../host-node/index.js";
import { memoryArtifactStore, memoryResultStore } from "../host-node/stores.js";
import { base32, canonicalJson, sha256 } from "../sandbox/hash.js";
import type { ArtifactStore, Usage } from "../types/artifacts.js";
import type { AskResolution, AskSpec } from "../types/ask.js";
import type { Duration, Effort } from "../types/common.js";
import type { SelfbuildingConfig } from "../types/config.js";
import type { SelfbuildingEvent } from "../types/events.js";
import type { Harness } from "../types/harness.js";
import type { DurableHost, ResultStore } from "../types/host.js";
import type { JournalStore, Lease, RunOptions } from "../types/orchestration.js";
import type { SandboxProvider, SandboxRef } from "../types/sandbox.js";
import type { SizeName } from "../types/sizes.js";

// The seam between the engine (run, scopes, journal, budget) and agent calls. The engine registers a resolver
// that returns the context of the scope the caller is in; with no resolver, or outside a run, an agent call or
// a sandbox handle runs as a standalone one-step run (spec §1.8, §2.5.1).

/** What feeds a step key (spec §3.2), minus the chain head the context owns. */
export interface StepIdentity {
  callPath: string;
  /** Skill hash, sha256 of an inline prompt, or a step name. */
  target: string;
  input: unknown;
  /** Hash of the result JSON Schema. */
  schema: string;
  /** Harness id + version policy, model, effort. */
  exec: unknown;
  /** "fresh" + provider id, or `{ boxId, prevCheckpointStepKey }`. */
  sandbox: unknown;
}

export interface FactoryDefaults {
  harness?: Harness;
  sandbox?: SandboxProvider;
  effort?: Effort;
  repo?: string;
  timeout?: Duration;
  size?: SizeName;
}

/** An event before the envelope's counters are filled in. */
export interface PartialEvent {
  type: string;
  level?: SelfbuildingEvent["level"];
  callPath?: string;
  launchId?: string;
  attempt?: number;
  data?: Record<string, unknown>;
}

/** Hands an agent's `ask_human` to the ask module (owner: core-ask) and returns the answer to deliver. */
export interface AgentAskBridge {
  /** Resolves with the answer to deliver hot, or "cold" when the ask moved to a cold wait. */
  handle(req: {
    runId: string;
    callPath: string;
    launchId: string;
    askSeq: number;
    spec: AskSpec;
    signal?: AbortSignal;
    /** The harness's MCP tool timeout and whether it can resume a session; they decide hot or cold (spec §8.4). */
    harness?: { mcpToolTimeoutMs: number | null; canResume: boolean };
    /** Shared handles are hot-only. */
    sharedHandle?: boolean;
  }): Promise<{ kind: "answer"; resolution: AskResolution } | { kind: "cold"; askId?: string }>;
  /** Waits out a cold ask: its resolution and the message that resumes the session with it. */
  awaitCold?(
    askId: string,
    /** Recorded on the ask before the wait, so a restarted host finds the parked box and session (demo-path §6). */
    cold?: { sandbox?: SandboxRef; sessionId?: string; launch?: number },
  ): Promise<{ resolution: AskResolution; message: string }>;
}

/** Held sandbox slots (spec §3.12). A holder marks itself idle between mutations and may offer a parker. */
export interface SlotLease {
  release(): void;
  /** Busy while a turn or exec runs; the deadlock breaker looks only at idle holders. */
  setBusy?(busy: boolean): void;
  /** Parks the holder's box and releases its slot to break a deadlock; resolves true when it did. */
  setParker?(park: (() => Promise<boolean>) | null): void;
}

/** A reserved slice of the run budget (spec §9.6). */
export interface BudgetSlice {
  usd?: number;
  /** `launchId` is the launch that produced the value, so a replay on resume does not count the spend twice. */
  release(spentUsd: number | null, launchId?: string): void;
  /**
   * Records the cumulative spend of one turn of one launch while the call runs (spec §3.9): a crash then still
   * counts what the attempt spent. Once any turn was charged, `release` adds no summary charge.
   */
  charge?(c: { launchId: string; turn: number; usd?: number; tokens?: number; final?: boolean }): Promise<void>;
}

export interface AgentRunContext {
  readonly runId: string;
  readonly deployment: string;
  readonly epoch: number;
  readonly config: SelfbuildingConfig;
  readonly defaults: FactoryDefaults;
  readonly host: DurableHost;
  /** Plain Node only: the fenced journal. Hosted runs use the host memo instead. */
  readonly journal?: { store: JournalStore; lease: Lease };
  readonly artifacts: ArtifactStore;
  /** Outcome records, accept records, the success cache and fences (spec §7.10). */
  readonly results: ResultStore;
  readonly signal?: AbortSignal;
  /** Registers secret values delivered to a box, so the run's events and `redactForRun` scrub them. */
  noteSecrets?(values: readonly string[]): void;
  readonly onInterrupted?: RunOptions["onInterrupted"];
  readonly asks?: AgentAskBridge;
  /** The sequential scope the caller is in. */
  readonly scopeId: string;
  /** False when the caller runs in a concurrent branch (parallel child, pipeline item) the owner scope did not create. */
  handleUsable(ownerScopeId: string): boolean;
  emit(event: PartialEvent): void;
  /** Reserves the callPath for a call in the current scope: the label, or `${name}#${n}`. */
  nextCallPath(name: string, label?: string): string;
  /** The step key for a call in the current scope (spec §3.2). */
  stepKey(identity: StepIdentity): string;
  /** Moves the scope's chain head after a call returned the value of `launchId`. */
  advanceChain(stepKey: string, launchId: string): void;
  admit?(callPath: string, requestedUsd: number | undefined): Promise<BudgetSlice>;
  /** Takes n slots at once. `each` holds one lease per slot, so a fork child owns exactly one. */
  acquireSlots?(callPath: string, n: number): Promise<SlotLease & { each?: SlotLease[] }>;
  /** Registers a handle the run disposes when it ends. */
  ownHandle?(handle: AsyncDisposable): void;
  /** Leaves the chain head unchanged for a call that ended without a value (a usage error before launch). */
  abandonChain?(stepKey: string): void;
  /** Adds a finished call's usage to the run total; replayed calls count toward `replayedUsd` instead. */
  noteUsage?(usage: Usage, replayed: boolean): void;
  /** An interrupted call that was not re-run: the run ends `needs_attention` (spec §3.10). */
  markNeedsAttention?(callPath: string): void;
}

let resolver: (() => AgentRunContext | undefined) | undefined;

/** Called once by the engine so agent calls and handles find the ambient run. */
export function setAgentContextResolver(fn: (() => AgentRunContext | undefined) | undefined): void {
  resolver = fn;
}

export function currentAgentContext(): AgentRunContext | undefined {
  return resolver?.();
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** `ns_` + a lowercase ULID (spec §7.2). */
export function newRunId(nowMs = Date.now()): string {
  let time = "";
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[(rand[i] ?? 0) % 32];
  return `ns_${time}${tail}`;
}

export function defaultDeployment(config: SelfbuildingConfig): string {
  if (config.deployment) return config.deployment;
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "host";
  // The CLI computes the same value, so `reap` and `cancel` list the deployment the run labelled its boxes with.
  return `local-${host}`.slice(0, 32).replace(/-+$/, "");
}

/** `base32lower(sha256(canonicalJson({ v: 1, ...identity, chain, refresh })))[:26]`. */
export function computeStepKey(identity: StepIdentity, chain: string, refresh: string | null = null): string {
  return base32(sha256(canonicalJson({ v: 1, ...identity, chain, refresh }))).slice(0, 26);
}

export interface StandaloneOptions {
  runId?: string;
  config?: SelfbuildingConfig;
  signal?: AbortSignal;
  events?: SelfbuildingEvent[];
}

/**
 * A one-step run for an agent called outside a factory, or a handle opened outside one. It keeps its own chain
 * head and counters, so several calls on the same standalone handle still get distinct, stable keys.
 */
export function standaloneContext(opts: StandaloneOptions = {}): AgentRunContext {
  const config = opts.config ?? {};
  const runId = opts.runId ?? newRunId();
  const counters = new Map<string, number>();
  const labels = new Set<string>();
  let chain = "";
  let seq = 0;
  const results = memoryResultStore();
  const sinks = config.events ?? [];
  const ctx: AgentRunContext = {
    runId,
    deployment: defaultDeployment(config),
    epoch: 0,
    config,
    defaults: {},
    host: nodeHost({ runId }),
    artifacts: config.artifacts ?? memoryArtifactStore(),
    results,
    ...(opts.signal ? { signal: opts.signal } : {}),
    scopeId: "root",
    handleUsable: () => true,
    emit(e) {
      const event: SelfbuildingEvent = {
        v: 1,
        runId,
        callPath: e.callPath ?? "run",
        launchId: e.launchId ?? "epoch-0",
        attempt: e.attempt ?? 0,
        seq: seq++,
        ts: new Date().toISOString(),
        traceId: runId,
        type: e.type,
        level: e.level ?? "info",
        ...(e.data ? { data: e.data } : {}),
      };
      opts.events?.push(event);
      for (const sink of sinks) {
        try {
          sink(event);
        } catch {
          // Sinks are fail-soft (spec §9.7).
        }
      }
    },
    nextCallPath(name, label) {
      if (label !== undefined) {
        labels.add(label);
        return label;
      }
      const n = counters.get(name) ?? 0;
      counters.set(name, n + 1);
      return `${name}#${n}`;
    },
    stepKey: (identity) => computeStepKey(identity, chain),
    advanceChain(stepKey, launchId) {
      chain = sha256(`${stepKey}:${launchId}`).toString("hex");
    },
  };
  return ctx;
}
