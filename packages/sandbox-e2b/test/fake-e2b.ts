// An offline stand-in for an E2B-shape vendor: the control plane in memory, each sandbox a temp directory standing in
// for "/", and envd as local `/bin/sh` processes. Errors are shaped like the real SDKs' (by `name`, `statusCode` or a
// "<status>: " prefix), in either SDK's flavour, so the adapter's classification is exercised as it runs for real.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  E2bCommandHandle,
  E2bCommandOpts,
  E2bCommandResult,
  E2bConnection,
  E2bCreateOpts,
  E2bFileOpts,
  E2bListOpts,
  E2bPaginator,
  E2bSandbox,
  E2bSandboxInfo,
  E2bShapeClient,
} from "../src/client.js";
import type { E2bShapeTimings } from "../src/provider.js";

/** Short deadlines so the ghost and guest-gone cases finish in well under a second offline. */
export const FAST: Partial<E2bShapeTimings> = {
  createDeadlineMs: 10_000,
  openDeadlineMs: 1_500,
  ghostProbeMs: 300,
  pauseDeadlineMs: 2_000,
  pollMs: 20,
  backoffBaseMs: 10,
  backoffCapMs: 50,
};

/** `e2b` sets `statusCode` and throws `ServiceBusyError` on 503; `@impello/sdk` only prefixes "<status>: ". */
export type FakeFlavor = "e2b" | "impello";

export type FakeFaultKind =
  | "503"
  | "500"
  | "501"
  | "400"
  | "network"
  | "timeout"
  | "429"
  | "401"
  | "403"
  | "404"
  | "408"
  | "409"
  | "refuse";

export type FakeMethod =
  | "create"
  | "connect"
  | "list"
  | "getInfo"
  | "kill"
  | "pause"
  | "setTimeout"
  | "createSnapshot"
  | "commands.run"
  | "files.read"
  | "files.write";

export interface FakeCall {
  method: FakeMethod;
  id?: string;
  opts?: Record<string, unknown>;
}

interface Armed {
  kind: FakeFaultKind;
  method: FakeMethod;
  times: number;
}

interface Rec {
  id: string;
  root: string;
  template: string;
  metadata: Record<string, string>;
  state: "running" | "paused";
  startedAt: Date;
  endAt: Date;
  onTimeout: "pause" | "kill";
  allowInternet: boolean;
  ghost?: "not-found" | "guest-gone";
  procs: Set<ChildProcess>;
  /** getInfo answers "running" (or 404) this many more times after a pause, like a slow vendor pause. */
  pauseLag: number;
}

export interface FakeE2bOptions {
  flavor?: FakeFlavor;
  /** Page size of `list`, small by default so pagination is always exercised. */
  pageSize?: number;
  /** Templates that do not exist (create answers 404 "template not found"). */
  missingTemplates?: string[];
  /** Answer getInfo with "running" this many times after each pause. */
  pauseLag?: number;
  /** During that lag, answer 404 instead of "running" (a slow pause seen as gone). */
  pauseLag404?: boolean;
  /** Accept an egress policy at create and never enforce it, as both live vendors were seen to do. */
  ignoreEgress?: boolean;
}

const CANONICAL = /(^|[\s'"=:;&|(<>`{])(\/run\/selfbuilding|\/selfbuilding|\/tmp)(?=$|[/\s'";&|)<>`}])/g;
const ENV_PATH = /^(\/run\/selfbuilding|\/selfbuilding|\/tmp|\/root)(\/|$)/;

function vendorError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, extra);
  return error;
}

function hex(n = 4): string {
  return randomBytes(n).toString("hex");
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

export class FakeE2b {
  readonly base: string;
  readonly calls: FakeCall[] = [];
  readonly flavor: FakeFlavor;
  readonly #recs = new Map<string, Rec>();
  readonly #snapshots = new Map<string, string>();
  readonly #faults: Armed[] = [];
  readonly #opts: FakeE2bOptions;
  #ready: Promise<void> | undefined;
  #clock = 0;

  constructor(opts: FakeE2bOptions = {}) {
    this.#opts = opts;
    this.flavor = opts.flavor ?? "e2b";
    const tmp = existsSync("/tmp") ? realpathSync("/tmp") : "/tmp";
    // Short, so /run/selfbuilding/tools.sock still fits the socket path limit.
    this.base = path.join(tmp, `sbe-${hex(3)}`);
  }

  // ---- test controls -----------------------------------------------------------------------------------------------

  inject(kind: FakeFaultKind, method: FakeMethod, opts: { times?: number } = {}): void {
    this.#faults.push({ kind, method, times: opts.times ?? 1 });
  }

  reset(): void {
    this.#faults.length = 0;
  }

  /** The listing row stays; the box behind it is gone (a positive 404) or silent (the guest never answers). */
  async ghost(id: string, kind: "not-found" | "guest-gone" = "not-found"): Promise<void> {
    const rec = this.#recs.get(id);
    if (!rec) throw new Error(`no sandbox ${id}`);
    await this.#killProcs(rec);
    await fs.rm(rec.root, { recursive: true, force: true });
    rec.ghost = kind;
  }

  /** Lets a box's lifetime run out now; the vendor applies `onTimeout` on its next call. */
  expire(id: string): void {
    const rec = this.#recs.get(id);
    if (rec) rec.endAt = new Date(Date.now() - 1);
  }

  record(id: string): { state: string; metadata: Record<string, string>; endAt: Date; root: string } | undefined {
    const rec = this.#recs.get(id);
    return rec && { state: rec.state, metadata: { ...rec.metadata }, endAt: rec.endAt, root: rec.root };
  }

  ids(): string[] {
    return [...this.#recs.keys()];
  }

  callsTo(method: FakeMethod): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async close(): Promise<void> {
    for (const rec of this.#recs.values()) await this.#killProcs(rec);
    this.#recs.clear();
    await fs.rm(this.base, { recursive: true, force: true, maxRetries: 3 });
  }

  // ---- the SDK surface ---------------------------------------------------------------------------------------------

  /** The vendor's `Sandbox` class statics. */
  get client(): E2bShapeClient {
    return {
      create: (template, opts) => this.#create(template, opts),
      connect: (id, opts) => this.#connect(id, opts),
      list: (opts) => this.#list(opts),
      getInfo: (id, opts) => this.#getInfo(id, opts),
      kill: (id, opts) => this.#kill(id, opts),
      pause: (id, opts) => this.#pause(id, opts),
      setTimeout: (id, ms, opts) => this.#setTimeout(id, ms, opts),
      createSnapshot: (id, opts) => this.#createSnapshot(id, opts),
    };
  }

  // ---- plumbing ----------------------------------------------------------------------------------------------------

  async #init(): Promise<void> {
    this.#ready ??= (async () => {
      const shims = path.join(this.base, ".shims");
      await fs.mkdir(shims, { recursive: true });
      // Everything runs as the test user, so changing owners is a no-op here.
      await fs.writeFile(path.join(shims, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // The vendor blocks egress for boxes created without internet access; here that is emulated for node.
      await fs.writeFile(
        path.join(shims, "deny-net.cjs"),
        `const net=require("net");net.Socket.prototype.connect=function(){process.nextTick(()=>this.destroy(Object.assign(new Error("egress blocked"),{code:"ENETUNREACH"})));return this;};\n`,
      );
      await fs.writeFile(
        path.join(shims, "open-net.cjs"),
        `const net=require("net");net.Socket.prototype.connect=function(){process.nextTick(()=>this.emit("connect"));return this;};\n`,
      );
    })();
    await this.#ready;
  }

  #status(status: number, message: string): Error {
    if (status === 401)
      return vendorError("AuthenticationError", `Unauthorized, please check your credentials. - ${message}`);
    if (status === 429)
      return vendorError("RateLimitError", `Rate limit exceeded, please try again later - ${message}`);
    if (status === 503 && this.flavor === "e2b") {
      return vendorError("ServiceBusyError", `Service temporarily unavailable, please retry - ${message}`, {
        statusCode: 503,
      });
    }
    return this.flavor === "e2b"
      ? vendorError("SandboxError", `${status}: ${message}`, { statusCode: status })
      : vendorError("SandboxError", `${status}: ${message}`);
  }

  #notFound(id: string): Error {
    return vendorError(
      "SandboxNotFoundError",
      `Sandbox ${id} not found`,
      this.flavor === "e2b" ? { statusCode: 404 } : {},
    );
  }

  #unreachable(id: string): Error {
    return vendorError(
      "TimeoutError",
      `[unavailable] sandbox ${id} is not reachable: This error is likely due to sandbox timeout.`,
    );
  }

  /** Consumes a fault armed for `method`. Returns a function that loses the response after the call took effect. */
  #fault(method: FakeMethod, call: Omit<FakeCall, "method">): (() => never) | undefined {
    this.calls.push({ method, ...call });
    const index = this.#faults.findIndex((f) => f.method === method);
    if (index < 0) return undefined;
    const fault = this.#faults[index] as Armed;
    fault.times -= 1;
    if (fault.times <= 0) this.#faults.splice(index, 1);
    switch (fault.kind) {
      case "timeout":
        return () => {
          throw vendorError(
            "TimeoutError",
            "[canceled] The request was aborted: This error is likely due to exceeding 'requestTimeoutMs'.",
          );
        };
      case "network":
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      case "refuse":
        throw this.#status(400, "plan limit reached");
      default:
        throw this.#status(Number(fault.kind), `injected ${fault.kind}`);
    }
  }

  async #tick(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Applies lifetimes lazily, as a vendor would on its own clock. */
  async #expire(rec: Rec): Promise<Rec | undefined> {
    if (rec.state !== "running" || Date.now() < rec.endAt.getTime()) return rec;
    if (rec.onTimeout === "kill") {
      await this.#destroy(rec);
      return undefined;
    }
    await this.#signal(rec, "SIGSTOP");
    rec.state = "paused";
    return rec;
  }

  async #get(id: string): Promise<Rec | undefined> {
    const rec = this.#recs.get(id);
    return rec ? this.#expire(rec) : undefined;
  }

  async #groups(rec: Rec): Promise<number[]> {
    const pids = [...rec.procs].map((p) => p.pid).filter((p): p is number => p !== undefined);
    const procDir = path.join(rec.root, "selfbuilding/state/proc");
    for (const file of await fs.readdir(procDir).catch(() => [] as string[])) {
      if (!file.endsWith(".pid")) continue;
      const pid = Number((await fs.readFile(path.join(procDir, file), "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return pids;
  }

  async #signal(rec: Rec, signal: NodeJS.Signals): Promise<void> {
    for (const pid of await this.#groups(rec)) signalGroup(pid, signal);
  }

  async #killProcs(rec: Rec): Promise<void> {
    await this.#signal(rec, "SIGCONT");
    await this.#signal(rec, "SIGKILL");
    rec.procs.clear();
  }

  async #destroy(rec: Rec): Promise<void> {
    await this.#killProcs(rec);
    await fs.rm(rec.root, { recursive: true, force: true, maxRetries: 3 });
    this.#recs.delete(rec.id);
  }

  #info(rec: Rec): E2bSandboxInfo {
    return {
      sandboxId: rec.id,
      templateId: rec.template,
      metadata: { ...rec.metadata },
      startedAt: rec.startedAt,
      endAt: rec.endAt,
      state: rec.state,
    };
  }

  #now(): Date {
    // Strictly increasing, so "oldest" is never a tie the way two creates in one millisecond would be.
    this.#clock = Math.max(this.#clock + 1, Date.now());
    return new Date(this.#clock);
  }

  // ---- control plane -----------------------------------------------------------------------------------------------

  async #create(template: string, opts: E2bCreateOpts): Promise<E2bSandbox> {
    await this.#init();
    const lose = this.#fault("create", { opts: { ...opts, template } as unknown as Record<string, unknown> });
    await this.#tick();
    if (this.#opts.missingTemplates?.includes(template)) throw this.#status(404, `template '${template}' not found`);
    const id = `i${hex(5)}`;
    const root = path.join(this.base, id);
    const snapshot = this.#snapshots.get(template);
    if (snapshot) await fs.cp(snapshot, root, { recursive: true, verbatimSymlinks: true });
    else if (template.startsWith("snap-")) throw this.#status(404, `snapshot '${template}' not found`);
    // Every Linux box has /tmp; the snapshot copy skipped it.
    await fs.mkdir(path.join(root, "tmp"), { recursive: true });
    const now = this.#now();
    const rec: Rec = {
      id,
      root,
      template,
      metadata: { ...opts.metadata },
      state: "running",
      startedAt: now,
      endAt: new Date(now.getTime() + opts.timeoutMs),
      onTimeout: opts.lifecycle.onTimeout,
      allowInternet:
        this.#opts.ignoreEgress === true || (opts.allowInternetAccess !== false && !opts.network?.denyOut?.length),
      procs: new Set(),
      pauseLag: 0,
    };
    this.#recs.set(id, rec);
    lose?.();
    return this.#instance(rec);
  }

  async #connect(id: string, opts: E2bConnection & { timeoutMs: number }): Promise<E2bSandbox> {
    const lose = this.#fault("connect", { id, opts: { ...opts } });
    await this.#tick();
    const rec = await this.#get(id);
    if (!rec || rec.ghost === "not-found") {
      // A positive 404: the vendor's listing drops the dead row now.
      if (rec) this.#recs.delete(id);
      throw this.#notFound(id);
    }
    const now = Date.now();
    if (rec.state === "paused") {
      await this.#signal(rec, "SIGCONT");
      rec.state = "running";
      rec.endAt = new Date(now + opts.timeoutMs);
    } else if (now + opts.timeoutMs > rec.endAt.getTime()) {
      rec.endAt = new Date(now + opts.timeoutMs);
    }
    lose?.();
    return this.#instance(rec);
  }

  #list(opts: E2bListOpts): E2bPaginator {
    const pageSize =
      opts.limit === undefined ? (this.#opts.pageSize ?? 2) : Math.min(opts.limit, this.#opts.pageSize ?? 2);
    let cursor = 0;
    let done = false;
    let snapshot: Rec[] | undefined;
    return {
      get hasNext() {
        return !done;
      },
      nextItems: async () => {
        this.#fault("list", { opts: { query: opts.query } });
        await this.#tick();
        if (!snapshot) {
          const live: Rec[] = [];
          for (const rec of [...this.#recs.values()]) {
            const current = await this.#expire(rec);
            if (current) live.push(current);
          }
          snapshot = live.filter(
            (r) =>
              Object.entries(opts.query.metadata).every(([k, v]) => r.metadata[k] === v) &&
              opts.query.state.includes(r.state),
          );
        }
        const page = snapshot.slice(cursor, cursor + pageSize);
        cursor += page.length;
        done = cursor >= snapshot.length;
        return page.map((r) => this.#info(r));
      },
    };
  }

  async #getInfo(id: string, opts: E2bConnection): Promise<E2bSandboxInfo> {
    this.#fault("getInfo", { id, opts: { ...opts } });
    await this.#tick();
    const rec = await this.#get(id);
    if (!rec || rec.ghost === "not-found") throw this.#notFound(id);
    if (rec.pauseLag > 0) {
      rec.pauseLag -= 1;
      if (this.#opts.pauseLag404) throw this.#notFound(id);
      return { ...this.#info(rec), state: "running" };
    }
    return this.#info(rec);
  }

  async #kill(id: string, opts: E2bConnection): Promise<boolean> {
    const lose = this.#fault("kill", { id, opts: { ...opts } });
    await this.#tick();
    const rec = this.#recs.get(id);
    if (!rec) return false;
    await this.#destroy(rec);
    lose?.();
    return true;
  }

  async #pause(id: string, opts: E2bConnection & { keepMemory?: boolean }): Promise<boolean> {
    const lose = this.#fault("pause", { id, opts: { ...opts } });
    await this.#tick();
    const rec = await this.#get(id);
    if (!rec || rec.ghost) throw this.#notFound(id);
    if (rec.state === "paused") return false;
    await this.#signal(rec, "SIGSTOP");
    rec.state = "paused";
    rec.pauseLag = this.#opts.pauseLag ?? 0;
    lose?.();
    return true;
  }

  async #setTimeout(id: string, ms: number, opts: E2bConnection): Promise<void> {
    const lose = this.#fault("setTimeout", { id, opts: { ...opts, timeoutMs: ms } });
    await this.#tick();
    const rec = await this.#get(id);
    if (!rec || rec.ghost) throw this.#notFound(id);
    rec.endAt = new Date(Date.now() + ms);
    lose?.();
  }

  async #createSnapshot(id: string, opts: E2bConnection & { name?: string }): Promise<{ snapshotId: string }> {
    const lose = this.#fault("createSnapshot", { id, opts: { ...opts } });
    await this.#tick();
    const rec = await this.#get(id);
    if (!rec || rec.ghost) throw this.#notFound(id);
    const snapshotId = `snap-${hex(4)}`;
    const dir = path.join(this.base, ".snapshots", snapshotId);
    // /run and /tmp are tmpfs in a real box; sockets and pipes cannot be copied.
    await fs.cp(rec.root, dir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: async (source) => {
        const rel = path.relative(rec.root, source);
        if (/^(run|tmp)(\/|$)/.test(rel)) return false;
        const stat = await fs.lstat(source);
        return !stat.isSocket() && !stat.isFIFO();
      },
    });
    this.#snapshots.set(snapshotId, dir);
    lose?.();
    return { snapshotId };
  }

  // ---- envd --------------------------------------------------------------------------------------------------------

  #map(root: string, file: string): string {
    const absolute = file.startsWith("/") ? file : path.posix.join("/selfbuilding/home", file);
    return path.join(root, path.posix.normalize(absolute));
  }

  #rewrite(root: string, cmd: string): string {
    return cmd.replace(CANONICAL, (_m: string, lead: string, prefix: string) => `${lead}${root}${prefix}`);
  }

  async #live(id: string, method: FakeMethod, opts?: Record<string, unknown>): Promise<Rec> {
    this.#fault(method, { id, ...(opts ? { opts } : {}) });
    await this.#tick();
    const rec = await this.#get(id);
    if (!rec)
      throw vendorError(
        "TimeoutError",
        `[unavailable] sandbox ${id} was not found: The sandbox is not running anymore.`,
      );
    if (rec.ghost === "guest-gone" || rec.state === "paused") throw this.#unreachable(id);
    if (rec.ghost === "not-found") throw this.#notFound(id);
    return rec;
  }

  #instance(rec: Rec): E2bSandbox {
    return {
      sandboxId: rec.id,
      trafficAccessToken: undefined,
      commands: { run: (cmd, opts) => this.#run(rec.id, cmd, opts) },
      files: {
        read: (file, opts) => this.#read(rec.id, file, opts),
        write: (files, opts) => this.#write(rec.id, files, opts),
      },
      getHost: (port) => `${port}-${rec.id}.fake.local`,
    };
  }

  async #run(id: string, cmd: string, opts: E2bCommandOpts): Promise<E2bCommandHandle> {
    const rec = await this.#live(id, "commands.run", {
      user: opts.user,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      envs: opts.envs,
      cmd,
    });
    const env: Record<string, string> = {
      PATH: `${path.join(this.base, ".shims")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      SELFBUILDING_FS_ROOT: rec.root,
    };
    for (const [k, v] of Object.entries(opts.envs ?? {})) env[k] = ENV_PATH.test(v) ? this.#map(rec.root, v) : v;
    if (!rec.allowInternet) env.NODE_OPTIONS = `--require ${path.join(this.base, ".shims", "deny-net.cjs")}`;
    // Offline tests never touch the real internet: an open box's public connections succeed in a shim instead.
    else if (this.#opts.ignoreEgress) env.NODE_OPTIONS = `--require ${path.join(this.base, ".shims", "open-net.cjs")}`;
    const cwd = this.#map(rec.root, opts.cwd ?? "/");
    await fs.mkdir(cwd, { recursive: true });
    const child = spawn("/bin/sh", ["-c", this.#rewrite(rec.root, cmd)], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    rec.procs.add(child);
    let forward = true;
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = out.write(chunk);
      stdout = (stdout + text).slice(-1_000_000);
      if (forward && text) void opts.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = err.write(chunk);
      stderr = (stderr + text).slice(-1_000_000);
      if (forward && text) void opts.onStderr?.(text);
    });
    let deadlineHit = false;
    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            deadlineHit = true;
            if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
          }, opts.timeoutMs)
        : undefined;
    const done = new Promise<E2bCommandResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () => {
        // A backgrounded grandchild can keep the pipes open; stop reading shortly after the shell exits.
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, 50);
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        rec.procs.delete(child);
        const tailOut = out.end();
        const tailErr = err.end();
        if (forward && tailOut) void opts.onStdout?.(tailOut);
        if (forward && tailErr) void opts.onStderr?.(tailErr);
        if (deadlineHit) {
          reject(
            vendorError(
              "TimeoutError",
              "[deadline_exceeded] context deadline exceeded: This error is likely due to exceeding 'timeoutMs'.",
            ),
          );
          return;
        }
        const exitCode = code ?? 128 + (signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 1);
        const result = { exitCode, stdout, stderr };
        if (exitCode === 0) resolve(result);
        else reject(vendorError("CommandExitError", `Command exited with code ${exitCode}`, result));
      });
    });
    // The real SDK leaves an unobserved rejection on a disconnected handle; keep the test process quiet about it.
    done.catch(() => undefined);
    return {
      pid: child.pid ?? -1,
      wait: () => done,
      kill: async () =>
        child.pid !== undefined && child.exitCode === null ? signalGroup(child.pid, "SIGKILL") : false,
      disconnect: async () => {
        forward = false;
      },
    };
  }

  async #read(id: string, file: string, opts: E2bFileOpts & { format: "bytes" }): Promise<Uint8Array> {
    const rec = await this.#live(id, "files.read", { user: opts.user, path: file });
    try {
      const data = await fs.readFile(this.#map(rec.root, file));
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
        throw vendorError("FileNotFoundError", `Path not found: ${file}`);
      }
      throw error;
    }
  }

  async #write(
    id: string,
    files: { path: string; data: string | ArrayBuffer }[],
    opts?: E2bFileOpts,
  ): Promise<unknown> {
    const rec = await this.#live(id, "files.write", { user: opts?.user, paths: files.map((f) => f.path) });
    for (const file of files) {
      const target = this.#map(rec.root, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, typeof file.data === "string" ? file.data : new Uint8Array(file.data));
    }
    return files.map((f) => ({ name: path.posix.basename(f.path), path: f.path }));
  }
}

/** Maps the conformance suite's operation names onto the vendor calls they lead to. */
export function conformanceFaults(fake: FakeE2b) {
  const methods: Record<string, FakeMethod> = {
    find: "list",
    list: "list",
    openOrCreate: "list",
    open: "connect",
    pause: "pause",
    kill: "kill",
    create: "create",
    snapshot: "createSnapshot",
    fork: "createSnapshot",
    "fork.child": "create",
    exec: "commands.run",
    spawn: "commands.run",
    attach: "commands.run",
    readFile: "files.read",
    writeFiles: "files.write",
    extendLifetime: "setTimeout",
  };
  return {
    inject(kind: FakeFaultKind, op: string, opts?: { times?: number }): void {
      const method = methods[op];
      if (!method) throw new Error(`no vendor call for "${op}"`);
      fake.inject(kind === "refuse" && op !== "pause" ? "503" : kind, method, opts);
    },
    reset(): void {
      fake.reset();
    },
  };
}
