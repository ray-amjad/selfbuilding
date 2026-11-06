import type { SerializedSelfbuildingError } from "../errors/codes.js";
import type { Agent } from "./agent.js";
import type { AgentArtifacts, Usage } from "./artifacts.js";
import type { AskRecord, AskResolution, AskStore, HostId } from "./ask.js";
import type { Json } from "./common.js";
import type { SelfbuildingConfig } from "./config.js";
import type { Harness } from "./harness.js";
import type { Factory } from "./orchestration.js";
import type { SandboxProvider, SandboxRef } from "./sandbox.js";

// Durability and hosts (spec §7).

/** "ns_" + lowercase ULID when generated; user ids match ^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$. */
export type RunId = string;
/** 0 on the first host run; +1 per resume after a terminal failure. */
export type Epoch = number;
/** 26 chars, base32 (spec §3.2). */
export type StepKey = string;
export type HostKey = `${StepKey}_e${Epoch}`;
export type LaunchId = `${HostKey}_l${number}`;
/** e.g. "pipeline#0/[issue-412]/stage#1/ImplementSpec#0". */
export type CallPath = string;

export interface HostLimits {
  /** Larger values go to the artifact store by reference. */
  maxStepOutputBytes: number;
  maxStepsPerRun?: number;
  maxWaitMs?: number;
  /** false on Trigger.dev; the parent scheduler multiplexes. */
  parallelWaits: boolean;
}

export type CallbackTarget =
  | { kind: "url"; url: string; headers?: Record<string, string> }
  | { kind: "event"; endpoint: string; eventKey: string; token: string };

export interface StepOpts {
  /** "agent" | "step" | "exec" | "sandbox" | "clock" | "charge". */
  kind?: string;
  callPath?: string;
  retries?: number;
}

/** A factory as a host can start it: by name, with its loaded definition. */
export interface FactoryRef<I, O> {
  name: string;
  factory: Factory<I, O>;
}

/** The host adapter contract (spec §7.3). Factory authors never touch it; the primitives do. */
export interface DurableHost {
  readonly id: "node" | "trigger" | "inngest" | "cloudflare-workflows";
  readonly limits: HostLimits;
  readonly epoch: Epoch;
  /** Runs fn at most once to completion per key within this epoch. On replay, returns the stored value. */
  step<T extends Json>(key: string, fn: () => Promise<T>, opts?: StepOpts): Promise<T>;
  /**
   * Suspends until a callback for `launchId` arrives or `timeoutMs` passes. `register` receives the
   * host-specific target and must hand it to the sandbox before the wait begins.
   */
  waitForCallback<T extends Json>(
    launchId: LaunchId,
    opts: { timeoutMs: number; rearm: number; register: (target: CallbackTarget) => Promise<void> },
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" }>;
  sleep(key: string, ms: number): Promise<void>;
  /** Plain Promise.all works on every host. */
  all<T>(branches: Array<() => Promise<T>>): Promise<T[]>;
  /** A nested factory as a child run. Never a blocking wait in the parent. */
  child<I, O>(key: string, factory: FactoryRef<I, O>, input: I): Promise<O>;
  /** Used by the reaper on hosted deployments. */
  runStatus?(hostRunId: string): Promise<"running" | "waiting" | "terminal" | "not-found">;
  /**
   * Hosts that run launch, wait and collect away from the factory process (Trigger.dev, spec §7.5.1) set this.
   * It resolves with the call's raw outcome; the caller runs accept. Absent: the caller drives the lifecycle itself.
   */
  dispatchAgent?(call: HostAgentCall): Promise<RawOutcome>;
  /**
   * A factory-side `ask()` wait (spec §8.5). Resolves with the record once it is no longer open, or null when
   * `timeoutMs` passes first. The answer is always read from the ask store, never from the wake.
   */
  waitForAsk?(askId: string, opts: { timeoutMs: number }): Promise<AskRecord | null>;
  /** Wakes a launch's armed wait from outside it: the reaper's synthetic `finished` or `lost`, or a cancel (spec §7.8). */
  deliverCallback?(cb: AgentCallback): Promise<void>;
}

/** One agent call as a durable host dispatches it (spec §7.5.1 child payload). Plain JSON; no closure crosses. */
export interface HostAgentCall {
  runId: RunId;
  epoch: Epoch;
  stepKey: StepKey;
  callPath: CallPath;
  /** The launch attempt this dispatch starts at; its LaunchId is `${stepKey}_e${epoch}_l${launch}`. */
  launch: number;
  /**
   * Core-owned description of the call: skill reference or inline prompt, input, result JSON Schema, `cmd` and
   * `judge` checks, harness, model, placement and budget slice. Hosts never read it.
   */
  spec: Json;
  /** Set on follow-up launches: a host-side check retry or an interrupted-turn resume (spec §7.4.4, §7.6). */
  resume?: { message: string; sessionId?: string };
}

/** An `ask_human` call a launch is blocked on, as the driver reports it (spec §8.4). */
export interface PendingAgentAsk {
  askId: string;
  /** The ask's own timeout; the host's wait on the answer never outlives it. */
  timeoutMs: number;
}

/** What the host learns when it reconciles a launch from the sandbox (spec §6.6, §7.4.2). */
export type LaunchProbeState =
  /** outcome.json exists for this launch: collect. */
  | { state: "outcome" }
  /** Hot ask: the tool call is blocked and the sandbox is up. */
  | { state: "ask"; ask: PendingAgentAsk }
  /** Cold ask: the turn ended waiting for a human; resume it as a new launch with the answer. */
  | { state: "suspended"; ask: PendingAgentAsk }
  /** The turn lock is held: the wake was premature or stale. */
  | { state: "busy" }
  /** The turn lock is free and there is no outcome: the turn is interrupted. */
  | { state: "free" }
  /** The sandbox is positively gone. */
  | { state: "gone" }
  /** The probe could not tell (timeout, 5xx). Never treated as gone. */
  | { state: "unknown" };

export type AgentLaunchResult =
  | { kind: "launched"; record: LaunchRecord }
  /** An outcome record already exists for this launch: nothing was created or started. */
  | { kind: "settled"; outcome: RawOutcome };

/**
 * The serialisable half of an agent call: launch, reconcile and collect (spec §7.4.1–§7.4.3), plus the
 * agent-side ask steps (§8.4). Core implements it; a host whose accept runs elsewhere drives it. Every method
 * is idempotent, because a host retry runs it again from the top.
 */
export interface AgentCallDriver {
  launch(call: HostAgentCall, launchId: LaunchId, opts?: { answer?: AskResolution }): Promise<AgentLaunchResult>;
  /** Hands the sandbox this armed wait's wake target (wake.json, mode 0600) before the wait begins. */
  registerWake(
    call: HostAgentCall,
    record: LaunchRecord,
    wake: { rearm: number; target: CallbackTarget },
  ): Promise<void>;
  probe(call: HostAgentCall, record: LaunchRecord): Promise<LaunchProbeState>;
  collect(call: HostAgentCall, record: LaunchRecord): Promise<RawOutcome>;
  /** Writes the cancel sentinel; the runtime stops the harness and writes its outcome. */
  stop(call: HostAgentCall, record: LaunchRecord, reason: string): Promise<void>;
  /** The failure value for a turn that cannot be collected (AgentInterruptedError with its recovery data). */
  interrupted(
    call: HostAgentCall,
    record: LaunchRecord,
    reason: "lock-free" | "gone" | "unknown" | "wait-timeout",
  ): Promise<RawOutcome>;
  /**
   * Creates the ask record with this waitpoint, then posts it (store first). Returns the resolution when the
   * ask was already answered.
   */
  openAsk(
    call: HostAgentCall,
    record: LaunchRecord,
    askId: string,
    waitpoint: { host: HostId; ref: string },
  ): Promise<AskResolution | null>;
  /** The ask store's answer, read after every wait returns. */
  readAnswer(askId: string): Promise<AskResolution | null>;
  /** Hot ask: writes inbox/<askId>.json so the blocked tool call returns. */
  deliverAnswer(call: HostAgentCall, record: LaunchRecord, resolution: AskResolution): Promise<void>;
  /** The ask's wait timed out: applies the AFK policy (§8.8). */
  expireAsk(
    call: HostAgentCall,
    record: LaunchRecord,
    askId: string,
  ): Promise<{ resolution: AskResolution } | { outcome: RawOutcome }>;
}

/** What core's `agentCallDriver()` needs (demo-path §5). */
export interface AgentCallDriverDeps {
  config: SelfbuildingConfig;
  store: ResultStore;
  asks: AskStore;
  /**
   * Providers and harnesses a call may name besides `config.sandbox` and `config.harness`, looked up by id. A call
   * naming an id found in neither fails with ConfigError (demo-path §5).
   */
  registry?: { providers?: SandboxProvider[]; harnesses?: Harness[] };
  /** Compiled agents whose skills a call may name. Unlisted skills load from the folder the parent loaded them from. */
  // biome-ignore lint/suspicious/noExplicitAny: agents of any input and output type are accepted.
  agents?: Agent<any, any>[];
  /** The host's durable wait for an agent ask, created before the ask is posted (spec §8.5). Default: the ask id. */
  askWaitpoint?: { host: HostId; create(askId: string, expiresAt: string): Promise<string> };
}

/** What launch returns (spec §7.4). Plain JSON. */
export interface LaunchRecord {
  launchId: LaunchId;
  sandbox: SandboxRef;
  process: { pid?: number; cmdId?: string };
  sessionId?: string;
  /** ISO wall-clock deadline for this turn. */
  deadline: string;
}

/** The wake callback body, HMAC-signed with the call's callbackToken (spec §6.6, §7.4). */
export interface AgentCallback {
  v: 1;
  runId: RunId;
  stepKey: StepKey;
  launchId: LaunchId;
  status: "submitted" | "no_result" | "failed" | "timeout" | "stopped" | "lost" | "finished" | "ask";
  /** The armed wait this callback answers. */
  rearm: number;
  source: "runtime" | "reaper" | "cancel";
  at: string;
}

/** What collect returns. Serialisable; no closure has run yet. */
export type RawOutcome =
  | { ok: true; launchId: LaunchId; result: unknown; artifacts: AgentArtifacts; usage: Usage; sessionId?: string }
  | { ok: false; launchId: LaunchId; error: SerializedSelfbuildingError };

/** What accept returns. */
export type AgentOutcome<O> =
  | { ok: true; result: O; artifacts: AgentArtifacts; usage: Usage }
  | { ok: false; error: SerializedSelfbuildingError };

/** Only the launch the fence names may push or be accepted (spec §7.4.5). */
export interface FenceRecord {
  hostKey: HostKey;
  current: LaunchId;
  branch: string;
  /** Remote head when the fence advanced; the push lease expectation. */
  expectSha: string | null;
  superseded: LaunchId[];
}

/**
 * Run record, success cache, outcome records, accept records, fences, and Trigger step/clock records
 * (spec §7.10). Writes are create-if-absent unless noted.
 */
export interface ResultStore {
  get<T extends Json>(key: string): Promise<T | null>;
  /** Create-if-absent. Returns false when the key already existed. */
  createIfAbsent(key: string, value: Json): Promise<boolean>;
  /** Compare-and-set on a version token returned by `getVersioned`. */
  getVersioned<T extends Json>(key: string): Promise<{ value: T; version: string } | null>;
  replace(key: string, value: Json, expectVersion: string | null): Promise<boolean>;
  list(prefix: string): AsyncIterable<string>;
}
