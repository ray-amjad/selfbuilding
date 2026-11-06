import { ConfigError, SandboxCapDeadlockError } from "../errors/classes.js";

/** Deeper pipeline stages first, then lower item indexes (spec §3.5). */
export interface SlotPriority {
  depth: number;
  index: number;
}

export const DEFAULT_PRIORITY: SlotPriority = { depth: 0, index: 0 };

export interface Slot {
  readonly id: number;
  readonly callPath: string;
  /** Busy while a turn or exec runs. Deadlock detection looks only at idle holders. */
  setBusy(busy: boolean): void;
  /** Lets the slot manager park the holder's box to break a deadlock. Resolves true when parked. */
  setParker(park: (() => Promise<boolean>) | null): void;
  release(): void;
}

interface Waiter {
  callPath: string;
  n: number;
  priority: SlotPriority;
  order: number;
  resolve: (slots: Slot[]) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Held {
  id: number;
  callPath: string;
  busy: boolean;
  parker: (() => Promise<boolean>) | null;
  parking: boolean;
}

/**
 * The live-sandbox cap (spec §3.12): an in-process semaphore over sandboxes, not agents. `acquire(n)` takes
 * all n slots at once or none, waiters are served strictly in priority order, and a cap that can never admit
 * its waiters is broken by parking idle shared handles or reported as SandboxCapDeadlockError.
 */
export class SandboxSlots {
  private readonly held = new Map<number, Held>();
  private waiters: Waiter[] = [];
  private nextId = 1;
  private order = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly cap: number,
    private readonly opts: { deadlockAfterMs?: number } = {},
  ) {
    if (!Number.isInteger(cap) || cap < 1)
      throw new ConfigError(`concurrency.sandboxes must be a positive integer; got ${cap}.`);
  }

  get inUse(): number {
    return this.held.size;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  acquire(callPath: string, priority: SlotPriority = DEFAULT_PRIORITY, n = 1, signal?: AbortSignal): Promise<Slot[]> {
    if (!Number.isInteger(n) || n < 1)
      throw new ConfigError(`A sandbox slot request needs a positive count; got ${n}.`);
    if (n > this.cap) {
      throw new ConfigError(
        `${callPath} needs ${n} sandboxes at once but concurrency.sandboxes is ${this.cap}. Raise the cap or fork fewer.`,
      );
    }
    signal?.throwIfAborted();
    return new Promise<Slot[]>((resolve, reject) => {
      const waiter: Waiter = { callPath, n, priority, order: this.order++, resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(signal.reason);
          this.pump();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.waiters.sort(compareWaiters);
      this.pump();
    });
  }

  /** Callers that hold slots and are about to wait on other slots for a long time can check this. */
  holders(): { callPath: string; busy: boolean }[] {
    return [...this.held.values()].map((h) => ({ callPath: h.callPath, busy: h.busy }));
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0] as Waiter;
      if (this.cap - this.held.size < head.n) break;
      this.waiters.shift();
      if (head.signal && head.onAbort) head.signal.removeEventListener("abort", head.onAbort);
      const slots: Slot[] = [];
      for (let i = 0; i < head.n; i++) slots.push(this.grant(head.callPath));
      head.resolve(slots);
    }
    this.scheduleDeadlockCheck();
  }

  private grant(callPath: string): Slot {
    const id = this.nextId++;
    const held: Held = { id, callPath, busy: true, parker: null, parking: false };
    this.held.set(id, held);
    let released = false;
    return {
      id,
      callPath,
      setBusy: (busy) => {
        held.busy = busy;
        this.scheduleDeadlockCheck();
      },
      setParker: (park) => {
        held.parker = park;
        this.scheduleDeadlockCheck();
      },
      release: () => {
        if (released) return;
        released = true;
        this.held.delete(id);
        this.pump();
      },
    };
  }

  private scheduleDeadlockCheck(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.isStuck()) return;
    // Idle holders are often between two calls; only a state that persists counts as a deadlock.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.breakDeadlock();
    }, this.opts.deadlockAfterMs ?? 250);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private isStuck(): boolean {
    if (this.waiters.length === 0) return false;
    const head = this.waiters[0] as Waiter;
    if (this.cap - this.held.size >= head.n) return false;
    return [...this.held.values()].every((h) => !h.busy && !h.parking);
  }

  private async breakDeadlock(): Promise<void> {
    if (!this.isStuck()) return;
    const parkable = [...this.held.values()].filter((h) => h.parker !== null);
    for (const holder of parkable) {
      if (!this.isStuck()) return;
      holder.parking = true;
      try {
        // A successful parker releases its slot itself, which pumps the waiters.
        await (holder.parker as () => Promise<boolean>)();
      } catch {
        // A box that refuses to park stays a holder.
      } finally {
        holder.parking = false;
      }
    }
    if (!this.isStuck()) return;
    const error = new SandboxCapDeadlockError({
      holders: [...this.held.values()].map((h) => h.callPath),
      waiters: this.waiters.map((w) => w.callPath),
    });
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      w.reject(error);
    }
  }

  /** Stops the deadlock timer; used when a run ends. */
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

function compareWaiters(a: Waiter, b: Waiter): number {
  return b.priority.depth - a.priority.depth || a.priority.index - b.priority.index || a.order - b.order;
}

/**
 * The default cap: `min(4, provider.limits.maxConcurrent)` unless `concurrency.sandboxes` is set (spec §3.12).
 */
export function defaultSandboxCap(explicit: number | undefined, providerMax: number | undefined): number {
  if (explicit !== undefined) return explicit;
  return Math.max(1, Math.min(4, providerMax ?? 4));
}
