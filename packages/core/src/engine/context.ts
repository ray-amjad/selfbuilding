import { AsyncLocalStorage } from "node:async_hooks";
import { NoActiveRunError } from "../errors/classes.js";
import type { RunState } from "./run-state.js";
import type { Scope } from "./scope.js";

/** What the primitives find through AsyncLocalStorage (spec §3.3). */
export interface Frame {
  readonly run: RunState;
  readonly scope: Scope;
  /** Selfbuilding internals and step() bodies: exempt from strict mode's determinism checks. */
  readonly internal: boolean;
}

const storage = new AsyncLocalStorage<Frame>();

/** The current frame, or NoActiveRunError naming the primitive that was called outside a run. */
export function currentFrame(primitive: string): Frame {
  const frame = storage.getStore();
  if (!frame) throw new NoActiveRunError({ primitive });
  return frame;
}

export function maybeFrame(): Frame | undefined {
  return storage.getStore();
}

/** Runs `fn` with `scope` as the current scope of factory code. */
export function withScope<T>(scope: Scope, fn: () => T): T {
  return storage.run({ run: scope.run, scope, internal: false }, fn);
}

/**
 * Runs Selfbuilding internals (or a step() body) inside the current run but exempt from strict mode. Agent,
 * sandbox and ask implementations wrap their work in this, so library and SDK code may read clocks freely.
 */
export function internal<T>(fn: () => T): T {
  const frame = storage.getStore();
  if (!frame || frame.internal) return fn();
  return storage.run({ ...frame, internal: true }, fn);
}
