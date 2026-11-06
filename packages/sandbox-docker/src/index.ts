import type { ProviderLimits, SandboxProvider } from "@selfbuilding/core";
import { hostIds } from "./build.js";
import { connectDocker, type DockerClient } from "./client.js";
import { DockerProvider, dockerSizing, SNAPSHOT_REPO, validateWorktree } from "./provider.js";

export { type DockerImageBuilderOptions, dockerImageBuilder } from "./build.js";

export type {
  DockerClient,
  DockerContainer,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerCreateOptions,
  DockerExec,
  DockerExecCreate,
  DockerExecInspect,
  DockerPortBinding,
} from "./client.js";
export { dockerSizing, SNAPSHOT_REPO };

export interface DockerOptions {
  /** Default selfbuilding/<harness>:<version>. When set, every box that is not restored from a snapshot uses it. */
  image?: string;
  /** Build a local image whose agent user matches this machine's UID. */
  build?: boolean;
  /** Bind-mount a host worktree at the workdir for fast local loops. */
  mount?: "isolated" | "worktree";
  /** Docker socket path; default the local daemon. */
  socketPath?: string;
  /** The host worktree to bind-mount with `mount: "worktree"`. Absolute. */
  worktree?: string;
  /** Provider id written into every ref. Default "docker". */
  id?: string;
  limits?: Partial<ProviderLimits>;
  /** The most vCPU one box may ask for on this host; a bigger size fails with SizeUnavailableError. Default: no cap. */
  maxVcpu?: number;
  /** The most memory one box may ask for on this host, in MiB. Default: no cap. */
  maxMemoryMiB?: number;
  /** The deadline for one `openOrCreate` or `open`, retries included. Default 120 s. */
  deadlineMs?: number;
  /** The short first-pass budget per ref when converging ghost refs (invariant 6). Default 20 s. */
  probeBudgetMs?: number;
  /** How often `attach` polls a detached process. Default 250 ms. */
  pollMs?: number;
  /**
   * How long past `timeoutMs` an exec waits for the in-box timeout before abandoning the stream and raising
   * `SandboxCommandTimeoutError { mayStillBeRunning: true }`. Default 5 s.
   */
  execGraceMs?: number;
  /** Full-jitter backoff `rand × min(capMs, baseMs × 2^n)`. Default 1 s and 8 s (spec §5.4 invariant 13). */
  backoff?: { baseMs: number; capMs: number };
  /** A Docker Engine client. Default: dockerode on `socketPath`. Tests pass an in-memory one. */
  client?: DockerClient;
}

const DEFAULT_LIMITS: ProviderLimits = {
  // Docker sessions are unbounded; the cap only gives extendLifetime and the reaper a finite horizon.
  maxLifetimeMs: 7 * 24 * 60 * 60 * 1000,
  lifetimeGuaranteed: true,
  // Pause is the cgroup freezer (memory kept), but expiry is the reaper stopping the container: filesystem only.
  expireKeeps: "filesystem",
};

/** The Docker sandbox provider (spec §5.5). */
export function docker(opts: DockerOptions = {}): SandboxProvider {
  const worktree = validateWorktree(opts.mount, opts.worktree);
  const injected = opts.client;
  return new DockerProvider({
    id: opts.id ?? "docker",
    client: injected ? () => injected : () => connectDocker(opts.socketPath),
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    ...(opts.image === undefined ? {} : { image: opts.image }),
    build: opts.build ?? false,
    ...(worktree === undefined ? {} : { worktree }),
    deadlineMs: opts.deadlineMs ?? 120_000,
    probeBudgetMs: opts.probeBudgetMs ?? 20_000,
    pollMs: opts.pollMs ?? 250,
    graceMs: opts.execGraceMs ?? 5_000,
    backoff: opts.backoff ?? { baseMs: 1_000, capMs: 8_000 },
    buildUser: hostIds(),
    sizeLimits: {
      ...(opts.maxVcpu === undefined ? {} : { maxVcpu: opts.maxVcpu }),
      ...(opts.maxMemoryMiB === undefined ? {} : { maxMemoryMiB: opts.maxMemoryMiB }),
    },
  });
}
