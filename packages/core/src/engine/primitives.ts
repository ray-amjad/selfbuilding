import { ConfigError } from "../errors/classes.js";
import { isUsageError, serializeThrown } from "../errors/serialize.js";
import type { ArtifactRefJson } from "../types/artifacts.js";
import type {
  LogLevel,
  PipelineArgs,
  PipelineOptions,
  Stage,
  StageContext,
  ThunkList,
  ThunkRecord,
} from "../types/orchestration.js";
import { OpenedCall } from "./calls.js";
import { currentFrame, type Frame, internal, withScope } from "./context.js";
import { formatUuidV4, internalNow, randomBytes } from "./hash.js";
import { isSuspension } from "./run-state.js";
import { foldHeads, type Scope } from "./scope.js";

// Orchestration primitives (spec §3.5–§3.8). They find the current run through AsyncLocalStorage and throw
// NoActiveRunError outside a running factory.

type ParallelResult<T> = {
  -readonly [K in keyof T]: T[K] extends () => Promise<infer R> ? NonNullable<R> | null : never;
};

/** Usage errors and suspensions pass through parallel() and pipeline(); everything else becomes null. */
function isFatal(error: unknown): boolean {
  return isUsageError(error) || isSuspension(error);
}

function errorData(error: unknown): Record<string, unknown> {
  const json = serializeThrown(error) as { name: string; message: string; code?: string; retryable?: boolean };
  return { code: json.code ?? "unknown", retryable: json.retryable ?? false, name: json.name, message: json.message };
}

/** Starts `fn` in `scope`, turning a synchronous throw into a rejection. */
function startIn<T>(scope: Scope, fn: () => Promise<T> | T): Promise<T> {
  return withScope(scope, () => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  });
}

/** Resolves once every promise settled, or rejects at once on the first fatal error. */
function settleAll(
  promises: Promise<unknown>[],
  onValue: (index: number, value: unknown) => void,
  onError: (index: number, error: unknown) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    if (remaining === 0) resolve();
    promises.forEach((promise, index) => {
      promise.then(
        (value) => {
          onValue(index, value);
          if (--remaining === 0) resolve();
        },
        (error) => {
          if (isFatal(error)) {
            reject(error);
            return;
          }
          onError(index, error);
          if (--remaining === 0) resolve();
        },
      );
    });
  });
}

const KEY_PATTERN = /^[^/[\]]{1,128}$/;

function checkKey(key: string, what: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new ConfigError(`${what} "${key}" must be 1-128 characters with no "/", "[" or "]".`);
  }
  return key;
}

/** A barrier: resolves once every thunk has settled. Agent-level failures become `null` (spec §3.6). */
export function parallel<const T extends ThunkList>(thunks: T): Promise<ParallelResult<T>>;
export function parallel<T extends ThunkRecord>(thunks: T): Promise<ParallelResult<T>>;
export async function parallel(thunks: ThunkList | ThunkRecord): Promise<unknown> {
  const frame = currentFrame("parallel");
  if (thunks === null || typeof thunks !== "object") {
    throw new ConfigError("parallel() takes an array or a record of thunks: parallel([() => A(x), () => B(y)]).");
  }
  const isList = Array.isArray(thunks);
  const pairs: [string, unknown][] = isList
    ? (thunks as ThunkList).map((t, i) => [String(i), t])
    : Object.entries(thunks as ThunkRecord);
  for (const [key, thunk] of pairs) {
    if (typeof thunk !== "function") {
      throw new ConfigError(`parallel() child [${key}] is not a function. Pass thunks: () => Agent(input).`);
    }
    if (!isList) checkKey(key, "parallel() key");
  }

  const path = frame.scope.allocate("parallel");
  const link = frame.scope.reserveLink();
  const children = pairs.map(([key], index) =>
    frame.scope.child({
      path: `${path}/[${key}]`,
      concurrent: true,
      priority: { depth: frame.scope.priority.depth, index },
    }),
  );
  // Thunks start synchronously, in index (or key) order.
  const promises = pairs.map(([, thunk], i) => startIn(children[i] as Scope, thunk as () => Promise<unknown>));
  const values: unknown[] = pairs.map(() => null);
  try {
    await settleAll(
      promises,
      (i, value) => {
        values[i] = value ?? null;
      },
      (i, error) => {
        frame.run.dropped++;
        frame.run.emit({
          type: "error",
          level: "error",
          callPath: (children[i] as Scope).path,
          data: { ...errorData(error), primitive: "parallel" },
        });
      },
    );
  } catch (error) {
    link(null);
    throw error;
  }
  link((head) =>
    foldHeads(
      "parallel",
      head,
      children.map((c) => c.chainHead),
    ),
  );
  if (isList) return values;
  return Object.fromEntries(pairs.map(([key], i) => [key, values[i]]));
}

/** Narrows `(T | null)[]` to `T[]` with `filter(isPresent)`. */
export function isPresent<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

/** Each item moves through the stages on its own, with no barrier (spec §3.5). Results are in input order. */
export function pipeline<T, R1>(items: readonly T[], s1: Stage<T, R1, T>): Promise<(R1 | null)[]>;
export function pipeline<T, R1>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
): Promise<(R1 | null)[]>;
export function pipeline<T, R1, R2>(
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
): Promise<(R2 | null)[]>;
export function pipeline<T, R1, R2>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
): Promise<(R2 | null)[]>;
export function pipeline<T, R1, R2, R3>(
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
): Promise<(R3 | null)[]>;
export function pipeline<T, R1, R2, R3>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
): Promise<(R3 | null)[]>;
export function pipeline<T, R1, R2, R3, R4>(
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
): Promise<(R4 | null)[]>;
export function pipeline<T, R1, R2, R3, R4>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
): Promise<(R4 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5>(
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
): Promise<(R5 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
): Promise<(R5 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5, R6>(
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
  s6: Stage<R5, R6, T>,
): Promise<(R6 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5, R6>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
  s6: Stage<R5, R6, T>,
): Promise<(R6 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5, R6, R7>(
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
  s6: Stage<R5, R6, T>,
  s7: Stage<R6, R7, T>,
): Promise<(R7 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5, R6, R7>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
  s6: Stage<R5, R6, T>,
  s7: Stage<R6, R7, T>,
): Promise<(R7 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5, R6, R7, R8>(
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
  s6: Stage<R5, R6, T>,
  s7: Stage<R6, R7, T>,
  s8: Stage<R7, R8, T>,
): Promise<(R8 | null)[]>;
export function pipeline<T, R1, R2, R3, R4, R5, R6, R7, R8>(
  opts: PipelineOptions<T>,
  items: readonly T[],
  s1: Stage<T, R1, T>,
  s2: Stage<R1, R2, T>,
  s3: Stage<R2, R3, T>,
  s4: Stage<R3, R4, T>,
  s5: Stage<R4, R5, T>,
  s6: Stage<R5, R6, T>,
  s7: Stage<R6, R7, T>,
  s8: Stage<R7, R8, T>,
): Promise<(R8 | null)[]>;
export async function pipeline(...args: PipelineArgs): Promise<(unknown | null)[]> {
  const frame = currentFrame("pipeline");
  const { opts, items, stages } = parsePipelineArgs(args);
  const keys = items.map((item, index) =>
    checkKey(opts.key ? String(opts.key(item)) : String(index), "pipeline() item key"),
  );
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key))
      throw new ConfigError(`pipeline() item key "${key}" is not unique. opts.key must return unique keys.`);
    seen.add(key);
  }

  const path = frame.scope.allocate("pipeline", opts.label);
  const link = frame.scope.reserveLink();
  const itemScopes = items.map((_, index) =>
    frame.scope.child({ path: `${path}/[${keys[index]}]`, concurrent: true, priority: { depth: 0, index } }),
  );
  const results: unknown[] = items.map(() => null);
  const gate = new Gate(opts.maxInFlight ?? Number.POSITIVE_INFINITY);

  const runItem = async (index: number): Promise<void> => {
    await gate.enter();
    try {
      const itemScope = itemScopes[index] as Scope;
      const ctx: StageContext<unknown> = { item: items[index], index, key: keys[index] as string };
      let prev: unknown = items[index];
      for (let s = 0; s < stages.length; s++) {
        const stageScope = itemScope.child({
          path: `${itemScope.path}/stage#${s}`,
          concurrent: false,
          priority: { depth: s, index },
        });
        const advance = itemScope.reserveLink();
        try {
          prev = await startIn(stageScope, () => (stages[s] as Stage<unknown, unknown, unknown>)(prev, ctx));
        } catch (error) {
          if (isFatal(error)) {
            advance(null);
            throw error;
          }
          advance(() => stageScope.chainHead);
          frame.run.dropped++;
          frame.run.emit({
            type: "item.dropped",
            level: "warn",
            callPath: itemScope.path,
            data: { index, key: ctx.key, stage: s, error: errorData(error) },
          });
          return;
        }
        advance(() => stageScope.chainHead);
        if (prev === null || prev === undefined) return;
      }
      results[index] = prev;
    } finally {
      gate.leave();
    }
  };

  const promises = items.map((_, index) => runItem(index));
  try {
    await settleAll(
      promises,
      () => {},
      () => {},
    );
  } catch (error) {
    link(null);
    throw error;
  }
  link((head) =>
    foldHeads(
      "pipeline",
      head,
      itemScopes.map((s) => s.chainHead),
    ),
  );
  return results;
}

function parsePipelineArgs(args: PipelineArgs): {
  opts: PipelineOptions<unknown>;
  items: readonly unknown[];
  stages: Stage<unknown, unknown, unknown>[];
} {
  const [first, ...rest] = args as unknown[];
  let opts: PipelineOptions<unknown> = {};
  let items: unknown;
  let stages: unknown[];
  if (Array.isArray(first)) {
    items = first;
    stages = rest;
  } else if (first !== null && typeof first === "object") {
    opts = first as PipelineOptions<unknown>;
    items = rest[0];
    stages = rest.slice(1);
  } else {
    throw new ConfigError("pipeline() takes (items, ...stages) or (opts, items, ...stages).");
  }
  if (!Array.isArray(items)) throw new ConfigError("pipeline() items must be an array.");
  if (stages.length === 0 || stages.length > 8) throw new ConfigError("pipeline() takes 1 to 8 stages.");
  if (!stages.every((s) => typeof s === "function")) {
    throw new ConfigError(
      "Every pipeline() stage must be a function (prev, { item, index, key }) => Promise<next | null>.",
    );
  }
  if (opts.key !== undefined && typeof opts.key !== "function")
    throw new ConfigError("pipeline() opts.key must be a function.");
  if (opts.maxInFlight !== undefined && !(Number.isInteger(opts.maxInFlight) && opts.maxInFlight > 0)) {
    throw new ConfigError("pipeline() opts.maxInFlight must be a positive integer.");
  }
  return { opts, items, stages: stages as Stage<unknown, unknown, unknown>[] };
}

/** Bounds items in flight; waiting items are admitted in item order. */
class Gate {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  enter(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  leave(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

const STEP_MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/** Journaled non-agent work. On replay it returns the stored value. Values are JSON, ≤ 256 KiB. */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const frame = currentFrame("step");
  if (typeof fn !== "function") throw new ConfigError(`step("${name}", fn) needs a function.`);
  const call = new OpenedCall(frame, { kind: "step", name: "step", label: name, target: `step:${name}` });
  if (call.cached) return rehydrate(frame, call.replay()) as T;

  try {
    await frame.run.settleWrites();
    await call.start();
  } catch (error) {
    call.abandon();
    throw error;
  }
  let value: T;
  try {
    value = await internal(() => fn());
  } catch (error) {
    await call.fail(error).catch(() => {});
    throw error;
  }
  let stored: unknown;
  try {
    stored = toStepValue(name, value);
  } catch (error) {
    await call.fail(error).catch(() => {});
    throw error;
  }
  await call.complete(stored);
  return rehydrate(frame, stored) as T;
}

function toStepValue(name: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    throw new ConfigError(`step("${name}") returned a value that is not JSON: ${(cause as Error).message}`, { cause });
  }
  const bytes = encoder.encode(text).length;
  if (bytes > STEP_MAX_BYTES) {
    throw new ConfigError(
      `step("${name}") returned ${bytes} bytes; step values are capped at 256 KiB. Store large data with the artifact store and return the ArtifactRef.`,
    );
  }
  return JSON.parse(text);
}

function isArtifactRefJson(v: Record<string, unknown>): v is ArtifactRefJson & Record<string, unknown> {
  return (
    Object.keys(v).length === 4 &&
    typeof v.uri === "string" &&
    typeof v.bytes === "number" &&
    typeof v.sha256 === "string" &&
    typeof v.contentType === "string"
  );
}

/** Restores `text()` on ArtifactRefs inside a step value, live or replayed alike. */
function rehydrate(frame: Frame, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => rehydrate(frame, v));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (isArtifactRefJson(obj)) return frame.run.artifacts.hydrate(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = rehydrate(frame, v);
    return out;
  }
  return value;
}

function clockValue<T>(name: "now" | "random" | "uuid", produce: () => T): T {
  const frame = currentFrame(name);
  const call = new OpenedCall(frame, { kind: "clock", name, target: name });
  if (call.cached) return call.replay() as T;
  const value = produce();
  call.completeSync(value);
  return value;
}

/** Replay-stable clock (journaled per scope). */
export function now(): number {
  return clockValue("now", internalNow);
}

/** Replay-stable random number in [0, 1). */
export function random(): number {
  return clockValue("random", () => {
    let n = 0;
    for (const b of randomBytes(7)) n = n * 256 + b;
    return (n % 2 ** 53) / 2 ** 53;
  });
}

/** Replay-stable UUID. */
export function uuid(): string {
  return clockValue("uuid", () => formatUuidV4(randomBytes(16)));
}

function replaying(frame: Frame): boolean {
  return frame.run.resumed && !frame.scope.live;
}

/** Sets the phase for the rest of the scope. Emits a `phase` event; not journaled. */
export function phase(name: string): void {
  const frame = currentFrame("phase");
  if (typeof name !== "string" || name === "") throw new ConfigError("phase(name) needs a non-empty string.");
  frame.scope.phase = name;
  frame.run.emit({ type: "phase", callPath: frame.scope.path, data: { name }, replayed: replaying(frame) });
}

const LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

/** Emits a `log` event; not journaled. Replayed runs emit it again with `replayed: true`. */
export function log(message: string, data?: Record<string, unknown>): void;
export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
export function log(a: string, b?: string | Record<string, unknown>, c?: Record<string, unknown>): void {
  const frame = currentFrame("log");
  const leveled = typeof b === "string" && LEVELS.has(a);
  const level = (leveled ? a : "info") as LogLevel;
  const message = leveled ? (b as string) : a;
  const data = leveled ? c : (b as Record<string, unknown> | undefined);
  frame.run.emit({
    type: "log",
    level,
    callPath: frame.scope.path,
    data: {
      message,
      ...(data === undefined ? {} : { data }),
      ...(frame.scope.phase ? { phase: frame.scope.phase } : {}),
    },
    replayed: replaying(frame),
  });
}
