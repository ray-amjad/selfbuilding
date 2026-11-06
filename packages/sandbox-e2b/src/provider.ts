import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type DeploymentId,
  EgressPolicyUnsupportedError,
  type ExecOpts,
  type ExecResult,
  ImageUnavailableError,
  type NetworkPolicy,
  type OnLine,
  type PauseOutcome,
  type ProcessRef,
  type ProviderLimits,
  type ProviderSandbox,
  type ProviderSizing,
  type ResolvedImage,
  type ResolvedSize,
  SANDBOX_PATHS,
  SandboxAuthError,
  SandboxCommandTimeoutError,
  type SandboxError,
  SandboxGuestGoneError,
  type SandboxKey,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxQuotaError,
  type SandboxRef,
  type SandboxSpec,
  type SandboxState,
  SandboxUnavailableError,
  SandboxUnsupportedError,
  SELFBUILDING_LABELS,
  SecretInEnvError,
  type SnapshotResult,
  type SpawnOpts,
  type Stability,
  type WriteFileEntry,
} from "@selfbuilding/core";
import type {
  E2bCommandHandle,
  E2bConnection,
  E2bCreateOpts,
  E2bSandbox,
  E2bSandboxInfo,
  E2bShapeClient,
  E2bVendorState,
} from "./client.js";
import { classify, type ErrorSite, isRefusal, isTransient, readVendorFailure } from "./errors.js";
import { backoff, LineSplitter, looksSecret, shq, sleep, Tail } from "./util.js";

/** Deadlines and poll intervals. The defaults follow the spec; tests shrink them. */
export interface E2bShapeTimings {
  /** One deadline for `openOrCreate`, retries included (invariant 13). */
  createDeadlineMs: number;
  /** The full resume deadline for `open`: a guest silent this long is `SandboxGuestGoneError`. */
  openDeadlineMs: number;
  /** The short first-pass budget per ref when `openOrCreate` walks ghost refs (invariant 6). */
  ghostProbeMs: number;
  /** How long `pause` polls for the paused state before the outcome counts as unknown. */
  pauseDeadlineMs: number;
  /** Per-request timeout for control-plane calls. */
  requestTimeoutMs: number;
  /** Timeout for one snapshot request: a memory snapshot of a large box takes minutes, not seconds. */
  snapshotTimeoutMs: number;
  /** Poll interval for `attach` and `pause`. */
  pollMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  /**
   * How long this process trusts its own record of a create, pause, resume or kill over the vendor's listing.
   * Under load the listing trails those writes by seconds, so it can miss a box just made or show a killed one.
   */
  listLagMs: number;
}

export const DEFAULT_TIMINGS: E2bShapeTimings = {
  createDeadlineMs: 180_000,
  openDeadlineMs: 120_000,
  ghostProbeMs: 20_000,
  pauseDeadlineMs: 120_000,
  requestTimeoutMs: 60_000,
  snapshotTimeoutMs: 600_000,
  pollMs: 500,
  backoffBaseMs: 1_000,
  backoffCapMs: 8_000,
  listLagMs: 120_000,
};

export interface E2bShapeProviderOptions {
  /** Adapter id written into every ref, e.g. "e2b" or "impello". */
  id: string;
  /** The vendor SDK's `Sandbox` class, bound to that vendor's package. */
  client: E2bShapeClient;
  /** The default template, used when the spec's image is not a template alias or snapshot id. */
  template: string;
  /** Resolves connection options for one call. Credentials arrive here, never from the environment. */
  connection: () => E2bConnection | Promise<E2bConnection>;
  limits: ProviderLimits;
  stability?: Stability;
  /** A floor for every box lifetime the adapter asks for (the factory's `timeout` option). */
  minLifetimeMs?: number;
  timings?: Partial<E2bShapeTimings>;
  /** Template sizing (docs/spec/demo-path.md §1.3); built by `templateSizing()` in sizes.ts. */
  sizing?: ProviderSizing;
  /**
   * Probe every freshly created box whose spec asks for a non-open egress policy, and refuse it with
   * `EgressPolicyUnsupportedError` when the vendor accepted the policy but the box can still reach the internet
   * (docs/decisions/0001-egress-enforcement.md). Off by default: the probe adds a few seconds to each create.
   */
  verifyEgress?: boolean;
}

/** Public addresses the egress probe tries, in order; the first one outside an allowlist is used. */
export const EGRESS_PROBE_TARGETS: readonly string[] = ["1.1.1.1", "8.8.8.8"];

/** Retries after a probe that could not run (a vendor error, a timeout, an exit code other than 0 or 1). */
export const EGRESS_PROBE_RETRIES = 3;

function ipv4(text: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return parts.reduce((acc, p) => acc * 256 + p, 0);
}

/** Whether one allowlist entry (hostname, IPv4 with an optional port, or IPv4 CIDR) lets traffic to `target` out. */
function covers(entry: string, target: string): boolean {
  const e = entry.trim().toLowerCase();
  if (e === "*") return true;
  const slash = e.indexOf("/");
  const want = ipv4(target);
  if (slash >= 0) {
    const base = ipv4(e.slice(0, slash));
    const bits = Number(e.slice(slash + 1));
    if (base === undefined || want === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(base / size) === Math.floor(want / size);
  }
  // "1.1.1.1:443" and "example.com:443" name the host before the port.
  const host = /^[^:]+:\d+$/.test(e) ? e.slice(0, e.lastIndexOf(":")) : e;
  const ip = ipv4(host);
  if (ip !== undefined) return ip === want;
  return host === target.toLowerCase();
}

/**
 * The first probe address no allowlist entry covers (exact host, IP equality, CIDR containment), or undefined when
 * the allowlist covers them all. Substring matching was wrong: `8.8.8.80` does not let `8.8.8.8` out.
 */
export function egressProbeTarget(allow: readonly string[]): string | undefined {
  return EGRESS_PROBE_TARGETS.find((target) => !allow.some((entry) => covers(entry, target)));
}

/** Exit 0: connected. Exit 1: refused, unreachable or timed out. Anything else: the probe itself could not run. */
export function egressProbeCommand(host: string, port = 443, timeoutMs = 4_000): string {
  const js = `const s=require('net').connect(${port},${JSON.stringify(host)});s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.setTimeout(${timeoutMs},()=>process.exit(1))`;
  return `node -e ${shq(js)}`;
}

/** Adapter-private metadata. Not labels: stripped from `ref.labels` and surfaced in `ref.meta`. */
const META = {
  scope: "sbx.scope",
  createdAt: "sbx.createdAt",
  forkSnapshot: "sbx.forkSnapshot",
  /** The create-time egress options, so fork children get the parent's policy (egress is not in a snapshot). */
  network: "sbx.network",
} as const;
const META_PREFIX = "sbx.";

/** Where the create-time env lives inside the box, because create-time env does not survive a resume. */
export const ENV_FILE = `${SANDBOX_PATHS.state}/sandbox-env.json`;
const ENV_MISSING = "__selfbuilding_env_missing__";

const AGENT_DIRS = [
  SANDBOX_PATHS.workdir,
  SANDBOX_PATHS.home,
  SANDBOX_PATHS.in,
  SANDBOX_PATHS.out,
  SANDBOX_PATHS.state,
  SANDBOX_PATHS.launches,
  SANDBOX_PATHS.proc,
  SANDBOX_PATHS.calls,
  SANDBOX_PATHS.logs,
  SANDBOX_PATHS.run,
];
/** The secrets directory is root's, so the agent can neither read nor replace what root delivers there. */
const ROOT_DIRS = [
  SANDBOX_PATHS.bin,
  SANDBOX_PATHS.skills,
  path.posix.dirname(SANDBOX_PATHS.contract),
  SANDBOX_PATHS.secrets,
];
/** Parent directories under these roots are handed to the file's owner by `writeFiles`. */
const OWNED_ROOTS = ["/selfbuilding", "/run/selfbuilding", "/tmp", SANDBOX_PATHS.home];

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_TAIL_BYTES = 65_536;
/** The vendor's own command timeout is a backstop only; the adapter's timer fires first. */
const VENDOR_TIMEOUT_GRACE_MS = 15_000;
const ATTACH_CHUNK_BYTES = 1024 * 1024;
const STATE_RANK: Record<SandboxState, number> = {
  running: 0,
  paused: 1,
  starting: 2,
  stopped: 3,
  error: 4,
  unknown: 5,
};

/** The layout every box gets on create and on every open. A box without the `agent` user fails here, loudly. */
function layoutScript(): string {
  const all = [...AGENT_DIRS, ...ROOT_DIRS].map(shq).join(" ");
  const owned = AGENT_DIRS.map(shq).join(" ");
  return [
    `mkdir -p ${all} && chown agent:agent ${owned} && chown root:root ${shq(SANDBOX_PATHS.secrets)} && chmod 0700 ${shq(SANDBOX_PATHS.secrets)} || exit 70`,
    `if [ -f ${shq(ENV_FILE)} ]; then cat ${shq(ENV_FILE)}; else printf %s ${ENV_MISSING}; fi`,
  ].join("\n");
}

function isUnder(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

function toVendorState(state: string | undefined): SandboxState {
  return state === "running" || state === "paused" ? state : "unknown";
}

function isoOf(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toArrayBuffer(data: Uint8Array | string): string | ArrayBuffer {
  if (typeof data === "string") return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function randomId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** A vendor `CommandExitError`: the command ran and exited non-zero. That is a result, not an error (spec §5.3). */
function exitCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { name?: unknown; exitCode?: unknown };
  return e.name === "CommandExitError" && typeof e.exitCode === "number" ? e.exitCode : undefined;
}

/** The client gave up waiting (AbortSignal.timeout), as opposed to the vendor answering with an error. */
function isRequestTimeout(error: unknown): boolean {
  const failure = readVendorFailure(error);
  return (
    (failure.name === "TimeoutError" || failure.name === "AbortError") &&
    /aborted due to timeout|operation timed out/i.test(failure.message)
  );
}

function isVendorDeadline(error: unknown): boolean {
  const failure = readVendorFailure(error);
  return failure.name === "TimeoutError" && /deadline_exceeded|'timeoutMs'/i.test(failure.message);
}

interface VendorRow {
  id: string;
  metadata: Record<string, string>;
  state: SandboxState;
  createdAt: string;
  startedAt?: string;
  templateId?: string;
}

/**
 * Which of a key's boxes came first: the vendor's start time, not the client's pre-create stamp. A call whose create
 * began first but landed second would otherwise keep its box while the call that listed before it existed keeps the
 * other. `find`, `openOrCreate` and the post-create convergence all use this one order, so they pick the same box.
 */
function arrival(row: VendorRow): string {
  return row.startedAt ?? row.createdAt;
}

/** What this process last did to a box. `metadata` is the box's create-time metadata, when this process made it. */
interface LocalWrite {
  op: "created" | "paused" | "resumed" | "killed";
  at: number;
  metadata?: Record<string, string>;
}

interface CachedFile {
  entry: WriteFileEntry;
}

/** The shared E2B-shape provider (spec §5.5): one implementation, two SDK bindings. */
export class E2bShapeProvider implements SandboxProvider {
  readonly id: string;
  readonly stability: Stability;
  readonly limits: ProviderLimits;
  readonly timings: E2bShapeTimings;
  readonly sizing?: ProviderSizing;
  readonly #client: E2bShapeClient;
  readonly #template: string;
  readonly #connection: () => E2bConnection | Promise<E2bConnection>;
  readonly #minLifetimeMs: number;
  readonly #verifyEgress: boolean;
  /** Ids whose open failed with a positive 404 or a silent guest; ranked last so a dead row is never preferred. */
  readonly #ghosts = new Set<string>();
  /** Files under /run/selfbuilding (tmpfs) per box, re-delivered after every connect in this process (invariant 18). */
  readonly #runFiles = new Map<string, Map<string, CachedFile>>();
  /** Optional operations the vendor answered 404/501 for, cached so later calls fail fast. */
  readonly #unsupported = new Set<string>();
  /** This process's recent writes, laid over every listing (see `listLagMs`). */
  readonly #writes = new Map<string, LocalWrite>();

  constructor(opts: E2bShapeProviderOptions) {
    this.id = opts.id;
    this.stability = opts.stability ?? "stable";
    this.limits = opts.limits;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.#client = opts.client;
    this.#template = opts.template;
    this.#connection = opts.connection;
    this.#minLifetimeMs = opts.minLifetimeMs ?? 0;
    this.#verifyEgress = opts.verifyEgress ?? false;
    if (opts.sizing !== undefined) this.sizing = opts.sizing;
    if (typeof opts.client.createSnapshot !== "function") {
      // The core checks for the method, never a flag (spec §5.1 rule 2), so absent support removes the methods.
      Object.defineProperty(this, "snapshot", { value: undefined });
      Object.defineProperty(this, "fork", { value: undefined });
    }
  }

  // ---- shared plumbing ---------------------------------------------------------------------------------------------

  async conn(o: { signal?: AbortSignal; requestTimeoutMs?: number } = {}): Promise<E2bConnection> {
    const base = await this.#connection();
    return {
      ...base,
      requestTimeoutMs: o.requestTimeoutMs ?? base.requestTimeoutMs ?? this.timings.requestTimeoutMs,
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    };
  }

  site(op: string, sandboxId?: string, extra: Partial<ErrorSite> = {}): ErrorSite {
    return sandboxId === undefined
      ? { provider: this.id, op, ...extra }
      : { provider: this.id, sandboxId, op, ...extra };
  }

  ctx(sandboxId?: string): { provider: string; sandboxId?: string } {
    return sandboxId === undefined ? { provider: this.id } : { provider: this.id, sandboxId };
  }

  /** Clamps a requested lifetime to the plan maximum and the provider's floor. Never the vendor's 5-minute default. */
  lifetime(ms: number): number {
    return Math.max(1_000, Math.min(Math.max(ms, this.#minLifetimeMs), this.limits.maxLifetimeMs));
  }

  #templateFor(image: ResolvedImage, size?: ResolvedSize): string {
    // OCI references ("selfbuilding/<harness>:<version>") are for Docker; this provider runs its own template.
    if (!image.ref || image.ref.startsWith("selfbuilding/")) {
      // The core checked the size against `sizing` before create; a snapshot restore keeps the snapshot's size.
      return size !== undefined && this.sizing?.kind === "template"
        ? this.sizing.templateFor(this.#template, size.name)
        : this.#template;
    }
    return image.ref;
  }

  /** Secret values this process has delivered as files. An env var carrying one is rejected (invariant 18). */
  #knownSecretValues(): Set<string> {
    const values = new Set<string>();
    for (const files of this.#runFiles.values()) {
      for (const { entry } of files.values()) {
        if (!isUnder(entry.path, SANDBOX_PATHS.secrets) || typeof entry.data !== "string") continue;
        const value = entry.data.trim();
        if (value.length >= 8) values.add(value);
      }
    }
    return values;
  }

  checkEnv(env: Record<string, string> | undefined): void {
    if (!env) return;
    const known = this.#knownSecretValues();
    for (const [name, value] of Object.entries(env)) {
      if (looksSecret(name) || known.has(value.trim())) throw new SecretInEnvError({ variable: name });
    }
  }

  rememberRunFiles(sandboxId: string, files: WriteFileEntry[]): void {
    const tmpfs = files.filter((f) => isUnder(f.path, SANDBOX_PATHS.run));
    if (tmpfs.length === 0) return;
    let cache = this.#runFiles.get(sandboxId);
    if (!cache) {
      cache = new Map();
      this.#runFiles.set(sandboxId, cache);
    }
    for (const entry of tmpfs) {
      const data = typeof entry.data === "string" ? entry.data : new Uint8Array(entry.data);
      cache.set(entry.path, { entry: { ...entry, data } });
    }
  }

  #runFilesFor(sandboxId: string): WriteFileEntry[] {
    return [...(this.#runFiles.get(sandboxId)?.values() ?? [])].map((c) => c.entry);
  }

  #toRow(info: E2bSandboxInfo): VendorRow {
    const metadata = { ...(info.metadata ?? {}) };
    const startedAt = isoOf(info.startedAt);
    const createdAt = metadata[META.createdAt] ?? startedAt ?? new Date(0).toISOString();
    return {
      id: info.sandboxId,
      metadata,
      state: toVendorState(info.state),
      createdAt,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(info.templateId === undefined ? {} : { templateId: info.templateId }),
    };
  }

  toRef(row: VendorRow, state: SandboxState = row.state): SandboxRef {
    const labels: Record<string, string> = {};
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.metadata)) {
      if (k.startsWith(META_PREFIX)) meta[k.slice(META_PREFIX.length)] = v;
      else labels[k] = v;
    }
    if (row.startedAt !== undefined) meta.startedAt = row.startedAt;
    if (row.templateId !== undefined) meta.template = row.templateId;
    const deployment = labels[SELFBUILDING_LABELS.deployment] ?? "";
    const size = labels[SELFBUILDING_LABELS.size];
    return {
      ...(size === undefined ? {} : { size }),
      provider: this.id,
      id: row.id,
      name: labels[SELFBUILDING_LABELS.name] ?? "",
      key: { runId: labels[SELFBUILDING_LABELS.run] ?? "", scope: meta.scope ?? "", deployment },
      deployment,
      state,
      createdAt: row.createdAt,
      labels,
      meta,
    };
  }

  /** Every page of a metadata-filtered listing. A failed page throws; it never ends the listing early (invariant 2). */
  async #listRows(
    op: string,
    metadata: Record<string, string>,
    states: E2bVendorState[],
    signal?: AbortSignal,
  ): Promise<VendorRow[]> {
    const rows: VendorRow[] = [];
    try {
      const pages = this.#client.list({
        ...(await this.conn({ ...(signal ? { signal } : {}) })),
        query: { metadata, state: states },
        limit: 100,
      });
      while (pages.hasNext) {
        for (const info of await pages.nextItems()) rows.push(this.#toRow(info));
      }
    } catch (error) {
      throw classify(error, this.site(op));
    }
    // Filtered again in memory: a host that ignores a metadata filter must not leak another deployment (invariant 20).
    const matches = (m: Record<string, string>) => Object.entries(metadata).every(([k, v]) => m[k] === v);
    return this.#overlayWrites(
      rows.filter((r) => matches(r.metadata) && states.includes(r.state as E2bVendorState)),
      matches,
      states,
    );
  }

  /** Records a write so listings in the next `listLagMs` reflect it even when the vendor's listing does not yet. */
  #noteWrite(id: string, op: LocalWrite["op"], metadata?: Record<string, string>): void {
    const now = Date.now();
    for (const [key, w] of this.#writes) if (now - w.at >= this.timings.listLagMs) this.#writes.delete(key);
    const known = metadata ?? this.#writes.get(id)?.metadata;
    this.#writes.set(id, known === undefined ? { op, at: now } : { op, at: now, metadata: known });
  }

  /**
   * Lays this process's recent writes over a listing: a box it killed is dropped, and a box it created, paused or
   * resumed is read with `getInfo` (which never wakes a box), so a box just made is found and its state is current.
   * When `getInfo` cannot answer, the listing row stands; a 404 alone never drops a listed box (invariant 5).
   */
  async #overlayWrites(
    rows: VendorRow[],
    matches: (metadata: Record<string, string>) => boolean,
    states: E2bVendorState[],
  ): Promise<VendorRow[]> {
    const now = Date.now();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const checks: Promise<void>[] = [];
    for (const [id, w] of this.#writes) {
      if (now - w.at >= this.timings.listLagMs) continue;
      if (w.op === "killed") {
        byId.delete(id);
        continue;
      }
      const listed = byId.get(id);
      if (listed === undefined && !(w.metadata !== undefined && matches(w.metadata))) continue;
      checks.push(
        (async () => {
          let info: E2bSandboxInfo;
          try {
            info = await this.#client.getInfo(id, await this.conn());
          } catch (error) {
            const failure = readVendorFailure(error);
            if (listed !== undefined || failure.status === 404 || failure.name === "SandboxNotFoundError") return;
            if (w.metadata === undefined) return;
            const state: SandboxState = w.op === "paused" ? "paused" : "running";
            if (states.includes(state as E2bVendorState)) {
              byId.set(id, { id, metadata: w.metadata, state, createdAt: w.metadata[META.createdAt] ?? "" });
            }
            return;
          }
          const fresh = this.#toRow({
            ...info,
            metadata: { ...(listed?.metadata ?? w.metadata), ...info.metadata },
          });
          if (this.#writes.get(id)?.op === "killed" || !matches(fresh.metadata)) return;
          // A state the adapter does not know (a transition) keeps the listing's answer rather than hiding the box.
          if (fresh.state === "unknown") return;
          if (states.includes(fresh.state as E2bVendorState)) byId.set(id, fresh);
          else byId.delete(id);
        })(),
      );
    }
    await Promise.all(checks);
    return [...byId.values()];
  }

  #rank(rows: VendorRow[]): VendorRow[] {
    return [...rows].sort(
      (a, b) =>
        Number(this.#ghosts.has(a.id)) - Number(this.#ghosts.has(b.id)) ||
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        arrival(a).localeCompare(arrival(b)) ||
        a.id.localeCompare(b.id),
    );
  }

  #keyQuery(key: SandboxKey): Record<string, string> {
    return {
      [SELFBUILDING_LABELS.deployment]: key.deployment,
      [SELFBUILDING_LABELS.run]: key.runId,
      [META.scope]: key.scope,
    };
  }

  async #rowsForKey(key: SandboxKey, op: string, signal?: AbortSignal): Promise<VendorRow[]> {
    return this.#rank(await this.#listRows(op, this.#keyQuery(key), ["running", "paused"], signal));
  }

  // ---- provider verbs -----------------------------------------------------------------------------------------------

  #networkOpts(spec: SandboxSpec): Pick<E2bCreateOpts, "allowInternetAccess" | "network"> {
    const policy = spec.network;
    if (policy === undefined || policy === "open") return {};
    if (policy === "deny-all") return { allowInternetAccess: false };
    if (policy.inject !== undefined && policy.inject.length > 0) {
      // Header injection would put secrets in the vendor's network rules; secrets reach a box only as files.
      throw new EgressPolicyUnsupportedError({
        provider: this.id,
        requested: "allowlist with header injection",
        supported: ["open", "deny-all", "allowlist"],
      });
    }
    return { network: { allowOut: [...policy.allow], denyOut: ["0.0.0.0/0"] } };
  }

  async openOrCreate(
    key: SandboxKey,
    spec: SandboxSpec,
    o?: { signal?: AbortSignal },
  ): Promise<{ handle: ProviderSandbox; created: boolean; rebuilt: boolean }> {
    this.checkEnv(spec.env);
    const network = this.#networkOpts(spec);
    const signal = o?.signal;
    const deadline = Date.now() + this.timings.createDeadlineMs;
    let sawGhost = false;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let converged: { handle: E2bShapeBox; created: boolean };
      try {
        const rows = await this.#rowsForKey(key, "find", signal);
        const opened = await this.#openFirstLive(rows, spec, signal);
        if (opened.handle) return { handle: opened.handle, created: false, rebuilt: false };
        sawGhost ||= opened.sawGhost;
        const created = await this.#createBox(key, {
          template: this.#templateFor(spec.image, spec.size),
          labels: spec.labels,
          env: spec.env,
          lifetimeMs: spec.lifetimeMs,
          onExpire: spec.onExpire,
          network,
          ...(signal ? { signal } : {}),
        });
        converged = await this.#converge(key, created, spec, deadline, signal);
      } catch (error) {
        if (!isTransient(error) || Date.now() >= deadline) throw error;
        await sleep(Math.min(this.#retryPause(error, attempt), Math.max(0, deadline - Date.now())), signal);
        continue;
      }
      // Outside the create retry: a probe that could not run fails this create instead of starting another box.
      // Only a box this call created is probed (and killed on a failure), never one it converged onto.
      if (converged.created) await this.#checkEgress(converged.handle, spec, signal);
      return { handle: converged.handle, created: converged.created, rebuilt: sawGhost && converged.created };
    }
  }

  /** Full-jitter backoff, never shorter than the vendor's Retry-After on a quota answer. */
  #retryPause(error: unknown, attempt: number): number {
    const wait = error instanceof SandboxQuotaError ? (error.retryAfterMs ?? 0) : 0;
    return Math.max(wait, backoff(attempt, this.timings.backoffBaseMs, this.timings.backoffCapMs));
  }

  /**
   * Runs `fn` again after a quota answer (HTTP 429) until the create deadline. A 429 means the vendor made nothing,
   * so a retry cannot leave a second box or snapshot behind.
   */
  async #retryOnQuota<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + this.timings.createDeadlineMs;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof SandboxQuotaError) || Date.now() >= deadline) throw error;
        await sleep(Math.min(this.#retryPause(error, attempt), Math.max(0, deadline - Date.now())), signal);
      }
    }
  }

  /**
   * Opt-in egress check (docs/decisions/0001-egress-enforcement.md). Opens a TCP connection from inside the box to a
   * public address the policy does not allow; a connection that succeeds means the vendor accepted the policy
   * without enforcing it.
   *
   * A probe that could not run (a vendor error such as a 429, a timeout, a connect error, or an exit code other
   * than 0 or 1) says nothing about the policy, so it is never reported as a leak: it is retried with backoff
   * `EGRESS_PROBE_RETRIES` times, then the call throws `SandboxUnavailableError` (retryable).
   */
  async probeEgress(
    box: ProviderSandbox,
    policy: NetworkPolicy,
    signal?: AbortSignal,
  ): Promise<{ enforced: boolean; detail: string }> {
    if (policy === "open") return { enforced: true, detail: "open policy: nothing to enforce" };
    const target = egressProbeTarget(policy === "deny-all" ? [] : policy.allow);
    if (target === undefined) return { enforced: true, detail: "every probe address is on the allowlist" };
    let failure = "";
    for (let attempt = 0; attempt <= EGRESS_PROBE_RETRIES; attempt++) {
      if (attempt > 0) {
        const { backoffBaseMs: base, backoffCapMs: cap } = this.timings;
        await sleep(Math.max(base, backoff(attempt, base, cap)), signal);
      }
      try {
        const r = await box.exec(egressProbeCommand(target), { user: "agent", timeoutMs: 30_000 });
        if (r.exitCode === 0)
          return { enforced: false, detail: `the box connected to ${target}:443 despite the policy` };
        if (r.exitCode === 1) return { enforced: true, detail: `a connection to ${target}:443 was blocked` };
        failure = `exit ${r.exitCode}: ${r.stderrTail.trim().slice(-200)}`;
      } catch (error) {
        signal?.throwIfAborted();
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    throw new SandboxUnavailableError(this.ctx(box.ref.id), {
      cause: new Error(`the egress probe could not run in ${EGRESS_PROBE_RETRIES + 1} tries (${failure})`),
    });
  }

  /** Called only for a box this call created: killing it can never take a box another caller converged on. */
  async #checkEgress(box: E2bShapeBox, spec: SandboxSpec, signal?: AbortSignal): Promise<void> {
    const policy = spec.network;
    if (!this.#verifyEgress || policy === undefined || policy === "open") return;
    let probe: { enforced: boolean; detail: string };
    try {
      probe = await this.probeEgress(box, policy, signal);
    } catch (error) {
      // The box is unverified, so it is not handed out; the create fails retryably and a later try makes a new one.
      await this.#kill(box.ref.id).catch(() => undefined);
      if (error instanceof SandboxUnavailableError || signal?.aborted) throw error;
      throw new SandboxUnavailableError(this.ctx(box.ref.id), { cause: error });
    }
    if (probe.enforced) return;
    // A box that ignores its policy is never handed out; the caller sees the vendor fact, not a leaky box.
    await this.#kill(box.ref.id).catch(() => undefined);
    throw new EgressPolicyUnsupportedError(
      {
        provider: this.id,
        requested: policy === "deny-all" ? "deny-all" : "allowlist",
        supported: ["open"],
      },
      { cause: new Error(probe.detail) },
    );
  }

  /**
   * Opens the first row whose guest answers (invariant 6): every ref with a short budget first, then the silent
   * ones again with the full deadline. Positive 404s are ghosts at once.
   */
  async #openFirstLive(
    rows: VendorRow[],
    spec: SandboxSpec,
    signal?: AbortSignal,
  ): Promise<{ handle?: E2bShapeBox; sawGhost: boolean }> {
    let sawGhost = false;
    const silent: VendorRow[] = [];
    const passes = [
      { budget: this.timings.ghostProbeMs, candidates: rows, retrySilent: true },
      { budget: this.timings.openDeadlineMs, candidates: silent, retrySilent: false },
    ];
    for (const { budget, candidates, retrySilent } of passes) {
      for (const row of candidates) {
        try {
          const handle = await this.openRow(row, spec.lifetimeMs, budget, signal);
          this.#ghosts.delete(row.id);
          if (!handle.hasEnvFile && Object.keys(spec.env).length > 0) await handle.writeEnvFile(spec.env);
          return { handle, sawGhost };
        } catch (error) {
          if (error instanceof SandboxNotFoundError) {
            this.#ghosts.add(row.id);
            sawGhost = true;
            continue;
          }
          if (error instanceof SandboxGuestGoneError) {
            this.#ghosts.add(row.id);
            sawGhost = true;
            if (retrySilent) silent.push(row);
            continue;
          }
          throw error;
        }
      }
    }
    return { sawGhost };
  }

  /**
   * Invariant 7 without a unique name: after a create, list by key and keep the oldest live box. A box this call just
   * created and lost the race with is empty and unseen by anyone else, so it is killed rather than left running.
   */
  async #converge(
    key: SandboxKey,
    mine: E2bShapeBox,
    spec: SandboxSpec,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<{ handle: E2bShapeBox; created: boolean }> {
    let rows: VendorRow[] | undefined;
    for (let attempt = 0; rows === undefined; attempt++) {
      try {
        rows = await this.#listRows("find", this.#keyQuery(key), ["running", "paused"], signal);
      } catch (error) {
        // Keeping this box without a list could leave two for one key when a concurrent call also created one
        // (a 429 here is common exactly when calls race), so the list is retried and, failing that, the box goes.
        if (!isTransient(error) || Date.now() >= deadline) {
          await this.#discard(mine.ref.id, deadline, signal);
          throw error;
        }
        await sleep(Math.min(this.#retryPause(error, attempt), Math.max(0, deadline - Date.now())), signal);
      }
    }
    const live = rows
      .filter((r) => !this.#ghosts.has(r.id))
      .sort((a, b) => arrival(a).localeCompare(arrival(b)) || a.id.localeCompare(b.id));
    const oldest = live[0];
    if (!oldest || oldest.id === mine.ref.id) return { handle: mine, created: true };
    await this.#discard(mine.ref.id, deadline, signal);
    return { handle: await this.openRow(oldest, spec.lifetimeMs, this.timings.openDeadlineMs, signal), created: false };
  }

  /**
   * Kills a box this call made and will not hand out. A kill refused for rate (429) or unanswered is retried until the
   * deadline: swallowed at once, it left the losing box of a race running beside the winner (invariant 7).
   */
  async #discard(id: string, deadline: number, signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#kill(id);
        return;
      } catch (error) {
        if (!isTransient(error) || Date.now() >= deadline || signal?.aborted) return;
        await sleep(Math.min(this.#retryPause(error, attempt), Math.max(0, deadline - Date.now())), signal).catch(
          () => undefined,
        );
      }
    }
  }

  async #createBox(
    key: SandboxKey,
    o: {
      template: string;
      labels: Record<string, string>;
      env?: Record<string, string>;
      lifetimeMs: number;
      onExpire: "pause" | "kill";
      network?: Pick<E2bCreateOpts, "allowInternetAccess" | "network">;
      extraMeta?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<E2bShapeBox> {
    const metadata: Record<string, string> = {
      ...o.labels,
      [SELFBUILDING_LABELS.deployment]: key.deployment,
      [SELFBUILDING_LABELS.run]: o.labels[SELFBUILDING_LABELS.run] ?? key.runId,
      [META.scope]: key.scope,
      [META.createdAt]: new Date().toISOString(),
      ...(o.network && Object.keys(o.network).length > 0 ? { [META.network]: JSON.stringify(o.network) } : {}),
      ...o.extraMeta,
    };
    const lifetimeMs = this.lifetime(o.lifetimeMs);
    let sbx: E2bSandbox;
    try {
      // Labels go on at create time, so a create whose response is lost is still found by key (invariant 8).
      sbx = await this.#client.create(o.template, {
        ...(await this.conn(o.signal ? { signal: o.signal } : {})),
        metadata,
        timeoutMs: lifetimeMs,
        lifecycle: { onTimeout: o.onExpire },
        ...o.network,
      });
    } catch (error) {
      throw classify(error, this.site("create", undefined, { template: o.template }));
    }
    this.#noteWrite(sbx.sandboxId, "created", metadata);
    const now = Date.now();
    const row: VendorRow = {
      id: sbx.sandboxId,
      metadata,
      state: "running",
      createdAt: metadata[META.createdAt] as string,
    };
    const box = new E2bShapeBox(this, sbx, this.toRef(row), {}, now, now + lifetimeMs);
    try {
      if (o.env !== undefined) await box.writeEnvFile(o.env);
      await box.layout(o.template);
      return box;
    } catch (error) {
      // Invariant 9: anything failing between "vendor returned an id" and "handle returned" kills the box.
      await this.#discard(sbx.sandboxId, Date.now() + this.timings.requestTimeoutMs, o.signal);
      throw error;
    }
  }

  async find(key: SandboxKey): Promise<SandboxRef | null> {
    const [first] = await this.#rowsForKey(key, "find");
    return first ? this.toRef(first) : null;
  }

  list(filter: { deployment: DeploymentId; runId?: string; states?: SandboxState[] }): AsyncIterable<SandboxRef> {
    const self = this;
    return (async function* () {
      const wanted = filter.states ?? (["running", "paused"] as SandboxState[]);
      const states = (["running", "paused"] as const).filter((s) => wanted.includes(s));
      if (states.length === 0) return;
      const metadata: Record<string, string> = { [SELFBUILDING_LABELS.deployment]: filter.deployment };
      if (filter.runId !== undefined) metadata[SELFBUILDING_LABELS.run] = filter.runId;
      const rows = await self.#listRows("list", metadata, [...states]);
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const row of rows) yield self.toRef(row);
    })();
  }

  async open(ref: SandboxRef, o: { lifetimeMs: number; signal?: AbortSignal }): Promise<ProviderSandbox> {
    const row: VendorRow = {
      id: ref.id,
      metadata: {
        ...ref.labels,
        ...Object.fromEntries(Object.entries(ref.meta ?? {}).map(([k, v]) => [`${META_PREFIX}${k}`, v])),
      },
      state: ref.state,
      createdAt: ref.createdAt,
      ...(ref.meta?.startedAt === undefined ? {} : { startedAt: ref.meta.startedAt }),
    };
    return this.openRow(row, o.lifetimeMs, this.timings.openDeadlineMs, o.signal);
  }

  /**
   * `connect` is the only resume verb (invariant 1 keeps it out of every lookup). After it: the `true` probe until
   * the guest answers or the budget is spent (invariant 3), then the files under /run/selfbuilding again.
   */
  async openRow(row: VendorRow, lifetimeMs: number, budgetMs: number, signal?: AbortSignal): Promise<E2bShapeBox> {
    const lifetime = this.lifetime(lifetimeMs);
    let sbx: E2bSandbox | undefined;
    // A 409 here means the box is still pausing (an answer can arrive mid-park); connect resumes it once the pause
    // lands, so wait for that within the open budget instead of reporting an outage.
    const connectBy = Date.now() + budgetMs;
    for (let attempt = 0; sbx === undefined; attempt++) {
      try {
        sbx = await this.#client.connect(row.id, {
          ...(await this.conn(signal ? { signal } : {})),
          timeoutMs: lifetime,
        });
      } catch (error) {
        const remaining = connectBy - Date.now();
        if (readVendorFailure(error).status !== 409 || remaining <= 0) throw classify(error, this.site("open", row.id));
        await sleep(
          Math.min(remaining, backoff(attempt, this.timings.backoffBaseMs, this.timings.backoffCapMs)),
          signal,
        );
      }
    }
    this.#noteWrite(row.id, "resumed");
    const now = Date.now();
    const started = row.startedAt === undefined ? now : Math.min(now, Date.parse(row.startedAt) || now);
    const box = new E2bShapeBox(this, sbx, this.toRef(row, "running"), {}, started, now + lifetime);
    const deadline = now + budgetMs;
    let last: unknown;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        await box.layout(row.templateId ?? row.metadata[META.forkSnapshot] ?? this.#template, deadline - Date.now());
        break;
      } catch (error) {
        if (!isTransient(error) && !(error instanceof SandboxCommandTimeoutError)) throw error;
        last = error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SandboxGuestGoneError(this.ctx(row.id), { cause: last });
      await sleep(
        Math.min(remaining, backoff(attempt, Math.min(250, this.timings.backoffBaseMs), this.timings.backoffCapMs)),
        signal,
      );
    }
    const files = this.#runFilesFor(row.id);
    if (files.length > 0) await box.writeFiles(files);
    return box;
  }

  /**
   * Pause by id, never through a handle (invariant 1), then poll until the vendor reports it paused (invariant 4).
   * 409 is "already pausing or paused", 408 means the server did pause, 404 is gone; fleet errors are rethrown;
   * any other 4xx is a typed refusal.
   */
  async pause(ref: SandboxRef): Promise<PauseOutcome> {
    try {
      // A memory pause of a large box takes minutes; the 60 s control-plane timeout cut it off (found live).
      await this.#client.pause(ref.id, {
        ...(await this.conn({ requestTimeoutMs: this.timings.snapshotTimeoutMs })),
        keepMemory: true,
      });
    } catch (error) {
      const failure = readVendorFailure(error);
      // Our own request timing out says nothing about the pause: the vendor may still be pausing, so poll for it.
      if (isRequestTimeout(error)) return this.#awaitPaused(ref.id);
      if (failure.name === "SandboxNotFoundError" || failure.status === 404) {
        this.#runFiles.delete(ref.id);
        return { confirmed: false, reason: "gone", status: 404, message: failure.message };
      }
      if (failure.status !== 408 && failure.status !== 409) {
        const classified = classify(error, this.site("pause", ref.id));
        if (classified instanceof SandboxAuthError || classified instanceof SandboxQuotaError) throw classified;
        if (isRefusal(classified) && failure.status !== undefined) {
          return { confirmed: false, reason: "refused", status: failure.status, message: failure.message };
        }
        throw classified;
      }
    }
    return this.#awaitPaused(ref.id);
  }

  async #awaitPaused(id: string): Promise<PauseOutcome> {
    const deadline = Date.now() + this.timings.pauseDeadlineMs;
    let last: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        const info = await this.#client.getInfo(id, await this.conn());
        if (info.state === "paused") {
          this.#noteWrite(id, "paused");
          return { confirmed: true, kept: this.limits.expireKeeps === "memory" ? "memory" : "filesystem" };
        }
      } catch (error) {
        // A slow pause can answer 404 for a box that is still alive (invariant 5), so nothing here means "gone".
        const classified = classify(error, this.site("pause", id));
        if (classified instanceof SandboxAuthError) throw classified;
        last = classified;
      }
      if (Date.now() >= deadline) {
        throw new SandboxUnavailableError(this.ctx(id), {
          cause: last,
          message: `Provider "${this.id}" accepted the pause of ${id} but never reported it paused. The outcome is unknown; check again before acting on it.`,
        });
      }
      await sleep(Math.min(this.timings.pollMs * 2 ** Math.min(attempt, 3), Math.max(0, deadline - Date.now())));
    }
  }

  async kill(ref: SandboxRef): Promise<{ path: "killed" | "already-gone" }> {
    return this.#kill(ref.id);
  }

  async #kill(id: string): Promise<{ path: "killed" | "already-gone" }> {
    let killed: boolean;
    try {
      killed = await this.#client.kill(id, await this.conn());
    } catch (error) {
      throw classify(error, this.site("kill", id));
    }
    this.#runFiles.delete(id);
    this.#ghosts.delete(id);
    this.#noteWrite(id, "killed");
    return { path: killed ? "killed" : "already-gone" };
  }

  async snapshot(ref: SandboxRef, o?: { name?: string }): Promise<SnapshotResult> {
    const createSnapshot = this.#client.createSnapshot;
    if (!createSnapshot || this.#unsupported.has("snapshot")) {
      throw new SandboxUnsupportedError({ ...this.ctx(ref.id), op: "snapshot" });
    }
    const slug = (o?.name ?? "selfbuilding")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const snapshotId = await this.#retryOnQuota(async () => {
      try {
        const info = await createSnapshot.call(this.#client, ref.id, {
          ...(await this.conn({ requestTimeoutMs: this.timings.snapshotTimeoutMs })),
          name: `${slug || "selfbuilding"}-${randomBytes(3).toString("hex")}`,
        });
        return info.snapshotId;
      } catch (error) {
        const classified = classify(error, this.site("snapshot", ref.id));
        if (classified instanceof SandboxUnsupportedError) this.#unsupported.add("snapshot");
        throw classified;
      }
    });
    // The vendor pauses the source while it captures; report whatever state it is left in (invariant 17).
    let sourceState: SnapshotResult["sourceState"] = "running";
    try {
      const info = await this.#client.getInfo(ref.id, await this.conn());
      if (info.state === "paused") sourceState = "paused";
    } catch {
      // The snapshot exists; an unreadable source state is reported as the vendor's documented default.
    }
    return { snapshotId, fidelity: "memory", sourceState };
  }

  /**
   * One snapshot of the quiesced source, then one create per child with the child's own labels. The vendor's native
   * fork copies the parent's metadata and offers no way to relabel a sandbox, so its children would answer `find`
   * for the parent's key. Children report `forkSnapshot` in `ref.meta`; the snapshot outlives them for the reaper.
   */
  /**
   * The parent's egress options. Egress is a create-time option on this vendor, so a child created from the
   * snapshot without them would get open internet: a policy the parent never had (spec §9.5 rule 1).
   */
  async #networkOf(ref: SandboxRef): Promise<Pick<E2bCreateOpts, "allowInternetAccess" | "network">> {
    let encoded = ref.meta?.network as string | undefined;
    if (encoded === undefined && ref.meta?.scope === undefined) {
      const info = await this.#client.getInfo(ref.id, await this.conn());
      encoded = info.metadata?.[META.network];
    }
    if (encoded === undefined) return {};
    return JSON.parse(encoded) as Pick<E2bCreateOpts, "allowInternetAccess" | "network">;
  }

  async fork(
    ref: SandboxRef,
    o: { children: { name: string; labels: Record<string, string>; key?: SandboxKey }[]; lifetimeMs: number },
  ): Promise<Array<ProviderSandbox | SandboxError>> {
    if (o.children.length === 0) return [];
    let network: Pick<E2bCreateOpts, "allowInternetAccess" | "network">;
    try {
      network = await this.#networkOf(ref);
    } catch (error) {
      // An unreadable policy is never guessed as open.
      const item: SandboxError = classify(error, this.site("fork.network", ref.id));
      return o.children.map(() => item);
    }
    let snapshotId: string;
    try {
      snapshotId = (await this.snapshot(ref, { name: `fork-${ref.name || ref.id}` })).snapshotId;
    } catch (error) {
      if (error instanceof SandboxNotFoundError || error instanceof SandboxAuthError) throw error;
      const item: SandboxError = classify(error, this.site("fork.snapshot", ref.id));
      return o.children.map(() => item);
    }
    const results: Array<ProviderSandbox | SandboxError> = [];
    for (const [index, child] of o.children.entries()) {
      // The core's own key for the child, so a replayed fork finds the child it made instead of making another.
      const key: SandboxKey = child.key ?? { ...ref.key, scope: `${ref.key.scope}/fork[${index}]` };
      try {
        // A retry after a 429 looks for the child again first, so it never makes a second one.
        const made = await this.#retryOnQuota(async (): Promise<ProviderSandbox> => {
          const existing = await this.#rowsForKey(key, "fork.find");
          if (existing.length > 0) {
            const spec = {
              image: snapshotId,
              env: {},
              lifetimeMs: o.lifetimeMs,
              onExpire: "pause",
              labels: child.labels,
            };
            const opened = await this.#openFirstLive(existing, spec as unknown as SandboxSpec);
            if (opened.handle) return opened.handle;
          }
          return this.#createBox(key, {
            template: snapshotId,
            labels: {
              ...child.labels,
              [SELFBUILDING_LABELS.name]: child.name,
              [SELFBUILDING_LABELS.parent]: ref.id,
            },
            lifetimeMs: o.lifetimeMs,
            onExpire: "pause",
            network,
            extraMeta: { [META.forkSnapshot]: snapshotId },
          });
        });
        results.push(made);
      } catch (error) {
        results.push(classify(error, this.site("fork.child", ref.id)));
      }
    }
    return results;
  }

  // ---- used by handles --------------------------------------------------------------------------------------------

  /** The vendor's current deadline for a box, or undefined when it cannot be read. */
  async deadlineOf(id: string): Promise<number | undefined> {
    try {
      const info = await this.#client.getInfo(id, await this.conn());
      const end = info.endAt === undefined ? Number.NaN : new Date(info.endAt).getTime();
      return Number.isFinite(end) ? end : undefined;
    } catch (error) {
      const classified = classify(error, this.site("extendLifetime", id));
      if (classified instanceof SandboxNotFoundError || classified instanceof SandboxAuthError) throw classified;
      return undefined;
    }
  }

  async setTimeout(id: string, ms: number): Promise<void> {
    try {
      await this.#client.setTimeout(id, ms, await this.conn());
    } catch (error) {
      throw classify(error, this.site("extendLifetime", id));
    }
  }
}

/** A connected box. Holds the vendor instance for envd calls; control-plane calls go back through the provider. */
export class E2bShapeBox implements ProviderSandbox {
  readonly ref: SandboxRef;
  readonly #provider: E2bShapeProvider;
  readonly #sbx: E2bSandbox;
  #env: Record<string, string>;
  #hasEnvFile = false;
  readonly #sessionStartMs: number;
  #untilMs: number;

  constructor(
    provider: E2bShapeProvider,
    sbx: E2bSandbox,
    ref: SandboxRef,
    env: Record<string, string>,
    sessionStartMs: number,
    untilMs: number,
  ) {
    this.#provider = provider;
    this.#sbx = sbx;
    this.ref = ref;
    this.#env = env;
    this.#sessionStartMs = sessionStartMs;
    this.#untilMs = untilMs;
  }

  get hasEnvFile(): boolean {
    return this.#hasEnvFile;
  }

  #site(op: string, extra: Partial<ErrorSite> = {}): ErrorSite {
    return this.#provider.site(op, this.ref.id, extra);
  }

  #envs(user: "agent" | "root", extra: Record<string, string> | undefined): Record<string, string> {
    // envd may default to root and a non-login shell may not set HOME, so it is always explicit.
    return {
      LANG: "C.UTF-8",
      HOME: user === "root" ? "/root" : SANDBOX_PATHS.home,
      ...this.#env,
      ...extra,
    };
  }

  /** Writes the create-time env into the box and keeps it for this handle. */
  async writeEnvFile(env: Record<string, string>): Promise<void> {
    await this.#write([{ path: ENV_FILE, data: JSON.stringify(env) }], "root");
    this.#env = { ...env };
    this.#hasEnvFile = true;
  }

  /** Lays out the canonical directories and reads the create-time env back. Doubles as the guest probe. */
  async layout(template: string, budgetMs?: number): Promise<void> {
    const timeoutMs = Math.max(1_000, Math.min(budgetMs ?? 30_000, 30_000));
    const result = await this.exec(layoutScript(), { user: "root", timeoutMs, cwd: "/" });
    if (result.exitCode !== 0) {
      throw new ImageUnavailableError(
        `Sandbox ${this.ref.id} (template "${template}") has no "agent" user or cannot create the selfbuilding layout (exit ${result.exitCode}: ${result.stderrTail.trim()}). Use a selfbuilding template such as "selfbuilding-claude-code" or "selfbuilding-codex".`,
      );
    }
    const out = result.stdoutTail.trim();
    if (out === ENV_MISSING) return;
    try {
      this.#env = JSON.parse(out) as Record<string, string>;
      this.#hasEnvFile = true;
    } catch {
      this.#hasEnvFile = false;
    }
  }

  async exec(cmd: string, o: ExecOpts = {}): Promise<ExecResult> {
    this.#provider.checkEnv(o.env);
    const user = o.user ?? "agent";
    const timeoutMs = o.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const tailBytes = o.maxTailBytes ?? DEFAULT_TAIL_BYTES;
    let wrapped: string;
    if (o.stdin !== undefined) {
      // Stdin travels as a file, never through argv (invariant 11); the shell opens it before removing it.
      const file = `/tmp/.selfbuilding-stdin-${randomId("")}`;
      await this.#write([{ path: file, data: o.stdin }], user);
      wrapped = `{ rm -f ${shq(file)}; ${cmd}\n} < ${shq(file)}`;
    } else {
      wrapped = `{ ${cmd}\n} < /dev/null`;
    }
    const stdout = new Tail(tailBytes);
    const stderr = new Tail(tailBytes);
    const outLines = new LineSplitter((line) => o.onLine?.("stdout", line));
    const errLines = new LineSplitter((line) => o.onLine?.("stderr", line));
    let handle: E2bCommandHandle;
    try {
      handle = await this.#sbx.commands.run(wrapped, {
        background: true,
        user,
        cwd: o.cwd ?? SANDBOX_PATHS.workdir,
        envs: this.#envs(user, o.env),
        timeoutMs: timeoutMs + VENDOR_TIMEOUT_GRACE_MS,
        onStdout: (data) => {
          stdout.push(data);
          outLines.push(data);
        },
        onStderr: (data) => {
          stderr.push(data);
          errLines.push(data);
        },
      });
    } catch (error) {
      throw classify(error, this.#site("exec"));
    }
    let killing: Promise<boolean> | undefined;
    const timer = setTimeout(() => {
      killing = handle.kill().catch(() => false);
    }, timeoutMs);
    const timeoutError = async (vendorDeadline: boolean) =>
      new SandboxCommandTimeoutError({
        ...this.#provider.ctx(this.ref.id),
        cmd,
        mayStillBeRunning: vendorDeadline || !(await (killing ?? Promise.resolve(false))),
        ...(o.idempotent === undefined ? {} : { idempotent: o.idempotent }),
      });
    let exitCode: number;
    try {
      exitCode = (await handle.wait()).exitCode;
    } catch (error) {
      const code = exitCodeOf(error);
      if (killing) throw await timeoutError(false);
      if (code !== undefined) exitCode = code;
      else if (isVendorDeadline(error)) throw await timeoutError(true);
      else throw classify(error, this.#site("exec"));
    } finally {
      clearTimeout(timer);
    }
    if (killing) throw await timeoutError(false);
    outLines.end();
    errLines.end();
    return {
      exitCode,
      stdoutTail: stdout.toString(),
      stderrTail: stderr.toString(),
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  /**
   * Starts a process that outlives this client (invariant 12): native background start with no vendor timeout, in its
   * own session, with the log and exit code in files so any process can reattach by byte offset. Never retried.
   */
  async spawn(cmd: string, o: SpawnOpts = {}): Promise<ProcessRef> {
    this.#provider.checkEnv(o.env);
    const user = o.user ?? "agent";
    const id = randomId("p");
    const logPath = `${SANDBOX_PATHS.proc}/${id}.log`;
    const exitPath = `${SANDBOX_PATHS.proc}/${id}.exit`;
    const pidPath = `${SANDBOX_PATHS.proc}/${id}.pid`;
    // The trap is a handler, not an ignore, so the command keeps the default SIGINT action while the shim survives a
    // group-wide SIGINT long enough to record the exit code.
    const shim =
      'trap : INT TERM; echo $$ > "$2"; /bin/sh -c "$3" < "$4"; c=$?; printf %s "$c" > "$1.tmp" && mv "$1.tmp" "$1"';
    const start = [
      `mkdir -p ${shq(SANDBOX_PATHS.proc)} &&`,
      `setsid /bin/sh -c ${shq(shim)} selfbuilding-proc ${shq(exitPath)} ${shq(pidPath)} ${shq(cmd)} ${shq(o.stdinFile ?? "/dev/null")}`,
      `> ${shq(logPath)} 2>&1 < /dev/null`,
    ].join(" ");
    let handle: E2bCommandHandle;
    try {
      handle = await this.#sbx.commands.run(start, {
        background: true,
        user,
        cwd: o.cwd ?? SANDBOX_PATHS.workdir,
        envs: this.#envs(user, o.env),
        timeoutMs: 0,
      });
    } catch (error) {
      throw classify(error, this.#site("spawn"));
    }
    const startedAt = new Date().toISOString();
    await handle.disconnect().catch(() => undefined);
    const ref: ProcessRef = { id, vendorPid: String(handle.pid), logPath, exitPath, startedAt };
    // The process is running whatever happens next, so a failure to read its group id is not an error.
    try {
      const pid = await this.exec(
        `i=0; while [ ! -s ${shq(pidPath)} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; cat ${shq(pidPath)}`,
        { user: "root", timeoutMs: 20_000 },
      );
      const pgid = Number.parseInt(pid.stdoutTail.trim(), 10);
      if (Number.isInteger(pgid) && pgid > 0) ref.pgid = pgid;
    } catch {
      // Reattach still works from the log and exit files.
    }
    return ref;
  }

  async attach(
    p: ProcessRef,
    o: { fromOffset: number; onLine?: OnLine; signal?: AbortSignal },
  ): Promise<{ state: "running" | "exited"; exitCode?: number; offset: number }> {
    let offset = o.fromOffset;
    const pollMs = this.#provider.timings.pollMs;
    for (;;) {
      const alive = p.pgid === undefined ? "true" : `kill -0 -${p.pgid} 2>/dev/null`;
      const exitFile = shq(p.exitPath);
      const status = [
        `if [ -f ${exitFile} ]; then printf 'exit %s\\n' "$(cat ${exitFile})";`,
        `elif ${alive}; then echo running;`,
        `elif [ -f ${exitFile} ]; then printf 'exit %s\\n' "$(cat ${exitFile})";`,
        "else echo gone; fi",
        `tail -c +${offset + 1} ${shq(p.logPath)} 2>/dev/null | head -c ${ATTACH_CHUNK_BYTES} | base64 | tr -d '\\n'`,
      ].join("\n");
      const result = await this.exec(status, { user: "root", timeoutMs: 30_000, maxTailBytes: ATTACH_CHUNK_BYTES * 2 });
      if (result.exitCode !== 0) {
        throw new SandboxUnavailableError(this.#provider.ctx(this.ref.id), {
          message: `Could not read the state of process ${p.id} (exit ${result.exitCode}): ${result.stderrTail.trim()}`,
        });
      }
      const [head = "", encoded = ""] = result.stdoutTail.split("\n");
      const chunk = Buffer.from(encoded.trim(), "base64");
      const finished = head.startsWith("exit ") || head === "gone";
      const full = chunk.length >= ATTACH_CHUNK_BYTES;
      // Only whole lines are reported while the process runs; the final partial line is flushed once it has exited.
      const usable = finished && !full ? chunk.length : chunk.lastIndexOf(0x0a) + 1;
      if (usable > 0) {
        const lines = chunk.subarray(0, usable).toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        for (const line of lines) o.onLine?.("stdout", line);
        offset += usable;
      }
      if (full) continue;
      if (head.startsWith("exit ")) {
        const code = Number.parseInt(head.slice(5), 10);
        return Number.isInteger(code) ? { state: "exited", exitCode: code, offset } : { state: "exited", offset };
      }
      if (head === "gone") return { state: "exited", offset };
      if (o.signal?.aborted) return { state: "running", offset };
      try {
        await sleep(pollMs, o.signal);
      } catch {
        return { state: "running", offset };
      }
    }
  }

  async readFile(file: string): Promise<Uint8Array> {
    try {
      const data = await this.#sbx.files.read(file, { format: "bytes", user: "root" });
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch (error) {
      throw classify(error, this.#site("readFile", { file }));
    }
  }

  async #write(files: { path: string; data: Uint8Array | string }[], user: string): Promise<void> {
    try {
      await this.#sbx.files.write(
        files.map((f) => ({ path: f.path, data: toArrayBuffer(f.data) })),
        { user },
      );
    } catch (error) {
      throw classify(error, this.#site("writeFiles"));
    }
  }

  async #rootScript(script: string, what: string): Promise<void> {
    const result = await this.exec(script, { user: "root", timeoutMs: 60_000, cwd: "/" });
    if (result.exitCode !== 0) {
      throw new SandboxUnavailableError(this.#provider.ctx(this.ref.id), {
        message: `${what} failed in sandbox ${this.ref.id} (exit ${result.exitCode}): ${result.stderrTail.trim()}`,
      });
    }
  }

  /**
   * Writes as root, then sets each file's mode and owner, and hands parent directories under the selfbuilding roots
   * to the same owner. Secrets land in a 0700 directory and are forced to 0600 (invariant 18), so there is no window
   * in which another user can read them.
   */
  async writeFiles(files: WriteFileEntry[]): Promise<void> {
    if (files.length === 0) return;
    if (files.some((f) => isUnder(f.path, SANDBOX_PATHS.secrets))) {
      await this.#rootScript(
        // Root's, never the agent's: an owner could swap a file root later reads or runs (a credential helper).
        `mkdir -p ${shq(SANDBOX_PATHS.secrets)} && chown root:root ${shq(SANDBOX_PATHS.secrets)} && chmod 0700 ${shq(SANDBOX_PATHS.secrets)}`,
        "Preparing the secrets directory",
      );
    }
    await this.#write(files, "root");
    const steps: string[] = [];
    const dirs = new Map<string, "agent" | "root">();
    for (const file of files) {
      const owner = file.owner ?? "agent";
      const secret = isUnder(file.path, SANDBOX_PATHS.secrets);
      const mode = secret ? (file.mode ?? 0o600) & 0o600 : (file.mode ?? 0o644);
      steps.push(
        `chmod ${mode.toString(8).padStart(4, "0")} ${shq(file.path)} && chown ${owner}:${owner} ${shq(file.path)}`,
      );
      const root = OWNED_ROOTS.find((r) => isUnder(file.path, r) && file.path !== r);
      if (!root) continue;
      for (let dir = path.posix.dirname(file.path); dir !== root && isUnder(dir, root); dir = path.posix.dirname(dir)) {
        if (dir === SANDBOX_PATHS.secrets) continue;
        if (!dirs.has(dir) || owner === "agent") dirs.set(dir, owner);
      }
    }
    for (const [dir, owner] of dirs) steps.push(`chown ${owner}:${owner} ${shq(dir)}`);
    await this.#rootScript(steps.join(" && "), "Setting file modes and owners");
    this.#provider.rememberRunFiles(this.ref.id, files);
  }

  async extendLifetime(
    untilMs: number,
    opts?: { allowShorter?: boolean },
  ): Promise<{ untilMs: number; clamped: boolean }> {
    const now = Date.now();
    const max = Math.min(
      this.#sessionStartMs + this.#provider.limits.maxLifetimeMs,
      now + this.#provider.limits.maxLifetimeMs,
    );
    const clamped = untilMs > max;
    // The vendor verb overwrites the deadline and can shorten it; an extend never moves it earlier (invariant 15).
    const wanted = clamped ? max : untilMs;
    let target = wanted;
    if (!opts?.allowShorter) {
      const current = Math.max(this.#untilMs, (await this.#provider.deadlineOf(this.ref.id)) ?? 0);
      target = Math.max(wanted, Math.min(current, max));
      if (target <= current) return { untilMs: current, clamped };
    }
    // The vendor verb resets the deadline to now + ms, so the absolute target is converted here (invariant 15).
    const ms = Math.max(1_000, target - now);
    await this.#provider.setTimeout(this.ref.id, ms);
    this.#untilMs = now + ms;
    return { untilMs: this.#untilMs, clamped };
  }

  async previewUrl(port: number): Promise<{ url: string; headers: Record<string, string> }> {
    const host = this.#sbx.getHost(port);
    const token = this.#sbx.trafficAccessToken;
    return { url: `https://${host}`, headers: token ? { "e2b-traffic-access-token": token } : {} };
  }
}
