import { createHash, randomBytes } from "node:crypto";
import {
  type DeploymentId,
  type ProviderSandbox,
  type ResolvedImage,
  type SandboxKey,
  type SandboxProvider,
  type SandboxRef,
  type SandboxSpec,
  SELFBUILDING_LABELS,
  type SnapshotResult,
} from "@selfbuilding/core";

/** Fault kinds a provider under test can inject. Same meaning as `@selfbuilding/testing`'s `FaultKind`. */
export type ConformanceFaultKind = "503" | "network" | "timeout" | "429" | "401" | "refuse";

/**
 * Fault injection, keyed by operation name: the provider verbs (`find`, `list`, `open`, `pause`, `kill`,
 * `openOrCreate`, `snapshot`, `fork`), the handle verbs (`exec`, `spawn`, `attach`, `readFile`, `writeFiles`,
 * `extendLifetime`), `create` (the vendor create inside `openOrCreate`) and `fork.child` (one fork child).
 */
export interface ConformanceFaults {
  inject(kind: ConformanceFaultKind, op: string, opts?: { times?: number }): void;
  reset(): void;
}

export interface ConformanceOptions {
  /** Per-case timeout. Default 60 s. */
  timeoutMs?: number;
  /** The deployment id used for every box the suite creates. Default `conformance-<random>`. */
  label?: string;
  /** Skip the whole suite, printing the reason, e.g. when credentials or a daemon are absent. */
  skip?: string | false;
  /** Fault injection for the outage, 503, 429 and timeout cases. Without it those cases are skipped. */
  faults?: ConformanceFaults;
  /** Turns a live box into a ghost ref (listing row kept, box gone). Without it the ghost case is skipped. */
  ghost?: (ref: SandboxRef) => Promise<void> | void;
  /** The image every box uses. Default `selfbuilding/base:test`. */
  image?: ResolvedImage;
  /** How a box is created from a snapshot. Default: the base image with `ref` set to the snapshot id. */
  snapshotImage?: (snapshot: SnapshotResult, base: ResolvedImage) => ResolvedImage;
  /** The runtime bundles to upload and check. Without them the upload case is skipped. */
  runtime?: { runtime: string | Uint8Array; mcp: string | Uint8Array };
  /** Harness CLIs the image must provide, each checked with `--version`. */
  harnessBinaries?: string[];
  /** Initial lifetime of each box. Default 10 min. */
  lifetimeMs?: number;
  /**
   * At most this many create-path calls (`openOrCreate`, `fork`, `snapshot`) in flight at once. Live vendors
   * rate-limit creates; unset means no limit. The race case still issues all its calls; they queue here.
   */
  concurrency?: number;
}

const LIMITED_OPS = new Set<PropertyKey>(["openOrCreate", "fork", "snapshot"]);

/**
 * Wraps a provider so at most `limit` create-path calls run at once. Every other member passes through, bound to
 * the real provider, so optional operations stay detectable by `typeof`.
 */
export function limitConcurrency(provider: SandboxProvider, limit: number): SandboxProvider {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`The conformance concurrency must be a whole number of at least 1, not ${limit}.`);
  }
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return new Proxy(provider, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!LIMITED_OPS.has(key)) return value.bind(target);
      return async (...args: unknown[]) => {
        await acquire();
        try {
          return await value.apply(target, args);
        } finally {
          release();
        }
      };
    },
  });
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The spec's `sandboxName(key)`: `"ns-" + base32(sha256("runId:scope")).slice(0, 20)`, lowercase. */
export function conformanceSandboxName(key: Pick<SandboxKey, "runId" | "scope">): string {
  const bytes = createHash("sha256").update(`${key.runId}:${key.scope}`).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `ns-${out.slice(0, 20)}`;
}

export const DEFAULT_IMAGE: ResolvedImage = {
  name: "selfbuilding-base",
  ref: "selfbuilding/base:test",
  version: "0.0.0-test",
};

/** Builds keys, specs and boxes for one suite run, all scoped to one deployment and run id. */
export class Fixture {
  readonly deployment: DeploymentId;
  readonly runId = `conf-${randomBytes(4).toString("hex")}`;
  readonly image: ResolvedImage;
  readonly lifetimeMs: number;

  constructor(opts: ConformanceOptions) {
    this.deployment = opts.label ?? `conformance-${randomBytes(3).toString("hex")}`;
    this.image = opts.image ?? DEFAULT_IMAGE;
    this.lifetimeMs = opts.lifetimeMs ?? 10 * 60 * 1000;
  }

  key(scope: string): SandboxKey {
    return { runId: this.runId, scope, deployment: this.deployment };
  }

  spec(scope: string, over: Partial<SandboxSpec> = {}): SandboxSpec {
    const key = this.key(scope);
    return {
      image: this.image,
      env: {},
      lifetimeMs: this.lifetimeMs,
      onExpire: "pause",
      ...over,
      labels: {
        [SELFBUILDING_LABELS.deployment]: this.deployment,
        [SELFBUILDING_LABELS.run]: this.runId,
        [SELFBUILDING_LABELS.name]: conformanceSandboxName(key),
        ...over.labels,
      },
    };
  }

  async box(provider: SandboxProvider, scope: string, over: Partial<SandboxSpec> = {}): Promise<ProviderSandbox> {
    return (await provider.openOrCreate(this.key(scope), this.spec(scope, over))).handle;
  }

  /** Every box of this suite's deployment on one provider. */
  async boxes(provider: SandboxProvider, scope?: string): Promise<SandboxRef[]> {
    const refs: SandboxRef[] = [];
    for await (const ref of provider.list({ deployment: this.deployment, runId: this.runId })) {
      if (scope === undefined || ref.key.scope === scope) refs.push(ref);
    }
    return refs;
  }

  /** Kills this suite's boxes, except those whose scope is in `keep`. Failures are ignored: this is best effort. */
  async cleanup(provider: SandboxProvider, o: { keep?: ReadonlySet<string> } = {}): Promise<void> {
    for (const ref of await this.boxes(provider).catch(() => [] as SandboxRef[])) {
      if (o.keep?.has(ref.key.scope)) continue;
      await provider.kill(ref).catch(() => undefined);
    }
  }
}

/** Runs a shell command and returns trimmed stdout, failing loudly on a non-zero exit. */
export async function sh(
  box: ProviderSandbox,
  cmd: string,
  opts: { cwd?: string; timeoutMs?: number; user?: "agent" | "root" } = {},
) {
  const result = await box.exec(cmd, { timeoutMs: 60_000, ...opts });
  if (result.exitCode !== 0) {
    throw new Error(`\`${cmd}\` exited ${result.exitCode}: ${result.stderrTail || result.stdoutTail}`);
  }
  return result.stdoutTail.trim();
}

export const GIT =
  "git -c user.name=conformance -c user.email=conformance@selfbuilding.test -c init.defaultBranch=main";

/** Rejects unless `promise` rejects with an instance of `ctor`. Returns the error. */
export async function rejectsWith<T extends Error>(
  promise: Promise<unknown>,
  ctor: abstract new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ctor) return error;
    const name = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`Expected ${ctor.name}, got ${name}`);
  }
  throw new Error(`Expected ${ctor.name}, but the call succeeded.`);
}
