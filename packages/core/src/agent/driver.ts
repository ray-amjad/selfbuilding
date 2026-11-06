import { loadSkill, type SkillDef } from "@selfbuilding/skills";
import { z } from "zod";
import { formatResumeMessage } from "../ask/format.js";
import { AskSession, type AskWaitpoints, nodeWaitpoints } from "../ask/session.js";
import { AgentInterruptedError, ConfigError, NonDeterminismError } from "../errors/classes.js";
import { fileArtifacts } from "../journal/index.js";
import {
  answerVerb,
  attemptDir,
  probeTurnLock,
  readText,
  type VerbContext,
  waitVerb,
  writeCancel,
} from "../sandbox/runtime-client.js";
import type { AskResolution } from "../types/ask.js";
import type { Json } from "../types/common.js";
import type { HarnessCredential } from "../types/harness.js";
import type {
  AgentCallback,
  AgentCallDriver,
  AgentCallDriverDeps,
  AgentLaunchResult,
  CallbackTarget,
  HostAgentCall,
  LaunchId,
  LaunchProbeState,
  LaunchRecord,
  RawOutcome,
} from "../types/host.js";
import type { Outcome, RuntimeEvent, WakeFile } from "../types/runtime.js";
import { ATTEMPT_FILES } from "../types/runtime.js";
import type { ProviderSandbox, SandboxProvider, SandboxRef } from "../types/sandbox.js";
import { type AgentRunContext, standaloneContext } from "./context.js";
import { compileContract } from "./contract.js";
import { credentialPool, leasedContent, releaseLease } from "./credentials.js";
import { hasCode, serializeError } from "./errors.js";
import { type CallState, collectAttempt, errOpts, launchAttempt } from "./lifecycle.js";
import type { AgentDefinition, CallPlan } from "./plan.js";
import { launchDepthOf, noteLaunchDepth } from "./start-grant.js";

// The serialisable half of an agent call (demo-path §5): what a durable host whose accept runs in another process
// (the Trigger.dev parent) drives in its agent child. The parent sends `agentCallSpec()` as HostAgentCall.spec; the
// child rebuilds the call from it plus its own registry, then runs launch → (wake, probe)* → collect. Every method
// is idempotent: a retried child runs it again from the top and finds the outcome record, the launch record or
// the launch markers in the box.

/** Knobs tests turn down. */
export const DRIVER_TUNABLES = {
  /** How long launch watches a newly started turn for its `turn.started`, streaming the boot events meanwhile. */
  startWaitMs: 120_000,
  /** Long-poll slice while launch watches the boot. */
  startSliceMs: 5_000,
};

type PlanFields = Omit<CallPlan, "harness" | "provider" | "handle" | "outputSchema" | "wireSchema" | "pr">;

/** The core-owned JSON in HostAgentCall.spec. Hosts never read it. */
export interface AgentCallSpec {
  v: 1;
  agent:
    | {
        kind: "skill";
        name: string;
        hash: string;
        skill: string;
        skillHash: string;
        /** Where the parent loaded the skill from; the same path inside a deployed bundle. */
        dir: string;
        /** The body as called, including any `with({ appendBody })`. */
        body: string;
      }
    | { kind: "inline"; name: string; hash: string; prompt: string };
  harness: { id: string; model: string | null };
  provider: string;
  placement: { kind: "fresh" };
  protectAllow: string[];
  plan: PlanFields & { pr: boolean };
  /**
   * The run's start_workflow launch depth, when it is not 0. The parent learns it from the run-script input; the
   * child is another process, so it cannot, and grants it mints must still carry depth + 1.
   */
  launchDepth?: number;
}

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The serialisable description of one call. Closures (`assert` checks, PR builders, schemas) stay in the parent. */
export function agentCallSpec(def: AgentDefinition<unknown, unknown>, plan: CallPlan, runId?: string): Json {
  const { harness, provider, handle: _handle, outputSchema: _out, wireSchema: _wire, pr, input, ...rest } = plan;
  const spec: AgentCallSpec = {
    v: 1,
    agent: def.skill
      ? {
          kind: "skill",
          name: def.name,
          hash: def.hash,
          skill: def.skill.name,
          skillHash: def.skill.hash,
          dir: def.skill.dir,
          body: def.body,
        }
      : { kind: "inline", name: def.name, hash: def.hash, prompt: def.body },
    harness: { id: harness.id, model: harness.options.model ?? null },
    provider: provider.id,
    placement: { kind: "fresh" },
    protectAllow: [...def.contract.protect.allow],
    plan: { ...toJson(rest), input: toJson(input ?? null), pr: pr !== false },
  };
  const depth = runId === undefined ? 0 : launchDepthOf(runId);
  if (depth > 0) spec.launchDepth = depth;
  return spec as unknown as Json;
}

/** Per-launch facts the child keeps in the result store, so a retried child finds the box and the event cursor. */
interface LaunchRow {
  ref: SandboxRef;
  attempt: number;
  deadline: string;
  harnessStartedAt?: string;
  sessionId?: string;
  /** The last runtime event seq already emitted. */
  after: number;
}

const launchKey = (runId: string, launchId: string) => `launches/${runId}/${launchId}`;
const outcomeKey = (runId: string, launchId: string) => `outcomes/${runId}/${launchId}`;

function launchNumber(launchId: string): number {
  const m = /_l(\d+)$/.exec(launchId);
  return m ? Number(m[1]) : 0;
}

/** Core's AgentCallDriver (demo-path §5). The Trigger host looks it up by this export name. */
export function agentCallDriver(deps: AgentCallDriverDeps): AgentCallDriver {
  const { config, store } = deps;
  const artifacts = config.artifacts ?? fileArtifacts(".selfbuilding/artifacts");
  const states = new Map<string, CallState>();
  const sessions = new Map<string, AskSession>();
  const skills = new Map<string, Promise<SkillDef>>();

  const providers = (): SandboxProvider[] => [
    ...(deps.registry?.providers ?? []),
    ...(config.sandbox ? [config.sandbox] : []),
  ];
  const harnesses = () => [...(deps.registry?.harnesses ?? []), ...(config.harness ? [config.harness] : [])];

  function specOf(call: HostAgentCall): AgentCallSpec {
    const spec = call.spec as unknown as AgentCallSpec | null;
    if (!spec || typeof spec !== "object" || spec.v !== 1) {
      throw new ConfigError(
        `Agent call ${call.callPath} carries a spec this version of @selfbuilding/core cannot read. Deploy the parent and the agent task from the same build.`,
      );
    }
    return spec;
  }

  function resolveSkill(spec: Extract<AgentCallSpec["agent"], { kind: "skill" }>): Promise<SkillDef> {
    const registered = (deps.agents ?? []).find((a) => a.skill?.name === spec.skill)?.skill;
    let loading = skills.get(spec.dir);
    if (!loading) {
      const fresh = registered ? Promise.resolve(registered) : loadSkill(spec.dir);
      fresh.catch(() => skills.delete(spec.dir));
      skills.set(spec.dir, fresh);
      loading = fresh;
    }
    return loading.then((skill) => {
      if (skill.hash !== spec.skillHash) {
        throw new NonDeterminismError(
          `The skill "${spec.skill}" this worker loaded (${skill.hash.slice(0, 12)}) is not the one the run called (${spec.skillHash.slice(0, 12)}). Deploy the parent and the agent task from the same build.`,
        );
      }
      return skill;
    });
  }

  function contextFor(call: HostAgentCall): AgentRunContext {
    const base = standaloneContext({ runId: call.runId, config });
    return { ...base, epoch: call.epoch, artifacts, results: store };
  }

  function sessionFor(call: HostAgentCall, agentName: string): AskSession {
    let session = sessions.get(call.runId);
    if (!session) {
      const fallback = nodeWaitpoints(deps.asks);
      const waitpoints: AskWaitpoints = deps.askWaitpoint
        ? { host: deps.askWaitpoint.host, create: deps.askWaitpoint.create, wait: fallback.wait }
        : fallback;
      session = new AskSession({
        run: { runId: call.runId, factory: agentName },
        store: deps.asks,
        ...(config.hitl ? { hitl: config.hitl } : {}),
        ...(config.notify ? { notify: config.notify } : {}),
        waitpoints,
      });
      sessions.set(call.runId, session);
    }
    return session;
  }

  /** Rebuilds the call's state in this process, or reuses the one launch built. */
  async function stateFor(call: HostAgentCall): Promise<CallState> {
    const key = `${call.runId}/${call.stepKey}_e${call.epoch}`;
    const cached = states.get(key);
    if (cached) return cached;
    const spec = specOf(call);
    if (typeof spec.launchDepth === "number") noteLaunchDepth(call.runId, spec.launchDepth);
    const harness = harnesses().find((h) => h.id === spec.harness.id);
    if (!harness) {
      throw new ConfigError(
        `Agent call ${call.callPath} uses harness "${spec.harness.id}", which this worker does not have. Set config.harness or pass it in createTriggerHost({ registry: { harnesses } }).`,
      );
    }
    if ((harness.options.model ?? null) !== spec.harness.model) {
      throw new ConfigError(
        `Agent call ${call.callPath} runs ${spec.harness.id} with model ${spec.harness.model ?? "(default)"}, but this worker's ${spec.harness.id} uses ${harness.options.model ?? "(default)"}. Register the same harness value with the worker.`,
      );
    }
    const provider = providers().find((p) => p.id === spec.provider);
    if (!provider) {
      throw new ConfigError(
        `Agent call ${call.callPath} uses sandbox provider "${spec.provider}", which this worker does not have. Set config.sandbox or pass it in createTriggerHost({ registry: { providers } }).`,
      );
    }
    const skill = spec.agent.kind === "skill" ? await resolveSkill(spec.agent) : undefined;
    const contract = compileContract<unknown, unknown>({
      input: z.unknown(),
      output: z.unknown(),
      protect: { extra: [], allow: spec.protectAllow },
    });
    const def: AgentDefinition<unknown, unknown> = {
      name: spec.agent.name,
      ...(skill ? { skill } : {}),
      body: spec.agent.kind === "skill" ? spec.agent.body : spec.agent.prompt,
      literal: spec.agent.kind === "inline",
      contract,
      hash: spec.agent.hash,
      secrets: [...spec.plan.secrets],
    };
    const { pr: _pr, ...fields } = spec.plan;
    const plan: CallPlan = {
      ...fields,
      harness,
      provider,
      pr: false,
      outputSchema: z.unknown(),
      wireSchema: z.unknown(),
    };
    const state: CallState = {
      ctx: contextFor(call),
      def,
      plan,
      fresh: true,
      attempts: { submits: 0, resumes: 0, doneRetries: 0 },
      usage: { usd: null, inputTokens: 0, outputTokens: 0, turns: 0, wallClockMs: 0, sandboxMs: 0 },
      startedAt: Date.now(),
    };
    states.set(key, state);
    return state;
  }

  function vctx(state: CallState): VerbContext {
    return { box: state.box as ProviderSandbox, provider: state.plan.provider, runId: state.ctx.runId };
  }

  async function readRow(call: HostAgentCall, launchId: string): Promise<LaunchRow | null> {
    return (await store.get<LaunchRow & Json>(launchKey(call.runId, launchId))) as LaunchRow | null;
  }

  async function writeRow(call: HostAgentCall, launchId: string, patch: Partial<LaunchRow>): Promise<LaunchRow> {
    const key = launchKey(call.runId, launchId);
    for (let i = 0; i < 20; i++) {
      const current = await store.getVersioned<LaunchRow & Json>(key);
      const next = { ...(current?.value as LaunchRow | undefined), ...patch } as LaunchRow;
      if (await store.replace(key, next as unknown as Json, current?.version ?? null)) return next;
    }
    throw new ConfigError(`The launch record ${key} kept changing; another worker is driving this launch.`);
  }

  /** Opens the launch's box when this process does not hold it. Null when the box is gone. */
  async function boxFor(state: CallState, row: LaunchRow | null): Promise<ProviderSandbox | null> {
    if (state.box) return state.box;
    if (!row) return null;
    try {
      state.box = await state.plan.provider.open(row.ref, { lifetimeMs: state.plan.timeouts.callMs + 15 * 60_000 });
      state.fresh = true;
      return state.box;
    } catch (error) {
      if (hasCode(error, "sandbox_not_found", "sandbox_guest_gone")) return null;
      throw error;
    }
  }

  function withBox(raw: RawOutcome, ref: SandboxRef | undefined): RawOutcome {
    return ref ? ({ ...raw, sandbox: ref } as unknown as RawOutcome) : raw;
  }

  function stopTimers(state: CallState): void {
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.heartbeat = undefined;
  }

  /** Forwards runtime events as call events and moves the stored cursor past them. */
  async function forward(
    state: CallState,
    call: HostAgentCall,
    launchId: LaunchId,
    attempt: number,
    events: RuntimeEvent[],
    lastSeq: number,
    after: number,
    sessionId?: string,
  ): Promise<number> {
    for (const event of events) {
      if (event.seq !== undefined && event.seq <= after) continue;
      state.ctx.emit({
        type: event.type,
        level: event.level,
        callPath: call.callPath,
        launchId,
        attempt,
        ...(event.data ? { data: event.data } : {}),
      });
    }
    const next = Math.max(after, lastSeq);
    if (next !== after || (sessionId && sessionId !== state.sessionId)) {
      if (sessionId) state.sessionId = sessionId;
      await writeRow(call, launchId, { after: next, ...(sessionId ? { sessionId } : {}) });
    }
    return next;
  }

  /** Watches a turn that just started until the harness is up, so a turn that cannot start fails before any wait. */
  async function watchStart(state: CallState, call: HostAgentCall, launchId: LaunchId, row: LaunchRow) {
    const until = Date.now() + DRIVER_TUNABLES.startWaitMs;
    let after = row.after;
    while (Date.now() < until) {
      const r = await waitVerb(vctx(state), call.stepKey, row.attempt, after, DRIVER_TUNABLES.startSliceMs);
      after = await forward(state, call, launchId, row.attempt, r.events, r.lastSeq, after, r.state?.sessionId);
      if (r.outcome || r.pendingAsk) return;
      if (r.events.some((e) => e.type === "turn.started")) return;
      if (r.lock === "FREE" && r.state) return;
    }
  }

  /** The failure value for a turn nothing can collect, stored as the launch's outcome record. */
  async function interruptedOutcome(
    state: CallState,
    call: HostAgentCall,
    launchId: LaunchId,
    reason: string,
    row: LaunchRow | null,
  ): Promise<RawOutcome> {
    if (row?.sessionId) state.sessionId = row.sessionId;
    const error = new AgentInterruptedError(
      reason === "gone"
        ? "The agent's turn was cut off and its sandbox is gone. It is not re-run silently; resume it with onInterrupted or refresh."
        : undefined,
      errOpts(state),
    );
    const raw: RawOutcome = { ok: false, launchId, error: serializeError(error) };
    // The box goes back with the value, so the parent disposes of it as it would any other.
    const ref = row?.ref ?? state.box?.ref;
    if (!(await store.createIfAbsent(outcomeKey(call.runId, launchId), raw as unknown as Json))) {
      const stored = await store.get<RawOutcome & Json>(outcomeKey(call.runId, launchId));
      return withBox(stored as unknown as RawOutcome, ref);
    }
    state.ctx.emit({ type: "agent.interrupted", level: "warn", callPath: call.callPath, launchId, data: { reason } });
    return withBox(raw, ref);
  }

  /** Secret values the call delivered, for the push guard and redaction, when launch ran in another process. */
  async function restoreSecrets(state: CallState): Promise<void> {
    if (state.secrets) return;
    const values: string[] = [];
    for (const cred of credentialPool(state.plan.harness.options.credentials) as HarnessCredential[]) {
      const read = async (s: unknown) => (typeof s === "function" ? (s as () => Promise<string>)() : (s as string));
      if (cred.kind === "provider-keys") {
        for (const s of Object.values(cred.values)) values.push(await read(s));
      } else if (cred.kind === "auth-file") {
        values.push(leasedContent(cred) ?? (await read(cred.value)));
      } else {
        values.push(await read(cred.value));
      }
    }
    if (state.plan.secrets.length > 0 && config.secrets) {
      values.push(...Object.values(await config.secrets.resolve(state.plan.secrets)));
    }
    state.secrets = values;
  }

  async function settledFor(call: HostAgentCall, launchId: string): Promise<RawOutcome | null> {
    const recorded = await store.get<RawOutcome & Json>(outcomeKey(call.runId, launchId));
    if (!recorded) return null;
    const row = await readRow(call, launchId);
    return withBox(recorded as unknown as RawOutcome, row?.ref);
  }

  async function collectNow(state: CallState, call: HostAgentCall, launchId: LaunchId, row: LaunchRow) {
    let outcome: Outcome | undefined;
    let after = row.after;
    // Drains the events the turn wrote since the last read, then takes its outcome.
    for (let i = 0; i < 50; i++) {
      const r = await waitVerb(vctx(state), call.stepKey, row.attempt, after, 0);
      const prev = after;
      after = await forward(state, call, launchId, row.attempt, r.events, r.lastSeq, after, r.state?.sessionId);
      if (r.outcome) outcome = r.outcome;
      if (after === prev) break;
    }
    if (!outcome) return interruptedOutcome(state, call, launchId, "lock-free", row);
    await restoreSecrets(state);
    try {
      const raw = await collectAttempt(state, launchNumber(launchId), row.attempt, outcome);
      return withBox(raw, row.ref);
    } finally {
      stopTimers(state);
      const cred = state.lease?.cred;
      if (cred) releaseLease(cred, `${state.ctx.runId}/${state.plan.callPath}`);
      state.lease = undefined;
      states.delete(`${call.runId}/${call.stepKey}_e${call.epoch}`);
    }
  }

  const driver: AgentCallDriver = {
    async launch(call, launchId, opts): Promise<AgentLaunchResult> {
      const settled = await settledFor(call, launchId);
      if (settled) return { kind: "settled", outcome: settled };
      const state = await stateFor(call);
      const n = launchNumber(launchId);
      const existing = await readRow(call, launchId);
      if (existing) {
        const box = await boxFor(state, existing);
        // A turn that started and whose box is gone is never re-run silently (spec §3.10).
        if (!box && existing.harnessStartedAt) {
          return { kind: "settled", outcome: await interruptedOutcome(state, call, launchId, "gone", existing) };
        }
      }
      let followUp: { message: string; resumeSessionId: string } | undefined;
      if (opts?.answer) {
        const record = await deps.asks.get(opts.answer.askId);
        const previous = await readRow(call, `${call.stepKey}_e${call.epoch}_l${n - 1}`);
        const sessionId = previous?.sessionId ?? state.sessionId;
        if (record && sessionId) {
          followUp = { message: formatResumeMessage(record, opts.answer), resumeSessionId: sessionId };
        }
      } else if (call.resume?.sessionId && n === call.launch) {
        followUp = { message: call.resume.message, resumeSessionId: call.resume.sessionId };
      }
      const launched = await launchAttempt(state, n, followUp);
      if (launched.kind === "recorded") {
        return { kind: "settled", outcome: withBox(launched.raw, state.box?.ref) };
      }
      const box = state.box as ProviderSandbox;
      const row = await writeRow(call, launchId, {
        ref: box.ref,
        attempt: launched.attempt,
        deadline: existing?.deadline ?? new Date(Date.now() + state.plan.timeouts.callMs).toISOString(),
        after: existing?.after ?? 0,
        ...((existing?.harnessStartedAt ?? state.harnessStartedAt)
          ? { harnessStartedAt: existing?.harnessStartedAt ?? state.harnessStartedAt }
          : {}),
        ...((existing?.sessionId ?? state.sessionId) ? { sessionId: existing?.sessionId ?? state.sessionId } : {}),
      });
      const probe = launched.probe;
      if (probe.action === "settled") {
        return { kind: "settled", outcome: await collectNow(state, call, launchId, row) };
      }
      if (probe.action === "interrupted") {
        return { kind: "settled", outcome: await interruptedOutcome(state, call, launchId, "lock-free", row) };
      }
      if (probe.action === "start") await watchStart(state, call, launchId, row);
      const record: LaunchRecord = {
        launchId,
        sandbox: box.ref,
        process: {},
        deadline: row.deadline,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      };
      return { kind: "launched", record };
    },

    async registerWake(call, record, wake) {
      const state = await stateFor(call);
      const row = await readRow(call, record.launchId);
      const box = await boxFor(state, row ?? { ref: record.sandbox, attempt: 1, deadline: record.deadline, after: 0 });
      if (!box || !row) return;
      const dir = attemptDir(call.stepKey, row.attempt);
      const file: WakeFile = { launchId: record.launchId, rearm: wake.rearm, target: wake.target };
      await box.writeFiles([
        { path: `${dir}/${ATTEMPT_FILES.wake}`, data: JSON.stringify(file), mode: 0o600, owner: "root" },
      ]);
      // A turn that ended before this target existed has no one left to send its wake: send it from here.
      const ended =
        (await readText(box, `${dir}/${ATTEMPT_FILES.outcome}`)) !== null ||
        (await readText(box, `${dir}/wake.pending`)) !== null ||
        (await probeTurnLock(box)) === "FREE";
      if (ended) await sendWake(wake.target, call, record.launchId, wake.rearm);
    },

    async probe(call, record): Promise<LaunchProbeState> {
      const state = await stateFor(call);
      const row = await readRow(call, record.launchId);
      let box: ProviderSandbox | null;
      try {
        box = await boxFor(state, row);
      } catch {
        return { state: "unknown" };
      }
      if (!box || !row) return { state: "gone" };
      let strikes = 0;
      for (;;) {
        let r: Awaited<ReturnType<typeof waitVerb>>;
        try {
          r = await waitVerb(vctx(state), call.stepKey, row.attempt, row.after, 0);
        } catch (error) {
          if (hasCode(error, "sandbox_not_found", "sandbox_guest_gone")) return { state: "gone" };
          return { state: "unknown" };
        }
        row.after = await forward(
          state,
          call,
          record.launchId,
          row.attempt,
          r.events,
          r.lastSeq,
          row.after,
          r.state?.sessionId,
        );
        if (r.outcome) return { state: "outcome" };
        const suspended = r.state?.phase === "suspended" && r.lock === "FREE";
        if (r.pendingAsk && r.state?.pendingAsk) {
          const session = sessionFor(call, state.plan.agentName);
          const ticket = await session.openAgentAsk({
            callPath: call.callPath,
            launchId: record.launchId,
            askSeq: r.state.pendingAsk.askSeq,
            spec: r.pendingAsk,
            harness: {
              mcpToolTimeoutMs: state.plan.timeouts.mcpToolMs,
              canResume: state.plan.harness.resume !== undefined,
            },
          });
          if (ticket.kind === "rejected") {
            // The runtime renders whatever answer it gets; a refusal reaches the model as the tool text.
            await answerVerb(vctx(state), call.stepKey, row.attempt, {
              askId: `ask_rejected_${r.state.pendingAsk.askSeq}`,
              resolution: {
                askId: `ask_rejected_${r.state.pendingAsk.askSeq}`,
                answer: { kind: "text", text: ticket.toolText },
                choiceId: null,
                answeredBy: { kind: "default", reason: "undeliverable" },
                answeredAt: new Date().toISOString(),
              },
            });
            return { state: "busy" };
          }
          const ask = {
            askId: ticket.record.askId,
            timeoutMs: Math.max(1, Date.parse(ticket.record.expiresAt) - Date.now()),
          };
          return suspended ? { state: "suspended", ask } : { state: "ask", ask };
        }
        if (r.lock === "BUSY") return { state: "busy" };
        const phase = r.state?.phase;
        if (phase === "waiting" || phase === "suspended") return { state: "busy" };
        // Two FREE reads in a row: one could race the supervisor taking the lock.
        strikes++;
        if (strikes >= 2) return { state: "free" };
      }
    },

    async collect(call, record) {
      const settled = await settledFor(call, record.launchId);
      if (settled) return settled;
      const state = await stateFor(call);
      const row = await readRow(call, record.launchId);
      const box = await boxFor(state, row);
      if (!box || !row) return interruptedOutcome(state, call, record.launchId, "gone", row);
      return collectNow(state, call, record.launchId, row);
    },

    async stop(call, record, reason) {
      const state = await stateFor(call);
      const row = await readRow(call, record.launchId);
      const box = await boxFor(state, row);
      if (!box || !row) return;
      await writeCancel(box, call.stepKey, row.attempt, reason);
    },

    async interrupted(call, record, reason) {
      const settled = await settledFor(call, record.launchId);
      if (settled) return settled;
      const state = await stateFor(call);
      const row = await readRow(call, record.launchId);
      stopTimers(state);
      return withBox(await interruptedOutcome(state, call, record.launchId, reason, row), row?.ref);
    },

    async openAsk(_call, _record, askId) {
      // The record was created with this waitpoint when the probe opened it; the store holds any answer.
      return driver.readAnswer(askId);
    },

    async readAnswer(askId) {
      const record = await deps.asks.get(askId);
      return record?.status === "answered" && record.resolution ? record.resolution : null;
    },

    async deliverAnswer(call, record, resolution: AskResolution) {
      const state = await stateFor(call);
      const row = await readRow(call, record.launchId);
      const box = await boxFor(state, row);
      if (!box || !row) return;
      await answerVerb(vctx(state), call.stepKey, row.attempt, { askId: resolution.askId, resolution });
      const ask = await deps.asks.get(resolution.askId);
      if (ask) sessionFor(call, state.plan.agentName).delivered(ask, "inbox");
    },

    async expireAsk(call, record, askId) {
      const state = await stateFor(call);
      try {
        return { resolution: await sessionFor(call, state.plan.agentName).expire(askId) };
      } catch (error) {
        // The policy failed the ask: the blocked turn is stopped and the call fails with the policy's error.
        const row = await readRow(call, record.launchId);
        const box = await boxFor(state, row).catch(() => null);
        if (box && row) await writeCancel(box, call.stepKey, row.attempt, "ask-timeout").catch(() => undefined);
        const raw: RawOutcome = { ok: false, launchId: record.launchId, error: serializeError(error) };
        await store.createIfAbsent(outcomeKey(call.runId, record.launchId), raw as unknown as Json);
        stopTimers(state);
        return { outcome: withBox(raw, row?.ref) };
      }
    },
  };
  return driver;
}

/** The callback the runtime would have sent, sent by the host when the turn ended before the target existed. */
async function sendWake(target: CallbackTarget, call: HostAgentCall, launchId: LaunchId, rearm: number) {
  const callback: AgentCallback = {
    v: 1,
    runId: call.runId,
    stepKey: call.stepKey,
    launchId,
    status: "finished",
    rearm,
    source: "reaper",
    at: new Date().toISOString(),
  };
  const url = target.kind === "url" ? target.url : target.endpoint;
  const body =
    target.kind === "url" ? JSON.stringify(callback) : JSON.stringify({ eventKey: target.eventKey, callback });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(target.kind === "url" ? (target.headers ?? {}) : { authorization: `Bearer ${target.token}` }),
  };
  await fetch(url, { method: "POST", headers, body }).catch(() => undefined);
}
