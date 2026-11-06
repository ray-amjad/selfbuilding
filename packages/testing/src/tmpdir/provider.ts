import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type DeploymentId,
  EgressPolicyUnsupportedError,
  type ExecOpts,
  type ExecResult,
  type OnLine,
  type PauseOutcome,
  type ProcessRef,
  type ProviderLimits,
  type ProviderSandbox,
  type ProviderSizing,
  type ResolvedSize,
  RUNTIME_ENV,
  SANDBOX_PATHS,
  SandboxCommandTimeoutError,
  type SandboxError,
  SandboxFileNotFoundError,
  SandboxGuestGoneError,
  type SandboxKey,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxQuotaError,
  type SandboxRef,
  type SandboxSpec,
  type SandboxState,
  SandboxUnavailableError,
  SELFBUILDING_LABELS,
  SecretInEnvError,
  SizeUnavailableError,
  type SnapshotResult,
  type SpawnOpts,
  type WriteFileEntry,
} from "@selfbuilding/core";
import { type FaultController, Faults } from "./faults.js";
import { BOX_DIRS, hostPath, looksSecret, rewriteCommand } from "./paths.js";
import { LineSplitter, Tail } from "./stream.js";

export interface TmpdirProviderOptions {
  /**
   * Base directory. Each box lives in `<root>/<sandboxId>`, which stands in for "/" inside that box. Default: a new
   * directory under /tmp (kept short, because `/run/selfbuilding/tools.sock` must fit the 108-byte socket path limit).
   * Two providers given the same root see the same boxes, as two processes talking to one vendor would.
   */
  root?: string;
  /** Provider id written into every ref. Default "tmpdir". */
  id?: string;
  limits?: Partial<ProviderLimits>;
  /** The deadline for one `openOrCreate`, including retries. Default 15 s. */
  deadlineMs?: number;
  /**
   * How the provider claims to size boxes. Default: sized per create, forks may override, no limits; it records the
   * size on the box and enforces nothing. `false`: a provider that takes no sizes.
   */
  sizing?: ProviderSizing | false;
}

/** What a ghost ref does when opened: a positive 404, or a control plane that answers while the guest stays silent. */
export type GhostKind = "not-found" | "guest-gone";

/** The tmpdir provider plus its test controls. Assignable to `SandboxProvider`. */
export interface TmpdirProvider extends SandboxProvider {
  /** The base directory. Per-box roots are `<fsRoot>/<sandboxId>`; execs always get their own box root. */
  readonly fsRoot: string;
  readonly faults: FaultController;
  snapshot(ref: SandboxRef, o?: { name?: string }): Promise<SnapshotResult>;
  fork(
    ref: SandboxRef,
    o: { children: { name: string; labels: Record<string, string> }[]; lifetimeMs: number; size?: ResolvedSize },
  ): Promise<Array<ProviderSandbox | SandboxError>>;
  /** Turns a live box into a ghost: the listing row stays, the box behind it is gone. */
  ghost(ref: SandboxRef, kind?: GhostKind): Promise<void>;
  /** The host directory standing in for "/" in this box. */
  boxRoot(ref: SandboxRef | string): string;
  /** Kills every box under the root and removes the root if this provider created it. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

interface BoxRecord {
  v: 1;
  id: string;
  name: string;
  key: SandboxKey;
  deployment: DeploymentId;
  labels: Record<string, string>;
  createdAt: string;
  state: "running" | "paused";
  expiresAtMs: number;
  onExpire: "pause" | "kill";
  env: Record<string, string>;
  ghost?: GhostKind;
}

const DEFAULT_LIMITS: ProviderLimits = {
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  lifetimeGuaranteed: true,
  // Pause is SIGSTOP on every process group, so processes and their memory survive it.
  expireKeeps: "memory",
};

const DEFAULT_SIZING: ProviderSizing = { kind: "create", forkSize: "override", resize: false, limits: {} };

const STATE_RANK: Record<SandboxState, number> = {
  running: 0,
  paused: 1,
  starting: 2,
  stopped: 3,
  error: 4,
  unknown: 5,
};

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_TAIL_BYTES = 65_536;

/** Thrown inside openOrCreate while another creator holds the name claim; never escapes. */
class ClaimBusy extends Error {}

/** A SandboxProvider backed by temp directories and local child processes, for offline tests. */
export function tmpdirProvider(opts: TmpdirProviderOptions = {}): TmpdirProvider {
  return new TmpdirProviderImpl(opts);
}

function defaultBase(): string {
  const tmp = existsSync("/tmp") ? realpathSync("/tmp") : realpathSync(os.tmpdir());
  return path.join(tmp, `sbt-${randomBytes(4).toString("hex")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter backoff, scaled down from the spec's 1 s..8 s so offline tests stay fast. */
function backoff(attempt: number): number {
  return Math.random() * Math.min(200, 10 * 2 ** attempt);
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

class TmpdirProviderImpl implements TmpdirProvider {
  readonly id: string;
  readonly stability = "experimental" as const;
  readonly limits: ProviderLimits;
  readonly fsRoot: string;
  readonly faults: Faults;
  readonly sizing?: ProviderSizing;
  readonly #ownsRoot: boolean;
  readonly #deadlineMs: number;
  #ready: Promise<void> | undefined;

  constructor(opts: TmpdirProviderOptions) {
    this.id = opts.id ?? "tmpdir";
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.#ownsRoot = opts.root === undefined;
    this.fsRoot = path.resolve(opts.root ?? defaultBase());
    this.#deadlineMs = opts.deadlineMs ?? 15_000;
    this.faults = new Faults(this.id);
    if (opts.sizing !== false) this.sizing = opts.sizing ?? DEFAULT_SIZING;
  }

  // ---- layout -------------------------------------------------------------------------------------------------

  boxRoot(ref: SandboxRef | string): string {
    return path.join(this.fsRoot, typeof ref === "string" ? ref : ref.id);
  }

  #meta(...parts: string[]): string {
    return path.join(this.fsRoot, ".meta", ...parts);
  }

  async #init(): Promise<void> {
    this.#ready ??= (async () => {
      for (const dir of ["boxes", "names", "live", "snapshots"]) {
        await fs.mkdir(this.#meta(dir), { recursive: true });
      }
    })();
    await this.#ready;
  }

  async #read(id: string): Promise<BoxRecord | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.#meta("boxes", `${id}.json`), "utf8")) as BoxRecord;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async #write(record: BoxRecord): Promise<void> {
    const file = this.#meta("boxes", `${record.id}.json`);
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record));
    await fs.rename(tmp, file);
  }

  async #records(): Promise<BoxRecord[]> {
    await this.#init();
    const files = await fs.readdir(this.#meta("boxes"));
    const records: BoxRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = await this.#read(file.slice(0, -".json".length));
      if (record) records.push(record);
    }
    return records;
  }

  #toRef(record: BoxRecord): SandboxRef {
    return {
      provider: this.id,
      id: record.id,
      name: record.name,
      key: { ...record.key },
      deployment: record.deployment,
      state: record.state,
      createdAt: record.createdAt,
      labels: { ...record.labels },
      meta: { fsRoot: this.boxRoot(record.id) },
      ...(record.labels[SELFBUILDING_LABELS.size] ? { size: record.labels[SELFBUILDING_LABELS.size] } : {}),
    };
  }

  #ctx(sandboxId?: string): { provider: string; sandboxId?: string } {
    return sandboxId === undefined ? { provider: this.id } : { provider: this.id, sandboxId };
  }

  // ---- live process groups --------------------------------------------------------------------------------------

  async trackGroup(id: string, pgid: number): Promise<void> {
    await fs.mkdir(this.#meta("live", id), { recursive: true });
    await fs.writeFile(this.#meta("live", id, String(pgid)), "");
  }

  async untrackGroup(id: string, pgid: number): Promise<void> {
    await fs.rm(this.#meta("live", id, String(pgid)), { force: true });
  }

  async #signalBox(id: string, signal: NodeJS.Signals): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.#meta("live", id));
    } catch {
      return;
    }
    for (const entry of entries) {
      const pgid = Number(entry);
      if (!Number.isInteger(pgid) || !signalGroup(pgid, signal)) await this.untrackGroup(id, pgid);
    }
  }

  // ---- expiry -----------------------------------------------------------------------------------------------------

  async #expire(record: BoxRecord): Promise<BoxRecord | undefined> {
    if (record.state !== "running" || record.ghost || Date.now() < record.expiresAtMs) return record;
    if (record.onExpire === "kill") {
      await this.#destroy(record.id);
      return undefined;
    }
    await this.#signalBox(record.id, "SIGSTOP");
    const paused: BoxRecord = { ...record, state: "paused" };
    await this.#write(paused);
    return paused;
  }

  async #sweep(): Promise<BoxRecord[]> {
    const live: BoxRecord[] = [];
    for (const record of await this.#records()) {
      const current = await this.#expire(record);
      if (current) live.push(current);
    }
    return live;
  }

  // ---- provider verbs ---------------------------------------------------------------------------------------------

  #validateSpec(spec: SandboxSpec): void {
    for (const name of Object.keys(spec.env)) {
      if (looksSecret(name)) throw new SecretInEnvError({ variable: name });
    }
    if (spec.network !== undefined && spec.network !== "open") {
      const requested = typeof spec.network === "string" ? spec.network : "allowlist";
      throw new EgressPolicyUnsupportedError({ provider: this.id, requested, supported: ["open"] });
    }
    if (spec.size && !this.sizing) {
      throw new SizeUnavailableError({
        provider: this.id,
        size: spec.size.name,
        vcpu: spec.size.vcpu,
        memoryMiB: spec.size.memoryMiB,
        reason: "not-sizable",
        fix: `Provider "${this.id}" takes no sizes. Drop the size option.`,
      });
    }
  }

  async #rowsForKey(key: SandboxKey, records?: BoxRecord[]): Promise<BoxRecord[]> {
    const all = records ?? (await this.#sweep());
    return all
      .filter((r) => r.deployment === key.deployment && r.key.runId === key.runId && r.key.scope === key.scope)
      .sort(
        (a, b) =>
          STATE_RANK[a.state] - STATE_RANK[b.state] ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }

  async openOrCreate(
    key: SandboxKey,
    spec: SandboxSpec,
    o?: { signal?: AbortSignal },
  ): Promise<{ handle: ProviderSandbox; created: boolean; rebuilt: boolean }> {
    this.#validateSpec(spec);
    this.faults.check("openOrCreate");
    const deadline = Date.now() + this.#deadlineMs;
    let sawGhost = false;
    for (let attempt = 0; ; attempt++) {
      o?.signal?.throwIfAborted();
      try {
        const rows = await this.#rowsForKey(key);
        for (const row of rows) {
          try {
            return { handle: await this.#openRecord(row.id, spec.lifetimeMs), created: false, rebuilt: false };
          } catch (error) {
            if (error instanceof SandboxNotFoundError || error instanceof SandboxGuestGoneError) {
              sawGhost = true;
              continue;
            }
            throw error;
          }
        }
        const handle = await this.#create(
          key,
          spec,
          rows.map((r) => r.id),
        );
        return { handle, created: true, rebuilt: sawGhost };
      } catch (error) {
        const retryable =
          error instanceof ClaimBusy ||
          (error instanceof SandboxUnavailableError && !(error instanceof SandboxGuestGoneError)) ||
          error instanceof SandboxQuotaError;
        if (!retryable) throw error;
        if (Date.now() >= deadline) {
          if (error instanceof ClaimBusy) throw new SandboxUnavailableError(this.#ctx(), { cause: error });
          throw error;
        }
        const wait = error instanceof SandboxQuotaError ? (error.retryAfterMs ?? 0) : 0;
        await sleep(Math.max(wait, backoff(attempt)));
      }
    }
  }

  async #claim(key: SandboxKey, id: string, ghosts: string[]): Promise<string> {
    const digest = createHash("sha256").update(`${key.deployment}\0${key.runId}\0${key.scope}`).digest("hex");
    const claim = this.#meta("names", digest.slice(0, 32));
    try {
      await fs.writeFile(claim, id, { flag: "wx" });
      return claim;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const holder = (await fs.readFile(claim, "utf8").catch(() => "")).trim();
    const stat = await fs.stat(claim).catch(() => undefined);
    const holderRecord = holder ? await this.#read(holder) : undefined;
    const abandoned = !holderRecord && (stat === undefined || Date.now() - stat.mtimeMs > 2_000);
    if (!ghosts.includes(holder) && !abandoned) throw new ClaimBusy(`name held by ${holder}`);
    // Every row for this key is a confirmed ghost (or the claim was abandoned), so the name may be taken over.
    const tmp = `${claim}.${id}.tmp`;
    await fs.writeFile(tmp, id);
    await fs.rename(tmp, claim);
    return claim;
  }

  async #create(key: SandboxKey, spec: SandboxSpec, ghosts: string[]): Promise<ProviderSandbox> {
    await this.#init();
    const lost = this.faults.check("create");
    const id = `sb${randomBytes(4).toString("hex")}`;
    const claim = await this.#claim(key, id, ghosts);
    try {
      const root = this.boxRoot(id);
      await this.#layout(root);
      const snapshot = await this.#snapshotDir(spec.image.ref);
      if (snapshot) await this.#copyTree(snapshot, root);
      const now = Date.now();
      const expiresAtMs = Math.min(now + spec.lifetimeMs, now + this.limits.maxLifetimeMs);
      const record: BoxRecord = {
        v: 1,
        id,
        name: spec.labels[SELFBUILDING_LABELS.name] ?? `sbt-${key.runId}-${key.scope}`,
        key: { ...key },
        deployment: key.deployment,
        labels: {
          ...spec.labels,
          [SELFBUILDING_LABELS.deployment]: key.deployment,
          [SELFBUILDING_LABELS.run]: spec.labels[SELFBUILDING_LABELS.run] ?? key.runId,
          [SELFBUILDING_LABELS.expiresAt]: new Date(expiresAtMs).toISOString(),
        },
        createdAt: new Date(now).toISOString(),
        state: "running",
        expiresAtMs,
        onExpire: spec.onExpire,
        env: { ...spec.env },
      };
      await this.#write(record);
    } catch (error) {
      // Invariant 9: anything failing between "id issued" and "handle returned" destroys the box.
      await this.#destroy(id).catch(() => undefined);
      await fs.rm(claim, { force: true });
      throw error;
    }
    lost?.raise();
    return new TmpdirSandbox(this, id, this.#toRef((await this.#read(id)) as BoxRecord));
  }

  async #layout(root: string): Promise<void> {
    for (const dir of BOX_DIRS) await fs.mkdir(hostPath(root, dir), { recursive: true });
  }

  async #snapshotDir(ref: string): Promise<string | undefined> {
    if (!/^snap-[a-z0-9-]+$/.test(ref)) return undefined;
    const dir = this.#meta("snapshots", ref);
    return existsSync(dir) ? dir : undefined;
  }

  /** Copies a box filesystem. /run and /tmp are skipped: they are tmpfs in a real box, and /run holds the secrets. */
  async #copyTree(from: string, to: string): Promise<void> {
    await fs.cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      force: true,
      filter: async (source) => {
        const rel = path.relative(from, source);
        if (rel === "run" || rel.startsWith(`run${path.sep}`) || rel === "tmp" || rel.startsWith(`tmp${path.sep}`)) {
          return false;
        }
        const stat = await fs.lstat(source);
        return !stat.isSocket() && !stat.isFIFO();
      },
    });
    await this.#layout(to);
  }

  async find(key: SandboxKey): Promise<SandboxRef | null> {
    this.faults.check("find");
    const [first] = await this.#rowsForKey(key);
    return first ? this.#toRef(first) : null;
  }

  list(filter: { deployment: DeploymentId; runId?: string; states?: SandboxState[] }): AsyncIterable<SandboxRef> {
    const self = this;
    return (async function* () {
      self.faults.check("list");
      const rows = (await self.#sweep())
        .filter((r) => r.deployment === filter.deployment)
        .filter((r) => filter.runId === undefined || r.key.runId === filter.runId)
        .filter((r) => filter.states === undefined || filter.states.includes(r.state))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const row of rows) yield self.#toRef(row);
    })();
  }

  async open(ref: SandboxRef, o: { lifetimeMs: number; signal?: AbortSignal }): Promise<ProviderSandbox> {
    const lost = this.faults.check("open", ref.id);
    const handle = await this.#openRecord(ref.id, o.lifetimeMs);
    lost?.raise();
    return handle;
  }

  async #openRecord(id: string, lifetimeMs: number): Promise<ProviderSandbox> {
    await this.#init();
    let record = await this.#read(id);
    if (record) record = await this.#expire(record);
    if (!record) throw new SandboxNotFoundError(this.#ctx(id));
    if (record.ghost === "not-found") {
      // A positive 404: the vendor now knows the row is dead, so the listing drops it.
      await fs.rm(this.#meta("boxes", `${id}.json`), { force: true });
      throw new SandboxNotFoundError(this.#ctx(id));
    }
    if (record.ghost === "guest-gone") throw new SandboxGuestGoneError(this.#ctx(id));
    if (record.state === "paused") await this.#signalBox(id, "SIGCONT");
    const now = Date.now();
    const createdAtMs = Date.parse(record.createdAt);
    const resumed: BoxRecord = {
      ...record,
      state: "running",
      expiresAtMs: Math.max(record.expiresAtMs, Math.min(now + lifetimeMs, createdAtMs + this.limits.maxLifetimeMs)),
    };
    await this.#write(resumed);
    const handle = new TmpdirSandbox(this, id, this.#toRef(resumed));
    // Invariant 3: a box is handed out only once its guest answers.
    const probe = await handle.exec("true", { timeoutMs: 10_000 });
    if (probe.exitCode !== 0) throw new SandboxGuestGoneError(this.#ctx(id));
    return handle;
  }

  async pause(ref: SandboxRef): Promise<PauseOutcome> {
    const fault = this.faults.checkPause("pause", ref.id);
    if (fault === "refuse") {
      return { confirmed: false, reason: "refused", status: 400, message: "Injected refusal: plan limit reached." };
    }
    await this.#init();
    const record = await this.#read(ref.id);
    if (!record || record.ghost) {
      return { confirmed: false, reason: "gone", status: 404, message: `Sandbox ${ref.id} does not exist.` };
    }
    if (record.state !== "paused") {
      await this.#signalBox(ref.id, "SIGSTOP");
      await this.#write({ ...record, state: "paused" });
    }
    fault?.raise();
    return { confirmed: true, kept: "memory" };
  }

  async kill(ref: SandboxRef): Promise<{ path: "killed" | "already-gone" }> {
    const lost = this.faults.check("kill", ref.id);
    await this.#init();
    const record = await this.#read(ref.id);
    if (!record) {
      lost?.raise();
      return { path: "already-gone" };
    }
    await this.#destroy(ref.id);
    lost?.raise();
    return { path: "killed" };
  }

  async #destroy(id: string): Promise<void> {
    await this.#signalBox(id, "SIGKILL");
    await fs.rm(this.#meta("live", id), { recursive: true, force: true });
    await fs.rm(this.#meta("boxes", `${id}.json`), { force: true });
    await fs.rm(this.boxRoot(id), { recursive: true, force: true, maxRetries: 3 });
    const names = await fs.readdir(this.#meta("names")).catch(() => [] as string[]);
    for (const name of names) {
      const file = this.#meta("names", name);
      if ((await fs.readFile(file, "utf8").catch(() => "")).trim() === id) await fs.rm(file, { force: true });
    }
  }

  async snapshot(ref: SandboxRef, o?: { name?: string }): Promise<SnapshotResult> {
    const lost = this.faults.check("snapshot", ref.id);
    await this.#init();
    const record = await this.#read(ref.id);
    if (!record || record.ghost) throw new SandboxNotFoundError(this.#ctx(ref.id));
    const slug = (o?.name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const snapshotId = `snap-${slug ? `${slug.slice(0, 40)}-` : ""}${randomBytes(4).toString("hex")}`;
    await this.#copyTree(this.boxRoot(ref.id), this.#meta("snapshots", snapshotId));
    lost?.raise();
    return { snapshotId, fidelity: "filesystem", sourceState: record.state };
  }

  async fork(
    ref: SandboxRef,
    o: { children: { name: string; labels: Record<string, string> }[]; lifetimeMs: number; size?: ResolvedSize },
  ): Promise<Array<ProviderSandbox | SandboxError>> {
    this.faults.check("fork", ref.id);
    await this.#init();
    const source = await this.#read(ref.id);
    if (!source || source.ghost) throw new SandboxNotFoundError(this.#ctx(ref.id));
    const results: Array<ProviderSandbox | SandboxError> = [];
    for (const [index, child] of o.children.entries()) {
      try {
        this.faults.check("fork.child", ref.id);
        results.push(await this.#forkChild(source, child, index, o.lifetimeMs, o.size));
      } catch (error) {
        results.push(
          error instanceof SandboxUnavailableError || error instanceof SandboxQuotaError
            ? (error as SandboxError)
            : new SandboxUnavailableError(this.#ctx(ref.id), { cause: error }),
        );
      }
    }
    return results;
  }

  async #forkChild(
    source: BoxRecord,
    child: { name: string; labels: Record<string, string> },
    index: number,
    lifetimeMs: number,
    size?: ResolvedSize,
  ): Promise<ProviderSandbox> {
    const id = `sb${randomBytes(4).toString("hex")}`;
    try {
      await this.#copyTree(this.boxRoot(source.id), this.boxRoot(id));
      const now = Date.now();
      const expiresAtMs = Math.min(now + lifetimeMs, now + this.limits.maxLifetimeMs);
      const record: BoxRecord = {
        v: 1,
        id,
        name: child.name,
        // Fork children are keyed "<parent scope>/fork[<index>]", the spec's fork-child scope form.
        key: { ...source.key, scope: `${source.key.scope}/fork[${index}]` },
        deployment: source.deployment,
        labels: {
          // A child keeps the parent's size unless the fork asked for another.
          ...(source.labels[SELFBUILDING_LABELS.size]
            ? { [SELFBUILDING_LABELS.size]: source.labels[SELFBUILDING_LABELS.size] }
            : {}),
          ...child.labels,
          ...(size ? { [SELFBUILDING_LABELS.size]: size.name } : {}),
          [SELFBUILDING_LABELS.deployment]: source.deployment,
          [SELFBUILDING_LABELS.run]: child.labels[SELFBUILDING_LABELS.run] ?? source.key.runId,
          [SELFBUILDING_LABELS.parent]: source.id,
          [SELFBUILDING_LABELS.expiresAt]: new Date(expiresAtMs).toISOString(),
        },
        createdAt: new Date(now).toISOString(),
        state: "running",
        expiresAtMs,
        onExpire: source.onExpire,
        env: { ...source.env },
      };
      await this.#write(record);
      return new TmpdirSandbox(this, id, this.#toRef(record));
    } catch (error) {
      await this.#destroy(id).catch(() => undefined);
      throw error;
    }
  }

  // ---- test controls ----------------------------------------------------------------------------------------------

  async ghost(ref: SandboxRef, kind: GhostKind = "guest-gone"): Promise<void> {
    const record = await this.#read(ref.id);
    if (!record) throw new SandboxNotFoundError(this.#ctx(ref.id));
    await this.#signalBox(ref.id, "SIGKILL");
    await fs.rm(this.boxRoot(ref.id), { recursive: true, force: true, maxRetries: 3 });
    await this.#write({ ...record, ghost: kind });
  }

  async close(): Promise<void> {
    if (!existsSync(this.fsRoot)) return;
    for (const record of await this.#records().catch(() => [] as BoxRecord[])) {
      await this.#destroy(record.id).catch(() => undefined);
    }
    if (this.#ownsRoot) await fs.rm(this.fsRoot, { recursive: true, force: true, maxRetries: 3 });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ---- used by handles ----------------------------------------------------------------------------------------------

  /** Loads a box for a handle operation; a paused or missing box is refused rather than silently woken. */
  async guard(op: string, id: string): Promise<{ record: BoxRecord; lost: ReturnType<Faults["check"]> }> {
    const lost = this.faults.check(op, id);
    await this.#init();
    let record = await this.#read(id);
    if (record) record = await this.#expire(record);
    if (!record || record.ghost === "not-found") throw new SandboxNotFoundError(this.#ctx(id));
    if (record.ghost === "guest-gone") throw new SandboxGuestGoneError(this.#ctx(id));
    if (record.state === "paused") {
      throw new SandboxUnavailableError(this.#ctx(id), {
        message: `Sandbox ${id} is paused. Reopen it with provider.open(ref) before using a handle.`,
      });
    }
    return { record, lost };
  }

  async updateExpiry(id: string, untilMs: number): Promise<{ untilMs: number; clamped: boolean }> {
    const record = await this.#read(id);
    if (!record) throw new SandboxNotFoundError(this.#ctx(id));
    const max = Date.parse(record.createdAt) + this.limits.maxLifetimeMs;
    const clamped = untilMs > max;
    const target = clamped ? max : untilMs;
    await this.#write({
      ...record,
      expiresAtMs: target,
      labels: { ...record.labels, [SELFBUILDING_LABELS.expiresAt]: new Date(target).toISOString() },
    });
    return { untilMs: target, clamped };
  }

  errorContext(id: string): { provider: string; sandboxId?: string } {
    return this.#ctx(id);
  }
}

/** A connected handle. Every call re-reads the box record, so a handle held across a pause or kill fails loudly. */
class TmpdirSandbox implements ProviderSandbox {
  readonly ref: SandboxRef;
  readonly #provider: TmpdirProviderImpl;
  readonly #id: string;
  readonly #root: string;

  constructor(provider: TmpdirProviderImpl, id: string, ref: SandboxRef) {
    this.#provider = provider;
    this.#id = id;
    this.ref = ref;
    this.#root = provider.boxRoot(id);
  }

  #env(record: BoxRecord, extra: Record<string, string> | undefined): Record<string, string> {
    for (const name of Object.keys(extra ?? {})) {
      if (looksSecret(name)) throw new SecretInEnvError({ variable: name });
    }
    const home = hostPath(this.#root, SANDBOX_PATHS.home);
    // The host's own environment is never inherited (an undeclared variable must not be visible in the box).
    return {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: home,
      TMPDIR: hostPath(this.#root, "/tmp"),
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      ...record.env,
      ...extra,
      // Always this box's own root: a host passing the provider-level fsRoot must not point at the base directory.
      [RUNTIME_ENV.fsRoot]: this.#root,
    };
  }

  async exec(cmd: string, o: ExecOpts = {}): Promise<ExecResult> {
    const { record, lost } = await this.#provider.guard("exec", this.#id);
    const env = this.#env(record, o.env);
    const cwd = hostPath(this.#root, o.cwd ?? SANDBOX_PATHS.workdir);
    const timeoutMs = o.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const tailBytes = o.maxTailBytes ?? DEFAULT_TAIL_BYTES;
    const child = spawn("/bin/sh", ["-c", rewriteCommand(this.#root, cmd)], {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Listeners attach before any await, or a fast command's output and exit would be missed.
    const exited = runToExit(child, { stdin: o.stdin, timeoutMs, tailBytes, onLine: o.onLine });
    const pgid = child.pid;
    if (pgid !== undefined) await this.#provider.trackGroup(this.#id, pgid);
    const result = await exited;
    // A backgrounded child keeps the group alive and stays tracked, so pause and kill still reach it.
    if (pgid !== undefined && !signalGroup(pgid, 0)) await this.#provider.untrackGroup(this.#id, pgid);
    if (result.timedOut) {
      throw new SandboxCommandTimeoutError({
        ...this.#provider.errorContext(this.#id),
        cmd,
        mayStillBeRunning: false,
        ...(o.idempotent === undefined ? {} : { idempotent: o.idempotent }),
      });
    }
    lost?.raise();
    return {
      exitCode: result.exitCode,
      stdoutTail: result.stdout.toString(),
      stderrTail: result.stderr.toString(),
      truncated: result.stdout.truncated || result.stderr.truncated,
    };
  }

  async spawn(cmd: string, o: SpawnOpts = {}): Promise<ProcessRef> {
    const { record, lost } = await this.#provider.guard("spawn", this.#id);
    const id = `p${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const logPath = `${SANDBOX_PATHS.proc}/${id}.log`;
    const exitPath = `${SANDBOX_PATHS.proc}/${id}.exit`;
    const script = hostPath(this.#root, `${SANDBOX_PATHS.proc}/${id}.sh`);
    const command = hostPath(this.#root, `${SANDBOX_PATHS.proc}/${id}.cmd`);
    const exitHost = hostPath(this.#root, exitPath);
    await fs.mkdir(path.dirname(script), { recursive: true });
    // The shim from invariant 12: run the command in its own shell (so its `exit` cannot skip the bookkeeping), then
    // record the exit code atomically next to the log. The trap (a handler, not an ignore, so children still get the
    // default action) keeps a group-wide SIGINT from killing the shim before it records the code.
    await fs.writeFile(command, `${rewriteCommand(this.#root, cmd)}\n`);
    await fs.writeFile(
      script,
      `trap : INT TERM\n/bin/sh '${command}'\nc=$?\nprintf %s "$c" > '${exitHost}.tmp' && mv '${exitHost}.tmp' '${exitHost}'\n`,
    );
    const log = await fs.open(hostPath(this.#root, logPath), "a");
    const stdin = o.stdinFile ? await fs.open(hostPath(this.#root, o.stdinFile), "r") : undefined;
    try {
      const child = spawn("/bin/sh", [script], {
        cwd: hostPath(this.#root, o.cwd ?? SANDBOX_PATHS.workdir),
        env: this.#env(record, o.env),
        detached: true,
        stdio: [stdin?.fd ?? "ignore", log.fd, log.fd],
      });
      child.unref();
      const pgid = child.pid;
      if (pgid !== undefined) await this.#provider.trackGroup(this.#id, pgid);
      lost?.raise();
      return {
        id,
        ...(pgid === undefined ? {} : { pgid, vendorPid: String(pgid) }),
        logPath,
        exitPath,
        startedAt: new Date().toISOString(),
      };
    } finally {
      await log.close();
      await stdin?.close();
    }
  }

  async attach(
    p: ProcessRef,
    o: { fromOffset: number; onLine?: OnLine; signal?: AbortSignal },
  ): Promise<{ state: "running" | "exited"; exitCode?: number; offset: number }> {
    const { lost } = await this.#provider.guard("attach", this.#id);
    lost?.raise();
    const logFile = hostPath(this.#root, p.logPath);
    const exitFile = hostPath(this.#root, p.exitPath);
    let offset = o.fromOffset;
    const drain = async (final: boolean): Promise<void> => {
      const data = await fs.readFile(logFile).catch(() => Buffer.alloc(0));
      if (data.length <= offset) return;
      const fresh = data.subarray(offset);
      const lastNewline = fresh.lastIndexOf(0x0a);
      const usable = final ? fresh.length : lastNewline + 1;
      if (usable <= 0) return;
      const text = fresh.subarray(0, usable).toString("utf8");
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (const line of lines) o.onLine?.("stdout", line);
      offset += usable;
    };
    for (;;) {
      const code = await fs.readFile(exitFile, "utf8").catch(() => undefined);
      if (code !== undefined) {
        await drain(true);
        if (p.pgid !== undefined) await this.#provider.untrackGroup(this.#id, p.pgid);
        return { state: "exited", exitCode: Number(code), offset };
      }
      if (p.pgid !== undefined && !signalGroup(p.pgid, 0)) {
        // The group may have written its exit code just before dying; only its absence means a signal killed it.
        if (existsSync(exitFile)) continue;
        await drain(true);
        await this.#provider.untrackGroup(this.#id, p.pgid);
        return { state: "exited", offset };
      }
      await drain(false);
      if (o.signal?.aborted) return { state: "running", offset };
      await sleep(25);
    }
  }

  async readFile(file: string): Promise<Uint8Array> {
    const { lost } = await this.#provider.guard("readFile", this.#id);
    try {
      const data = await fs.readFile(hostPath(this.#root, file));
      lost?.raise();
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "EISDIR") || isErrno(error, "ENOTDIR")) {
        throw new SandboxFileNotFoundError({ ...this.#provider.errorContext(this.#id), path: file });
      }
      throw error;
    }
  }

  async writeFiles(files: WriteFileEntry[]): Promise<void> {
    const { lost } = await this.#provider.guard("writeFiles", this.#id);
    for (const file of files) {
      const target = hostPath(this.#root, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, file.data, { mode: file.mode ?? 0o644 });
      await fs.chmod(tmp, file.mode ?? 0o644);
      await fs.rename(tmp, target);
    }
    lost?.raise();
  }

  async extendLifetime(untilMs: number): Promise<{ untilMs: number; clamped: boolean }> {
    const { lost } = await this.#provider.guard("extendLifetime", this.#id);
    const result = await this.#provider.updateExpiry(this.#id, untilMs);
    lost?.raise();
    return result;
  }

  async previewUrl(port: number): Promise<{ url: string; headers: Record<string, string> }> {
    await this.#provider.guard("previewUrl", this.#id);
    return { url: `http://127.0.0.1:${port}`, headers: {} };
  }
}

interface ExitInfo {
  exitCode: number;
  timedOut: boolean;
  stdout: Tail;
  stderr: Tail;
}

function runToExit(
  child: ChildProcess,
  o: { stdin?: string | Uint8Array; timeoutMs: number; tailBytes: number; onLine?: OnLine },
): Promise<ExitInfo> {
  const stdout = new Tail(o.tailBytes);
  const stderr = new Tail(o.tailBytes);
  const outLines = new LineSplitter((line) => o.onLine?.("stdout", line));
  const errLines = new LineSplitter((line) => o.onLine?.("stderr", line));
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    outLines.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    errLines.push(chunk);
  });
  // A command that never reads stdin closes the pipe early; that is not an error for the caller.
  child.stdin?.on("error", () => undefined);
  if (o.stdin !== undefined) child.stdin?.end(o.stdin);
  else child.stdin?.end();
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
    }, o.timeoutMs);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outLines.end();
      errLines.end();
      const signalNumber = signal ? (os.constants.signals[signal] ?? 1) : 0;
      resolve({ exitCode: code ?? 128 + signalNumber, timedOut, stdout, stderr });
    };
    child.on("error", () => undefined);
    child.on("close", finish);
    // A backgrounded child that inherited stdout would hold "close" open forever; stop reading shortly after exit.
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 250).unref();
    });
  });
}
