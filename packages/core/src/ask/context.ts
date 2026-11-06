import { AsyncLocalStorage } from "node:async_hooks";
import type { AskSession } from "./session.js";

// How `ask()` finds its run. The engine wraps the factory body in runWithAskScope; `callPath` reads the
// engine's own position tracking, so asks inside parallel branches get their branch's path.

export interface AskScope {
  session: AskSession;
  callPath(): string;
}

const storage = new AsyncLocalStorage<AskScope>();

export function runWithAskScope<T>(scope: AskScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentAskScope(): AskScope | undefined {
  return storage.getStore();
}
