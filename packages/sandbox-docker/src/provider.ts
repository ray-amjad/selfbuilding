import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  ConfigError,
  type DeploymentId,
  EgressPolicyUnsupportedError,
  ImageUnavailableError,
  type PauseOutcome,
  type ProviderLimits,
  type ProviderSandbox,
  type ProviderSizing,
  type ResolvedSize,
  SANDBOX_PATHS,
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
  type SizeLimits,
  SizeUnavailableError,
  type SnapshotResult,
} from "@selfbuilding/core";
import { dockerImageRef, type ImageDefinition, officialImageFor, toDockerfile } from "@selfbuilding/images";
import type {
  DockerClient,
  DockerContainer,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerCreateOptions,
} from "./client.js";
import { classify, daemonMessage, type ErrorContext, isPermanent, statusOf } from "./errors.js";
import {
  containerLabels,
  containerName,
  looksSecret,
  normaliseState,
  PRIVATE,
  publicLabels,
  STATE_RANK,
} from "./labels.js";
import { DockerSandbox, LEASE_PATH, runExec, type SandboxHost } from "./sandbox.js";
import { collect, progressError } from "./stream.js";
import { packTar, unpackTar } from "./tar.js";

export interface DockerProviderConfig {
  id: string;
  client: () => DockerClient;
  limits: ProviderLimits;
  image?: string;
  build: boolean;
  worktree?: string;
  deadlineMs: number;
  probeBudgetMs: number;
  pollMs: number;
  graceMs: number;
  backoff: { baseMs: number; capMs: number };
  buildUser: { uid: number; gid: number };
  /** The host's ceiling per box, from docker({ maxVcpu, maxMemoryMiB }). */
  sizeLimits: SizeLimits;
}

/** Docker sizes at create, and a fork boots new containers from a commit, so children may take another size. */
export function dockerSizing(limits: SizeLimits): ProviderSizing {
  return Object.freeze({
    kind: "create",
    forkSize: "override",
    resize: false,
    limits: Object.freeze({ overLimitFix: dockerOverLimitFix(limits), ...limits }),
  });
}

function dockerOverLimitFix(limits: SizeLimits): string {
  const parts: string[] = [];
  if (limits.maxVcpu !== undefined) parts.push(`${limits.maxVcpu} vCPU`);
  if (limits.maxMemoryMiB !== undefined) parts.push(`${limits.maxMemoryMiB / 1024} GiB`);
  const cap = parts.length > 0 ? ` is ${parts.join(" and ")}` : "";
  return `Docker host limit set in docker({ maxVcpu, maxMemoryMiB })${cap}. Raise it there, or use a smaller size.`;
}

/** The machine a spec asks for: the named size, else bare `resources`. */
function requestedSize(spec: { size?: ResolvedSize; resources?: { vcpu: number; memoryMiB: number } }) {
  return spec.size ?? (spec.resources ? { name: "custom", ...spec.resources } : undefined);
}

/** Images made by `snapshot` and `fork`; a spec whose image ref starts with this restores from one. */
export const SNAPSHOT_REPO = "selfbuilding-snapshot";

/** Directories every box has. The agent owns the ones it writes to; the spawn shim writes logs as the agent. */
const ROOT_DIRS = [
  SANDBOX_PATHS.bin,
  SANDBOX_PATHS.skills,
  path.posix.dirname(SANDBOX_PATHS.contract),
  SANDBOX_PATHS.in,
  SANDBOX_PATHS.launches,
  SANDBOX_PATHS.calls,
  SANDBOX_PATHS.logs,
  SANDBOX_PATHS.secrets,
];
const AGENT_DIRS = [SANDBOX_PATHS.workdir, SANDBOX_PATHS.home, SANDBOX_PATHS.out, SANDBOX_PATHS.proc];

/** The readiness probe of invariant 3. It doubles as the idempotent layout step, so a box whose create response was lost is completed on first open. */
const LAYOUT_SCRIPT = [
  "set -e",
  `mkdir -p ${[...ROOT_DIRS, ...AGENT_DIRS].join(" ")}`,
  `if id agent >/dev/null 2>&1; then chown agent:agent ${AGENT_DIRS.join(" ")}; fi`,
  "chmod 1777 /tmp",
  `if [ -n "$1" ]; then printf '%s' "$1" > "$2.tmp" && mv "$2.tmp" "$2"; fi`,
].join("\n");

/** What `#create` needs, from a spec (openOrCreate) or from the parent container (fork). */
interface CreatePlan {
  image: string;
  env: string[];
  lifetimeMs: number;
  onExpire: string;
  labels: Record<string, string>;
  networkMode?: string;
  nanoCpus?: number;
  memory?: number;
  ports: number[];
}

/** createContainer hit an existing name: another creator won the race for this key. */
class NameTaken extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoOrUndefined(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export class DockerProvider implements SandboxProvider, SandboxHost {
  readonly id: string;
  readonly stability = "experimental" as const;
  readonly limits: ProviderLimits;
  readonly sizing: ProviderSizing;
  readonly pollMs: number;
  readonly graceMs: number;
  readonly #config: DockerProviderConfig;
  #client: DockerClient | undefined;
  readonly #images = new Map<string, Promise<void>>();
  /** Snapshot commits in flight, by container id. */
  readonly #commits = new Map<string, Promise<void>>();

  constructor(config: DockerProviderConfig) {
    this.#config = config;
    this.id = config.id;
    this.limits = config.limits;
    this.sizing = dockerSizing(config.sizeLimits);
    this.pollMs = config.pollMs;
    this.graceMs = config.graceMs;
  }

  get maxLifetimeMs(): number {
    return this.limits.maxLifetimeMs;
  }

  get #docker(): DockerClient {
    this.#client ??= this.#config.client();
    return this.#client;
  }

  container(id: string): DockerContainer {
    return this.#docker.getContainer(id);
  }

  committing(id: string): Promise<void> | undefined {
    return this.#commits.get(id);
  }

  ctx(sandboxId?: string): ErrorContext {
    return sandboxId === undefined ? { provider: this.id } : { provider: this.id, sandboxId };
  }

  #backoff(attempt: number): number {
    const { baseMs, capMs } = this.#config.backoff;
    return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
  }

  // ---- reading the daemon ---------------------------------------------------------------------------------------

  async #inspect(id: string): Promise<DockerContainerInspect> {
    try {
      return await this.container(id).inspect();
    } catch (error) {
      throw classify(error, this.ctx(id));
    }
  }

  async #summaries(labels: string[]): Promise<DockerContainerSummary[]> {
    try {
      return await this.#docker.listContainers({ all: true, filters: JSON.stringify({ label: labels }) });
    } catch (error) {
      throw classify(error, this.ctx());
    }
  }

  /** Every container for a key, best first: the one holding the key's name, then running, then oldest. */
  async #rows(key: SandboxKey): Promise<DockerContainerSummary[]> {
    const rows = await this.#summaries([
      `${SELFBUILDING_LABELS.deployment}=${key.deployment}`,
      `${SELFBUILDING_LABELS.run}=${key.runId}`,
      `${PRIVATE.scope}=${key.scope}`,
    ]);
    const holds = (row: DockerContainerSummary) => (row.Names[0] === `/${containerName(row.Labels ?? {})}` ? 0 : 1);
    return rows
      .filter((row) => {
        const labels = row.Labels ?? {};
        return (
          labels[SELFBUILDING_LABELS.deployment] === key.deployment &&
          labels[SELFBUILDING_LABELS.run] === key.runId &&
          labels[PRIVATE.scope] === key.scope
        );
      })
      .sort(
        (a, b) =>
          holds(a) - holds(b) ||
          STATE_RANK[normaliseState(a.State)] - STATE_RANK[normaliseState(b.State)] ||
          this.#createdAt(a).localeCompare(this.#createdAt(b)) ||
          a.Id.localeCompare(b.Id),
      );
  }

  #createdAt(row: DockerContainerSummary): string {
    return isoOrUndefined(row.Labels?.[PRIVATE.createdAt]) ?? new Date(row.Created * 1000).toISOString();
  }

  /** The extended lifetime, if `extendLifetime` or `open` wrote one. Reading an archive never wakes a paused box. */
  async #lease(id: string): Promise<string | undefined> {
    try {
      const [entry] = unpackTar(await collect(await this.container(id).getArchive({ path: LEASE_PATH })));
      return entry?.type === "file" ? isoOrUndefined(entry.data.toString("utf8").trim()) : undefined;
    } catch {
      return undefined;
    }
  }

  async #toRef(row: DockerContainerSummary): Promise<SandboxRef> {
    const labels = publicLabels(row.Labels);
    const lease = await this.#lease(row.Id);
    if (lease) labels[SELFBUILDING_LABELS.expiresAt] = lease;
    const all = row.Labels ?? {};
    const deployment = all[SELFBUILDING_LABELS.deployment] ?? "";
    return {
      provider: this.id,
      id: row.Id,
      name: all[SELFBUILDING_LABELS.name] ?? "",
      key: { runId: all[SELFBUILDING_LABELS.run] ?? "", scope: all[PRIVATE.scope] ?? "", deployment },
      deployment,
      state: normaliseState(row.State),
      createdAt: this.#createdAt(row),
      labels,
      meta: { container: (row.Names[0] ?? "").replace(/^\//, ""), onExpire: all[PRIVATE.onExpire] ?? "pause" },
      ...(labels[SELFBUILDING_LABELS.size] ? { size: labels[SELFBUILDING_LABELS.size] } : {}),
    };
  }

  #summaryOf(info: DockerContainerInspect): DockerContainerSummary {
    return {
      Id: info.Id,
      Names: [info.Name],
      State: info.State.Paused ? "paused" : info.State.Status,
      Created: Math.floor(Date.parse(info.Created) / 1000),
      Labels: info.Config.Labels ?? {},
    };
  }

  // ---- provider verbs ---------------------------------------------------------------------------------------------

  async find(key: SandboxKey): Promise<SandboxRef | null> {
    const [first] = await this.#rows(key);
    return first ? this.#toRef(first) : null;
  }

  list(filter: { deployment: DeploymentId; runId?: string; states?: SandboxState[] }): AsyncIterable<SandboxRef> {
    const self = this;
    return (async function* () {
      const query = [`${SELFBUILDING_LABELS.deployment}=${filter.deployment}`];
      if (filter.runId !== undefined) query.push(`${SELFBUILDING_LABELS.run}=${filter.runId}`);
      const rows = (await self.#summaries(query))
        .filter((row) => row.Labels?.[SELFBUILDING_LABELS.deployment] === filter.deployment)
        .filter((row) => filter.runId === undefined || row.Labels?.[SELFBUILDING_LABELS.run] === filter.runId)
        .filter((row) => filter.states === undefined || filter.states.includes(normaliseState(row.State)))
        .sort((a, b) => self.#createdAt(a).localeCompare(self.#createdAt(b)) || a.Id.localeCompare(b.Id));
      for (const row of rows) yield await self.#toRef(row);
    })();
  }

  async open(ref: SandboxRef, o: { lifetimeMs: number; signal?: AbortSignal }): Promise<ProviderSandbox> {
    return (await this.#open(ref.id, o.lifetimeMs, this.#config.deadlineMs, o.signal)).handle;
  }

  /** Resumes, starts or waits for a container, then probes it until the guest answers (invariant 3). */
  async #open(
    id: string,
    lifetimeMs: number,
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<{ handle: DockerSandbox; definitive: boolean }> {
    const deadline = Date.now() + budgetMs;
    const container = this.container(id);
    let info = await this.#inspect(id);
    if (info.State.Dead || info.State.Status === "dead" || info.State.Status === "removing") {
      throw Object.assign(new SandboxGuestGoneError(this.ctx(id)), { definitive: true });
    }
    try {
      if (info.State.Paused) await container.unpause();
      else if (!info.State.Running && !info.State.Restarting) {
        // A stopped box (reaper expiry, daemon restart) comes back with its filesystem only; spawned processes are gone.
        await container.start();
      }
    } catch (error) {
      // 304 (already started) and 409/500 races with a concurrent opener are settled by the probe below.
      const status = statusOf(error);
      if (status === 404) throw classify(error, this.ctx(id));
      if (status !== 304 && status !== 409 && status !== 500) throw classify(error, this.ctx(id));
    }
    const lease = await this.#lease(id);
    const labels = info.Config.Labels ?? {};
    const createdAt = isoOrUndefined(labels[PRIVATE.createdAt]) ?? info.Created;
    const current = Date.parse(lease ?? labels[SELFBUILDING_LABELS.expiresAt] ?? "") || 0;
    const max = Date.parse(createdAt) + this.limits.maxLifetimeMs;
    const expiresAt = new Date(Math.min(Math.max(current, Date.now() + lifetimeMs), max)).toISOString();
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const probe = await runExec(container, {
          cmd: ["/bin/sh", "-c", LAYOUT_SCRIPT, "sb-layout", expiresAt, LEASE_PATH],
          user: "root",
          cwd: "/",
          timeoutMs: Math.max(1_000, Math.min(10_000, deadline - Date.now())),
          graceMs: this.graceMs,
        });
        if (!probe.abandoned && probe.exitCode === 0) break;
      } catch (error) {
        const classified = classify(error, this.ctx(id));
        if (classified instanceof SandboxNotFoundError || isPermanent(classified)) throw classified;
      }
      if (Date.now() >= deadline) throw Object.assign(new SandboxGuestGoneError(this.ctx(id)), { definitive: false });
      await sleep(Math.min(this.#backoff(attempt), Math.max(0, deadline - Date.now())));
    }
    info = await this.#inspect(id);
    const ref = await this.#toRef(this.#summaryOf(info));
    ref.labels[SELFBUILDING_LABELS.expiresAt] = expiresAt;
    return { handle: new DockerSandbox(this, ref), definitive: false };
  }

  /** Defence in depth: the core checks sizes first, but a size over the host limit is never created smaller. */
  #checkSize(size: ResolvedSize | undefined): void {
    if (!size) return;
    const { maxVcpu, maxMemoryMiB, overLimitFix } = this.sizing.limits;
    if (
      (maxVcpu !== undefined && size.vcpu > maxVcpu) ||
      (maxMemoryMiB !== undefined && size.memoryMiB > maxMemoryMiB)
    ) {
      throw new SizeUnavailableError({
        provider: this.id,
        size: size.name,
        vcpu: size.vcpu,
        memoryMiB: size.memoryMiB,
        reason: "over-limit",
        fix: overLimitFix ?? "Docker host limit set in docker({ maxVcpu, maxMemoryMiB }).",
      });
    }
  }

  #validate(spec: SandboxSpec): void {
    this.#checkSize(requestedSize(spec));
    for (const name of Object.keys(spec.env)) {
      if (looksSecret(name)) throw new SecretInEnvError({ variable: name });
    }
    if (spec.network !== undefined && spec.network !== "open" && spec.network !== "deny-all") {
      throw new EgressPolicyUnsupportedError({
        provider: this.id,
        requested: "allowlist",
        supported: ["open", "deny-all"],
      });
    }
  }

  #imageFor(spec: SandboxSpec): string {
    const ref = spec.image.ref;
    return this.#config.image && !ref.startsWith(`${SNAPSHOT_REPO}:`) ? this.#config.image : ref;
  }

  async openOrCreate(
    key: SandboxKey,
    spec: SandboxSpec,
    o?: { signal?: AbortSignal },
  ): Promise<{ handle: ProviderSandbox; created: boolean; rebuilt: boolean }> {
    this.#validate(spec);
    const image = this.#imageFor(spec);
    await this.#ensureImage(image);
    const machine = requestedSize(spec);
    const plan: CreatePlan = {
      image,
      env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      lifetimeMs: spec.lifetimeMs,
      onExpire: spec.onExpire,
      labels: spec.size ? { ...spec.labels, [SELFBUILDING_LABELS.size]: spec.size.name } : spec.labels,
      ...(spec.network === "deny-all" ? { networkMode: "none" } : {}),
      ...(machine ? machineLimits(machine) : {}),
      ports: spec.ports ?? [],
    };
    const deadline = Date.now() + this.#config.deadlineMs;
    let sawGhost = false;
    for (let attempt = 0; ; attempt++) {
      o?.signal?.throwIfAborted();
      try {
        const rows = await this.#rows(key);
        const ghosts: DockerContainerSummary[] = [];
        // Invariant 6: every ref for the key is tried in rank order, first on a short budget, then on the full one.
        for (const pass of [0, 1]) {
          const candidates = pass === 0 ? rows : ghosts.splice(0);
          for (const row of candidates) {
            const remaining = deadline - Date.now();
            const budget = pass === 0 ? Math.min(this.#config.probeBudgetMs, remaining) : remaining;
            try {
              const { handle } = await this.#open(row.Id, spec.lifetimeMs, Math.max(budget, 0), o?.signal);
              return { handle, created: false, rebuilt: false };
            } catch (error) {
              if (error instanceof SandboxNotFoundError) {
                sawGhost = true;
                continue;
              }
              if (error instanceof SandboxGuestGoneError) {
                sawGhost = true;
                if (pass === 0 && !(error as { definitive?: boolean }).definitive) ghosts.push(row);
                await this.#releaseName(row, pass === 1 || (error as { definitive?: boolean }).definitive === true);
                continue;
              }
              throw error;
            }
          }
        }
        const handle = await this.#create(key, plan);
        return { handle, created: true, rebuilt: sawGhost };
      } catch (error) {
        if (error instanceof NameTaken) {
          await sleep(this.#backoff(0) / 10);
          continue;
        }
        const retryable =
          (error instanceof SandboxUnavailableError &&
            !(error instanceof SandboxGuestGoneError) &&
            !isPermanent(error)) ||
          error instanceof SandboxQuotaError;
        if (!retryable || Date.now() >= deadline) throw error;
        const wait = error instanceof SandboxQuotaError ? (error.retryAfterMs ?? 0) : 0;
        await sleep(Math.min(Math.max(wait, this.#backoff(attempt)), Math.max(0, deadline - Date.now())));
      }
    }
  }

  /**
   * Frees the key's container name held by a ghost, so the rebuild can take it. The ghost is renamed, never removed:
   * a silent guest is not positive evidence that the box is gone (invariant 5). The reaper collects it later.
   */
  async #releaseName(row: DockerContainerSummary, now: boolean): Promise<void> {
    if (!now || row.Names[0] !== `/${containerName(row.Labels ?? {})}`) return;
    try {
      await this.container(row.Id).rename({ name: `${containerName(row.Labels ?? {})}.ghost-${row.Id.slice(0, 12)}` });
    } catch (error) {
      if (statusOf(error) !== 404) throw classify(error, this.ctx(row.Id));
    }
  }

  async #create(key: SandboxKey, plan: CreatePlan): Promise<DockerSandbox> {
    const now = Date.now();
    const lifetime = Math.min(plan.lifetimeMs, this.limits.maxLifetimeMs);
    const labels = containerLabels(key, plan.labels, {
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + lifetime).toISOString(),
      onExpire: plan.onExpire,
    });
    const options: DockerCreateOptions = {
      name: containerName(labels),
      Image: plan.image,
      // The box idles until the core execs into it; tini (Init) reaps the shim's orphans.
      Entrypoint: ["sleep"],
      Cmd: ["infinity"],
      Labels: labels,
      Env: plan.env,
      WorkingDir: SANDBOX_PATHS.workdir,
      User: "root",
      Tty: false,
      HostConfig: {
        Init: true,
        RestartPolicy: { Name: "no" },
        // Volumes, not tmpfs: the archive API cannot write into tmpfs, and volumes stay out of snapshot commits,
        // which keeps the secrets under /run/selfbuilding out of every snapshot image.
        Mounts: [
          { Type: "volume", Target: SANDBOX_PATHS.run },
          { Type: "volume", Target: "/tmp" },
        ],
        ...(plan.networkMode ? { NetworkMode: plan.networkMode } : {}),
        ...(plan.nanoCpus ? { NanoCpus: plan.nanoCpus } : {}),
        ...(plan.memory ? { Memory: plan.memory } : {}),
        ...(this.#config.worktree ? { Binds: this.#worktreeBinds(this.#config.worktree) } : {}),
      },
    };
    if (plan.ports.length > 0) {
      options.ExposedPorts = Object.fromEntries(plan.ports.map((p) => [`${p}/tcp`, {}]));
      options.HostConfig.PortBindings = Object.fromEntries(
        plan.ports.map((p) => [`${p}/tcp`, [{ HostIp: "127.0.0.1", HostPort: "" }]]),
      );
    }
    let container: DockerContainer;
    try {
      container = await this.#docker.createContainer(options);
    } catch (error) {
      if (statusOf(error) === 409) throw new NameTaken(daemonMessage(error));
      if (statusOf(error) === 404) {
        throw new ImageUnavailableError(`Image ${plan.image} is not available to the Docker daemon.`, { cause: error });
      }
      throw classify(error, this.ctx());
    }
    // Invariant 9: anything failing between "the daemon issued an id" and "handle returned" removes the box.
    try {
      try {
        await container.start();
      } catch (error) {
        if (statusOf(error) !== 304) throw classify(error, this.ctx(container.id));
      }
      return (await this.#open(container.id, plan.lifetimeMs, this.#config.deadlineMs)).handle;
    } catch (error) {
      await container.remove({ force: true, v: true }).catch(() => undefined);
      throw error instanceof SandboxGuestGoneError
        ? new SandboxUnavailableError(this.ctx(container.id), {
            cause: error,
            message: `A new box never answered its readiness probe and was removed. Check that ${plan.image} has /bin/sh.`,
          })
        : error;
    }
  }

  /** `.git/config`, hooks and info are read-only, so an agent cannot plant code that later runs on the host. */
  #worktreeBinds(worktree: string): string[] {
    const binds = [`${worktree}:${SANDBOX_PATHS.workdir}`];
    for (const part of ["config", "hooks", "info"]) {
      const source = path.join(worktree, ".git", part);
      if (existsSync(source)) binds.push(`${source}:${SANDBOX_PATHS.workdir}/.git/${part}:ro`);
    }
    return binds;
  }

  async pause(ref: SandboxRef): Promise<PauseOutcome> {
    const gone = (status = 404): PauseOutcome => ({
      confirmed: false,
      reason: "gone",
      status,
      message: `Sandbox ${ref.id} does not exist.`,
    });
    const settled = async (): Promise<PauseOutcome | undefined> => {
      let info: DockerContainerInspect;
      try {
        info = await this.container(ref.id).inspect();
      } catch (error) {
        if (statusOf(error) === 404) return gone();
        throw classify(error, this.ctx(ref.id));
      }
      if (info.State.Paused) return { confirmed: true, kept: "memory" };
      // A stopped container is already parked; only its filesystem survives.
      if (!info.State.Running && !info.State.Restarting) return { confirmed: true, kept: "filesystem" };
      return undefined;
    };
    const before = await settled();
    if (before) return before;
    try {
      await this.container(ref.id).pause();
    } catch (error) {
      const status = statusOf(error);
      if (status === 404) return gone();
      if (status === 401 || status === 402 || status === 403 || status === 429) throw classify(error, this.ctx(ref.id));
      if (status !== undefined && status >= 400 && status < 500 && status !== 409) {
        return { confirmed: false, reason: "refused", status, message: daemonMessage(error) };
      }
      if (status !== 409) throw classify(error, this.ctx(ref.id));
    }
    // Invariant 4: confirmed only once the daemon reports the terminal state.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const outcome = await settled();
      if (outcome) return outcome;
      if (Date.now() >= deadline) {
        throw new SandboxUnavailableError(this.ctx(ref.id), {
          message: `Sandbox ${ref.id} did not report paused within 10 s; the outcome is unknown.`,
        });
      }
      await sleep(100);
    }
  }

  async kill(ref: SandboxRef): Promise<{ path: "killed" | "already-gone" }> {
    try {
      await this.container(ref.id).remove({ force: true, v: true });
      return { path: "killed" };
    } catch (error) {
      if (statusOf(error) === 404) return { path: "already-gone" };
      throw classify(error, this.ctx(ref.id));
    }
  }

  async snapshot(ref: SandboxRef, o?: { name?: string }): Promise<SnapshotResult> {
    this.#refuseWithWorktree("snapshot", ref.id);
    const info = await this.#inspect(ref.id);
    const sourceState = info.State.Paused ? "paused" : info.State.Running ? "running" : "stopped";
    const slug = (o?.name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const tag = `${slug ? `${slug}-` : ""}${randomBytes(6).toString("hex")}`;
    // The commit freezes the box for the copy; volumes (/run/selfbuilding, /tmp) are not part of it. Handles wait
    // for it rather than fail on that freeze (see DockerSandbox.#run).
    const commit = this.container(ref.id).commit({
      repo: SNAPSHOT_REPO,
      tag,
      pause: true,
      comment: `selfbuilding snapshot of ${ref.id}`,
    });
    const settled = commit.then(
      () => undefined,
      () => undefined,
    );
    const others = this.#commits.get(ref.id);
    const all = others ? Promise.all([others, settled]).then(() => undefined) : settled;
    this.#commits.set(ref.id, all);
    try {
      await commit;
    } catch (error) {
      throw classify(error, this.ctx(ref.id));
    } finally {
      if (this.#commits.get(ref.id) === all) this.#commits.delete(ref.id);
    }
    return { snapshotId: `${SNAPSHOT_REPO}:${tag}`, fidelity: "filesystem", sourceState };
  }

  /**
   * Docker has no native fork, so the adapter commits the quiesced parent once and boots each child from it. A
   * child is keyed by the core's own key for it, so a replayed fork adopts the child it made before instead of
   * colliding with its name.
   */
  async fork(
    ref: SandboxRef,
    o: {
      children: { name: string; labels: Record<string, string>; key?: SandboxKey }[];
      lifetimeMs: number;
      size?: ResolvedSize;
    },
  ): Promise<Array<ProviderSandbox | SandboxError>> {
    this.#refuseWithWorktree("fork", ref.id);
    this.#checkSize(o.size);
    const info = await this.#inspect(ref.id);
    const parent = info.Config.Labels ?? {};
    const key: SandboxKey = {
      runId: parent[SELFBUILDING_LABELS.run] ?? ref.key.runId,
      scope: parent[PRIVATE.scope] ?? ref.key.scope,
      deployment: parent[SELFBUILDING_LABELS.deployment] ?? ref.deployment,
    };
    // The spec's fork-child scope form, when the core did not pass its own key.
    const childKey = (index: number): SandboxKey =>
      o.children[index]?.key ?? { ...key, scope: `${key.scope}/fork[${index}]` };
    const adopt = async (index: number): Promise<ProviderSandbox | null> => {
      const found = await this.find(childKey(index)).catch(() => null);
      if (!found || found.state === "stopped" || found.state === "error") return null;
      return this.open(found, { lifetimeMs: o.lifetimeMs });
    };
    const adopted = await Promise.all(o.children.map((_, index) => adopt(index).catch(() => null)));
    if (adopted.every((c) => c !== null)) return adopted as ProviderSandbox[];
    const snap = await this.snapshot(ref, { name: "fork" });
    const bindings = info.HostConfig?.PortBindings;
    const ports =
      bindings && typeof bindings === "object"
        ? Object.keys(bindings)
            .map((p) => Number.parseInt(p, 10))
            .filter(Number.isInteger)
        : [];
    return Promise.all(
      o.children.map(async (child, index): Promise<ProviderSandbox | SandboxError> => {
        const ready = adopted[index];
        if (ready) return ready;
        try {
          return await this.#create(childKey(index), {
            image: snap.snapshotId,
            env: info.Config.Env ?? [],
            lifetimeMs: o.lifetimeMs,
            onExpire: parent[PRIVATE.onExpire] ?? "pause",
            labels: {
              ...child.labels,
              [SELFBUILDING_LABELS.name]: child.name,
              [SELFBUILDING_LABELS.run]: child.labels[SELFBUILDING_LABELS.run] || key.runId,
              [SELFBUILDING_LABELS.parent]: ref.id,
              // Children keep the parent's size unless the fork asked for another one.
              [SELFBUILDING_LABELS.size]: o.size?.name ?? parent[SELFBUILDING_LABELS.size] ?? "",
            },
            ...(info.HostConfig?.NetworkMode === "none" ? { networkMode: "none" } : {}),
            ...(o.size
              ? machineLimits(o.size)
              : {
                  ...(info.HostConfig?.NanoCpus ? { nanoCpus: info.HostConfig.NanoCpus } : {}),
                  ...(info.HostConfig?.Memory ? { memory: info.HostConfig.Memory } : {}),
                }),
            ports,
          });
        } catch (error) {
          if (error instanceof NameTaken) {
            const raced = await adopt(index).catch(() => null);
            if (raced) return raced;
            return new SandboxUnavailableError(this.ctx(ref.id), {
              message: `A box named ${child.name} already exists and could not be opened as this fork's child.`,
            });
          }
          return classify(error, this.ctx(ref.id));
        }
      }),
    );
  }

  #refuseWithWorktree(op: string, id: string): void {
    if (this.#config.worktree) {
      throw new SandboxUnsupportedError(
        { ...this.ctx(id), op },
        { message: `${op} cannot capture a bind-mounted worktree. Use mount: "isolated", or a git checkpoint.` },
      );
    }
  }

  // ---- images -----------------------------------------------------------------------------------------------------

  /** Makes sure the daemon has the image: present, built from the official definition (`build: true`), or pulled. */
  async #ensureImage(ref: string): Promise<void> {
    let pending = this.#images.get(ref);
    if (!pending) {
      pending = this.#loadImage(ref);
      this.#images.set(ref, pending);
      pending.catch(() => this.#images.delete(ref));
    }
    await pending;
  }

  async #loadImage(ref: string): Promise<void> {
    try {
      await this.#docker.getImage(ref).inspect();
      return;
    } catch (error) {
      if (statusOf(error) !== 404) throw classify(error, this.ctx());
    }
    const official = officialImageFor(ref);
    if (this.#config.build && official) return this.#buildImage(official.def, official.tag);
    if (ref.startsWith(`${SNAPSHOT_REPO}:`)) {
      throw new ImageUnavailableError(`Snapshot ${ref} is not on this Docker daemon. Snapshots are local to a daemon.`);
    }
    let failure: string | undefined;
    try {
      failure = await progressError(await this.#docker.pull(ref));
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 403 || status === 401) failure = daemonMessage(error);
      else throw classify(error, this.ctx());
    }
    if (failure !== undefined) {
      throw new ImageUnavailableError(
        `Could not pull ${ref}: ${failure}. Pass build: true to build the official images locally, or check the name.`,
      );
    }
  }

  async #buildImage(def: ImageDefinition, tag: string): Promise<void> {
    const ref = dockerImageRef(def, tag);
    const buildargs: Record<string, string> = {
      AGENT_UID: String(this.#config.buildUser.uid),
      AGENT_GID: String(this.#config.buildUser.gid),
    };
    if (!("base" in def.from)) {
      await this.#ensureImage(dockerImageRef(def.from, tag));
      buildargs.BASE_IMAGE = dockerImageRef(def.from, tag);
    }
    const context = packTar([{ name: "Dockerfile", data: Buffer.from(toDockerfile(def, { version: tag })) }]);
    let failure: string | undefined;
    try {
      failure = await progressError(await this.#docker.buildImage(context, { t: ref, buildargs }));
    } catch (error) {
      throw classify(error, this.ctx());
    }
    if (failure !== undefined) throw new ImageUnavailableError(`Building ${ref} failed: ${failure}`);
  }
}

function machineLimits(size: { vcpu: number; memoryMiB: number }): { nanoCpus: number; memory: number } {
  return { nanoCpus: Math.round(size.vcpu * 1e9), memory: size.memoryMiB * 1024 * 1024 };
}

export function validateWorktree(mount: string | undefined, worktree: string | undefined): string | undefined {
  if (mount !== "worktree") return undefined;
  if (!worktree || !path.isAbsolute(worktree)) {
    throw new ConfigError('docker({ mount: "worktree" }) needs worktree: an absolute path to the host worktree.');
  }
  return worktree;
}
