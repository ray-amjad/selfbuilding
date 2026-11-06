// The engine's internal surface for the other core modules (agent, sandbox, ask, host-node, reap). Not part
// of the public API: import it relatively from inside @selfbuilding/core only.
//
//   const frame = currentFrame("agent");          // { run, scope, internal }; NoActiveRunError outside a run
//   const call = openCall("agent", { kind: "agent", name, label, target, input, schema, exec, sandbox });
//   if (call.cached) return call.replay();         // replayed: note usage with run.budget.noteReplayed(usd)
//   if (call.previous?.status === "started") ...   // interrupted: apply spec §3.10 with run.interruptedPolicy()
//   await call.start({ sandbox, harnessStartedAt }) // write-ahead; then call.update(...) as facts arrive
//   await run.assertLease()                        // before every sandbox create and harness launch
//   const res = run.budget.admit({ callPath, stepKey, usd, model, tokenMetered })  // per attempt
//   const [slot] = await run.slots.acquire(callPath, scope.priority, 1, run.signal)
//   await run.createLimiter(provider).take(run.signal)
//   await call.complete(value, { launchId }) | await call.fail(error, { launchId })
//   internal(() => ...)                            // exempt library code from strict mode

export {
  type AdmitInput,
  BudgetLedger,
  type ChargeInput,
  createBackoffMs,
  Reservation,
  SandboxSlots,
  type Slot,
  type SlotPriority,
} from "../budget/index.js";
export { checkTimeoutOrder, firstDefined, parseDuration, resolveSecret } from "../config/index.js";
export { deserializeError, isUsageError, serializeThrown } from "../errors/serialize.js";
export type { EmitInput } from "../events/bus.js";
export { type CallSpec, computeStepKey, OpenedCall, openCall } from "./calls.js";
export { currentFrame, type Frame, internal, maybeFrame, withScope } from "./context.js";
export { canonicalJson, internalNow, sha256Hex, ulid } from "./hash.js";
export { type RunInternals, runFactory } from "./run.js";
export { isSuspension, RunState, RunSuspension } from "./run-state.js";
export { type FactoryFrame, foldHeads, headAfter, LABEL_PATTERN, Scope } from "./scope.js";
