import type { SlotPriority } from "../budget/slots.js";
import { ConfigError, DuplicateLabelError } from "../errors/classes.js";
import type { FactoryOptions } from "../types/orchestration.js";
import { sha256Hex } from "./hash.js";
import type { RunState } from "./run-state.js";

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_CALL_PATH = 512;

/** The factory whose body a scope belongs to: depth 0 is the run's own factory, 1 a nested one (spec §3.7). */
export interface FactoryFrame {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: a frame holds any factory's options
  options: FactoryOptions<any, any>;
  depth: number;
}

/** Identity of a concurrent branch: the run root, each parallel() child and each pipeline() item. */
export interface ConcurrencyRoot {
  readonly path: string;
}

/**
 * One sequential scope of a run (spec §3.2): it owns the per-name counters, the label set, the current phase
 * and the chain head that makes every later step key depend on what ran before it.
 */
export class Scope {
  /** True once a call in this scope (or before it opened) ran live; log/phase events are then not replays. */
  live: boolean;
  phase: string | undefined;
  private readonly counters = new Map<string, number>();
  private readonly labels = new Set<string>();
  private head: string;
  private nextLink = 0;
  private appliedLinks = 0;
  private readonly settledLinks = new Map<number, ((head: string) => string) | null>();

  constructor(
    readonly run: RunState,
    /** The callPath prefix of everything in this scope; "" at the root. */
    readonly path: string,
    readonly factory: FactoryFrame,
    readonly concurrencyRoot: ConcurrencyRoot,
    readonly priority: SlotPriority,
    readonly parent: Scope | null,
    chainHead: string,
  ) {
    this.head = chainHead;
    this.live = parent?.live ?? false;
    this.phase = parent?.phase;
  }

  /** The chain head that the next call's step key includes. */
  get chainHead(): string {
    return this.head;
  }

  /**
   * Allocates the next callPath segment. Unlabelled calls get `Name#n`, counted per name; a label (or a
   * step name) is used as is and must be unique in the scope.
   */
  allocate(name: string, label?: string): string {
    let segment: string;
    if (label !== undefined) {
      if (!LABEL_PATTERN.test(label)) {
        throw new ConfigError(`Label "${label}" must match ^[a-z0-9][a-z0-9-]{0,47}$ (lowercase, digits and dashes).`);
      }
      if (this.labels.has(label)) throw new DuplicateLabelError({ label }, { callPath: this.join(label) });
      this.labels.add(label);
      segment = label;
    } else {
      if (!name || name.includes("/"))
        throw new ConfigError(`"${name}" cannot name a call: it must be non-empty with no "/".`);
      const n = this.counters.get(name) ?? 0;
      this.counters.set(name, n + 1);
      segment = `${name}#${n}`;
    }
    return this.join(segment);
  }

  /** Reserves a unique bracketed segment such as `[issue-412]` for a parallel() child or pipeline() item. */
  claimKey(key: string): string {
    const segment = `[${key}]`;
    if (this.labels.has(segment)) throw new DuplicateLabelError({ label: segment }, { callPath: this.join(segment) });
    this.labels.add(segment);
    return segment;
  }

  join(segment: string): string {
    const path = this.path === "" ? segment : `${this.path}/${segment}`;
    if (path.length > MAX_CALL_PATH) {
      throw new ConfigError(
        `callPath "${path.slice(0, 80)}…" is longer than ${MAX_CALL_PATH} characters. Use shorter labels or keys.`,
      );
    }
    return path;
  }

  /**
   * Reserves this call's place in the chain. Links are applied in the order they were reserved, whatever the
   * order calls finish in, so concurrent single calls in one scope still give later calls a stable key.
   * Settle with a function of the current head, or null to leave the head unchanged.
   */
  reserveLink(): (advance: ((head: string) => string) | null) => void {
    const index = this.nextLink++;
    let settled = false;
    return (advance) => {
      if (settled) return;
      settled = true;
      this.settledLinks.set(index, advance);
      while (this.settledLinks.has(this.appliedLinks)) {
        const next = this.settledLinks.get(this.appliedLinks);
        this.settledLinks.delete(this.appliedLinks);
        this.appliedLinks++;
        if (next) this.head = next(this.head);
      }
    };
  }

  /** Opens a child scope that starts from this scope's current chain head. */
  child(opts: { path: string; concurrent: boolean; priority?: SlotPriority; factory?: FactoryFrame }): Scope {
    return new Scope(
      this.run,
      opts.path,
      opts.factory ?? this.factory,
      opts.concurrent ? { path: opts.path } : this.concurrencyRoot,
      opts.priority ?? this.priority,
      this,
      this.head,
    );
  }

  /** The nearest scope's factory defaults, for execution-setting precedence (spec §1.11). */
  get defaults(): FactoryFrame["options"]["defaults"] {
    return this.factory.options.defaults;
  }
}

/** The chain head after a call: sha256(stepKey + ":" + launchId) (spec §3.2). */
export function headAfter(stepKey: string, launchId: string): string {
  return sha256Hex(`${stepKey}:${launchId}`);
}

/** Folds child scopes back into their parent, so a live call inside them also makes later parent calls live. */
export function foldHeads(kind: string, parentHead: string, childHeads: readonly string[]): string {
  return sha256Hex(`${kind}:${parentHead}:${childHeads.join(",")}`);
}
