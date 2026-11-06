import type { AgentAskBridge, AgentRunContext, BudgetSlice, StepIdentity } from "../agent/context.js";
import { defaultDeployment } from "../agent/context.js";
import type { AskSession } from "../ask/session.js";
import { nodeHost } from "../host-node/index.js";
import { memoryResultStore } from "../host-node/stores.js";
import type { ResultStore } from "../types/host.js";
import { computeStepKey } from "./calls.js";
import { maybeFrame } from "./context.js";
import type { RunState } from "./run-state.js";
import { headAfter, type Scope } from "./scope.js";

/**
 * The agent module's view of an engine run. One object per run; everything that depends on where the caller is
 * (callPath counters, chain head, concurrency root) is read from the current AsyncLocalStorage frame at call
 * time, so a shared handle created in one scope sees the scope it is used from.
 */
export function agentContextFor(run: RunState, session: AskSession | undefined): AgentRunContext {
  // Links reserved per step key, settled in call order whatever order the calls finish in (spec §3.2).
  const keyByPath = new Map<string, string>();
  const links = new Map<string, { scope: Scope; settle: (advance: ((head: string) => string) | null) => void }>();
  const results: ResultStore = run.journal.results ?? memoryResultStore();
  // A durable host that dispatches agent calls (Trigger.dev) is the call path's host; plain Node waits in-process.
  const host = run.options.host ?? nodeHost({ runId: run.runId, epoch: run.epoch });

  const scope = (): Scope => {
    const frame = maybeFrame();
    // Calls from detached work (a timer, a finalizer) fall back to the run root's identity.
    return frame && frame.run === run ? frame.scope : rootOf(run);
  };

  const ctx: AgentRunContext = {
    runId: run.runId,
    deployment: defaultDeployment(run.config),
    epoch: run.epoch,
    config: run.config,
    get defaults() {
      return scope().defaults ?? {};
    },
    host,
    get journal() {
      return { store: run.journal, lease: run.lease };
    },
    artifacts: run.artifacts,
    results,
    signal: run.signal,
    ...(run.options.onInterrupted === undefined ? {} : { onInterrupted: run.options.onInterrupted }),
    ...(session ? { asks: askBridge(session) } : {}),
    get scopeId() {
      return scope().concurrencyRoot.path;
    },
    handleUsable(owner) {
      return scope().concurrencyRoot.path === owner;
    },
    noteSecrets(values) {
      for (const value of values) run.events.addSecret(value);
    },
    emit(e) {
      run.emit({
        type: e.type,
        ...(e.level ? { level: e.level } : {}),
        ...(e.callPath ? { callPath: e.callPath } : {}),
        ...(e.launchId ? { launchId: e.launchId } : {}),
        ...(e.attempt !== undefined ? { attempt: e.attempt } : {}),
        ...(e.data ? { data: e.data } : {}),
      });
    },
    nextCallPath(name, label) {
      const s = scope();
      s.live = true;
      return s.allocate(name, label);
    },
    stepKey(identity: StepIdentity) {
      const s = scope();
      const refresh = run.isRefreshed(identity.callPath) ? run.resumeId : null;
      const key = computeStepKey({ ...identity, chain: s.chainHead, refresh });
      run.visited.add(key);
      keyByPath.set(identity.callPath, key);
      links.set(key, { scope: s, settle: s.reserveLink() });
      return key;
    },
    advanceChain(stepKey, launchId) {
      const link = links.get(stepKey);
      if (!link) return;
      links.delete(stepKey);
      link.settle(() => headAfter(stepKey, launchId));
    },
    abandonChain(stepKey) {
      const link = links.get(stepKey);
      if (!link) return;
      links.delete(stepKey);
      link.settle(null);
    },
    async admit(callPath, requestedUsd): Promise<BudgetSlice> {
      await run.assertLease();
      const stepKey = keyByPath.get(callPath) ?? callPath;
      const reservation = run.budget.admit({
        callPath,
        stepKey,
        ...(requestedUsd === undefined ? {} : { usd: requestedUsd }),
      });
      let chargedTurns = false;
      return {
        ...(reservation.sliceUsd === null ? {} : { usd: reservation.sliceUsd }),
        async charge(c) {
          chargedTurns = true;
          await reservation.charge({
            launchId: c.launchId,
            turn: c.turn,
            ...(c.usd === undefined ? {} : { usd: c.usd }),
            ...(c.tokens === undefined ? {} : { tokens: c.tokens }),
            ...(c.final ? { final: true } : {}),
          });
        },
        release(spentUsd, launchId) {
          if (chargedTurns) {
            run.track(Promise.resolve().then(() => reservation.release()));
            return;
          }
          // The lifecycle reports one total per call. A failed call's spend gets its own launch id, so it
          // still counts after a resume; a successful one uses the launch the journal excludes on replay.
          const id = launchId ?? `${stepKey}_e${run.epoch}_p${run.processEpoch}`;
          const done =
            spentUsd != null && spentUsd > 0
              ? reservation.charge({ launchId: id, turn: 0, usd: spentUsd, final: true })
              : Promise.resolve({ exceeded: false });
          run.track(done.finally(() => reservation.release()));
        },
      };
    },
    async acquireSlots(callPath, n) {
      const s = scope();
      const slots = await run.slots.acquire(callPath, s.priority, n, run.signal);
      return {
        release() {
          for (const slot of slots) slot.release();
        },
        setBusy(busy) {
          for (const slot of slots) slot.setBusy(busy);
        },
        setParker(park) {
          // One holder for all n: the first slot carries the parker, whose success releases every slot.
          slots[0]?.setParker(park);
        },
        each: slots,
      };
    },
    ownHandle(handle) {
      run.defer(async () => {
        await handle[Symbol.asyncDispose]();
      });
    },
    noteUsage(usage, replayed) {
      if (replayed) run.budget.noteReplayed(usage.usd);
      else run.addUsage(usage);
    },
    markNeedsAttention(callPath) {
      run.needsAttention.add(callPath);
    },
  };
  return ctx;
}

const roots = new WeakMap<RunState, Scope>();

/** Registers the root scope so detached calls still resolve to this run. */
export function setRootScope(run: RunState, root: Scope): void {
  roots.set(run, root);
}

function rootOf(run: RunState): Scope {
  const root = roots.get(run);
  if (!root) throw new Error(`run ${run.runId} has no root scope yet`);
  return root;
}

/** Hands an agent's `ask_human` to the run's ask session: hot wait first, then cold or the timeout policy. */
function askBridge(session: AskSession): AgentAskBridge {
  return {
    async handle(req) {
      const ticket = await session.openAgentAsk({
        callPath: req.callPath,
        launchId: req.launchId,
        askSeq: req.askSeq,
        spec: req.spec,
        harness: req.harness ?? { mcpToolTimeoutMs: null, canResume: false },
        ...(req.sharedHandle === undefined ? {} : { sharedHandle: req.sharedHandle }),
      });
      if (ticket.kind === "resolved") return { kind: "answer", resolution: ticket.resolution };
      if (ticket.kind === "rejected") {
        // The runtime renders whatever answer it is given; a refusal reaches the model as the default's text.
        return {
          kind: "answer",
          resolution: {
            askId: `ask_rejected_${req.askSeq}`,
            answer: { kind: "text", text: ticket.toolText },
            choiceId: null,
            answeredBy: { kind: "default", reason: "undeliverable" },
            answeredAt: new Date().toISOString(),
          },
        };
      }
      const { record, plan } = ticket;
      if (plan.mode === "hot") {
        const hot = await session.waitHot(record.askId, plan.hotMs);
        if (hot) return { kind: "answer", resolution: hot };
        if (plan.afterHot === "policy") return { kind: "answer", resolution: await session.expire(record.askId) };
      }
      return { kind: "cold", askId: record.askId };
    },
    awaitCold: (askId, cold) => session.awaitCold(askId, cold),
  };
}
