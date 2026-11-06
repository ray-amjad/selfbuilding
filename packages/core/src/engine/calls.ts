import { ConfigError } from "../errors/classes.js";
import { serializeThrown } from "../errors/serialize.js";
import type { JournalEntry } from "../types/orchestration.js";
import { currentFrame, type Frame } from "./context.js";
import { base32Lower, canonicalJson, internalNow, sha256Bytes, sha256Hex } from "./hash.js";
import type { RunState } from "./run-state.js";
import { headAfter, type Scope } from "./scope.js";

/** What identifies one primitive call (spec §3.2). */
export interface CallSpec {
  kind: Exclude<JournalEntry["kind"], "run" | "charge">;
  /** The `Name` of `Name#n`: an agent name, "exec", "fork", "now", ... */
  name: string;
  /** Replaces `Name#n`; required for steps (the step name). */
  label?: string;
  /** Skill hash, sha256(prompt), or step name. */
  target: string;
  input?: unknown;
  /** The result JSON Schema, or its hash. */
  schema?: unknown;
  /** `{ harness id + version policy, model, effort }`. Not label, phase or timeout. */
  exec?: unknown;
  /** `"fresh"` + provider spec hash, or `{ boxId, prevCheckpointStepKey }`. */
  sandbox?: unknown;
}

/** stepKey = base32lower(sha256(canonicalJson({...}))).slice(0, 26) (spec §3.2). */
export function computeStepKey(fields: {
  callPath: string;
  chain: string;
  target: string;
  input?: unknown;
  schema?: unknown;
  exec?: unknown;
  sandbox?: unknown;
  refresh: string | null;
}): string {
  const canonical = canonicalJson({
    v: 1,
    callPath: fields.callPath,
    chain: fields.chain,
    target: fields.target,
    input: fields.input ?? null,
    schema:
      fields.schema === undefined
        ? null
        : typeof fields.schema === "string"
          ? fields.schema
          : sha256Hex(canonicalJson(fields.schema)),
    exec: fields.exec ?? null,
    sandbox: fields.sandbox ?? null,
    refresh: fields.refresh,
  });
  return base32Lower(sha256Bytes(canonical)).slice(0, 26);
}

const LAUNCH_INDEX = /_l(\d+)$/;

/**
 * One journaled call, opened synchronously so its callPath and stepKey never depend on timing. The caller
 * either replays it (`previous` is `ok`) or runs it live through start → update* → complete | fail.
 * Every opened call must end in exactly one of `replay`, `complete`, `fail` or `abandon`, which advances
 * the scope's chain head in call order.
 */
export class OpenedCall {
  readonly run: RunState;
  readonly scope: Scope;
  readonly callPath: string;
  readonly stepKey: string;
  readonly kind: CallSpec["kind"];
  /** The journal entry for this step key from an earlier attempt, if any. */
  readonly previous: JournalEntry | null;
  /** 1 for the first attempt; previous attempt + 1 when re-running a failed or interrupted entry. */
  readonly attempt: number;
  private readonly firstLaunch: number;
  private readonly settleLink: (advance: ((head: string) => string) | null) => void;
  private current: JournalEntry | null = null;
  private ended = false;

  constructor(frame: Frame, spec: CallSpec) {
    this.run = frame.run;
    this.scope = frame.scope;
    this.kind = spec.kind;
    this.callPath = frame.scope.allocate(spec.name, spec.label);
    const refresh = this.run.isRefreshed(this.callPath) ? this.run.resumeId : null;
    this.stepKey = computeStepKey({
      callPath: this.callPath,
      chain: frame.scope.chainHead,
      target: spec.target,
      input: spec.input,
      schema: spec.schema,
      exec: spec.exec,
      sandbox: spec.sandbox,
      refresh,
    });
    this.settleLink = frame.scope.reserveLink();
    this.run.visited.add(this.stepKey);
    this.previous = this.run.entries.get(this.stepKey) ?? null;
    this.attempt = this.previous ? this.previous.attempt + 1 : 1;
    const prevIndex = this.previous ? Number(LAUNCH_INDEX.exec(this.previous.launchId)?.[1] ?? -1) : -1;
    this.firstLaunch = prevIndex + 1;
  }

  /** True when an `ok` entry exists: the caller should `replay()` instead of running live. */
  get cached(): boolean {
    return this.previous?.status === "ok";
  }

  /** `${stepKey}_e${epoch}_l${n}`: `n` counts launches of this call across attempts (spec §7.2). */
  launchId(n = 0): string {
    return `${this.stepKey}_e${this.run.epoch}_l${this.firstLaunch + n}`;
  }

  get entry(): JournalEntry | null {
    return this.current;
  }

  /** Returns the stored value and keeps the chain head as it was last time. */
  replay(): unknown {
    const previous = this.previous;
    if (previous?.status !== "ok")
      throw new ConfigError(`replay() on ${this.callPath} needs an ok journal entry; check cached first.`);
    this.end(previous.launchId);
    return previous.value;
  }

  /** Write-ahead: the `started` entry, before any sandbox or harness launches (spec §3.9). */
  async start(patch: Partial<JournalEntry> = {}): Promise<JournalEntry> {
    this.run.signal.throwIfAborted();
    this.scope.live = true;
    const entry: JournalEntry = {
      runId: this.run.runId,
      stepKey: this.stepKey,
      callPath: this.callPath,
      kind: this.kind,
      status: "started",
      launchId: this.launchId(),
      attempt: this.attempt,
      startedAt: new Date(internalNow()).toISOString(),
      ...patch,
    };
    await this.run.writeOrConflict(entry, this.previous?.status ?? null);
    this.current = entry;
    return entry;
  }

  /** Rewrites the started entry as facts arrive: SandboxRef, session id, pid, harnessStartedAt. */
  async update(patch: Partial<JournalEntry>): Promise<JournalEntry> {
    if (!this.current) throw new ConfigError(`update() on ${this.callPath} before start().`);
    const entry: JournalEntry = { ...this.current, ...patch, status: "started" };
    await this.run.writeOrConflict(entry, "started");
    this.current = entry;
    return entry;
  }

  /** The completion, written only after the value is final (spec §3.9). */
  async complete(value: unknown, opts: { launchId?: string; patch?: Partial<JournalEntry> } = {}): Promise<void> {
    await this.finish("ok", value, opts);
  }

  /** Records a failure. Failures are never cached: the next resume runs the call live again. */
  async fail(error: unknown, opts: { launchId?: string; patch?: Partial<JournalEntry> } = {}): Promise<void> {
    await this.finish("failed", { error: serializeThrown(error) }, opts);
  }

  /** Ends a call that never started (a usage error before launch): the chain head is left unchanged. */
  abandon(): void {
    if (this.ended) return;
    this.ended = true;
    this.settleLink(null);
  }

  /** For synchronous clock calls: settles now and writes the `ok` entry in the background. */
  completeSync(value: unknown): void {
    this.scope.live = true;
    const launchId = this.launchId();
    const at = new Date(internalNow()).toISOString();
    const entry: JournalEntry = {
      runId: this.run.runId,
      stepKey: this.stepKey,
      callPath: this.callPath,
      kind: this.kind,
      status: "ok",
      launchId,
      value,
      attempt: this.attempt,
      startedAt: at,
      finishedAt: at,
    };
    this.run.entries.set(this.stepKey, entry);
    this.end(launchId);
    void this.run.write(entry, this.previous?.status ?? null).catch(() => {});
  }

  private async finish(
    status: "ok" | "failed",
    value: unknown,
    opts: { launchId?: string; patch?: Partial<JournalEntry> },
  ): Promise<void> {
    const launchId = opts.launchId ?? this.current?.launchId ?? this.launchId();
    const base: JournalEntry = this.current ?? {
      runId: this.run.runId,
      stepKey: this.stepKey,
      callPath: this.callPath,
      kind: this.kind,
      status: "started",
      launchId,
      attempt: this.attempt,
      startedAt: new Date(internalNow()).toISOString(),
    };
    const entry: JournalEntry = {
      ...base,
      ...opts.patch,
      status,
      launchId,
      value,
      finishedAt: new Date(internalNow()).toISOString(),
    };
    try {
      await this.run.writeOrConflict(entry, this.current ? "started" : (this.previous?.status ?? null));
      this.current = entry;
    } finally {
      this.end(launchId);
    }
  }

  private end(launchId: string): void {
    if (this.ended) return;
    this.ended = true;
    this.settleLink(() => headAfter(this.stepKey, launchId));
  }
}

/** Opens a journaled call in the current scope. Synchronous: the callPath and stepKey are fixed at once. */
export function openCall(primitive: string, spec: CallSpec): OpenedCall {
  return new OpenedCall(currentFrame(primitive), spec);
}
