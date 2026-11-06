import type { DeploymentId, Duration, Stability } from "./common.js";
import type { NetworkPolicy } from "./security.js";
import type { ProviderSizing, ResolvedSize, SizeName } from "./sizes.js";

// Provider contract (spec §5.2). The provider-level handle is `ProviderSandbox`; the user-facing handle is
// `SandboxHandle` (spec §3.11).

/** Identity of a sandbox. Computed by the core, never by adapters. */
export interface SandboxKey {
  runId: string;
  /** Agent call path, shared-handle name, or fork child ("box#0/fork[1]"). */
  scope: string;
  /** Carried with the key so `find` can stay scoped to one deployment without reading config (spec §5.1 rule 6). */
  deployment: DeploymentId;
}

export type SandboxState = "starting" | "running" | "paused" | "stopped" | "error" | "unknown";

/** Plain JSON. Crosses host step boundaries and is reopened by id, sometimes days later. */
export interface SandboxRef {
  /** Adapter id, e.g. "impello". */
  provider: string;
  /** Vendor id. */
  id: string;
  /** `sandboxName(key)`. */
  name: string;
  key: SandboxKey;
  deployment: DeploymentId;
  /** "Is the VM up", never "is a turn running". */
  state: SandboxState;
  /** ISO. */
  createdAt: string;
  /** As read back from the vendor (see `SELFBUILDING_LABELS`). */
  labels: Record<string, string>;
  /** Adapter-private, e.g. region. */
  meta?: Record<string, string>;
  /** The size name the box was created at (label `selfbuilding.size`); absent: the provider default. */
  size?: string;
}

/** How each provider resolves an image or template (spec §5.6). */
export interface ResolvedImage {
  /** "selfbuilding-claude-code", "selfbuilding-codex", "selfbuilding-all", ... */
  name: string;
  /** Docker: "selfbuilding/claude-code:<version>"; Impello/E2B: the template alias; others: snapshot or image id. */
  ref: string;
  /** The selfbuilding version the image was built for. */
  version: string;
  digest?: string;
}

export interface SandboxSpec {
  image: ResolvedImage;
  /** Non-secret only (invariant 18). Adapters throw SecretInEnvError otherwise. */
  env: Record<string, string>;
  /** Initial lifetime; extended by the host. */
  lifetimeMs: number;
  /** No adapter default; the core passes "pause" for every placement (spec §5.8). */
  onExpire: "pause" | "kill";
  resources?: { vcpu: number; memoryMiB: number; diskGiB?: number };
  /**
   * The requested size, resolved from the config table (demo-path §1). Absent: the provider default (today's
   * behaviour). When set, the core also sets `resources` to the same numbers and has already checked the size
   * against `SandboxProvider.sizing`; a provider that still cannot give it throws SizeUnavailableError.
   */
  size?: ResolvedSize;
  /** Must be declared up front on some providers. */
  ports?: number[];
  /** Full policy, never a patch. */
  network?: NetworkPolicy;
  /** Set by the core; see `SELFBUILDING_LABELS`. */
  labels: Record<string, string>;
}

export interface ProviderLimits {
  /** The plan's longest session; extendLifetime clamps to it. */
  maxLifetimeMs: number;
  /** Seeds the default for `concurrency.sandboxes`. */
  maxConcurrent?: number;
  /** Feeds the create-rate limiter. */
  createsPerMinute?: number;
  /** false: the box can vanish before its lifetime ends. */
  lifetimeGuaranteed: boolean;
  /** What `onExpire: "pause"` actually keeps on this provider. */
  expireKeeps: "memory" | "filesystem" | "nothing";
}

export type PauseOutcome =
  | { confirmed: true; kept: "memory" | "filesystem" }
  | { confirmed: false; reason: "refused" | "gone"; status?: number; message: string };

export interface SnapshotResult {
  snapshotId: string;
  /** What the provider captured; never live agent processes. */
  fidelity: "memory" | "filesystem";
  /** The source's state after the snapshot. */
  sourceState: "running" | "paused" | "stopped";
  expiresAt?: string;
}

export type OnLine = (stream: "stdout" | "stderr", line: string) => void;

export interface ExecOpts {
  cwd?: string;
  /** Non-secret only; secrets arrive as files (invariant 18). */
  env?: Record<string, string>;
  /** Default "agent"; HOME is always set explicitly. */
  user?: "agent" | "root";
  /** Piped, then closed. */
  stdin?: string | Uint8Array;
  /** Default 120_000; never the vendor's default. */
  timeoutMs?: number;
  /** Line by line, unbuffered, split on "\n" only. */
  onLine?: OnLine;
  /** Allows retry on transient guest errors. */
  idempotent?: boolean;
  /** Default 65_536 per stream. */
  maxTailBytes?: number;
}

/** A non-zero exit is returned, never thrown. */
export interface ExecResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  user?: "agent" | "root";
  stdinFile?: string;
}

export interface ProcessRef {
  id: string;
  pgid?: number;
  vendorPid?: string;
  /** /selfbuilding/state/proc/<id>.log */
  logPath: string;
  /** /selfbuilding/state/proc/<id>.exit */
  exitPath: string;
  startedAt: string;
}

export interface WriteFileEntry {
  path: string;
  data: Uint8Array | string;
  mode?: number;
  owner?: "agent" | "root";
}

/** A live box, as held by adapters and the core (spec §5.2, "SandboxHandle" there). */
export interface ProviderSandbox {
  readonly ref: SandboxRef;
  exec(cmd: string, o?: ExecOpts): Promise<ExecResult>;
  /** Starts a process that outlives this client and the orchestrator. Never retried. */
  spawn(cmd: string, o?: SpawnOpts): Promise<ProcessRef>;
  /** Reattaches by ref, from any process, and resumes the log at a byte offset. */
  attach(
    p: ProcessRef,
    o: { fromOffset: number; onLine?: OnLine; signal?: AbortSignal },
  ): Promise<{ state: "running" | "exited"; exitCode?: number; offset: number }>;
  /** Throws SandboxFileNotFoundError if absent. */
  readFile(path: string): Promise<Uint8Array>;
  writeFiles(files: WriteFileEntry[]): Promise<void>;
  /** Absolute target in epoch ms. The adapter converts it to its vendor's verb and clamps to limits. */
  /**
   * Moves the deadline to `untilMs`. An extend never moves a later deadline earlier unless `allowShorter` is set,
   * which only the refused-pause fallback uses (spec §9.9 #5).
   */
  extendLifetime(untilMs: number, opts?: { allowShorter?: boolean }): Promise<{ untilMs: number; clamped: boolean }>;
  previewUrl?(port: number): Promise<{ url: string; headers: Record<string, string> }>;
}

/** A per-item fork failure. Always one of the sandbox error classes (spec §5.3). */
export type SandboxError = Error & { readonly code: string };

export interface SandboxProvider {
  readonly id: string;
  readonly stability: Stability;
  readonly limits: ProviderLimits;
  /**
   * Test-only providers (the tmpdir provider) set this to the host directory that stands in for "/".
   * The host then passes it to the runtime as `SELFBUILDING_FS_ROOT`. Real providers leave it unset.
   */
  readonly fsRoot?: string;
  /** How this provider sizes boxes (demo-path §1.3). Absent: it takes no sizes; any requested size is refused. */
  readonly sizing?: ProviderSizing;

  /** Primary verb. Idempotent per key; atomic where the vendor allows it. */
  openOrCreate(
    key: SandboxKey,
    spec: SandboxSpec,
    o?: { signal?: AbortSignal },
  ): Promise<{ handle: ProviderSandbox; created: boolean; rebuilt: boolean }>;
  /** Pure lookup, scoped to `key.deployment`. Never wakes anything. Null only on a confirmed miss. */
  find(key: SandboxKey): Promise<SandboxRef | null>;
  /** Every sandbox of one deployment, including paused ones. Throws instead of yielding nothing. */
  list(filter: { deployment: DeploymentId; runId?: string; states?: SandboxState[] }): AsyncIterable<SandboxRef>;
  /** Always returns a running box whose guest answers. */
  open(ref: SandboxRef, o: { lifetimeMs: number; signal?: AbortSignal }): Promise<ProviderSandbox>;
  /** By ref, never through a connected handle. A refusal is an outcome, not a throw. */
  pause(ref: SandboxRef): Promise<PauseOutcome>;
  /** Idempotent. */
  kill(ref: SandboxRef): Promise<{ path: "killed" | "already-gone" }>;

  // Optional. The core checks for the method, never a flag, and calls both only on a quiesced box.
  snapshot?(ref: SandboxRef, o?: { name?: string }): Promise<SnapshotResult>;
  fork?(
    ref: SandboxRef,
    o: {
      /** `key` is the core's own key for the child; a provider keys the child by it so a replayed fork finds it. */
      children: { name: string; labels: Record<string, string>; key?: SandboxKey }[];
      lifetimeMs: number;
      /** Only on `sizing.forkSize: "override"` providers; the core refuses it elsewhere first. */
      size?: ResolvedSize;
    },
  ): Promise<Array<ProviderSandbox | SandboxError>>;
  /**
   * Opt-in egress check (docs/decisions/0001-egress-enforcement.md): after create, proves the box's policy holds,
   * e.g. that a deny-all box cannot open a TCP connection to a public address. `enforced: false` means the vendor
   * accepted the policy but does not enforce it; the core then throws EgressPolicyUnsupportedError.
   */
  probeEgress?(box: ProviderSandbox, policy: NetworkPolicy): Promise<{ enforced: boolean; detail: string }>;
}

// User-facing placement types (spec §3.11).

export type Snapshot = { snapshotId: string; fidelity: "memory" | "filesystem"; expiresAt?: string };

export type GitCheckpoint = { kind: "git"; remote: string; ref: string; sha: string };

export type Checkpoint = GitCheckpoint | { kind: "snapshot"; snapshot: Snapshot; git: GitCheckpoint };

export type ForkMode = "best" | "filesystem" | "git" | "memory";

/** The user-facing handle returned by `sandbox()`. Synchronous and lazy: no box exists until first use. */
export interface SandboxHandle extends AsyncDisposable {
  /** Logical id, stable for the run: the label, or "sandbox#n". */
  readonly id: string;
  /** Where the handle was created. */
  readonly callPath: string;
  /** Bumped by every mutation through the handle. */
  readonly version: number;
  /** Set on fork children. */
  readonly forkedWith?: "filesystem" | "git";
  exec(cmd: string, opts?: { cwd?: string; timeout?: Duration; checkpoint?: boolean }): Promise<ExecResult>;
  checkpoint(mode?: "git" | "snapshot"): Promise<Checkpoint>;
  /** The handle's branch, pushed by the host. */
  push(): Promise<{ remote: string; name: string; sha: string }>;
  snapshot(): Promise<Snapshot>;
  /** Takes n slots atomically. A failed fork is `null`. `mode: "memory"` throws SandboxUnsupportedError in v1. */
  fork(n: number, opts?: { mode?: ForkMode; size?: SizeName }): Promise<(SandboxHandle | null)[]>;
  dispose(opts?: { mode?: "kill" | "pause" }): Promise<void>;
}

export interface SandboxOptions {
  /** Default: the factory's (or config's) sandbox provider. */
  provider?: SandboxProvider;
  /** Default: the factory's repo default, else required at first use. */
  repo?: string;
  /** Default: branchName(runId, label or "sandbox#n"). */
  branch?: string;
  /**
   * The branch the box's working branch starts from. Default: the first call's `git.baseBranch`, else the repo's
   * default branch. Forks inherit it.
   */
  baseBranch?: string;
  label?: string;
  from?: Snapshot | Checkpoint;
  /** Default: the factory's `defaults.size`, else the provider default. */
  size?: SizeName;
}
