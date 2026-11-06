// One QuickJS runtime per script run (demo-path §8.1). The sync WASM variant is used with host-settled promises:
// the asyncify variant would serialise concurrent host calls, so `sb.parallel` would run one agent at a time.
//
// Async context: a host operation the script starts is attached to the AsyncLocalStorage context the isolate
// was entered from, and its settlement re-enters the isolate from that same context (a `.then` callback runs in
// the context it was registered in). So script code after an `await` sees the run scope it issued the awaited
// call from, and primitives called there land in the right callPath, exactly as in a TypeScript factory.
import { ScriptInvalidError, ScriptLimitError } from "@selfbuilding/core";
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  RELEASE_SYNC,
} from "quickjs-emscripten";
import type { EffectiveCaps } from "./caps.js";
import { PRELUDE, PRELUDE_FILE, SCRIPT_FILE } from "./prelude.js";

/** Values crossing the boundary in either direction are JSON, at most 1 MiB each (demo-path §8.2). */
export const MAX_CROSSING_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The script's first frame in a QuickJS stack, e.g. `    at main (script.js:3:10)`. */
export function scriptPosition(stack: string | undefined): { line?: number; column?: number } {
  if (!stack) return {};
  const re = new RegExp(`${SCRIPT_FILE.replace(".", "\\.")}:(\\d+)(?::(\\d+))?`);
  const m = re.exec(stack);
  if (!m) return {};
  return { line: Number(m[1]), ...(m[2] === undefined ? {} : { column: Number(m[2]) }) };
}

/** Only the script's own frames: a host error never shows the prelude or the host. */
export function scriptStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n").filter((l) => l.includes(SCRIPT_FILE) && !l.includes(PRELUDE_FILE));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** A JSON value from the isolate; `__proto__` keys are dropped so no host object can be re-prototyped. */
export function parseCrossing(text: string): unknown {
  return JSON.parse(text, (key, value) => (key === "__proto__" ? undefined : value));
}

export interface VmErrorJson {
  name: string;
  message: string;
  stack: string;
  hostError: number | null;
}

/** What the host does for the isolate. Every method runs synchronously inside an isolate call. */
export interface IsolateHost {
  /** Starts an async operation. A synchronous throw becomes the script-side rejection. */
  op(name: string, args: unknown): Promise<unknown>;
  /** A synchronous operation; its return value must be JSON. */
  opSync(name: string, args: unknown): unknown;
}

type Bridge = { resolve: QuickJSHandle; invoke: QuickJSHandle; invokeSync: QuickJSHandle; start: QuickJSHandle };

export class Isolate {
  readonly #caps: EffectiveCaps;
  readonly #runtime: QuickJSRuntime;
  readonly #ctx: QuickJSContext;
  readonly #bridge: Bridge;
  readonly #owned: QuickJSHandle[] = [];
  #host: IsolateHost | undefined;
  #depth = 0;
  #sliceStart = 0;
  #disposed = false;
  #poison: unknown;
  #onPoison: ((e: unknown) => void) | undefined;
  #nextTicket = 1;
  readonly #invokes = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  /** Host errors handed to the script, by id, so a rethrown one surfaces as the original. */
  readonly hostErrors = new Map<number, unknown>();
  #nextHostError = 1;

  static async create(caps: EffectiveCaps): Promise<Isolate> {
    // A module per run: each run gets its own linear memory, so nothing one script does can touch another.
    const module = await newQuickJSWASMModule(RELEASE_SYNC);
    return new Isolate(module, caps);
  }

  private constructor(module: QuickJSWASMModule, caps: EffectiveCaps) {
    this.#caps = caps;
    this.#runtime = module.newRuntime();
    this.#runtime.setMemoryLimit(caps.memoryBytes);
    this.#runtime.setMaxStackSize(caps.stackBytes);
    this.#runtime.setInterruptHandler(() => {
      if (this.#disposed || this.#poison) return true;
      if (performance.now() - this.#sliceStart > this.#caps.cpuSliceMs) {
        this.poison(new ScriptLimitError({ limit: "cpu", max: `${this.#caps.cpuSliceMs} ms between host calls` }));
        return true;
      }
      return false;
    });
    this.#runtime.setModuleLoader((name) => {
      this.poison(
        new ScriptInvalidError({
          reason: `import "${name}" is not allowed; a script reaches the host only through its sb argument`,
        }),
      );
      return { error: new Error(`could not load module '${name}'`) };
    });
    this.#ctx = this.#runtime.newContext();
    this.#sliceStart = performance.now();
    this.#bridge = this.#installPrelude();
  }

  /** The first error the run must end on, whatever the script does about it. */
  get poisoned(): unknown {
    return this.#poison;
  }

  set host(host: IsolateHost) {
    this.#host = host;
  }

  /** Called once with the first poison. */
  onPoison(fn: (e: unknown) => void): void {
    this.#onPoison = fn;
  }

  poison(error: unknown): void {
    if (this.#poison !== undefined) return;
    this.#poison = error;
    this.#onPoison?.(error);
  }

  /** The script position the isolate is executing right now, read from a fresh Error's stack. */
  position(): { line?: number; column?: number } {
    if (this.#disposed || this.#depth === 0) return {};
    // An Error made inside the isolate captures the frames below it, the script's among them.
    const r = this.#ctx.evalCode("new Error().stack", PRELUDE_FILE);
    if (r.error) {
      r.error.dispose();
      return {};
    }
    const text = this.#ctx.dump(r.value);
    r.value.dispose();
    return scriptPosition(typeof text === "string" ? text : undefined);
  }

  #installPrelude(): Bridge {
    const ctx = this.#ctx;
    const fns = [
      ctx.newFunction("op", (name, args) => this.#hostOp(ctx.getString(name), ctx.getString(args), false)),
      ctx.newFunction("opSync", (name, args) => this.#hostOp(ctx.getString(name), ctx.getString(args), true)),
      ctx.newFunction("ban", (what, use) => {
        const reason = `${ctx.getString(what)} is not available in a workflow script; use ${ctx.getString(use)}`;
        const error = new ScriptInvalidError({ reason, ...this.position() });
        this.poison(error);
        return { error: ctx.newError({ name: "ScriptInvalidError", message: error.message }) };
      }),
      ctx.newFunction("settle", (ticket, ok, payload) => {
        this.#settle(ctx.getNumber(ticket), ctx.dump(ok) === true, ctx.getString(payload));
      }),
    ];
    const factory = this.#unwrap(ctx.evalCode(PRELUDE, PRELUDE_FILE, { type: "global", strict: true }));
    const bridge = this.#unwrap(ctx.callFunction(factory, ctx.undefined, ...fns));
    factory.dispose();
    for (const f of fns) f.dispose();
    const pick = (key: string) => {
      const h = ctx.getProp(bridge, key);
      this.#owned.push(h);
      return h;
    };
    const out = {
      resolve: pick("resolve"),
      invoke: pick("invoke"),
      invokeSync: pick("invokeSync"),
      start: pick("start"),
    };
    bridge.dispose();
    return out;
  }

  #unwrap(result: ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle {
    if (result.error) {
      const json = this.#ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`The script prelude failed: ${JSON.stringify(json)}`);
    }
    return result.value;
  }

  /** A host function body. Returns a ticket (async) or the JSON text of the value (sync). */
  #hostOp(name: string, argsText: string, sync: boolean): QuickJSHandle | { error: QuickJSHandle } {
    const ctx = this.#ctx;
    try {
      if (this.#poison) throw this.#poison;
      if (!this.#host) throw new ScriptInvalidError({ reason: "sb is only available inside the default export" });
      if (byteLength(argsText) > MAX_CROSSING_BYTES) {
        const error = new ScriptInvalidError({
          reason: `a value passed to sb is ${byteLength(argsText)} bytes; values crossing to the host are capped at 1 MiB`,
          ...this.position(),
        });
        this.poison(error);
        throw error;
      }
      const args = parseCrossing(argsText);
      if (sync) {
        const value = this.#host.opSync(name, args);
        return ctx.newString(JSON.stringify(value === undefined ? null : value));
      }
      const ticket = this.#nextTicket++;
      const started = this.#host.op(name, args);
      started.then(
        (value) => this.#deliver(ticket, true, JSON.stringify(value === undefined ? null : value)),
        (error) => this.#deliver(ticket, false, this.#errorPayload(error)),
      );
      return ctx.newNumber(ticket);
    } catch (error) {
      return { error: this.#vmError(error) };
    }
  }

  #errorPayload(error: unknown): string {
    const id = this.#nextHostError++;
    this.hostErrors.set(id, error);
    const e = error as { name?: unknown; message?: unknown; code?: unknown; retryable?: unknown };
    return JSON.stringify({
      id,
      name: typeof e?.name === "string" ? e.name : "Error",
      message: typeof e?.message === "string" ? e.message : String(error),
      ...(typeof e?.code === "string" ? { code: e.code } : {}),
      ...(typeof e?.retryable === "boolean" ? { retryable: e.retryable } : {}),
    });
  }

  /** A host error as an isolate Error: name, message and code only, never a host stack. */
  #vmError(error: unknown): QuickJSHandle {
    const payload = JSON.parse(this.#errorPayload(error)) as { id: number; name: string; message: string };
    const handle = this.#ctx.newError({ name: payload.name, message: payload.message });
    const code = (error as { code?: unknown })?.code;
    if (typeof code === "string") {
      const c = this.#ctx.newString(code);
      this.#ctx.setProp(handle, "code", c);
      c.dispose();
    }
    return handle;
  }

  #deliver(ticket: number, ok: boolean, payload: string): void {
    if (this.#disposed || this.#poison) return;
    this.#enter(() => {
      const args = [this.#ctx.newNumber(ticket), ok ? this.#ctx.true : this.#ctx.false, this.#ctx.newString(payload)];
      const r = this.#ctx.callFunction(this.#bridge.resolve, this.#ctx.undefined, ...args);
      (args[0] as QuickJSHandle).dispose();
      (args[2] as QuickJSHandle).dispose();
      this.#check(r);
    });
  }

  #settle(ticket: number, ok: boolean, payload: string): void {
    const waiter = this.#invokes.get(ticket);
    if (!waiter) return;
    this.#invokes.delete(ticket);
    if (ok) {
      if (byteLength(payload) > MAX_CROSSING_BYTES && ticket !== this.#mainTicket) {
        const error = new ScriptInvalidError({
          reason: `a value returned to sb is ${byteLength(payload)} bytes; values crossing to the host are capped at 1 MiB`,
        });
        this.poison(error);
        waiter.reject(error);
        return;
      }
      waiter.resolve(payload);
    } else waiter.reject(JSON.parse(payload) as VmErrorJson);
  }

  #mainTicket = -1;

  /** Calls a callback the script registered; resolves with its JSON text, rejects with its `VmErrorJson`. */
  invoke(id: number, args: unknown[]): Promise<string> {
    if (this.#poison) return Promise.reject(this.#poison);
    if (this.#disposed) return Promise.reject(new Error("The script has ended."));
    return new Promise<string>((resolve, reject) => {
      const ticket = this.#nextTicket++;
      this.#invokes.set(ticket, { resolve: resolve as (v: unknown) => void, reject });
      this.#enter(() => {
        const handles = [
          this.#ctx.newNumber(id),
          this.#ctx.newString(JSON.stringify(args)),
          this.#ctx.newNumber(ticket),
        ];
        const r = this.#ctx.callFunction(this.#bridge.invoke, this.#ctx.undefined, ...handles);
        for (const h of handles) h.dispose();
        this.#check(r);
      });
    });
  }

  /** Calls a synchronous callback (a pipeline key function). */
  invokeSync(id: number, args: unknown[]): unknown {
    if (this.#poison) throw this.#poison;
    let out: unknown;
    this.#enter(() => {
      const handles = [this.#ctx.newNumber(id), this.#ctx.newString(JSON.stringify(args))];
      const r = this.#ctx.callFunction(this.#bridge.invokeSync, this.#ctx.undefined, ...handles);
      for (const h of handles) h.dispose();
      if (r.error) {
        const json = this.#ctx.dump(r.error) as { message?: string };
        r.error.dispose();
        throw this.#poison ?? new Error(json?.message ?? "the callback threw");
      }
      out = parseCrossing(this.#ctx.getString(r.value));
      r.value.dispose();
    });
    return out;
  }

  /**
   * Compiles and evaluates the module and returns its default export, or throws ScriptInvalidError. The caller
   * owns the returned handle.
   */
  load(source: string): QuickJSHandle {
    let main: QuickJSHandle | undefined;
    this.#enter(() => {
      const r = this.#ctx.evalCode(source, SCRIPT_FILE, { type: "module", strict: true });
      if (r.error) {
        const err = this.#ctx.dump(r.error) as Partial<VmErrorJson> & { lineNumber?: number };
        r.error.dispose();
        throw this.#poison ?? this.#compileError(err);
      }
      this.#runtime.executePendingJobs();
      const state = this.#ctx.getPromiseState(r.value);
      let ns: QuickJSHandle;
      if (state.type === "fulfilled") {
        ns = state.value;
        if (!state.notAPromise) r.value.dispose();
      } else if (state.type === "rejected") {
        const err = this.#ctx.dump(state.error) as Partial<VmErrorJson>;
        state.error.dispose();
        r.value.dispose();
        throw this.#poison ?? this.#compileError(err);
      } else {
        r.value.dispose();
        throw this.#poison ?? new ScriptInvalidError({ reason: "the module's top-level await never settled" });
      }
      main = this.#ctx.getProp(ns, "default");
      ns.dispose();
      if (this.#poison) throw this.#poison;
      if (this.#ctx.typeof(main) !== "function") {
        main.dispose();
        main = undefined;
        throw new ScriptInvalidError({
          reason:
            "the module has no default export function; write export default async function main(input, sb) { ... }",
        });
      }
    });
    if (!main) throw this.#poison ?? new ScriptInvalidError({ reason: "the module could not be loaded" });
    return main;
  }

  #compileError(err: Partial<VmErrorJson> & { lineNumber?: number }): Error {
    const pos = scriptPosition(err.stack);
    const line = pos.line ?? (typeof err.lineNumber === "number" ? err.lineNumber : undefined);
    if (err.name === "InternalError") {
      const limit = this.#limitFor(err.message);
      if (limit) return limit;
    }
    return new ScriptInvalidError({
      reason: `${err.name ?? "Error"}: ${err.message ?? "the module failed to load"}`,
      ...(line === undefined ? {} : { line }),
      ...(pos.column === undefined ? {} : { column: pos.column }),
    });
  }

  /** Out of memory and stack overflow surface as InternalErrors; they are cap breaches. */
  #limitFor(message: string | undefined): ScriptLimitError | undefined {
    if (message === "out of memory") {
      return new ScriptLimitError({ limit: "memory", max: `${this.#caps.memoryBytes} bytes` });
    }
    if (message === "stack overflow") {
      return new ScriptLimitError({ limit: "stack", max: `${this.#caps.stackBytes} bytes` });
    }
    if (message === "interrupted") {
      return new ScriptLimitError({ limit: "cpu", max: `${this.#caps.cpuSliceMs} ms between host calls` });
    }
    return undefined;
  }

  /** Maps an uncaught isolate error to the host error the run fails with. */
  limitFor(err: VmErrorJson): ScriptLimitError | undefined {
    return err.name === "InternalError" ? this.#limitFor(err.message) : undefined;
  }

  /** Calls `main(input, sb)`; resolves with the JSON text of its return value. */
  start(main: QuickJSHandle, input: unknown, agentNames: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const ticket = this.#nextTicket++;
      this.#mainTicket = ticket;
      this.#invokes.set(ticket, { resolve: resolve as (v: unknown) => void, reject });
      this.#enter(() => {
        const handles = [
          this.#ctx.newString(JSON.stringify(input)),
          this.#ctx.newString(JSON.stringify(agentNames)),
          this.#ctx.newNumber(ticket),
        ];
        const r = this.#ctx.callFunction(this.#bridge.start, this.#ctx.undefined, main, ...handles);
        for (const h of handles) h.dispose();
        this.#check(r);
      });
    });
  }

  #check(r: ReturnType<QuickJSContext["callFunction"]>): void {
    if (r.error) {
      const json = this.#ctx.dump(r.error) as VmErrorJson;
      r.error.dispose();
      this.poison(this.#poison ?? this.limitFor(json) ?? new Error(`The script bridge failed: ${json.message}`));
    } else {
      r.value.dispose();
    }
  }

  /** Runs `fn` inside the isolate; the outermost entry starts a CPU slice and drains the job queue after. */
  #enter(fn: () => void): void {
    if (this.#disposed) throw this.#poison ?? new Error("The script has ended.");
    const outer = this.#depth === 0;
    if (outer) this.#sliceStart = performance.now();
    this.#depth++;
    try {
      fn();
      if (outer && !this.#poison) {
        const jobs = this.#runtime.executePendingJobs(-1);
        if (jobs.error) {
          const json = this.#ctx.dump(jobs.error) as VmErrorJson;
          jobs.error.dispose();
          this.poison(this.#poison ?? this.limitFor(json) ?? new Error(`A script job failed: ${json.message}`));
        }
      }
    } finally {
      this.#depth--;
      if (this.#depth === 0 && this.#pendingDispose) this.#teardown();
    }
  }

  #pendingDispose = false;

  /** Frees the isolate once no isolate frame is on the stack. Late host settlements are ignored after this. */
  dispose(): void {
    if (this.#disposed) return;
    if (this.#depth > 0) {
      this.#pendingDispose = true;
      return;
    }
    this.#teardown();
  }

  #teardown(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const waiter of this.#invokes.values()) waiter.reject(this.#poison ?? new Error("The script has ended."));
    this.#invokes.clear();
    try {
      for (const h of this.#owned) h.dispose();
      this.#ctx.dispose();
      this.#runtime.dispose();
    } catch {
      // A runtime that died mid-call (out of memory inside the allocator) cannot always free itself; its module
      // is private to this run and is collected with it.
    }
  }
}
