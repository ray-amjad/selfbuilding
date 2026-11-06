import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type ExecOpts,
  type ExecResult,
  type OnLine,
  type ProcessRef,
  type ProviderSandbox,
  SANDBOX_PATHS,
  SandboxCommandTimeoutError,
  SandboxFileNotFoundError,
  SandboxNotFoundError,
  type SandboxRef,
  SandboxUnavailableError,
  SandboxUnsupportedError,
  SELFBUILDING_LABELS,
  SecretInEnvError,
  type SpawnOpts,
  type WriteFileEntry,
} from "@selfbuilding/core";
import type { DockerContainer, DockerExec } from "./client.js";
import { classify, containerMissing, daemonMessage, type ErrorContext, statusOf } from "./errors.js";
import { looksSecret } from "./labels.js";
import { collect, Demuxer, LineSplitter, Tail } from "./stream.js";
import { packTar, unpackTar } from "./tar.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_TAIL_BYTES = 65_536;
/** How much of a spawned process's log one attach poll reads. */
const ATTACH_CHUNK = 1024 * 1024;
/** The lease file that carries an extended lifetime; container labels cannot change after create. */
export const LEASE_PATH = `${SANDBOX_PATHS.state}/expires-at`;

/** Creates missing directories from (owner, dir) argument pairs, top-down, owned like the file that needs them. */
const MKDIRS_SCRIPT = [
  "id agent >/dev/null 2>&1 && u=agent || u=",
  'while [ "$#" -ge 2 ]; do',
  '  if [ ! -d "$2" ]; then',
  '    mkdir "$2" || exit 1',
  '    if [ "$1" = agent ] && [ -n "$u" ]; then chown agent:agent "$2" || exit 1; fi',
  "  fi",
  "  shift 2",
  "done",
].join("\n");

/** Sets owner and mode from (owner, octal mode, path) argument triples. */
const OWN_SCRIPT = [
  "id agent >/dev/null 2>&1 && u=agent || u=",
  'while [ "$#" -ge 3 ]; do',
  '  if [ "$1" = agent ] && [ -n "$u" ]; then chown agent:agent "$3" || exit 1; else chown root:root "$3" || exit 1; fi',
  '  chmod "$2" "$3" || exit 1',
  "  shift 3",
  "done",
].join("\n");

/**
 * The detached-exec shim of invariant 12, run with (cmd file, exit file, log file, stdin file). The command arrives
 * on stdin, so it never meets argv; the shim's own shell records the exit code atomically, and its trap is a handler
 * (not an ignore) so children keep the default. The cmd and log files are private, but the command itself runs under
 * the exec's own umask: a 077 leaking into the supervisor makes every file it checks out unreadable to the agent.
 */
export const SPAWN_SCRIPT = [
  "m=$(umask)",
  "umask 077",
  'cat > "$1" || exit 1',
  `setsid nohup /bin/sh -c 'trap : INT TERM; umask "$3"; /bin/sh "$1"; c=$?; printf %s "$c" > "$2.tmp" && mv "$2.tmp" "$2"' sb-shim "$1" "$2" "$m" < "$4" > "$3" 2>&1 &`,
  "echo $!",
].join("\n");

/** What a handle needs from its provider. */
export interface SandboxHost {
  readonly id: string;
  readonly maxLifetimeMs: number;
  readonly pollMs: number;
  readonly graceMs: number;
  container(id: string): DockerContainer;
  ctx(sandboxId?: string): ErrorContext;
  /** Settles when this provider's own snapshot commit of the box ends; undefined when none is running. */
  committing(id: string): Promise<void> | undefined;
}

export interface RawExecOptions {
  cmd: string[];
  user: "agent" | "root";
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string | Uint8Array;
  timeoutMs: number;
  graceMs: number;
  onData?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}

export interface RawExecResult {
  exitCode: number;
  /** The client-side watchdog fired; the process may still be running. */
  abandoned: boolean;
  elapsedMs: number;
}

/** Thrown when the attach stream closed while the daemon still reports the process as running. */
class StreamLost extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function homeFor(user: "agent" | "root"): string {
  return user === "root" ? "/root" : SANDBOX_PATHS.home;
}

/** Resolves a sandbox path; relative paths are relative to the workdir. */
export function sandboxPath(p: string): string {
  return path.posix.normalize(p.startsWith("/") ? p : path.posix.join(SANDBOX_PATHS.workdir, p));
}

/**
 * Wraps a command in GNU `timeout`, which leads its own process group and kills the whole group, so the deadline is
 * enforced inside the box. The command travels as an argument, never spliced into the script.
 */
export function timeoutArgv(cmd: string, timeoutMs: number): string[] {
  const seconds = `${Math.max(timeoutMs, 1) / 1000}s`;
  return [
    "/bin/sh",
    "-c",
    'if command -v timeout >/dev/null 2>&1; then exec timeout -s KILL "$1" /bin/sh -c "$2"; fi; exec /bin/sh -c "$2"',
    "sb-exec",
    seconds,
    cmd,
  ];
}

async function exitCodeOf(exec: DockerExec, waitMs: number): Promise<number> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const info = await exec.inspect();
    if (!info.Running && info.ExitCode !== null) return info.ExitCode;
    if (Date.now() >= deadline) throw new StreamLost("The exec stream closed while the process was still running.");
    await sleep(25);
  }
}

/** Runs one exec with `Tty: false`, piping stdin then closing it, and demultiplexing stdout from stderr. */
export async function runExec(container: DockerContainer, o: RawExecOptions): Promise<RawExecResult> {
  const env = { HOME: homeFor(o.user), LANG: "C.UTF-8", ...o.env };
  const exec = await container.exec({
    Cmd: o.cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: o.user,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    WorkingDir: o.cwd ?? SANDBOX_PATHS.workdir,
  });
  const stream = await exec.start({ hijack: true, stdin: true, Detach: false, Tty: false });
  const started = Date.now();
  const demux = new Demuxer((which, chunk) => o.onData?.(which, chunk));
  return new Promise<RawExecResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn();
    };
    const watchdog = setTimeout(() => {
      settle(() => {
        stream.destroy();
        resolve({ exitCode: -1, abandoned: true, elapsedMs: Date.now() - started });
      });
    }, o.timeoutMs + o.graceMs);
    stream.on("data", (chunk: Buffer) => {
      if (!settled) demux.push(chunk);
    });
    // A process that never reads stdin can close the pipe under a large write; the exit code still decides.
    stream.on("error", () => undefined);
    const finish = () => {
      if (settled) return;
      exitCodeOf(exec, 2_000).then(
        (exitCode) => settle(() => resolve({ exitCode, abandoned: false, elapsedMs: Date.now() - started })),
        (error: unknown) => settle(() => reject(error)),
      );
    };
    stream.on("end", finish);
    stream.on("close", finish);
    if (o.stdin !== undefined && o.stdin.length > 0) stream.write(Buffer.from(o.stdin));
    stream.end();
  });
}

/** A connected Docker sandbox. Every call goes to the daemon; a handle held across a pause fails loudly. */
export class DockerSandbox implements ProviderSandbox {
  readonly ref: SandboxRef;
  readonly #host: SandboxHost;
  readonly #container: DockerContainer;

  constructor(host: SandboxHost, ref: SandboxRef) {
    this.#host = host;
    this.ref = ref;
    this.#container = host.container(ref.id);
  }

  #ctx(): ErrorContext {
    return this.#host.ctx(this.ref.id);
  }

  /**
   * Runs one exec. A snapshot or fork commit freezes the box for its copy, so an exec that lands meanwhile gets a
   * 409 "is paused" for a pause nobody asked for: wait for that commit and run again. A rejected exec never started,
   * so the retry cannot run a command twice. A pause from `provider.pause` still fails loudly.
   */
  async #run(o: RawExecOptions): Promise<RawExecResult> {
    for (let unexplained = 0; ; ) {
      try {
        return await runExec(this.#container, o);
      } catch (error) {
        if (!(statusOf(error) === 409 && /is paused/i.test(daemonMessage(error)))) throw error;
        const commit = this.#host.committing(this.ref.id);
        if (commit) {
          await commit.catch(() => undefined);
          continue;
        }
        // The commit may have ended between the rejection and now.
        const paused = await this.#container.inspect().then(
          (info) => info.State.Paused,
          () => true,
        );
        if (paused || ++unexplained > 3) throw error;
      }
    }
  }

  #checkEnv(env: Record<string, string> | undefined): void {
    for (const name of Object.keys(env ?? {})) {
      if (looksSecret(name)) throw new SecretInEnvError({ variable: name });
    }
  }

  /** Runs an internal script as root and returns its stdout; a non-zero exit is an error here. */
  async #root(
    name: string,
    script: string,
    args: string[],
    o: { stdin?: string | Uint8Array; timeoutMs?: number } = {},
  ) {
    const stdout: Buffer[] = [];
    const stderr = new Tail(4096);
    let result: RawExecResult;
    try {
      result = await this.#run({
        cmd: ["/bin/sh", "-c", script, `sb-${name}`, ...args],
        user: "root",
        cwd: "/",
        timeoutMs: o.timeoutMs ?? 30_000,
        graceMs: this.#host.graceMs,
        ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
        onData: (which, chunk) => (which === "stdout" ? stdout.push(chunk) : stderr.push(chunk)),
      });
    } catch (error) {
      throw classify(error, this.#ctx());
    }
    if (result.abandoned || result.exitCode !== 0) {
      throw new SandboxUnavailableError(this.#ctx(), {
        message: `An internal sandbox step failed in ${this.ref.id} (exit ${result.exitCode}): ${stderr.toString().trim()}`,
      });
    }
    return Buffer.concat(stdout);
  }

  async exec(cmd: string, o: ExecOpts = {}): Promise<ExecResult> {
    this.#checkEnv(o.env);
    const timeoutMs = o.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const tailBytes = o.maxTailBytes ?? DEFAULT_TAIL_BYTES;
    const user = o.user ?? "agent";
    const tails = { stdout: new Tail(tailBytes), stderr: new Tail(tailBytes) };
    const lines = {
      stdout: new LineSplitter((line) => o.onLine?.("stdout", line)),
      stderr: new LineSplitter((line) => o.onLine?.("stderr", line)),
    };
    let result: RawExecResult;
    try {
      result = await this.#run({
        cmd: timeoutArgv(cmd, timeoutMs),
        user,
        ...(o.env === undefined ? {} : { env: o.env }),
        cwd: sandboxPath(o.cwd ?? SANDBOX_PATHS.workdir),
        ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
        timeoutMs,
        graceMs: this.#host.graceMs,
        onData: (which, chunk) => {
          tails[which].push(chunk);
          lines[which].push(chunk);
        },
      });
    } catch (error) {
      if (error instanceof StreamLost) {
        throw new SandboxUnavailableError(this.#ctx(), {
          cause: error,
          message: `Lost the stream of a command in ${this.ref.id}; it may still be running: ${cmd}`,
        });
      }
      throw classify(error, this.#ctx());
    } finally {
      lines.stdout.end();
      lines.stderr.end();
    }
    // GNU timeout exits 124, or 137 when its KILL also reaches itself.
    const killedByDeadline =
      (result.exitCode === 137 || result.exitCode === 124) && result.elapsedMs >= timeoutMs * 0.9;
    if (result.abandoned || killedByDeadline) {
      throw new SandboxCommandTimeoutError({
        ...this.#ctx(),
        cmd,
        mayStillBeRunning: result.abandoned,
        ...(o.idempotent === undefined ? {} : { idempotent: o.idempotent }),
      });
    }
    return {
      exitCode: result.exitCode,
      stdoutTail: tails.stdout.toString(),
      stderrTail: tails.stderr.toString(),
      truncated: tails.stdout.truncated || tails.stderr.truncated,
    };
  }

  async spawn(cmd: string, o: SpawnOpts = {}): Promise<ProcessRef> {
    this.#checkEnv(o.env);
    const id = `p${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const logPath = `${SANDBOX_PATHS.proc}/${id}.log`;
    const exitPath = `${SANDBOX_PATHS.proc}/${id}.exit`;
    const cmdPath = `${SANDBOX_PATHS.proc}/${id}.cmd`;
    const stdout: Buffer[] = [];
    const stderr = new Tail(4096);
    let result: RawExecResult;
    try {
      result = await this.#run({
        cmd: [
          "/bin/sh",
          "-c",
          SPAWN_SCRIPT,
          "sb-spawn",
          cmdPath,
          exitPath,
          logPath,
          o.stdinFile ? sandboxPath(o.stdinFile) : "/dev/null",
        ],
        user: o.user ?? "agent",
        ...(o.env === undefined ? {} : { env: o.env }),
        cwd: sandboxPath(o.cwd ?? SANDBOX_PATHS.workdir),
        stdin: `${cmd}\n`,
        timeoutMs: 30_000,
        graceMs: this.#host.graceMs,
        onData: (which, chunk) => (which === "stdout" ? stdout.push(chunk) : stderr.push(chunk)),
      });
    } catch (error) {
      // Never retried: the process may have started.
      throw classify(error, this.#ctx());
    }
    const pid = Number.parseInt(Buffer.concat(stdout).toString("utf8").trim(), 10);
    if (result.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
      throw new SandboxUnavailableError(this.#ctx(), {
        message: `Could not start a detached process in ${this.ref.id} (exit ${result.exitCode}): ${stderr.toString().trim()}`,
      });
    }
    return { id, pgid: pid, vendorPid: String(pid), logPath, exitPath, startedAt: new Date().toISOString() };
  }

  async attach(
    p: ProcessRef,
    o: { fromOffset: number; onLine?: OnLine; signal?: AbortSignal },
  ): Promise<{ state: "running" | "exited"; exitCode?: number; offset: number }> {
    let offset = o.fromOffset;
    const poll = [
      'e=_; [ -f "$1" ] && e=$(cat "$1")',
      'a=1; if [ -n "$3" ]; then a=0; kill -0 -"$3" 2>/dev/null && a=1; fi',
      `printf '%s %s\\n' "\${e:-_}" "$a"`,
      'tail -c +"$4" "$2" 2>/dev/null | head -c "$5"',
    ].join("\n");
    const read = async () => {
      const out = await this.#root("attach", poll, [
        p.exitPath,
        p.logPath,
        p.pgid === undefined ? "" : String(p.pgid),
        String(offset + 1),
        String(ATTACH_CHUNK),
      ]);
      const newline = out.indexOf(0x0a);
      const [exit, alive] = out.subarray(0, newline).toString("utf8").split(" ");
      return { exit: exit === "_" ? undefined : Number(exit), alive: alive === "1", data: out.subarray(newline + 1) };
    };
    // Only whole lines are reported while the process runs; the final drain reports a trailing partial line too.
    const emit = (data: Buffer, final: boolean): number => {
      let usable = final ? data.length : data.lastIndexOf(0x0a) + 1;
      // A line longer than one read is split rather than waited on forever.
      if (usable <= 0 && data.length >= ATTACH_CHUNK) usable = data.length;
      if (usable <= 0) return 0;
      const lines = data.subarray(0, usable).toString("utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (const line of lines) o.onLine?.("stdout", line);
      offset += usable;
      return usable;
    };
    for (let confirmDeath = false; ; ) {
      const { exit, alive, data } = await read();
      if (exit !== undefined || (!alive && confirmDeath)) {
        emit(data, data.length < ATTACH_CHUNK);
        if (data.length >= ATTACH_CHUNK) continue;
        return exit !== undefined && Number.isFinite(exit)
          ? { state: "exited", exitCode: exit, offset }
          : { state: "exited", offset };
      }
      // The group can die a moment before its exit code lands; look once more before calling it killed.
      confirmDeath = !alive;
      const consumed = emit(data, false);
      if (data.length >= ATTACH_CHUNK && consumed > 0) continue;
      if (o.signal?.aborted) return { state: "running", offset };
      if (!confirmDeath) await sleep(this.#host.pollMs);
    }
  }

  async #containerGone(): Promise<boolean> {
    try {
      await this.#container.inspect();
      return false;
    } catch (error) {
      if (statusOf(error) === 404) return true;
      throw classify(error, this.#ctx());
    }
  }

  async readFile(file: string): Promise<Uint8Array> {
    let target = sandboxPath(file);
    for (let hops = 0; hops < 8; hops++) {
      let archive: Buffer;
      try {
        archive = await collect(await this.#container.getArchive({ path: target }));
      } catch (error) {
        if (statusOf(error) === 404) {
          // Without the daemon's body, ask the daemon whether the box itself still exists.
          const gone = containerMissing(error) ?? (await this.#containerGone());
          if (gone) throw new SandboxNotFoundError(this.#ctx(), { cause: error });
          throw new SandboxFileNotFoundError({ ...this.#ctx(), path: file }, { cause: error });
        }
        throw classify(error, this.#ctx());
      }
      const [entry] = unpackTar(archive);
      if (entry?.type === "file")
        return new Uint8Array(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
      if (entry?.type !== "symlink") break;
      target = path.posix.resolve(path.posix.dirname(target), entry.target);
    }
    throw new SandboxFileNotFoundError({ ...this.#ctx(), path: file });
  }

  async writeFiles(files: WriteFileEntry[]): Promise<void> {
    if (files.length === 0) return;
    const entries = files.map((f) => ({
      path: sandboxPath(f.path),
      data: typeof f.data === "string" ? Buffer.from(f.data) : f.data,
      mode: f.mode ?? 0o644,
      owner: f.owner ?? "agent",
    }));
    // Missing parent directories are created first, owned like the file that needs them.
    const dirs = new Map<string, "agent" | "root">();
    for (const entry of entries) {
      const parts = path.posix.dirname(entry.path).split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const dir = `/${parts.slice(0, i).join("/")}`;
        if (!dirs.has(dir)) dirs.set(dir, entry.owner);
      }
    }
    await this.#root(
      "mkdirs",
      MKDIRS_SCRIPT,
      [...dirs].flatMap(([dir, owner]) => [owner, dir]),
    );
    try {
      await this.#container.putArchive(
        packTar(entries.map((e) => ({ name: e.path.slice(1), data: e.data, mode: e.mode }))),
        { path: "/" },
      );
    } catch (error) {
      throw classify(error, this.#ctx());
    }
    // The archive's owner and mode handling differs across daemon versions, so both are set explicitly afterwards.
    await this.#root(
      "own",
      OWN_SCRIPT,
      entries.flatMap((e) => [e.owner, e.mode.toString(8), e.path]),
    );
  }

  async extendLifetime(untilMs: number): Promise<{ untilMs: number; clamped: boolean }> {
    const max = Date.parse(this.ref.createdAt) + this.#host.maxLifetimeMs;
    const clamped = untilMs > max;
    const target = clamped ? max : untilMs;
    const iso = new Date(target).toISOString();
    // Docker has no TTL: the reaper reads this lease (through find/list) and stops the box once it passes.
    await this.#root("lease", `printf '%s' "$1" > "$2.tmp" && mv "$2.tmp" "$2"`, [iso, LEASE_PATH]);
    this.ref.labels[SELFBUILDING_LABELS.expiresAt] = iso;
    return { untilMs: target, clamped };
  }

  async previewUrl(port: number): Promise<{ url: string; headers: Record<string, string> }> {
    let ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null | undefined;
    try {
      ports = (await this.#container.inspect()).NetworkSettings?.Ports;
    } catch (error) {
      throw classify(error, this.#ctx());
    }
    const binding = ports?.[`${port}/tcp`]?.[0];
    if (!binding?.HostPort) {
      throw new SandboxUnsupportedError(
        { ...this.#ctx(), op: `previewUrl(${port})` },
        { message: `Port ${port} was not declared in SandboxSpec.ports when ${this.ref.id} was created.` },
      );
    }
    const host =
      binding.HostIp && binding.HostIp !== "0.0.0.0" && binding.HostIp !== "::" ? binding.HostIp : "127.0.0.1";
    return { url: `http://${host}:${binding.HostPort}`, headers: {} };
  }
}
