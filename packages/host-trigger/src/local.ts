import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import type { Json } from "@selfbuilding/core";
import {
  isTerminalStatus,
  type TriggerRunContext,
  type TriggerRunStatus,
  type TriggerRunView,
  type TriggerScheduleDefinition,
  type TriggerSdk,
  type TriggerTaskDefinition,
  type WaitResult,
  type Wake,
} from "./sdk.js";

// A local, in-process stand-in for Trigger.dev v4, for offline tests of crash and resume. It keeps the
// platform's server-side state (runs, idempotency keys, waitpoint tokens, input streams) apart from the
// "worker" (the attempts executing task code), so `crash()` can kill every attempt while the server state
// survives, and `restart()` re-runs each unfinished run from the top as a new attempt, as Trigger.dev does.
//
// Semantics it enforces, because the host must respect them:
// - A run may hold one wait at a time; a second concurrent wait throws.
// - An idempotency key always returns the run (or token) it first created.
// - A completed token returns at once to every later `forToken`.
// - Time is virtual: timeouts fire only when `advance()` moves the clock past them.

const NEVER: Promise<never> = new Promise(() => {});

interface Attempt {
  run: LocalRun;
  alive: boolean;
  waiting: boolean;
  number: number;
}

interface LocalRun {
  id: string;
  taskId: string;
  payload: unknown;
  status: TriggerRunStatus;
  output?: unknown;
  error?: { message: string; name?: string };
  tags: string[];
  idempotencyKey?: string;
  /** The run that triggered this one, when it was triggered from inside a run. */
  parentRunId?: string;
  attempts: number;
  failures: number;
  attempt?: Attempt;
}

interface LocalToken {
  id: string;
  url: string;
  idempotencyKey: string;
  status: "WAITING" | "COMPLETED" | "TIMED_OUT";
  output?: Json;
  timeoutAt: number;
  tags: string[];
  waiters: { attempt: Attempt; resolve: (r: WaitResult<unknown>) => void }[];
}

interface StreamWaiter {
  attempt: Attempt;
  timeoutAt: number;
  resolve: (r: WaitResult<Wake>) => void;
}

type AnyTask = TriggerTaskDefinition<unknown, unknown>;

export interface LocalTriggerOptions {
  /** Virtual clock start, epoch ms. Default: 2026-01-01T00:00:00Z. */
  startAt?: number;
  /** Attempts per run when the task throws. Default 3, like the spec's trigger.config.ts. */
  maxAttempts?: number;
  /**
   * Prefix of run ids. Default "run_". Platform run ids are unique forever; give each stand-in that plays a later
   * deployment of the same platform (e.g. one per test process) its own prefix to keep them so.
   */
  runIdPrefix?: string;
  /**
   * Serves token URLs on 127.0.0.1 so a sandbox on this machine can POST its wake to them, as it would to
   * Trigger.dev's. Default true; with false, URLs are `local-trigger://` and only `postToTokenUrl` completes them.
   */
  serveTokens?: boolean;
  /**
   * The environment type every run's context reports, as Trigger.dev's `ctx.environment.type`. Default
   * "DEVELOPMENT" (`trigger.dev dev`); "PRODUCTION" plays a deployed project.
   */
  environment?: string;
}

/** What tests can inspect. */
export interface LocalRunInfo extends TriggerRunView {
  taskId: string;
  payload: unknown;
  tags: string[];
  idempotencyKey?: string;
  parentRunId?: string;
  attempts: number;
}

export interface LocalTokenInfo {
  id: string;
  url: string;
  idempotencyKey: string;
  status: "WAITING" | "COMPLETED" | "TIMED_OUT";
  output?: Json;
  timeoutAt: number;
  tags: string[];
}

export interface LocalTrigger extends TriggerSdk {
  /** Triggers a task from outside any run, like a backend call. */
  start(taskId: string, payload: Json, opts?: { idempotencyKey?: string; tags?: string[] }): Promise<{ id: string }>;
  /** Errors thrown by lifecycle hooks, which the platform logs and swallows. */
  readonly hookErrors: unknown[];
  /** Simulates the sandbox's server-to-server POST to a token URL. False when the token is unknown or spent. */
  postToTokenUrl(url: string, body: Json): Promise<boolean>;
  /** Moves the virtual clock and fires every timeout that falls due. */
  advance(ms: number): Promise<void>;
  /** Kills every executing attempt. Server state survives; nothing runs until `restart()`. */
  crash(): void;
  /** Starts the worker again: every unfinished run starts a new attempt from the top. */
  restart(): void;
  /** Resolves once every live attempt is waiting or finished. */
  settle(opts?: { timeoutMs?: number }): Promise<void>;
  /** Runs a scheduled task once, as its cron would. */
  fireSchedule(id: string): Promise<{ id: string }>;
  run(id: string): LocalRunInfo;
  runs(filter?: { taskId?: string }): LocalRunInfo[];
  tokens(): LocalTokenInfo[];
  schedules(): { id: string; cron: string }[];
  /** Stops the token server, if one was started. */
  close(): Promise<void>;
}

export function createLocalTrigger(opts: LocalTriggerOptions = {}): LocalTrigger {
  return new LocalTriggerImpl(opts);
}

function clone<T>(value: T): T {
  return value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T);
}

function errorView(error: unknown): { message: string; name?: string } {
  return error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) };
}

class LocalTriggerImpl implements LocalTrigger {
  readonly kind = "local";
  private clock: number;
  private readonly maxAttempts: number;
  private readonly als = new AsyncLocalStorage<Attempt>();
  private readonly tasks = new Map<string, AnyTask>();
  private readonly cronOf = new Map<string, string>();
  private readonly runsById = new Map<string, LocalRun>();
  private readonly runByKey = new Map<string, string>();
  private readonly tokensById = new Map<string, LocalToken>();
  private readonly tokenByKey = new Map<string, string>();
  private readonly streams = new Map<string, { buffer: Wake[]; waiter?: StreamWaiter }>();
  private readonly queued = new Set<string>();
  private workerUp = true;
  /** Errors thrown by lifecycle hooks; the platform logs and swallows them. */
  readonly hookErrors: unknown[] = [];
  private seq = 0;
  private readonly runIdPrefix: string;
  private readonly serveTokens: boolean;
  private readonly environment: string;
  private server?: Promise<{ server: Server; base: string }>;

  constructor(opts: LocalTriggerOptions) {
    this.clock = opts.startAt ?? Date.parse("2026-01-01T00:00:00Z");
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.runIdPrefix = opts.runIdPrefix ?? "run_";
    this.serveTokens = opts.serveTokens ?? true;
    this.environment = opts.environment ?? "DEVELOPMENT";
  }

  /** Answers 200 when the POST completed a waiting token, 409 when it was spent or unknown (no retry). */
  private tokenServer(): Promise<{ server: Server; base: string }> {
    // Outside any attempt's context: a request must never look like code from a killed attempt.
    this.server ??= this.als.exit(() => this.listen());
    return this.server;
  }

  private listen(): Promise<{ server: Server; base: string }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          let json: Json = null;
          try {
            json = JSON.parse(body || "null") as Json;
          } catch {
            // A body that is not JSON still wakes the waiter.
          }
          const ok = req.method === "POST" ? this.postToTokenUrl(req.url ?? "", json) : Promise.resolve(false);
          void ok.then((done) => {
            res.statusCode = done ? 200 : 409;
            res.end();
          });
        });
      });
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ server, base: `http://127.0.0.1:${port}` });
      });
    });
  }

  async close(): Promise<void> {
    const running = await this.server;
    this.server = undefined;
    if (running) await new Promise<void>((resolve) => running.server.close(() => resolve()));
  }

  private async tokenUrl(id: string): Promise<string> {
    if (!this.serveTokens) return `local-trigger://tokens/${id}`;
    return `${(await this.tokenServer()).base}/tokens/${id}`;
  }

  now(): number {
    return this.clock;
  }

  task<P, O>(def: TriggerTaskDefinition<P, O>): unknown {
    this.tasks.set(def.id, def as unknown as AnyTask);
    return {
      id: def.id,
      trigger: (payload: P, o?: { idempotencyKey?: string; tags?: string[] }) =>
        this.start(def.id, payload as Json, o ?? {}),
    };
  }

  scheduleTask(def: TriggerScheduleDefinition): unknown {
    this.cronOf.set(def.id, def.cron);
    this.tasks.set(def.id, {
      id: def.id,
      run: (_payload, params) => def.run({ timestamp: new Date(this.clock) }, params),
    });
    return { id: def.id, cron: def.cron };
  }

  private current(): Attempt | undefined {
    return this.als.getStore();
  }

  /** Code from a killed attempt never gets an answer again, like a process that died at its next call. */
  private dead(): boolean {
    const attempt = this.current();
    return attempt !== undefined && !attempt.alive;
  }

  async trigger(taskId: string, payload: Json, o: { idempotencyKey: string; tags?: string[] }) {
    if (this.dead()) return NEVER;
    return this.create(taskId, payload, o, this.current()?.run.id);
  }

  async start(taskId: string, payload: Json, o: { idempotencyKey?: string; tags?: string[] } = {}) {
    return this.create(taskId, payload, o, undefined);
  }

  private create(
    taskId: string,
    payload: unknown,
    o: { idempotencyKey?: string; tags?: string[] },
    parentRunId: string | undefined,
  ): { id: string } {
    if (o.idempotencyKey !== undefined) {
      const existing = this.runByKey.get(o.idempotencyKey);
      if (existing) return { id: existing };
    }
    const run: LocalRun = {
      id: `${this.runIdPrefix}${(++this.seq).toString().padStart(4, "0")}`,
      taskId,
      payload: clone(payload),
      status: "QUEUED",
      tags: [...(o.tags ?? [])],
      attempts: 0,
      failures: 0,
      ...(o.idempotencyKey === undefined ? {} : { idempotencyKey: o.idempotencyKey }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
    };
    this.runsById.set(run.id, run);
    if (o.idempotencyKey !== undefined) this.runByKey.set(o.idempotencyKey, run.id);
    this.enqueue(run);
    return { id: run.id };
  }

  private enqueue(run: LocalRun): void {
    this.queued.add(run.id);
    setImmediate(() => {
      if (!this.workerUp || !this.queued.has(run.id)) return;
      this.queued.delete(run.id);
      if (isTerminalStatus(run.status)) return;
      this.execute(run);
    });
  }

  private execute(run: LocalRun): void {
    const def = this.tasks.get(run.taskId);
    if (!def) {
      run.status = "SYSTEM_FAILURE";
      run.error = { message: `No task "${run.taskId}" is registered with the local trigger.` };
      return;
    }
    const attempt: Attempt = { run, alive: true, waiting: false, number: ++run.attempts };
    run.attempt = attempt;
    run.status = "EXECUTING";
    const ctx: TriggerRunContext = {
      run: { id: run.id },
      attempt: { number: attempt.number },
      environment: { type: this.environment },
    };
    const payload = clone(run.payload);
    this.als
      .run(attempt, () => Promise.resolve().then(() => def.run(payload, { ctx })))
      .then(
        (output) => {
          if (!attempt.alive) return;
          attempt.alive = false;
          run.status = "COMPLETED";
          run.output = clone(output);
        },
        (error: unknown) => {
          if (!attempt.alive) return;
          attempt.alive = false;
          run.failures += 1;
          if (run.failures < this.maxAttempts) {
            run.status = "QUEUED";
            this.enqueue(run);
          } else {
            run.status = "FAILED";
            run.error = errorView(error);
          }
        },
      );
  }

  async idempotencyKey(key: string): Promise<string> {
    if (this.dead()) return NEVER;
    return key;
  }

  async createToken(o: { idempotencyKey: string; timeoutMs: number; tags?: string[] }) {
    if (this.dead()) return NEVER;
    const existing = this.tokenByKey.get(o.idempotencyKey);
    if (existing) {
      const token = this.tokensById.get(existing) as LocalToken;
      return { id: token.id, url: token.url };
    }
    const id = `waitpoint_${(++this.seq).toString().padStart(4, "0")}`;
    const url = await this.tokenUrl(id);
    if (this.dead()) return NEVER;
    // Another caller may have created the token while the server started.
    const again = this.tokenByKey.get(o.idempotencyKey);
    if (again) {
      const token = this.tokensById.get(again) as LocalToken;
      return { id: token.id, url: token.url };
    }
    const token: LocalToken = {
      id,
      url,
      idempotencyKey: o.idempotencyKey,
      status: "WAITING",
      timeoutAt: this.clock + o.timeoutMs,
      tags: [...(o.tags ?? [])],
      waiters: [],
    };
    this.tokensById.set(id, token);
    this.tokenByKey.set(o.idempotencyKey, id);
    return { id, url: token.url };
  }

  private enterWait(what: string): Attempt {
    const attempt = this.current();
    if (!attempt) throw new Error(`${what} can only be used inside a task run.`);
    if (attempt.waiting) {
      throw new Error(`${what}: this run already has a wait open. Trigger.dev allows one wait per run at a time.`);
    }
    attempt.waiting = true;
    if (attempt.run.status === "EXECUTING") attempt.run.status = "WAITING";
    return attempt;
  }

  private exitWait(attempt: Attempt): void {
    attempt.waiting = false;
    if (attempt.run.status === "WAITING") attempt.run.status = "EXECUTING";
  }

  async forToken<T>(tokenId: string): Promise<WaitResult<T>> {
    if (this.dead()) return NEVER;
    const token = this.tokensById.get(tokenId);
    if (!token) throw new Error(`Unknown waitpoint token ${tokenId}.`);
    const attempt = this.enterWait("wait.forToken");
    if (token.status !== "WAITING") {
      this.exitWait(attempt);
      return this.tokenResult<T>(token);
    }
    return new Promise<WaitResult<T>>((resolve) => {
      token.waiters.push({ attempt, resolve: resolve as (r: WaitResult<unknown>) => void });
    });
  }

  private tokenResult<T>(token: LocalToken): WaitResult<T> {
    return token.status === "COMPLETED"
      ? { ok: true, output: clone(token.output) as T }
      : { ok: false, error: new Error(`Waitpoint ${token.id} timed out.`) };
  }

  private settleToken(token: LocalToken): void {
    const waiters = token.waiters.splice(0);
    for (const waiter of waiters) {
      if (!waiter.attempt.alive) continue;
      this.exitWait(waiter.attempt);
      waiter.resolve(this.tokenResult(token));
    }
  }

  async completeToken(tokenId: string, data: Json): Promise<void> {
    if (this.dead()) return NEVER;
    const token = this.tokensById.get(tokenId);
    if (!token) throw new Error(`Unknown waitpoint token ${tokenId}.`);
    if (token.status !== "WAITING") return;
    token.status = "COMPLETED";
    token.output = clone(data);
    this.settleToken(token);
  }

  async postToTokenUrl(url: string, body: Json): Promise<boolean> {
    // The token server passes the request path; tests pass the full URL.
    const id = /\/tokens\/([^/?#]+)$/.exec(url)?.[1];
    const token = [...this.tokensById.values()].find((t) => t.url === url || (id !== undefined && t.id === id));
    // A spent or expired token refuses the POST, so the sender keeps its wake pending.
    if (token?.status !== "WAITING") return false;
    await this.completeToken(token.id, body);
    return true;
  }

  private stream(runId: string) {
    let s = this.streams.get(runId);
    if (!s) {
      s = { buffer: [] };
      this.streams.set(runId, s);
    }
    return s;
  }

  async waitWake(o: { timeoutMs: number }): Promise<WaitResult<Wake>> {
    if (this.dead()) return NEVER;
    const attempt = this.enterWait("streams.input(...).wait");
    const s = this.stream(attempt.run.id);
    const next = s.buffer.shift();
    if (next !== undefined) {
      this.exitWait(attempt);
      return { ok: true, output: next };
    }
    return new Promise<WaitResult<Wake>>((resolve) => {
      s.waiter = { attempt, timeoutAt: this.clock + o.timeoutMs, resolve };
    });
  }

  async sendWake(runId: string, wake: Wake): Promise<void> {
    if (this.dead()) return NEVER;
    if (!this.runsById.has(runId)) throw new Error(`Unknown run ${runId}.`);
    const s = this.stream(runId);
    const waiter = s.waiter;
    if (waiter?.attempt.alive) {
      s.waiter = undefined;
      this.exitWait(waiter.attempt);
      waiter.resolve({ ok: true, output: clone(wake) });
      return;
    }
    s.waiter = undefined;
    s.buffer.push(clone(wake));
  }

  async retrieveRun(runId: string): Promise<TriggerRunView> {
    if (this.dead()) return NEVER;
    return this.view(this.mustRun(runId));
  }

  async cancelRun(runId: string): Promise<void> {
    if (this.dead()) return NEVER;
    const run = this.mustRun(runId);
    if (isTerminalStatus(run.status)) return;
    run.status = "CANCELED";
    this.queued.delete(run.id);
    const attempt = run.attempt;
    const wasExecuting = attempt?.alive === true;
    if (attempt) attempt.alive = false;
    const def = this.tasks.get(run.taskId);
    if (wasExecuting && def?.onCancel) {
      const ctx: TriggerRunContext = {
        run: { id: run.id },
        attempt: { number: run.attempts },
        environment: { type: this.environment },
      };
      await def.onCancel({ ctx, payload: clone(run.payload) }).catch((error: unknown) => {
        this.hookErrors.push(error);
      });
    }
  }

  async advance(ms: number): Promise<void> {
    this.clock += ms;
    for (const token of this.tokensById.values()) {
      if (token.status === "WAITING" && token.timeoutAt <= this.clock) {
        token.status = "TIMED_OUT";
        this.settleToken(token);
      }
    }
    for (const s of this.streams.values()) {
      const waiter = s.waiter;
      if (waiter && waiter.timeoutAt <= this.clock) {
        s.waiter = undefined;
        if (!waiter.attempt.alive) continue;
        this.exitWait(waiter.attempt);
        waiter.resolve({ ok: false, error: new Error("The wake stream wait timed out.") });
      }
    }
  }

  crash(): void {
    this.workerUp = false;
    for (const run of this.runsById.values()) {
      if (run.attempt) run.attempt.alive = false;
    }
    for (const s of this.streams.values()) s.waiter = undefined;
    for (const token of this.tokensById.values()) token.waiters.length = 0;
  }

  restart(): void {
    this.workerUp = true;
    for (const run of this.runsById.values()) {
      if (isTerminalStatus(run.status)) continue;
      if (run.attempt?.alive) continue;
      this.queued.delete(run.id);
      run.status = "QUEUED";
      this.enqueue(run);
    }
  }

  private busy(): boolean {
    if (this.workerUp && this.queued.size > 0) return true;
    for (const run of this.runsById.values()) {
      const a = run.attempt;
      if (a?.alive && !a.waiting) return true;
    }
    return false;
  }

  async settle(o: { timeoutMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (o.timeoutMs ?? 20_000);
    let quiet = 0;
    while (quiet < 3) {
      await new Promise((r) => setTimeout(r, 1));
      quiet = this.busy() ? 0 : quiet + 1;
      if (Date.now() > deadline) {
        const busy = [...this.runsById.values()].filter((r) => r.attempt?.alive && !r.attempt.waiting);
        throw new Error(`The local trigger did not settle; still executing: ${busy.map((r) => r.taskId).join(", ")}`);
      }
    }
  }

  async fireSchedule(id: string): Promise<{ id: string }> {
    if (!this.cronOf.has(id)) throw new Error(`No scheduled task "${id}".`);
    return this.create(id, { schedule: id }, {}, undefined);
  }

  private mustRun(runId: string): LocalRun {
    const run = this.runsById.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}.`);
    return run;
  }

  private view(run: LocalRun): TriggerRunView {
    return {
      id: run.id,
      status: run.status,
      ...(run.output === undefined ? {} : { output: clone(run.output) }),
      ...(run.error === undefined ? {} : { error: { ...run.error } }),
    };
  }

  run(id: string): LocalRunInfo {
    const run = this.mustRun(id);
    return {
      ...this.view(run),
      taskId: run.taskId,
      payload: clone(run.payload),
      tags: [...run.tags],
      attempts: run.attempts,
      ...(run.idempotencyKey === undefined ? {} : { idempotencyKey: run.idempotencyKey }),
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    };
  }

  runs(filter: { taskId?: string } = {}): LocalRunInfo[] {
    return [...this.runsById.values()]
      .filter((r) => filter.taskId === undefined || r.taskId === filter.taskId)
      .map((r) => this.run(r.id));
  }

  tokens(): LocalTokenInfo[] {
    return [...this.tokensById.values()].map((t) => ({
      id: t.id,
      url: t.url,
      idempotencyKey: t.idempotencyKey,
      status: t.status,
      ...(t.output === undefined ? {} : { output: clone(t.output) }),
      timeoutAt: t.timeoutAt,
      tags: [...t.tags],
    }));
  }

  schedules(): { id: string; cron: string }[] {
    return [...this.cronOf].map(([id, cron]) => ({ id, cron }));
  }
}
