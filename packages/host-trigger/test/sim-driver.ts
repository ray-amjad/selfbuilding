import {
  type AgentArtifacts,
  type AgentCallback,
  type AgentCallDriver,
  AgentInterruptedError,
  type AgentLaunchResult,
  type AskResolution,
  AskTimeoutError,
  type CallbackTarget,
  type HostAgentCall,
  type Json,
  type LaunchId,
  type LaunchProbeState,
  type LaunchRecord,
  type PendingAgentAsk,
  type RawOutcome,
  type SandboxProvider,
  type SandboxRef,
  SELFBUILDING_LABELS,
} from "@selfbuilding/core";
import { hostKeyOf, type LocalTrigger } from "../src/index.js";

// A simulated agent-call driver for host tests. It plays the sandbox side of the contract: launch markers
// (reattach, never a second harness), outcome records (written once), the wake target, asks, and the callback the
// runtime POSTs to the token URL. With a provider it also creates real labelled boxes, so cancellation can be
// checked against the provider.

export type SimState = "running" | "outcome" | "ask" | "suspended" | "free" | "gone" | "unknown";

export interface SimLaunch {
  launchId: LaunchId;
  call: HostAgentCall;
  record: LaunchRecord;
  state: SimState;
  outcome?: RawOutcome;
  ask?: PendingAgentAsk;
  /** The armed wake target, consumed by the first callback. */
  wake?: { rearm: number; url: string };
  wakes: number[];
  /** A critical event that happened while no target was armed. */
  pendingCallback?: AgentCallback["status"];
  answers: AskResolution[];
  /** The answer this launch was started with (a cold-ask resume). */
  resumedWith?: AskResolution;
  stops: number;
}

export interface SimOptions {
  /** The call's own timeout; the host wait adds 30 minutes. Default 60 min. */
  callMs?: number;
  provider?: SandboxProvider;
  deployment?: string;
  /** What `expireAsk` does: answer with a default, or fail the call. Default "fail". */
  onAskTimeout?: "default" | "fail";
  /** What the runtime does after the cancel sentinel. Default: writes a timed-out outcome. */
  onStop?: "outcome" | "ignore";
}

const ZERO_USAGE = { usd: 0, inputTokens: 0, outputTokens: 0, turns: 1, wallClockMs: 0, sandboxMs: 0 };

function artifacts(): AgentArtifacts {
  const ref = { uri: "file:///artifacts/x", bytes: 0, sha256: "0".repeat(64), contentType: "text/plain" };
  return { transcript: ref, files: [], logs: ref } as unknown as AgentArtifacts;
}

export class SimDriver implements AgentCallDriver {
  readonly launches = new Map<LaunchId, SimLaunch>();
  readonly outcomeRecords = new Map<LaunchId, RawOutcome>();
  readonly asks = new Map<string, { waitpoint?: { host: string; ref: string }; resolution?: AskResolution }>();
  readonly log: string[] = [];
  starts = 0;

  constructor(
    private readonly trigger: LocalTrigger,
    private readonly opts: SimOptions = {},
  ) {}

  /** Launches in start order, optionally for one call path. */
  list(callPath?: string): SimLaunch[] {
    return [...this.launches.values()].filter((l) => callPath === undefined || l.call.callPath === callPath);
  }

  only(callPath: string): SimLaunch {
    const found = this.list(callPath);
    if (found.length !== 1) throw new Error(`Expected one launch for ${callPath}, found ${found.length}.`);
    return found[0] as SimLaunch;
  }

  async launch(call: HostAgentCall, launchId: LaunchId, o?: { answer?: AskResolution }): Promise<AgentLaunchResult> {
    this.log.push(`launch ${launchId}`);
    const recorded = this.outcomeRecords.get(launchId);
    if (recorded) return { kind: "settled", outcome: recorded };
    const existing = this.launches.get(launchId);
    if (existing) return { kind: "launched", record: existing.record };
    const sandbox = await this.sandboxFor(call, launchId);
    const record: LaunchRecord = {
      launchId,
      sandbox,
      process: { pid: 1000 + this.starts },
      deadline: new Date(this.trigger.now() + (this.opts.callMs ?? 60 * 60_000)).toISOString(),
    };
    this.starts += 1;
    this.launches.set(launchId, {
      launchId,
      call,
      record,
      state: "running",
      wakes: [],
      answers: [],
      stops: 0,
      ...(o?.answer ? { resumedWith: o.answer } : {}),
    });
    return { kind: "launched", record };
  }

  private async sandboxFor(call: HostAgentCall, launchId: LaunchId): Promise<SandboxRef> {
    const deployment = this.opts.deployment ?? "test";
    const labels = {
      [SELFBUILDING_LABELS.deployment]: deployment,
      [SELFBUILDING_LABELS.run]: call.runId,
      [SELFBUILDING_LABELS.step]: hostKeyOf(call),
      [SELFBUILDING_LABELS.launch]: launchId,
    };
    if (!this.opts.provider) {
      return {
        provider: "sim",
        id: `box-${launchId}`,
        name: `box-${launchId}`,
        key: { runId: call.runId, scope: call.callPath, deployment },
        deployment,
        state: "running",
        createdAt: new Date(this.trigger.now()).toISOString(),
        labels,
      };
    }
    const { handle } = await this.opts.provider.openOrCreate(
      { runId: call.runId, scope: `${call.callPath}@${launchId}`, deployment },
      {
        image: { name: "selfbuilding-test", ref: "selfbuilding-test", version: "0" },
        env: {},
        lifetimeMs: 10 * 60_000,
        onExpire: "kill",
        labels,
      },
    );
    await handle.writeFiles([{ path: `/selfbuilding/state/launches/${launchId}.launched`, data: "1" }]);
    return handle.ref;
  }

  private mustLaunch(launchId: LaunchId): SimLaunch {
    const l = this.launches.get(launchId);
    if (!l) throw new Error(`No simulated launch ${launchId}.`);
    return l;
  }

  async registerWake(_call: HostAgentCall, record: LaunchRecord, wake: { rearm: number; target: CallbackTarget }) {
    const l = this.mustLaunch(record.launchId);
    if (wake.target.kind !== "url") throw new Error("The Trigger host must hand the sandbox a URL target.");
    l.wake = { rearm: wake.rearm, url: wake.target.url };
    l.wakes.push(wake.rearm);
    if (l.pendingCallback) {
      const status = l.pendingCallback;
      l.pendingCallback = undefined;
      await this.callback(l, status);
    }
  }

  async probe(_call: HostAgentCall, record: LaunchRecord): Promise<LaunchProbeState> {
    const l = this.mustLaunch(record.launchId);
    this.log.push(`probe ${record.launchId} ${l.state}`);
    switch (l.state) {
      case "outcome":
        return { state: "outcome" };
      case "ask":
        return { state: "ask", ask: l.ask as PendingAgentAsk };
      case "suspended":
        return { state: "suspended", ask: l.ask as PendingAgentAsk };
      case "running":
        return { state: "busy" };
      default:
        return { state: l.state };
    }
  }

  async collect(_call: HostAgentCall, record: LaunchRecord): Promise<RawOutcome> {
    this.log.push(`collect ${record.launchId}`);
    const recorded = this.outcomeRecords.get(record.launchId);
    if (recorded) return recorded;
    const l = this.mustLaunch(record.launchId);
    const outcome = l.outcome as RawOutcome;
    this.outcomeRecords.set(record.launchId, outcome);
    return outcome;
  }

  async stop(_call: HostAgentCall, record: LaunchRecord, reason: string) {
    this.log.push(`stop ${record.launchId} ${reason}`);
    const l = this.mustLaunch(record.launchId);
    l.stops += 1;
    if ((this.opts.onStop ?? "outcome") === "outcome") {
      l.state = "outcome";
      const error = new AgentInterruptedError("stopped at the wait timeout");
      l.outcome = { ok: false, launchId: l.launchId, error: error.toJSON() };
      await this.callback(l, "timeout");
    }
  }

  async interrupted(call: HostAgentCall, record: LaunchRecord, reason: string): Promise<RawOutcome> {
    this.log.push(`interrupted ${record.launchId} ${reason}`);
    const error = new AgentInterruptedError(`interrupted: ${reason}`, { runId: call.runId, callPath: call.callPath });
    return { ok: false, launchId: record.launchId, error: error.toJSON() };
  }

  async openAsk(_call: HostAgentCall, _record: LaunchRecord, askId: string, waitpoint: { host: string; ref: string }) {
    this.log.push(`openAsk ${askId}`);
    const ask = this.asks.get(askId) ?? {};
    ask.waitpoint ??= waitpoint;
    this.asks.set(askId, ask);
    return ask.resolution ?? null;
  }

  async readAnswer(askId: string) {
    return this.asks.get(askId)?.resolution ?? null;
  }

  async deliverAnswer(_call: HostAgentCall, record: LaunchRecord, resolution: AskResolution) {
    this.log.push(`deliver ${resolution.askId}`);
    const l = this.mustLaunch(record.launchId);
    l.answers.push(resolution);
    l.state = "running";
    l.ask = undefined;
  }

  async expireAsk(call: HostAgentCall, record: LaunchRecord, askId: string) {
    this.log.push(`expire ${askId}`);
    if (this.opts.onAskTimeout === "default") {
      return { resolution: resolution(askId, "default-choice", { kind: "default", reason: "timeout" }) };
    }
    const error = new AskTimeoutError({ askId }, { runId: call.runId, callPath: call.callPath });
    return { outcome: { ok: false as const, launchId: record.launchId, error: error.toJSON() } };
  }

  // ── what the sandbox does ──

  async callback(l: SimLaunch, status: AgentCallback["status"]): Promise<void> {
    if (!l.wake) {
      l.pendingCallback = status;
      return;
    }
    const body: AgentCallback = {
      v: 1,
      runId: l.call.runId,
      stepKey: l.call.stepKey,
      launchId: l.launchId,
      status,
      rearm: l.wake.rearm,
      source: "runtime",
      at: new Date(this.trigger.now()).toISOString(),
    };
    const url = l.wake.url;
    l.wake = undefined;
    if (!(await this.trigger.postToTokenUrl(url, body as unknown as Json))) l.pendingCallback = status;
  }

  async finish(launchId: LaunchId, result: unknown): Promise<void> {
    const l = this.mustLaunch(launchId);
    l.state = "outcome";
    l.outcome = { ok: true, launchId, result, artifacts: artifacts(), usage: ZERO_USAGE, sessionId: `s-${launchId}` };
    await this.callback(l, "submitted");
  }

  async failTurn(launchId: LaunchId, message: string): Promise<void> {
    const l = this.mustLaunch(launchId);
    l.state = "outcome";
    l.outcome = { ok: false, launchId, error: new AgentInterruptedError(message).toJSON() };
    await this.callback(l, "failed");
  }

  /** The harness died with no outcome; the lock is free. With `wake: false` nothing tells the host. */
  async die(launchId: LaunchId, o: { wake?: boolean } = {}): Promise<void> {
    const l = this.mustLaunch(launchId);
    l.state = "free";
    if (o.wake !== false) await this.callback(l, "lost");
  }

  async ask(launchId: LaunchId, askId: string, o: { timeoutMs?: number; cold?: boolean } = {}): Promise<void> {
    const l = this.mustLaunch(launchId);
    l.state = o.cold ? "suspended" : "ask";
    l.ask = { askId, timeoutMs: o.timeoutMs ?? 4 * 60 * 60_000 };
    await this.callback(l, "ask");
  }

  /** The hot ask timed out in the sandbox: the runtime suspends the turn (no wake; the host waits on the ask). */
  goCold(launchId: LaunchId): void {
    const l = this.mustLaunch(launchId);
    l.state = "suspended";
  }

  /** The channel handler: store first, then complete the ask's waitpoint token. */
  async answer(askId: string, choiceId: string): Promise<void> {
    const ask = this.asks.get(askId) ?? {};
    ask.resolution = resolution(askId, choiceId, {
      kind: "human",
      channel: "slack",
      userId: "U1",
      displayName: "alice",
    });
    this.asks.set(askId, ask);
    if (ask.waitpoint) await this.trigger.completeToken(ask.waitpoint.ref, ask.resolution as unknown as Json);
  }

  /** A premature wake: the runtime (or a duplicate) posts while the turn is still running. */
  async spuriousWake(launchId: LaunchId): Promise<void> {
    await this.callback(this.mustLaunch(launchId), "finished");
  }
}

export function resolution(askId: string, choiceId: string, answeredBy: AskResolution["answeredBy"]): AskResolution {
  return {
    askId,
    answer: { kind: "choice", choiceId },
    choiceId,
    answeredBy,
    answeredAt: "2026-01-01T00:00:00.000Z",
  };
}
