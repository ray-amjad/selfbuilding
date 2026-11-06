import type { AgentRunContext, SlotLease } from "../agent/context.js";
import { hasCode } from "../agent/errors.js";
import {
  ConfigError,
  NotOwnerError,
  SandboxBusyError,
  SandboxHandleScopeError,
  SandboxUnsupportedError,
} from "../errors/classes.js";
import type { Duration } from "../types/common.js";
import { SANDBOX_PATHS } from "../types/runtime.js";
import type {
  Checkpoint,
  ExecResult,
  ForkMode,
  GitCheckpoint,
  ProviderSandbox,
  SandboxHandle,
  SandboxOptions,
  SandboxProvider,
  SandboxRef,
  Snapshot,
} from "../types/sandbox.js";
import type { GitToken } from "../types/security.js";
import type { SizeName } from "../types/sizes.js";
import { commitSnapshotRef, gitHostOf, hostPush, matchesCheckpoint, remoteUrlFor, syncWorkdir } from "./git.js";
import { durationMs } from "./hash.js";
import { branchName, checkpointRef, sandboxName } from "./names.js";
import { quiesce, resetForkChild, writeBoxMarker } from "./quiesce.js";
import { writeSandboxRow } from "./registry.js";
import { DEFAULT_LIFETIME_MS, imageFor, keyFor, resolveBoxSize, sandboxSpecFor, sizeEventData } from "./spec.js";

const HANDLE_BRAND = Symbol.for("selfbuilding.sandboxHandle");

interface HandleInit {
  ctx: AgentRunContext;
  id: string;
  callPath: string;
  ownerScope: string;
  provider?: SandboxProvider;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  from?: Snapshot | Checkpoint;
  forkedWith?: "filesystem" | "git";
  /** A live box handed over by fork; reset before first use. */
  box?: ProviderSandbox;
  slot?: SlotLease;
  /** The size the box is (or will be) created at; absent: the provider default. */
  size?: SizeName;
}

/** A call or exec currently holding the handle's mutation lock. */
export interface HandleLease {
  box: ProviderSandbox;
  provider: SandboxProvider;
  release(): void;
}

/**
 * The user-facing shared handle (spec §3.11). Lazy: no box exists until the first live use. One mutation at a time:
 * a second concurrent call throws SandboxBusyError instead of queuing.
 */
export class SharedSandbox implements SandboxHandle {
  readonly id: string;
  readonly callPath: string;
  readonly forkedWith?: "filesystem" | "git";
  readonly [HANDLE_BRAND] = true;

  #ctx: AgentRunContext;
  #ownerScope: string;
  /** Where the handle may be used; a fork is claimed by the first concurrent branch that uses it. */
  #useScope: string;
  #claimable: boolean;
  #provider?: SandboxProvider;
  #repo?: string;
  #branch: string;
  #from?: Snapshot | Checkpoint;
  #size?: SizeName;
  #version = 0;
  /** The step key of the last call on this handle that returned a value, live or replayed (spec §3.2). */
  #prevCheckpointStepKey: string | null = null;
  /** Set by a replayed call: the first live use materialises the box at this checkpoint (spec §3.11). */
  #replayedCheckpoint?: Checkpoint;
  /** Children forked so far. Child ids keep counting across fork() calls, so no two children share a key. */
  #forked = 0;
  /** fork() calls so far: each is its own journaled step. */
  #forkCalls = 0;
  #box?: ProviderSandbox;
  #needsReset = false;
  #busy: string | null = null;
  #disposed = false;
  #parked = false;
  #slot?: SlotLease;
  #materialising?: Promise<ProviderSandbox>;
  #parking?: Promise<boolean>;
  #baseSha?: string;
  #baseBranch?: string;
  #opened = false;
  /** Secret values delivered to calls on this box; no push may carry them out (spec §9.3). */
  #secrets = new Set<string>();
  #credentialFiles = new Set<string>();

  constructor(init: HandleInit) {
    this.id = init.id;
    this.callPath = init.callPath;
    if (init.forkedWith) this.forkedWith = init.forkedWith;
    this.#ctx = init.ctx;
    this.#ownerScope = init.ownerScope;
    this.#useScope = init.ownerScope;
    this.#claimable = init.forkedWith !== undefined;
    if (init.provider) this.#provider = init.provider;
    if (init.repo) this.#repo = init.repo;
    this.#branch = init.branch ?? branchName(init.ctx.runId, init.id);
    if (init.baseBranch) this.#baseBranch = init.baseBranch;
    if (init.from) this.#from = init.from;
    if (init.size !== undefined) this.#size = init.size;
    if (init.box) {
      this.#box = init.box;
      this.#needsReset = true;
    }
    if (init.slot) this.#adoptSlot(init.slot);
    init.ctx.ownHandle?.({ [Symbol.asyncDispose]: () => this.#disposeBox("kill") });
  }

  static is(value: unknown): value is SharedSandbox {
    return value !== null && typeof value === "object" && HANDLE_BRAND in value;
  }

  get version(): number {
    return this.#version;
  }

  /** @internal */
  noteSecrets(values: readonly string[]): void {
    for (const v of values) this.#secrets.add(v);
  }

  /** @internal Credential files a call staged in the box; quiesce removes them before any snapshot or fork. */
  noteCredentialFiles(paths: readonly string[]): void {
    for (const p of paths) this.#credentialFiles.add(p);
  }

  /** @internal Part of the step-key identity of the next call on this handle. */
  get prevCheckpointStepKey(): string | null {
    return this.#prevCheckpointStepKey;
  }

  /**
   * @internal A call on this handle returned a value. A replayed call never ran here, so it also advances the
   * version a live call would have advanced and remembers its checkpoint for the first live use.
   */
  noteCallSettled(stepKey: string, o: { replayed: boolean; checkpoint?: Checkpoint }): void {
    this.#prevCheckpointStepKey = stepKey;
    if (!o.replayed) return;
    this.#version++;
    if (o.checkpoint) this.#replayedCheckpoint = o.checkpoint;
  }

  /** @internal */
  get context(): AgentRunContext {
    return this.#ctx;
  }

  /** @internal */
  get repo(): string | undefined {
    return this.#repo;
  }

  /** @internal */
  get branch(): string {
    return this.#branch;
  }

  /** @internal */
  get baseSha(): string | undefined {
    return this.#baseSha;
  }

  /** @internal The branch the working branch starts from; undefined means the repo's default branch. */
  get baseBranch(): string | undefined {
    return this.#baseBranch;
  }

  /**
   * @internal A box opens on its first call, so a handle with no base of its own takes the first call's
   * `git.baseBranch`. Returns the base now in force: once the box has opened, it can no longer change.
   */
  adoptBaseBranch(base: string): string | undefined {
    if (this.#baseBranch === undefined && !this.#opened && this.#box === undefined) this.#baseBranch = base;
    return this.#baseBranch;
  }

  /** @internal The size name the box is created at; undefined means the provider default. */
  get size(): SizeName | undefined {
    return this.#size;
  }

  /** @internal The box ref, once materialised. */
  get ref(): SandboxRef | undefined {
    return this.#box?.ref;
  }

  /** @internal */
  resolveProvider(): SandboxProvider {
    const provider = this.#provider ?? this.#ctx.defaults.sandbox ?? this.#ctx.config.sandbox;
    if (!provider) {
      throw new ConfigError(
        `sandbox "${this.id}" has no provider. Pass sandbox({ provider }), set factory defaults.sandbox, or set sandbox in the config.`,
      );
    }
    this.#provider = provider;
    return provider;
  }

  #checkUsable(op: string): void {
    if (this.#disposed) throw new ConfigError(`sandbox "${this.id}" was disposed; ${op} needs a live handle.`);
    if (this.#ctx.handleUsable(this.#useScope)) return;
    // A fork handed to one parallel() child or pipeline() item counts as created there (spec §3.11).
    const here = this.#ctx.scopeId;
    if (this.#claimable && within(here, this.#useScope)) {
      this.#useScope = here;
      this.#claimable = false;
      return;
    }
    throw new SandboxHandleScopeError(undefined, { callPath: this.callPath });
  }

  #begin(op: string, by: string): void {
    this.#checkUsable(op);
    if (this.#busy !== null) {
      throw new SandboxBusyError(
        `sandbox "${this.id}" is busy with ${this.#busy}; ${op} cannot start until it finishes. Await it, or fork() for concurrent work.`,
      );
    }
    this.#busy = by;
    this.#slot?.setBusy?.(true);
  }

  #end(): void {
    this.#busy = null;
    // Idle between mutations, so a cap that cannot admit a waiter can park this box (spec §3.12).
    this.#slot?.setBusy?.(false);
  }

  #adoptSlot(slot: SlotLease): void {
    this.#slot = slot;
    slot.setBusy?.(this.#busy !== null);
    slot.setParker?.(() => this.#park());
  }

  /** Pauses an idle box and gives its slot back; the next live use takes a slot again and reopens it. */
  #park(): Promise<boolean> {
    if (this.#busy !== null || this.#disposed || !this.#box || this.#parked || this.#needsReset) {
      return Promise.resolve(false);
    }
    const box = this.#box;
    this.#parking = (async () => {
      const outcome = await this.resolveProvider().pause(box.ref);
      if (!outcome.confirmed) return false;
      this.#parked = true;
      const slot = this.#slot;
      this.#slot = undefined;
      slot?.setParker?.(null);
      slot?.release();
      this.#ctx.emit({ type: "sandbox.parked", callPath: this.callPath, data: { boxId: this.id, ref: box.ref } });
      return true;
    })().finally(() => {
      this.#parking = undefined;
    });
    return this.#parking;
  }

  async #takeSlot(): Promise<void> {
    if (this.#slot || !this.#ctx.acquireSlots) return;
    this.#adoptSlot(await this.#ctx.acquireSlots(this.id, 1));
  }

  #lifetimeMs(): number {
    const provider = this.resolveProvider();
    return Math.min(DEFAULT_LIFETIME_MS, provider.limits.maxLifetimeMs);
  }

  async #token(kind: "read" | "push"): Promise<GitToken | undefined> {
    const broker = this.#ctx.config.git;
    if (!broker || !this.#repo || !gitHostOf(this.#repo)) return undefined;
    const req = { repo: this.#repo, runId: this.#ctx.runId, callPath: this.callPath };
    return kind === "read"
      ? broker.readToken(req)
      : broker.pushToken({ ...req, launchId: `${sandboxName(keyFor(this.#ctx, this.id))}_e${this.#ctx.epoch}_l0` });
  }

  async #materialise(): Promise<ProviderSandbox> {
    const ctx = this.#ctx;
    const provider = this.resolveProvider();
    const key = keyFor(ctx, this.id);
    const name = sandboxName(key);
    // A resume recreates the box at the size the first run journaled for it.
    const journaled = ctx.journal ? (await ctx.journal.store.get(ctx.runId, name))?.sandbox?.size : undefined;
    if (journaled !== undefined) this.#size = journaled;
    const sizeOpts = this.#size !== undefined ? { provider, size: this.#size, callPath: this.callPath } : {};
    // Resolved before a slot is taken, so a refused size holds no capacity.
    resolveBoxSize(ctx, { image: imageFor(undefined), ...sizeOpts });
    await this.#takeSlot();
    await writeSandboxRow(ctx, {
      name,
      scope: this.id,
      status: "started",
      ...(this.#size !== undefined ? { size: this.#size } : {}),
    });
    // A replayed checkpoint is newer than whatever the handle was created from.
    const from = this.#replayedCheckpoint ?? this.#from;
    const snapshotId = from && "snapshotId" in from ? from.snapshotId : undefined;
    const restoreSnapshot =
      snapshotId ?? (from && "kind" in from && from.kind === "snapshot" ? from.snapshot.snapshotId : undefined);
    const gitFrom = from && "kind" in from ? (from.kind === "git" ? from : from.git) : undefined;
    const spec = sandboxSpecFor(ctx, {
      key,
      image: imageFor(undefined, restoreSnapshot),
      lifetimeMs: this.#lifetimeMs(),
      ...sizeOpts,
    });
    const open = () => provider.openOrCreate(key, spec, ctx.signal ? { signal: ctx.signal } : undefined);
    let opened = await open();
    if (!opened.created && !opened.rebuilt && this.#replayedCheckpoint && gitFrom) {
      // Reuse the original box only when it is exactly at the replayed checkpoint; otherwise rebuild it there.
      if (!(await matchesCheckpoint(opened.handle, gitFrom.sha).catch(() => false))) {
        await provider.kill(opened.handle.ref);
        opened = await open();
      }
    }
    const box = opened.handle;
    this.#opened = true;
    await writeSandboxRow(ctx, { name, scope: this.id, status: "started", ref: box.ref });
    if (opened.created || opened.rebuilt) {
      try {
        if (restoreSnapshot) {
          await resetForkChild(ctx, provider, box, { boxId: this.id, branch: this.#branch });
        } else if (this.#repo) {
          const synced = await syncWorkdir(box, {
            remoteUrl: remoteUrlFor(this.#repo),
            branch: this.#branch,
            ...(this.#baseBranch ? { base: this.#baseBranch } : {}),
            ...(gitFrom ? { checkoutRef: gitFrom.sha } : {}),
            ...(await this.#tokenOption("read")),
          });
          this.#baseSha = synced.baseSha;
        }
        await writeBoxMarker(ctx, box, { boxId: this.id, version: this.#version });
      } catch (error) {
        // A box that failed setup is never reused: the next open would find it and skip the setup (spec §9.9).
        await provider.kill(box.ref).catch(() => undefined);
        throw error;
      }
      ctx.emit({
        type: "sandbox.created",
        callPath: this.callPath,
        data: { boxId: this.id, ref: box.ref, ...sizeEventData(provider, spec) },
      });
    }
    this.#replayedCheckpoint = undefined;
    return box;
  }

  async #tokenOption(kind: "read" | "push"): Promise<{ token?: GitToken }> {
    const token = await this.#token(kind);
    return token ? { token } : {};
  }

  /** @internal The live box: materialised on first use, reopened when parked, reset when it is a fresh fork child. */
  async live(): Promise<ProviderSandbox> {
    if (this.#parking) await this.#parking;
    if (this.#box && this.#needsReset) {
      await resetForkChild(this.#ctx, this.resolveProvider(), this.#box, { boxId: this.id, branch: this.#branch });
      // Cleared only once the reset took: a retry after a failed reset must reset again.
      this.#needsReset = false;
    }
    if (this.#box && this.#parked) {
      await this.#takeSlot();
      this.#box = await this.resolveProvider().open(this.#box.ref, { lifetimeMs: this.#lifetimeMs() });
      this.#parked = false;
    }
    if (this.#box) return this.#box;
    this.#materialising ??= this.#materialise().finally(() => {
      this.#materialising = undefined;
    });
    this.#box = await this.#materialising;
    return this.#box;
  }

  /** Runs `fn` on the box; a box the provider paused behind our back is reopened once. */
  async #onBox<T>(fn: (box: ProviderSandbox) => Promise<T>): Promise<T> {
    const box = await this.live();
    try {
      return await fn(box);
    } catch (error) {
      if (!hasCode(error, "sandbox_unavailable")) throw error;
      const found = await this.resolveProvider().find(box.ref.key);
      if (found?.state !== "paused") throw error;
      this.#parked = true;
      return fn(await this.live());
    }
  }

  /** @internal Takes the mutation lock for an agent call. */
  async beginCall(callPath: string): Promise<HandleLease> {
    this.#begin("an agent call", callPath);
    try {
      const box = await this.live();
      this.#version++;
      return { box, provider: this.resolveProvider(), release: () => this.#end() };
    } catch (error) {
      this.#end();
      throw error;
    }
  }

  async exec(cmd: string, opts: { cwd?: string; timeout?: Duration; checkpoint?: boolean } = {}): Promise<ExecResult> {
    this.#begin("exec", `exec in ${this.callPath}`);
    try {
      const result = await this.#onBox((box) =>
        box.exec(cmd, {
          cwd: opts.cwd ?? SANDBOX_PATHS.workdir,
          timeoutMs: durationMs(opts.timeout, 120_000),
        }),
      );
      this.#version++;
      if (opts.checkpoint) await this.#checkpoint("git");
      return result;
    } finally {
      this.#end();
    }
  }

  async checkpoint(mode: "git" | "snapshot" = "git"): Promise<Checkpoint> {
    this.#begin("checkpoint", `checkpoint of ${this.id}`);
    try {
      return await this.#checkpoint(mode);
    } finally {
      this.#end();
    }
  }

  /** @internal Callers hold the mutation lock. */
  async checkpointLocked(mode: "git" | "snapshot"): Promise<Checkpoint> {
    return this.#checkpoint(mode);
  }

  async #gitCheckpoint(): Promise<GitCheckpoint> {
    const box = await this.live();
    const ref = checkpointRef(this.#ctx.runId, this.id, this.#version);
    const sha = await commitSnapshotRef(box, ref, `selfbuilding: checkpoint ${this.id}@${this.#version}`);
    const remote = this.#repo ? remoteUrlFor(this.#repo) : "";
    if (this.#repo) {
      await hostPush(box, {
        source: sha,
        remoteRef: ref,
        remoteUrl: remote,
        secrets: [...this.#secrets],
        target: "checkpoint",
        ...(await this.#tokenOption("push")),
      });
    }
    await writeBoxMarker(this.#ctx, box, { boxId: this.id, version: this.#version });
    return { kind: "git", remote, ref, sha };
  }

  async #checkpoint(mode: "git" | "snapshot"): Promise<Checkpoint> {
    const git = await this.#gitCheckpoint();
    if (mode === "git") return git;
    const provider = this.resolveProvider();
    if (!provider.snapshot) return git;
    return { kind: "snapshot", snapshot: await this.#snapshot(), git };
  }

  async push(): Promise<{ remote: string; name: string; sha: string }> {
    this.#begin("push", `push of ${this.id}`);
    try {
      if (!this.#repo) throw new ConfigError(`sandbox "${this.id}" has no repo to push to. Pass sandbox({ repo }).`);
      const box = await this.live();
      const { sha } = await hostPush(box, {
        source: "HEAD",
        remoteRef: this.#branch,
        remoteUrl: remoteUrlFor(this.#repo),
        secrets: [...this.#secrets],
        ...(await this.#tokenOption("push")),
      });
      return { remote: remoteUrlFor(this.#repo), name: this.#branch, sha };
    } finally {
      this.#end();
    }
  }

  async snapshot(): Promise<Snapshot> {
    this.#begin("snapshot", `snapshot of ${this.id}`);
    try {
      return await this.#snapshot();
    } finally {
      this.#end();
    }
  }

  async #snapshot(): Promise<Snapshot> {
    const provider = this.resolveProvider();
    const box = await this.live();
    if (!provider.snapshot)
      throw new SandboxUnsupportedError({ provider: provider.id, sandboxId: box.ref.id, op: "snapshot" });
    await quiesce(this.#ctx, provider, box, [...this.#credentialFiles]);
    const result = await provider.snapshot(box.ref, { name: `${box.ref.name}-v${this.#version}` });
    // Every stream and handle is stale after a snapshot (spec §5.4 invariant 17).
    this.#box = await provider.open(box.ref, { lifetimeMs: this.#lifetimeMs() });
    this.#ctx.emit({ type: "sandbox.snapshot", callPath: this.callPath, data: { boxId: this.id, ...result } });
    return {
      snapshotId: result.snapshotId,
      fidelity: result.fidelity,
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    };
  }

  async fork(n: number, opts: { mode?: ForkMode; size?: SizeName } = {}): Promise<(SandboxHandle | null)[]> {
    const mode = opts.mode ?? "best";
    const provider = this.resolveProvider();
    if (mode === "memory") throw new SandboxUnsupportedError({ provider: provider.id, op: "fork.memory" });
    if (!Number.isInteger(n) || n < 0) throw new ConfigError(`fork(n) needs a whole number, got ${n}.`);
    if (n === 0) return [];
    const native = provider.fork !== undefined || provider.snapshot !== undefined;
    if (mode === "filesystem" && !native) {
      throw new SandboxUnsupportedError({ provider: provider.id, op: "fork.filesystem" });
    }
    // Checked before any slot is taken, so a refused fork holds nothing.
    if ((mode === "git" || !native) && !this.#repo) {
      throw new SandboxUnsupportedError({ provider: provider.id, op: "fork.git (the handle has no repo)" });
    }
    const childSize = opts.size ?? this.#size;
    this.#checkForkSize(provider, childSize, mode === "git" || !native);
    this.#begin("fork", `fork of ${this.id}`);
    const record = await this.#forkRecord(n, mode, opts.size).catch((error: unknown) => {
      this.#end();
      throw error;
    });
    if (record.replay) {
      try {
        return this.#replayFork(record.replay, provider);
      } finally {
        if (record.key) this.#ctx.advanceChain(record.key, record.replay.launchId);
        this.#end();
      }
    }
    const slots = new ForkSlots(n);
    const children: SharedSandbox[] = [];
    let forkCheckpoint: GitCheckpoint | undefined;
    try {
      if (this.#ctx.acquireSlots) {
        // Waiting for the children's slots is not work on this box: the deadlock breaker must see it idle.
        this.#slot?.setBusy?.(false);
        try {
          slots.hold(await this.#ctx.acquireSlots(`${this.id}/fork`, n));
        } finally {
          this.#slot?.setBusy?.(true);
        }
      }
      const first = this.#forked;
      this.#forked += n;
      const childIds = Array.from({ length: n }, (_, i) => `${this.id}/fork[${first + i}]`);
      const scope = this.#ctx.scopeId;
      const child = (i: number, extra: Partial<HandleInit>): SharedSandbox => {
        const id = childIds[i] as string;
        const slot = slots.take(i);
        const c = new SharedSandbox({
          ctx: this.#ctx,
          id,
          callPath: id,
          ownerScope: scope,
          provider,
          ...(this.#repo ? { repo: this.#repo } : {}),
          branch: branchName(this.#ctx.runId, id),
          ...(this.#baseBranch ? { baseBranch: this.#baseBranch } : {}),
          ...(slot ? { slot } : {}),
          ...(childSize !== undefined ? { size: childSize } : {}),
          ...extra,
        });
        children.push(c);
        return c;
      };
      const fail = (i: number, error: unknown): null => {
        this.#ctx.emit({
          type: "sandbox.fork_failed",
          level: "error",
          callPath: this.callPath,
          data: { child: childIds[i], message: error instanceof Error ? error.message : String(error) },
        });
        slots.drop(i);
        return null;
      };
      const viaGit = async (): Promise<(SharedSandbox | null)[]> => {
        const checkpoint = await this.#gitCheckpoint();
        forkCheckpoint = checkpoint;
        return childIds.map((_, i) => child(i, { forkedWith: "git", from: checkpoint }));
      };

      const forked = await (async (): Promise<(SharedSandbox | null)[]> => {
        if (mode === "git" || !native) return await viaGit();

        // A replay rebuilds the children lazily from this checkpoint instead of forking again (spec §3.11).
        if (record.key && this.#repo) forkCheckpoint = await this.#gitCheckpoint();
        const box = await this.live();
        await quiesce(this.#ctx, provider, box, [...this.#credentialFiles]);
        const lifetimeMs = this.#lifetimeMs();
        let result: (SharedSandbox | null)[];
        try {
          result = await this.#nativeFork(provider, box, childIds, lifetimeMs, child, fail, childSize);
        } catch (error) {
          // Every stream and handle is stale after a snapshot or fork attempt (spec §5.4 invariant 17).
          this.#box = await provider.open(box.ref, { lifetimeMs });
          if (mode !== "best") throw error;
          this.#ctx.emit({
            type: "sandbox.fork_fallback",
            level: "warn",
            callPath: this.callPath,
            data: { boxId: this.id, message: error instanceof Error ? error.message : String(error) },
          });
          // "best" falls back to git; with no repo, each child comes back null so callers take their own fallback.
          return this.#repo ? await viaGit() : childIds.map((_, i) => fail(i, error));
        }
        this.#box = await provider.open(box.ref, { lifetimeMs });
        for (const c of result) {
          if (c) {
            await writeSandboxRow(this.#ctx, {
              name: sandboxName(keyFor(this.#ctx, c.id)),
              scope: c.id,
              status: "started",
              ...(c.ref ? { ref: c.ref } : {}),
            });
          }
        }
        this.#ctx.emit({
          type: "sandbox.forked",
          callPath: this.callPath,
          data: { boxId: this.id, n, ok: result.filter(Boolean).length },
        });
        return result;
      })();
      if (record.key) await this.#journalFork(record.key, forked, first, forkCheckpoint, childSize);
      return forked;
    } catch (error) {
      // Nothing reaches the caller: kill the children already built and give back every slot (spec §3.12).
      await Promise.all(children.map((c) => c.#disposeBox("kill").catch(() => undefined)));
      slots.releaseAll();
      throw error;
    } finally {
      if (record.key) this.#ctx.abandonChain?.(record.key);
      this.#end();
    }
  }

  /**
   * A fork's size is checked before any slot is taken (demo-path §1.2). Git forks build fresh boxes, so they are
   * checked like any new box; a native fork is also checked against the parent's size where forks inherit it.
   */
  #checkForkSize(provider: SandboxProvider, size: SizeName | undefined, viaGit: boolean): void {
    if (size === undefined) return;
    resolveBoxSize(this.#ctx, {
      image: imageFor(undefined),
      provider,
      size,
      callPath: this.callPath,
      ...(viaGit ? {} : { fork: this.#parentSize() }),
    });
  }

  #parentSize(): { parentSize?: string } {
    return this.#size !== undefined ? { parentSize: this.#size } : {};
  }

  /**
   * A fork is a journaled step of the handle (spec §3.11). The key chains on the handle's last settled call, so a
   * replay that reaches the same fork finds the record and rebuilds nothing until a child is used live.
   */
  async #forkRecord(
    n: number,
    mode: ForkMode,
    size: SizeName | undefined,
  ): Promise<{ key?: string; replay?: { launchId: string; value: ForkRecordValue } }> {
    const journal = this.#ctx.journal;
    if (!journal) return {};
    const callPath = `${this.id}.fork#${this.#forkCalls++}`;
    const key = this.#ctx.stepKey({
      callPath,
      target: "sandbox.fork",
      // Only an explicit size joins the key, so forks journaled before sizes existed still replay.
      input: size !== undefined ? { n, mode, size } : { n, mode },
      schema: "",
      exec: null,
      sandbox: { boxId: this.id, prevCheckpointStepKey: this.#prevCheckpointStepKey },
    });
    const entry = await journal.store.get(this.#ctx.runId, key);
    const value = entry?.status === "ok" ? (entry.value as ForkRecordValue | undefined) : undefined;
    if (value?.checkpoint) return { key, replay: { launchId: entry?.launchId ?? key, value } };
    return { key };
  }

  #replayFork(replay: { value: ForkRecordValue }, provider: SandboxProvider): (SandboxHandle | null)[] {
    const { value } = replay;
    const first = this.#forked;
    this.#forked += value.children.length;
    const scope = this.#ctx.scopeId;
    const children = value.children.map((ok, i) => {
      if (!ok) return null;
      const id = `${this.id}/fork[${first + i}]`;
      return new SharedSandbox({
        ctx: this.#ctx,
        id,
        callPath: id,
        ownerScope: scope,
        provider,
        ...(this.#repo ? { repo: this.#repo } : {}),
        branch: branchName(this.#ctx.runId, id),
        ...(this.#baseBranch ? { baseBranch: this.#baseBranch } : {}),
        forkedWith: value.forkedWith,
        from: value.checkpoint as GitCheckpoint,
        ...(value.size !== undefined ? { size: value.size } : {}),
      });
    });
    this.#ctx.emit({
      type: "sandbox.fork_replayed",
      callPath: this.callPath,
      data: { boxId: this.id, n: children.length },
    });
    return children;
  }

  async #journalFork(
    key: string,
    children: (SharedSandbox | null)[],
    first: number,
    checkpoint: GitCheckpoint | undefined,
    size: SizeName | undefined,
  ): Promise<void> {
    const journal = this.#ctx.journal;
    if (!journal) return;
    const launchId = `${key}_e${this.#ctx.epoch}_l0`;
    const value: ForkRecordValue = {
      first,
      children: children.map((c) => c !== null),
      forkedWith: children.find((c) => c !== null)?.forkedWith ?? "git",
      ...(checkpoint ? { checkpoint } : {}),
      ...(size !== undefined ? { size } : {}),
    };
    const now = new Date().toISOString();
    await journal.store.put(
      {
        runId: this.#ctx.runId,
        stepKey: key,
        callPath: `${this.id}.fork`,
        kind: "sandbox",
        status: "ok",
        launchId,
        value,
        attempt: 1,
        startedAt: now,
        finishedAt: now,
      },
      { lease: journal.lease },
    );
    this.#ctx.advanceChain(key, launchId);
  }

  /** The provider fork, or a snapshot opened n times. A whole-call failure throws; a per-child one is null. */
  async #nativeFork(
    provider: SandboxProvider,
    box: ProviderSandbox,
    childIds: string[],
    lifetimeMs: number,
    child: (i: number, extra: Partial<HandleInit>) => SharedSandbox,
    fail: (i: number, error: unknown) => null,
    size: SizeName | undefined,
  ): Promise<(SharedSandbox | null)[]> {
    const sized = size !== undefined ? { provider, size, callPath: this.callPath, fork: this.#parentSize() } : {};
    const specs = childIds.map((id) => {
      const key = keyFor(this.#ctx, id);
      return {
        id,
        key,
        spec: sandboxSpecFor(this.#ctx, {
          key,
          image: imageFor(undefined),
          lifetimeMs,
          parentId: box.ref.id,
          ...sized,
        }),
      };
    });
    const resolved = specs[0]?.spec.size;
    if (provider.fork) {
      const results = await provider.fork(box.ref, {
        children: specs.map((s) => ({ name: sandboxName(s.key), labels: s.spec.labels, key: s.key })),
        lifetimeMs,
        // Only providers whose forks may change size are told one; the others give every child the parent's.
        ...(resolved && provider.sizing?.forkSize === "override" ? { size: resolved } : {}),
      });
      return results.map((r, i) =>
        r instanceof Error || !("exec" in r) ? fail(i, r) : child(i, { forkedWith: "filesystem", box: r }),
      );
    }
    const snap = await (provider.snapshot as NonNullable<SandboxProvider["snapshot"]>)(box.ref, {
      name: `${box.ref.name}-fork-v${this.#version}`,
    });
    return Promise.all(
      specs.map(async (s, i) => {
        try {
          const opened = await provider.openOrCreate(s.key, { ...s.spec, image: imageFor(undefined, snap.snapshotId) });
          return child(i, { forkedWith: "filesystem", box: opened.handle });
        } catch (error) {
          return fail(i, error);
        }
      }),
    );
  }

  async dispose(opts: { mode?: "kill" | "pause" } = {}): Promise<void> {
    const here = this.#ctx.scopeId;
    if (here !== this.#ownerScope && here !== this.#useScope)
      throw new NotOwnerError(undefined, { callPath: this.callPath });
    if (this.#busy !== null) {
      throw new SandboxBusyError(`sandbox "${this.id}" is busy with ${this.#busy}; await it before dispose().`);
    }
    await this.#disposeBox(opts.mode ?? "kill");
  }

  async #disposeBox(mode: "kill" | "pause"): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const box = this.#box;
    this.#slot?.setParker?.(null);
    try {
      if (this.#parking) await this.#parking.catch(() => false);
      if (!box) return;
      const provider = this.resolveProvider();
      if (mode === "pause") {
        const outcome = await provider.pause(box.ref);
        if (!outcome.confirmed) {
          this.#ctx.emit({
            type: "sandbox.pause_refused",
            level: "error",
            callPath: this.callPath,
            data: { boxId: this.id, ...outcome },
          });
          // A box kept for later must not run (and bill) until its full lifetime: a short TTL bounds it (§9.9 #5).
          await box.extendLifetime(Date.now() + 15 * 60_000, { allowShorter: true }).catch(() => undefined);
        }
      } else {
        await provider.kill(box.ref);
      }
      await writeSandboxRow(this.#ctx, {
        name: sandboxName(keyFor(this.#ctx, this.id)),
        scope: this.id,
        status: "ok",
        ref: box.ref,
      });
      this.#ctx.emit({ type: "sandbox.disposed", callPath: this.callPath, data: { boxId: this.id, mode } });
    } finally {
      this.#slot?.release();
      this.#slot = undefined;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

/** What the journal keeps for a fork: enough to rebuild each child lazily at the parent's state then. */
interface ForkRecordValue {
  first: number;
  children: boolean[];
  forkedWith: "filesystem" | "git";
  checkpoint?: GitCheckpoint;
  /** The children's size, so a replay rebuilds them at it. */
  size?: string;
}

/**
 * The slots a fork takes, n at once. Each child owns one; a slot nobody owns is released when its child fails or
 * the whole fork throws, so a refused fork never keeps capacity.
 */
class ForkSlots {
  #lease?: SlotLease & { each?: SlotLease[] };
  #owned: (SlotLease | null | undefined)[];
  #remaining: number;

  constructor(n: number) {
    this.#owned = Array.from({ length: n }, () => undefined);
    this.#remaining = n;
  }

  hold(lease: SlotLease & { each?: SlotLease[] }): void {
    this.#lease = lease;
  }

  #share(): SlotLease {
    // A context that hands out one lease for all n slots: the last holder to release gives all of them back.
    const lease = this.#lease as SlotLease;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (--this.#remaining === 0) lease.release();
      },
    };
  }

  /** Hands slot i to its child. */
  take(i: number): SlotLease | undefined {
    if (!this.#lease) return undefined;
    const slot = this.#lease.each?.[i] ?? this.#share();
    this.#owned[i] = slot;
    return slot;
  }

  /** Slot i has no child: give it back now. */
  drop(i: number): void {
    if (!this.#lease || this.#owned[i] === null) return;
    const slot = this.#owned[i] ?? this.#lease.each?.[i] ?? this.#share();
    this.#owned[i] = null;
    slot.release();
  }

  /** The fork threw: every slot goes back, owned or not (owned children were disposed). */
  releaseAll(): void {
    if (!this.#lease) return;
    if (this.#lease.each) {
      for (const slot of this.#lease.each) slot.release();
      return;
    }
    this.#lease.release();
  }
}

/** Creates the handle for `sandbox()`. */
export function createHandle(ctx: AgentRunContext, spec: SandboxOptions): SharedSandbox {
  const id = ctx.nextCallPath("sandbox", spec.label);
  const repo = spec.repo ?? ctx.defaults.repo;
  const size = spec.size ?? ctx.defaults.size;
  return new SharedSandbox({
    ctx,
    id,
    callPath: id,
    ownerScope: ctx.scopeId,
    ...(spec.provider ? { provider: spec.provider } : {}),
    ...(repo ? { repo } : {}),
    ...(spec.branch ? { branch: spec.branch } : {}),
    ...(spec.baseBranch ? { baseBranch: spec.baseBranch } : {}),
    ...(spec.from ? { from: spec.from } : {}),
    ...(size !== undefined ? { size } : {}),
  });
}

/** True when concurrency root `inner` is nested in `outer` ("" is the run root). */
function within(inner: string, outer: string): boolean {
  return inner !== outer && (outer === "" || inner.startsWith(`${outer}/`));
}
