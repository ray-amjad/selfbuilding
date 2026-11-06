// The host half of the bridge: every `sb` member maps onto the real core primitive, called from the run scope the
// script issued it in, so the journal, callPaths, budget and sandbox slots behave exactly as for a TypeScript
// factory (demo-path §8.2).
import {
  type AgentCallOptions,
  type AgentResult,
  type AskSpec,
  agent,
  ask,
  commentOnPr,
  getPr,
  type Harness,
  isSelfbuildingError,
  type Json,
  log,
  now,
  PrTargetError,
  type PrUpdate,
  parallel,
  parsePrTarget,
  phase,
  pipeline,
  random,
  type SandboxHandle,
  type SandboxProvider,
  ScriptFailedError,
  ScriptInvalidError,
  ScriptLimitError,
  type Settled,
  sandbox,
  step,
  updatePr,
  uuid,
} from "@selfbuilding/core";
import { z } from "zod";
import { durationMs, type EffectiveCaps } from "./caps.js";
import {
  byteLength,
  Isolate,
  type IsolateHost,
  parseCrossing,
  scriptPosition,
  scriptStack,
  type VmErrorJson,
} from "./isolate.js";

/** What a running script can reach by name, already resolved to values. */
export interface ResolvedRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: agents of any input and output are registered by name
  agents: Record<string, Settledable & ((input: any, opts?: AgentCallOptions) => Promise<AgentResult<unknown>>)>;
  harnesses: Record<string, Harness>;
  providers: Record<string, SandboxProvider>;
}

interface Settledable {
  // biome-ignore lint/suspicious/noExplicitAny: see ResolvedRegistry.agents
  settled(input: any, opts?: AgentCallOptions): Promise<Settled<AgentResult<unknown>>>;
}

const CALL_OPTION_KEYS = new Set([
  "sandbox",
  "harness",
  "provider",
  "size",
  "label",
  "phase",
  "timeout",
  "budget",
  "effort",
  "pr",
  "repo",
  "git",
]);
const ASK_KEYS = new Set([
  "question",
  "title",
  "context",
  "choices",
  "freeText",
  "default",
  "timeout",
  "onTimeout",
  "risk",
  "dedupeKey",
]);
const EFFORTS = new Set(["low", "medium", "high", "max"]);
/**
 * The size an unsized `sb.sandbox()` gets: the provider default, which on template providers is the unsuffixed
 * `small` template and elsewhere is no bigger than it (demo-path §1). It must be allowed like any named size.
 */
const PROVIDER_DEFAULT_SIZE = "small";
const LEVELS = new Set(["debug", "info", "warn", "error"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A run suspension (a cold ask) must leave the body untouched; the engine resumes the run later. */
function isSuspension(e: unknown): boolean {
  return isRecord(e) && (e as { selfbuildingSuspension?: unknown }).selfbuildingSuspension === true;
}

function isFatal(e: unknown): boolean {
  return e instanceof ScriptInvalidError || e instanceof ScriptLimitError || isSuspension(e);
}

function resultJson(r: AgentResult<unknown>): Json {
  const a = r.artifacts;
  return JSON.parse(
    JSON.stringify({
      result: r.result,
      callPath: r.callPath,
      replayed: r.replayed,
      usage: r.usage,
      artifacts: {
        ...(a?.branch ? { branch: a.branch } : {}),
        ...(a?.pr ? { pr: a.pr } : {}),
        files: (a?.files ?? []).map((f) => ({ path: f.path, uri: f.ref.uri })),
      },
    }),
  ) as Json;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function errorJson(e: unknown): Json {
  const x = e as { name?: unknown; message?: unknown; code?: unknown };
  return {
    name: typeof x?.name === "string" ? x.name : "Error",
    message: typeof x?.message === "string" ? x.message : String(e),
    ...(typeof x?.code === "string" ? { code: x.code } : {}),
  };
}

export interface ScriptRunParams {
  source: string;
  input: Json;
  caps: EffectiveCaps;
  registry: ResolvedRegistry;
}

/** Runs one script to completion inside the current factory run. */
export async function executeScript(params: ScriptRunParams): Promise<Json> {
  const { caps } = params;
  const bytes = byteLength(params.source);
  if (bytes > caps.maxSourceBytes) {
    throw new ScriptLimitError({ limit: "source_bytes", max: `${caps.maxSourceBytes} bytes (the script is ${bytes})` });
  }
  const isolate = await Isolate.create(caps);
  const host = new ScriptHost(isolate, params);
  isolate.host = host;
  let fail: (e: unknown) => void = () => {};
  const poisoned = new Promise<never>((_, reject) => {
    fail = reject;
  });
  poisoned.catch(() => {});
  isolate.onPoison((e) => fail(e));
  const wallMs = durationMs(caps.wallClock, "wallClock");
  const timer = setTimeout(
    () => isolate.poison(new ScriptLimitError({ limit: "wall_clock", max: String(caps.wallClock) })),
    wallMs,
  );
  (timer as { unref?: () => void }).unref?.();
  try {
    const main = isolate.load(params.source);
    let text: string;
    try {
      text = await Promise.race([isolate.start(main, params.input, Object.keys(params.registry.agents)), poisoned]);
    } catch (error) {
      throw host.finalError(error);
    } finally {
      try {
        main.dispose();
      } catch {
        // The runtime may already be gone after a poisoning; the handle went with it.
      }
    }
    if (isolate.poisoned !== undefined) throw isolate.poisoned;
    const out = byteLength(text);
    if (out > caps.maxOutputBytes) {
      throw new ScriptLimitError({ limit: "output_bytes", max: `${caps.maxOutputBytes} bytes (the result is ${out})` });
    }
    return parseCrossing(text) as Json;
  } finally {
    clearTimeout(timer);
    isolate.dispose();
  }
}

class ScriptHost implements IsolateHost {
  readonly #isolate: Isolate;
  readonly #caps: EffectiveCaps;
  readonly #registry: ResolvedRegistry;
  readonly #handles = new Map<number, SandboxHandle>();
  #nextHandle = 1;
  /** Handles not yet disposed; with `#reserved` (forks in flight) they count against maxSandboxes. */
  readonly #live = new Set<number>();
  #reserved = 0;
  #prWrites = 0;
  /**
   * `<repo>#<number>` of every PR an agent result of this run carried. sb.pr reaches only these: a script (one an
   * agent launched included) must not read or write other PRs the host identity can see.
   */
  readonly #runPrs = new Set<string>();
  #agentCalls = 0;
  #spentUsd = 0;

  constructor(isolate: Isolate, params: ScriptRunParams) {
    this.#isolate = isolate;
    this.#caps = params.caps;
    this.#registry = params.registry;
  }

  /** The error the run ends on, from whatever rejected the script's main promise. */
  finalError(error: unknown): unknown {
    if (this.#isolate.poisoned !== undefined) return this.#isolate.poisoned;
    if (!isVmError(error)) return error;
    if (error.hostError !== null) {
      const original = this.#isolate.hostErrors.get(error.hostError);
      if (isSelfbuildingError(original) || isSuspension(original)) return original;
    }
    const limit = this.#isolate.limitFor(error);
    if (limit) return limit;
    return this.#scriptFailed(error);
  }

  #scriptFailed(error: VmErrorJson): ScriptFailedError {
    const pos = scriptPosition(error.stack);
    const stack = scriptStack(error.stack);
    const at = pos.line === undefined ? "" : ` (script line ${pos.line})`;
    return new ScriptFailedError({
      reason: `${error.name}: ${error.message}${at}`,
      ...(stack === undefined ? {} : { scriptStack: stack }),
    });
  }

  /** A callback's rejection as a host error: the original host error when the script rethrew one. */
  #callbackError(error: unknown): unknown {
    if (!isVmError(error)) return error;
    if (error.hostError !== null && this.#isolate.hostErrors.has(error.hostError)) {
      return this.#isolate.hostErrors.get(error.hostError);
    }
    return this.#isolate.limitFor(error) ?? this.#scriptFailed(error);
  }

  #invalid(reason: string): ScriptInvalidError {
    return new ScriptInvalidError({ reason, ...this.#isolate.position() });
  }

  /** Breaches end the run whatever the script does; the error still reaches the script at the call site. */
  #fatal(error: unknown): never {
    this.#isolate.poison(error);
    throw error;
  }

  op(name: string, args: unknown): Promise<unknown> {
    let started: Promise<unknown>;
    try {
      started = this.#startOp(name, args);
    } catch (error) {
      if (isFatal(error)) this.#isolate.poison(error);
      return Promise.reject(error);
    }
    return started.catch((error: unknown) => {
      if (isFatal(error)) this.#isolate.poison(error);
      throw error;
    });
  }

  opSync(name: string, args: unknown): unknown {
    try {
      return this.#syncOp(name, args);
    } catch (error) {
      if (isFatal(error)) this.#isolate.poison(error);
      throw error;
    }
  }

  #callback(id: unknown, what: string): (...args: unknown[]) => Promise<unknown> {
    if (typeof id !== "number") throw this.#invalid(`${what} must be a function`);
    return async (...args: unknown[]) => {
      let text: string;
      try {
        text = await this.#isolate.invoke(id, args);
      } catch (error) {
        throw this.#callbackError(error);
      }
      return parseCrossing(text);
    };
  }

  /** Everything synchronous (validation, callPath allocation, slot order) happens before the first await. */
  #startOp(name: string, args: unknown): Promise<unknown> {
    const a = isRecord(args) ? args : {};
    switch (name) {
      case "agent":
        return this.#agentCall(a);
      case "agent.inline":
        return this.#inlineAgent(a);
      case "parallel": {
        if (a.invalid === true || !Array.isArray(a.ids)) {
          throw this.#invalid("sb.parallel takes an array or a record of functions");
        }
        const thunks = a.ids.map((id, i) => this.#callback(id, `sb.parallel item ${i}`));
        if (Array.isArray(a.keys)) {
          const keys = a.keys as string[];
          return parallel(Object.fromEntries(keys.map((k, i) => [k, thunks[i] as () => Promise<unknown>])));
        }
        return parallel(thunks as (() => Promise<unknown>)[]);
      }
      case "pipeline": {
        const o = isRecord(a.opts) ? a.opts : {};
        if (o.unknown !== undefined) {
          throw this.#invalid(
            `sb.pipeline option "${String(o.unknown)}" is not supported; use label, maxInFlight or key`,
          );
        }
        if (!Array.isArray(a.items)) throw this.#invalid("sb.pipeline items must be an array");
        const stages = Array.isArray(a.stages)
          ? a.stages.map((id, i) => this.#callback(id, `sb.pipeline stage ${i}`))
          : [];
        const opts: { label?: string; maxInFlight?: number; key?: (item: unknown) => string } = {};
        if (typeof o.label === "string") opts.label = o.label;
        if (o.maxInFlight !== undefined) opts.maxInFlight = o.maxInFlight as number;
        if (typeof o.key === "number") {
          const keyId = o.key;
          opts.key = (item) => String(this.#isolate.invokeSync(keyId, [item]));
        }
        return (pipeline as unknown as (...args: unknown[]) => Promise<unknown>)(opts, a.items, ...stages);
      }
      case "step": {
        if (typeof a.name !== "string" || a.name === "") throw this.#invalid("sb.step(name, fn) needs a name");
        const fn = this.#callback(a.fn, "sb.step fn");
        return step(a.name, () => fn());
      }
      case "ask":
        return this.#ask(args);
      case "sandbox.exec": {
        const handle = this.#handle(a.hid);
        if (typeof a.cmd !== "string") throw this.#invalid("handle.exec(cmd) needs a command string");
        const o = this.#options(a.opts, ["cwd", "timeout"], "handle.exec");
        return handle.exec(a.cmd, o as { cwd?: string });
      }
      case "sandbox.fork": {
        const handle = this.#handle(a.hid);
        const n = a.n;
        if (!(typeof n === "number" && Number.isInteger(n) && n > 0))
          throw this.#invalid("handle.fork(n) needs a positive integer");
        const o = this.#options(a.opts, ["size"], "handle.fork");
        if (o.size !== undefined) this.#checkSize(o.size);
        this.#admitSandboxes(n, `handle.fork(${n})`);
        this.#reserved += n;
        const release = () => {
          this.#reserved -= n;
        };
        return handle.fork(n, o.size === undefined ? {} : { size: o.size as string }).then(
          (children) => {
            release();
            return children.map((c) => (c ? this.#register(c) : null));
          },
          (error: unknown) => {
            release();
            throw error;
          },
        );
      }
      case "sandbox.push":
        return this.#handle(a.hid).push();
      case "sandbox.dispose": {
        const hid = a.hid as number;
        const handle = this.#handle(hid);
        return handle.dispose().then(() => {
          this.#live.delete(hid);
          return null;
        });
      }
      case "pr.get":
        return getPr(this.#prTarget(a.pr, "sb.pr.get(pr)")).then(toJson);
      case "pr.comment": {
        const o = this.#prOptions(a.opts, ["pr", "body", "dedupeKey"], "sb.pr.comment");
        const target = this.#prTarget(o.pr, "sb.pr.comment({ pr })");
        if (typeof o.body !== "string") throw this.#invalid("sb.pr.comment({ pr, body }) needs the body as a string");
        if (o.dedupeKey !== undefined && (typeof o.dedupeKey !== "string" || o.dedupeKey === "")) {
          throw this.#invalid("sb.pr.comment dedupeKey must be a non-empty string");
        }
        this.#admitPrWrite();
        return commentOnPr(target, o.body, o.dedupeKey === undefined ? {} : { dedupeKey: o.dedupeKey }).then(toJson);
      }
      case "pr.update": {
        const o = this.#prOptions(a.opts, ["pr", "title", "body", "section"], "sb.pr.update");
        const target = this.#prTarget(o.pr, "sb.pr.update({ pr })");
        const patch: PrUpdate = {};
        for (const key of ["title", "body"] as const) {
          if (o[key] === undefined) continue;
          if (typeof o[key] !== "string") throw this.#invalid(`sb.pr.update ${key} must be a string`);
          patch[key] = o[key] as string;
        }
        if (o.section !== undefined) {
          const s = this.#options(o.section, ["heading", "content"], "sb.pr.update section");
          if (typeof s.heading !== "string" || typeof s.content !== "string") {
            throw this.#invalid("sb.pr.update section is { heading, content } with string values");
          }
          if (/[\r\n]/.test(s.heading) || s.heading.trim() === "") {
            throw this.#invalid("sb.pr.update section.heading is one non-empty line");
          }
          patch.section = { heading: s.heading, content: s.content };
        }
        if (patch.title === undefined && patch.body === undefined && patch.section === undefined) {
          throw this.#invalid("sb.pr.update needs a title, a body or a section");
        }
        this.#admitPrWrite();
        return updatePr(target, patch).then(toJson);
      }
      default:
        throw this.#invalid(`unknown operation "${name}"`);
    }
  }

  #syncOp(name: string, args: unknown): unknown {
    const a = isRecord(args) ? args : {};
    switch (name) {
      case "now":
        return now();
      case "random":
        return random();
      case "uuid":
        return uuid();
      case "phase":
        if (typeof a.name !== "string" || a.name === "") throw this.#invalid("sb.phase(name) needs a non-empty string");
        phase(a.name);
        return null;
      case "log": {
        const level = a.level === undefined ? "info" : a.level;
        if (typeof level !== "string" || !LEVELS.has(level)) {
          throw this.#invalid(`sb.log level must be one of ${[...LEVELS].join(", ")}`);
        }
        log(level as "info", String(a.message));
        return null;
      }
      case "sandbox.create": {
        const o = this.#options(args, ["label", "size", "provider", "repo", "baseBranch"], "sb.sandbox");
        const provider = o.provider === undefined ? undefined : this.#provider(o.provider);
        if (o.size !== undefined) this.#checkSize(o.size);
        // A provider that takes no sizes has no default size to check.
        else if (provider === undefined || provider.sizing !== undefined) {
          this.#checkSize(PROVIDER_DEFAULT_SIZE, "sb.sandbox() with no size");
        }
        this.#admitSandboxes(1, "sb.sandbox()");
        const handle = sandbox({
          ...(o.label === undefined ? {} : { label: String(o.label) }),
          ...(o.size === undefined ? {} : { size: o.size as string }),
          ...(o.repo === undefined ? {} : { repo: String(o.repo) }),
          ...(o.baseBranch === undefined ? {} : { baseBranch: String(o.baseBranch) }),
          ...(provider === undefined ? {} : { provider }),
        });
        return this.#register(handle);
      }
      case "unknown_agent":
        throw this.#invalid(
          `there is no agent named "${String(a.name)}"; registered agents: ${Object.keys(this.#registry.agents).join(", ") || "none"}`,
        );
      default:
        throw this.#invalid(`unknown operation "${name}"`);
    }
  }

  #register(handle: SandboxHandle): { $sandbox: number; id: string } {
    const hid = this.#nextHandle++;
    this.#handles.set(hid, handle);
    this.#live.add(hid);
    return { $sandbox: hid, id: handle.id };
  }

  /** Live handles, forks in flight and `n` more must fit in maxSandboxes (release-prep §7.3). */
  #admitSandboxes(n: number, what: string): void {
    const live = this.#live.size + this.#reserved;
    if (live + n > this.#caps.maxSandboxes) {
      this.#fatal(
        new ScriptLimitError({
          limit: "sandboxes",
          max: `${this.#caps.maxSandboxes} live sandboxes; ${live} are live and ${what} asks for ${n} more. Dispose a handle first`,
        }),
      );
    }
  }

  /** Counted at issue time, before any request, so a replay counts the same writes (release-prep §2.3). */
  #admitPrWrite(): void {
    this.#prWrites++;
    if (this.#prWrites > this.#caps.maxPrWrites) {
      this.#fatal(new ScriptLimitError({ limit: "pr_writes", max: `${this.#caps.maxPrWrites} PR writes` }));
    }
  }

  #prOptions(value: unknown, allowed: string[], what: string): Record<string, unknown> {
    if (!isRecord(value)) throw this.#invalid(`${what}({ pr, ... }) needs an object`);
    return this.#options(value, allowed, what);
  }

  /** A PR target the script passed, checked here so a bad one is ScriptInvalidError at the call site. */
  #prTarget(value: unknown, what: string): { repo: string; number: number } {
    const shaped =
      typeof value === "string" ||
      (isRecord(value) && (typeof value.url === "string" || (typeof value.repo === "string" && "number" in value)));
    if (!shaped) {
      throw this.#invalid(`${what} needs a PR: an agent result's artifacts.pr, its URL, or { repo, number }`);
    }
    let target: { repo: string; number: number };
    try {
      target = parsePrTarget(value as Parameters<typeof parsePrTarget>[0]);
    } catch (error) {
      if (error instanceof PrTargetError) throw this.#invalid(`${what}: ${error.message.replace(/\.$/, "")}`);
      throw error;
    }
    if (!this.#runPrs.has(`${target.repo}#${target.number}`)) {
      throw this.#invalid(
        `${what}: ${target.repo}#${target.number} is not a PR this run opened; sb.pr works only on the PRs this run's agent results carry (artifacts.pr)`,
      );
    }
    return target;
  }

  #handle(hid: unknown): SandboxHandle {
    const handle = typeof hid === "number" ? this.#handles.get(hid) : undefined;
    if (!handle) throw this.#invalid("that value is not a sandbox handle from sb.sandbox() or handle.fork()");
    return handle;
  }

  #provider(name: unknown): SandboxProvider {
    const p = typeof name === "string" ? this.#registry.providers[name] : undefined;
    if (!p) {
      throw this.#invalid(
        `there is no provider named "${String(name)}"; registered providers: ${Object.keys(this.#registry.providers).join(", ") || "none (the run's default provider is used when provider is omitted)"}`,
      );
    }
    return p;
  }

  #options(value: unknown, allowed: string[], what: string): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) throw this.#invalid(`${what} options must be an object`);
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key))
        throw this.#invalid(`${what} option "${key}" is not supported; allowed: ${allowed.join(", ")}`);
    }
    return value;
  }

  #checkSize(size: unknown, defaultedBy?: string): void {
    if (typeof size !== "string") throw this.#invalid('size must be a size name such as "small"');
    if (!this.#caps.allowedSizes.includes(size)) {
      const allowed = this.#caps.allowedSizes.join(", ") || "none";
      this.#fatal(
        new ScriptLimitError({
          limit: "size",
          max: defaultedBy
            ? `allowed sizes: ${allowed}; ${defaultedBy} defaults to "${size}". Pass { size: "${this.#caps.allowedSizes[0] ?? "small"}" } on the call, or start the run with a larger size`
            : `allowed sizes: ${allowed}; the script asked for "${size}"`,
        }),
      );
    }
  }

  /**
   * A call that names no size and gets a fresh box is sized by its contract's default (Verify: medium), which must
   * be allowed too. A handle's box was checked when it was made.
   */
  #checkDefaultSize(target: unknown, opts: AgentCallOptions, what: string): void {
    if (opts.size !== undefined) return;
    if ([...this.#handles.values()].some((h) => h === opts.sandbox)) return;
    const size = (target as { contract?: { defaults?: { size?: unknown } } }).contract?.defaults?.size;
    if (size !== undefined) this.#checkSize(size, what);
  }

  /** Maps the script's call options onto AgentCallOptions; anything else is ScriptInvalidError (demo-path §8.2). */
  #callOptions(value: unknown, what: string): AgentCallOptions {
    const o = this.#options(value, [...CALL_OPTION_KEYS], what);
    const out: AgentCallOptions = {};
    if (o.sandbox !== undefined) {
      if (o.sandbox === "fresh") out.sandbox = "fresh";
      else if (isRecord(o.sandbox) && typeof o.sandbox.$sandbox === "number")
        out.sandbox = this.#handle(o.sandbox.$sandbox);
      else throw this.#invalid(`${what} sandbox must be "fresh" or a handle from sb.sandbox() or handle.fork()`);
    }
    if (o.provider !== undefined) {
      if (out.sandbox !== undefined && out.sandbox !== "fresh") {
        throw this.#invalid(`${what} takes either a sandbox handle or a provider, not both`);
      }
      out.sandbox = this.#provider(o.provider);
    }
    if (o.harness !== undefined) {
      const h = typeof o.harness === "string" ? this.#registry.harnesses[o.harness] : undefined;
      if (!h) {
        throw this.#invalid(
          `there is no harness named "${String(o.harness)}"; registered harnesses: ${Object.keys(this.#registry.harnesses).join(", ")}`,
        );
      }
      out.harness = h;
    }
    if (o.size !== undefined) {
      this.#checkSize(o.size);
      out.size = o.size as string;
    }
    for (const key of ["label", "phase", "repo"] as const) {
      if (o[key] !== undefined) {
        if (typeof o[key] !== "string") throw this.#invalid(`${what} ${key} must be a string`);
        out[key] = o[key] as string;
      }
    }
    if (o.timeout !== undefined) {
      if (typeof o.timeout !== "string" && typeof o.timeout !== "number") {
        throw this.#invalid(`${what} timeout must be a duration such as "30m"`);
      }
      out.timeout = o.timeout as NonNullable<AgentCallOptions["timeout"]>;
    }
    if (o.effort !== undefined) {
      if (typeof o.effort !== "string" || !EFFORTS.has(o.effort)) {
        throw this.#invalid(`${what} effort must be one of ${[...EFFORTS].join(", ")}`);
      }
      out.effort = o.effort as AgentCallOptions["effort"];
    }
    if (o.budget !== undefined) {
      const b = this.#options(o.budget, ["usd"], `${what} budget`);
      if (b.usd !== undefined && !(typeof b.usd === "number" && b.usd > 0)) {
        throw this.#invalid(`${what} budget.usd must be a positive number`);
      }
      // A call never carries more than the run has left; the engine's run budget also reserves across parallel calls.
      const left = Math.max(0, this.#caps.budgetUsd - this.#spentUsd);
      out.budget = b.usd === undefined ? {} : { usd: Math.min(b.usd as number, left) };
    }
    if (o.pr !== undefined) {
      if (typeof o.pr === "boolean") out.pr = o.pr;
      else {
        const pr = this.#options(o.pr, ["draft", "base", "title", "body", "labels"], `${what} pr`);
        for (const key of ["title", "body", "base"] as const) {
          if (pr[key] !== undefined && typeof pr[key] !== "string")
            throw this.#invalid(`${what} pr.${key} must be a string`);
        }
        out.pr = pr as AgentCallOptions["pr"];
      }
    }
    if (o.git !== undefined) {
      const git = this.#options(o.git, ["branch", "baseBranch"], `${what} git`);
      for (const key of ["branch", "baseBranch"] as const) {
        if (git[key] !== undefined && typeof git[key] !== "string")
          throw this.#invalid(`${what} git.${key} must be a string`);
      }
      out.git = git as AgentCallOptions["git"];
    }
    return out;
  }

  /** Caps checked before each agent call (demo-path §8.3). */
  #admitAgentCall(): void {
    this.#agentCalls++;
    if (this.#agentCalls > this.#caps.maxAgentCalls) {
      this.#fatal(new ScriptLimitError({ limit: "agent_calls", max: `${this.#caps.maxAgentCalls} agent calls` }));
    }
    if (this.#spentUsd >= this.#caps.budgetUsd) {
      this.#fatal(new ScriptLimitError({ limit: "budget", max: `${this.#caps.budgetUsd} USD` }));
    }
  }

  #spend(usd: number | null | undefined): void {
    if (typeof usd === "number" && Number.isFinite(usd)) this.#spentUsd += usd;
    if (this.#spentUsd > this.#caps.budgetUsd) {
      this.#isolate.poison(new ScriptLimitError({ limit: "budget", max: `${this.#caps.budgetUsd} USD` }));
    }
  }

  async #agentCall(a: Record<string, unknown>): Promise<unknown> {
    const name = a.name;
    const target = typeof name === "string" ? this.#registry.agents[name] : undefined;
    if (!target) {
      throw this.#invalid(
        `there is no agent named "${String(name)}"; registered agents: ${Object.keys(this.#registry.agents).join(", ") || "none"}`,
      );
    }
    const opts = this.#callOptions(a.opts, `sb.agents.${String(name)}`);
    this.#checkDefaultSize(target, opts, `sb.agents.${String(name)}`);
    this.#admitAgentCall();
    return this.#finish(a.settled === true ? target.settled(a.input, opts) : target(a.input, opts), a.settled === true);
  }

  async #inlineAgent(a: Record<string, unknown>): Promise<unknown> {
    const spec = this.#options(a.spec, ["name", "prompt", "output", "input"], "sb.agent");
    if (typeof spec.name !== "string" || typeof spec.prompt !== "string") {
      throw this.#invalid("sb.agent({ name, prompt, output }) needs a name and a prompt string");
    }
    if (!isRecord(spec.output)) throw this.#invalid("sb.agent output must be a JSON Schema object");
    let output: z.ZodType;
    try {
      output = z.fromJSONSchema(spec.output as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (error) {
      throw this.#invalid(`sb.agent output is not a usable JSON Schema: ${(error as Error).message}`);
    }
    const opts = this.#callOptions(a.opts, "sb.agent");
    this.#admitAgentCall();
    const full = {
      name: spec.name,
      prompt: spec.prompt,
      output,
      ...(spec.input === undefined ? {} : { input: spec.input }),
      ...opts,
    };
    return this.#finish(
      a.settled === true ? agent.settled(full) : (agent(full) as Promise<AgentResult<unknown>>),
      a.settled === true,
    );
  }

  async #finish(
    call: Promise<AgentResult<unknown> | Settled<AgentResult<unknown>>>,
    settled: boolean,
  ): Promise<unknown> {
    const value = await call;
    if (!settled) {
      const r = value as AgentResult<unknown>;
      this.#spend(r.usage?.usd);
      this.#notePr(r);
      return resultJson(r);
    }
    const s = value as Settled<AgentResult<unknown>>;
    if (s.ok) {
      this.#spend(s.value.usage?.usd);
      this.#notePr(s.value);
      return { ok: true, value: resultJson(s.value) };
    }
    return { ok: false, code: s.code, error: errorJson(s.error) };
  }

  #notePr(result: AgentResult<unknown>): void {
    const pr = (result as { artifacts?: { pr?: { url?: unknown } } }).artifacts?.pr;
    if (typeof pr?.url !== "string") return;
    try {
      const t = parsePrTarget(pr.url);
      this.#runPrs.add(`${t.repo}#${t.number}`);
    } catch {
      // A PR on another host than the broker's cannot be reached through sb.pr anyway.
    }
  }

  #ask(value: unknown): Promise<unknown> {
    if (!isRecord(value)) throw this.#invalid("sb.ask({ question }) needs an object");
    for (const key of Object.keys(value)) {
      if (!ASK_KEYS.has(key)) {
        throw this.#invalid(
          key === "afk"
            ? "sb.ask has no per-ask afk; start the run with afk (start_workflow afk: true) instead"
            : `sb.ask option "${key}" is not supported; allowed: ${[...ASK_KEYS].join(", ")}`,
        );
      }
    }
    if (typeof value.question !== "string") throw this.#invalid("sb.ask needs a question string");
    return ask(value as unknown as AskSpec).then((r) => JSON.parse(JSON.stringify(r)) as Json);
  }
}

function isVmError(e: unknown): e is VmErrorJson {
  return isRecord(e) && typeof e.name === "string" && typeof e.message === "string" && "hostError" in e;
}
