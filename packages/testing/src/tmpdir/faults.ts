import { SandboxAuthError, SandboxQuotaError, SandboxUnavailableError } from "@selfbuilding/core";

/**
 * What an injected fault does:
 * - "503" and "network": the call fails before it reaches the box (an outage).
 * - "timeout": the call takes effect, then its response is lost, so the caller sees an outage with an unknown outcome.
 * - "429": a quota refusal (`SandboxQuotaError`). "401": a fleet-wide auth failure (`SandboxAuthError`).
 * - "refuse": `pause` returns a typed refusal (a plan-limit 400). Other operations treat it as "503".
 */
export type FaultKind = "503" | "network" | "timeout" | "429" | "401" | "refuse";

/** Provider operations faults can target. `create` is the vendor create inside `openOrCreate`; `fork.child` is one fork child. */
export type FaultOp =
  | "openOrCreate"
  | "create"
  | "find"
  | "list"
  | "open"
  | "pause"
  | "kill"
  | "snapshot"
  | "fork"
  | "fork.child"
  | "exec"
  | "spawn"
  | "attach"
  | "readFile"
  | "writeFiles"
  | "extendLifetime";

/** The fault-injection surface shared by `tmpdirProvider` and the conformance suite's `faults` option. */
export interface FaultController {
  /** Arms a fault for the next `times` calls of `op` (default 1). */
  inject(kind: FaultKind, op: FaultOp | (string & {}), opts?: { times?: number }): void;
  /** Disarms every pending fault. */
  reset(): void;
  /** Faults still armed, for assertions. */
  pending(): ReadonlyArray<{ kind: FaultKind; op: string; times: number }>;
}

interface Armed {
  kind: FaultKind;
  op: string;
  times: number;
}

/** A fault that fires after the operation took effect. */
export interface LostResponse {
  readonly lost: true;
  raise(): never;
}

export class Faults implements FaultController {
  readonly #armed: Armed[] = [];
  readonly #provider: string;

  constructor(provider: string) {
    this.#provider = provider;
  }

  inject(kind: FaultKind, op: string, opts: { times?: number } = {}): void {
    this.#armed.push({ kind, op, times: opts.times ?? 1 });
  }

  reset(): void {
    this.#armed.length = 0;
  }

  pending(): ReadonlyArray<{ kind: FaultKind; op: string; times: number }> {
    return this.#armed.map((a) => ({ ...a }));
  }

  /** Consumes a matching fault. Throws for faults that fire before the call; returns a token for lost responses. */
  check(op: string, sandboxId?: string): LostResponse | undefined {
    const outcome = this.checkPause(op, sandboxId);
    return outcome === "refuse" ? undefined : outcome;
  }

  /** As `check`, but a "refuse" fault on `pause` is returned instead of thrown. */
  checkPause(op: string, sandboxId?: string): LostResponse | "refuse" | undefined {
    const index = this.#armed.findIndex((a) => a.op === op);
    if (index < 0) return undefined;
    const armed = this.#armed[index] as Armed;
    armed.times -= 1;
    if (armed.times <= 0) this.#armed.splice(index, 1);
    const ctx = { provider: this.#provider, ...(sandboxId === undefined ? {} : { sandboxId }) };
    switch (armed.kind) {
      case "timeout":
        return {
          lost: true,
          raise: () => {
            throw new SandboxUnavailableError(ctx, { cause: { injected: "timeout", op } });
          },
        };
      case "refuse":
        if (op === "pause") return "refuse";
        throw new SandboxUnavailableError(ctx, { cause: { injected: "503", status: 503, op } });
      case "429":
        throw new SandboxQuotaError({ ...ctx, retryAfterMs: 20 }, { cause: { injected: "429", status: 429, op } });
      case "401":
        throw new SandboxAuthError(ctx, { cause: { injected: "401", status: 401, op } });
      case "network":
        throw new SandboxUnavailableError(ctx, { cause: { injected: "network", code: "ECONNRESET", op } });
      default:
        throw new SandboxUnavailableError(ctx, { cause: { injected: "503", status: 503, op } });
    }
  }
}
