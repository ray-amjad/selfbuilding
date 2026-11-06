import type { CallState, LaunchId, LaunchStatus, RuntimeState } from "@selfbuilding/core";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import type { AttemptLayout, Layout } from "./paths.js";

export const TERMINAL_STATES: ReadonlySet<CallState> = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/**
 * state.json for one attempt, plus the launch's `.status` file, both rewritten on every change. The active-time
 * clock lives here: it advances only while not paused, and pauses while the call waits on a human.
 */
export class StateStore {
  #state: RuntimeState;
  #clockMark: number;
  #hasOutcome = false;

  constructor(
    private readonly layout: Layout,
    private readonly attempt: AttemptLayout,
    readonly launchId: string,
    private readonly now: () => number = Date.now,
  ) {
    const previous = readJson<RuntimeState>(attempt.state);
    // askSeq, the session and the turn count carry over from earlier launches of the same attempt (spec §8.3).
    this.#state = {
      phase: "booting",
      launchId: launchId as LaunchId,
      pids: { supervisor: process.pid },
      lastSeq: previous?.lastSeq ?? 0,
      heartbeatAt: new Date(now()).toISOString(),
      clock: { activeMs: previous?.clock.activeMs ?? 0, paused: false },
      askSeq: previous?.askSeq ?? 0,
      turnIndex: previous?.turnIndex ?? 0,
      ...(previous?.sessionId === undefined ? {} : { sessionId: previous.sessionId }),
      ...(previous?.pendingAsk === undefined ? {} : { pendingAsk: previous.pendingAsk }),
    };
    this.#clockMark = now();
  }

  static read(attempt: AttemptLayout): RuntimeState | undefined {
    return readJson<RuntimeState>(attempt.state);
  }

  get value(): Readonly<RuntimeState> {
    return this.#state;
  }

  /** Active milliseconds so far, including the running stretch since the last update. */
  activeMs(): number {
    const { activeMs, paused } = this.#state.clock;
    return paused ? activeMs : activeMs + (this.now() - this.#clockMark);
  }

  #tick(): void {
    const at = this.now();
    if (!this.#state.clock.paused) this.#state.clock.activeMs += at - this.#clockMark;
    this.#clockMark = at;
  }

  pauseClock(): void {
    this.#tick();
    this.#state.clock.paused = true;
  }

  resumeClock(): void {
    this.#tick();
    this.#state.clock.paused = false;
  }

  /** Tracks the spool cursor without a write; the next update or heartbeat persists it. */
  setLastSeq(seq: number): void {
    this.#state.lastSeq = seq;
  }

  setHasOutcome(): void {
    this.#hasOutcome = true;
  }

  update(patch: Partial<RuntimeState> = {}): void {
    this.#tick();
    this.#state = { ...this.#state, ...patch, heartbeatAt: new Date(this.now()).toISOString() };
    for (const key of Object.keys(patch) as (keyof RuntimeState)[]) {
      if (patch[key] === undefined) delete this.#state[key];
    }
    this.flush();
  }

  flush(): void {
    writeJsonAtomic(this.attempt.state, this.#state);
    const status: LaunchStatus = {
      launchId: this.launchId as LaunchId,
      state: this.#state.phase,
      lastSeq: this.#state.lastSeq,
      hasOutcome: this.#hasOutcome,
      pendingAsk: this.#state.pendingAsk !== undefined,
      at: this.#state.heartbeatAt,
    };
    writeJsonAtomic(this.layout.launchStatus(this.launchId), status);
  }
}
