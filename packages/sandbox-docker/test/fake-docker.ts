import { randomBytes } from "node:crypto";
import path from "node:path";
import { Duplex, Readable } from "node:stream";
import type {
  DockerClient,
  DockerContainer,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerCreateOptions,
  DockerExec,
  DockerExecCreate,
} from "../src/client.js";
import { frame } from "../src/stream.js";
import { packTar, unpackTar } from "../src/tar.js";

// An in-memory Docker Engine double: containers, labels, names, states, files (through the archive API), images and
// commits. Execs are interpreted by their argv0 marker; user commands go to a scriptable handler.

/** Shaped like the HTTP client's rejection; `reason` is the per-endpoint text it prefixes, e.g. "no such container". */
export function httpError(statusCode: number, message: string, reason?: string): Error {
  const text = `(HTTP code ${statusCode}) ${reason === undefined ? "" : `${reason} - `}${message}`;
  return Object.assign(new Error(text), { statusCode, json: { message }, ...(reason === undefined ? {} : { reason }) });
}

/** The client labels every 404 on the archive endpoint "no such container", even a missing path. */
function archiveError(error: unknown): unknown {
  const e = error as { statusCode?: number; json?: { message: string } };
  return e.statusCode === 404 && e.json ? httpError(404, e.json.message, "no such container") : error;
}

export function netError(code = "ECONNRESET"): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

interface FakeFile {
  data: Buffer;
  mode: number;
  owner: string;
  symlink?: string;
}

export interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  env: string[];
  state: "created" | "running" | "paused" | "exited" | "dead";
  created: Date;
  files: Map<string, FakeFile>;
  dirs: Set<string>;
  options: DockerCreateOptions;
  /** The guest never answers an exec (a ghost whose control plane still lists it). */
  guestGone?: boolean;
  processes: Map<number, FakeProcess>;
}

interface FakeProcess {
  pid: number;
  alive: boolean;
}

interface FakeImage {
  labels: Record<string, string>;
  env: string[];
  files: Map<string, FakeFile>;
}

export interface CommandContext {
  container: FakeContainer;
  cmd: string;
  user: string;
  env: Record<string, string>;
  cwd: string;
  stdin: Buffer;
}

/** What a user command does. `durationMs` beyond the exec's timeout ends like GNU timeout's KILL (137). */
export interface CommandResult {
  stdout?: string | Buffer | Array<{ text: string; afterMs: number; stream?: "stdout" | "stderr" }>;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  /** Never ends (the in-box timeout is missing or ignored). */
  hang?: boolean;
}

/** A detached process: lines are appended to its log over time, then it writes its exit code. */
export interface SpawnScript {
  lines?: Array<{ text: string; afterMs: number }>;
  exitCode?: number;
  exitAfterMs?: number;
  /** Dies without writing an exit code (killed by a signal). */
  killed?: boolean;
}

type Method =
  | "createContainer"
  | "listContainers"
  | "inspect"
  | "start"
  | "pause"
  | "unpause"
  | "remove"
  | "rename"
  | "exec"
  | "putArchive"
  | "getArchive"
  | "commit"
  | "pull"
  | "imageInspect"
  | "buildImage";

interface Armed {
  method: Method;
  error: Error;
  times: number;
  /** The call takes effect, then the response is lost. */
  after: boolean;
}

const VOLUMES = ["/run/selfbuilding", "/tmp"];

export class FakeDocker implements DockerClient {
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Map<string, FakeImage>();
  readonly calls: string[] = [];
  readonly pulled: string[] = [];
  readonly built: Array<{ t: string; buildargs?: Record<string, string>; dockerfile: string }> = [];
  pullError: string | undefined;
  onCommand: (ctx: CommandContext) => CommandResult | Promise<CommandResult> = () => ({ exitCode: 0 });
  onSpawn: (ctx: CommandContext) => SpawnScript = () => ({ exitCode: 0 });
  /** Pause leaves the container running for this many inspects (a slow freezer). */
  pauseLag = 0;
  /** How long a pausing commit keeps the box frozen. */
  commitMs = 0;
  readonly #armed: Armed[] = [];
  #nextPid = 100;

  constructor(images: string[] = ["selfbuilding/base:test"]) {
    for (const image of images)
      this.images.set(image, { labels: {}, env: ["PATH=/usr/local/bin:/usr/bin:/bin"], files: new Map() });
  }

  fail(method: Method, error: Error, opts: { times?: number; after?: boolean } = {}): void {
    this.#armed.push({ method, error, times: opts.times ?? 1, after: opts.after ?? false });
  }

  #check(method: Method, phase: "before" | "after"): void {
    const index = this.#armed.findIndex((a) => a.method === method && a.after === (phase === "after"));
    if (index < 0) return;
    const armed = this.#armed[index] as Armed;
    armed.times -= 1;
    if (armed.times <= 0) this.#armed.splice(index, 1);
    throw armed.error;
  }

  async #call<T>(method: Method, fn: () => T | Promise<T>): Promise<T> {
    this.calls.push(method);
    await Promise.resolve();
    this.#check(method, "before");
    const value = await fn();
    this.#check(method, "after");
    return value;
  }

  byName(name: string): FakeContainer | undefined {
    for (const c of this.containers.values()) if (c.name === name) return c;
    return undefined;
  }

  only(): FakeContainer {
    const all = [...this.containers.values()];
    if (all.length !== 1) throw new Error(`expected one container, found ${all.length}`);
    return all[0] as FakeContainer;
  }

  #get(id: string): FakeContainer {
    const c = this.containers.get(id) ?? this.byName(id.replace(/^\//, ""));
    if (!c) throw httpError(404, `No such container: ${id}`);
    return c;
  }

  // ---- DockerClient ----------------------------------------------------------------------------------------------

  createContainer(o: DockerCreateOptions): Promise<DockerContainer> {
    return this.#call("createContainer", () => {
      if (this.byName(o.name)) throw httpError(409, `Conflict. The container name "/${o.name}" is already in use.`);
      const image = this.images.get(o.Image);
      if (!image) throw httpError(404, `No such image: ${o.Image}`);
      const id = randomBytes(32).toString("hex");
      const files = new Map<string, FakeFile>();
      for (const [p, f] of image.files) files.set(p, { ...f });
      const container: FakeContainer = {
        id,
        name: o.name,
        image: o.Image,
        labels: { ...image.labels, ...o.Labels },
        env: [...image.env, ...o.Env],
        state: "created",
        created: new Date(),
        files,
        dirs: new Set(["/", "/tmp", "/run", "/run/selfbuilding"]),
        options: o,
        processes: new Map(),
      };
      this.containers.set(id, container);
      return this.getContainer(id);
    });
  }

  getContainer(id: string): DockerContainer {
    return new FakeContainerApi(this, id);
  }

  listContainers(o: { all: boolean; filters: string }): Promise<DockerContainerSummary[]> {
    return this.#call("listContainers", () => {
      const labels = (JSON.parse(o.filters) as { label?: string[] }).label ?? [];
      return [...this.containers.values()]
        .filter((c) =>
          labels.every((f) => {
            const eq = f.indexOf("=");
            return eq < 0 ? f in c.labels : c.labels[f.slice(0, eq)] === f.slice(eq + 1);
          }),
        )
        .map((c) => ({
          Id: c.id,
          Names: [`/${c.name}`],
          State: c.state,
          Created: Math.floor(c.created.getTime() / 1000),
          Labels: { ...c.labels },
        }));
    });
  }

  getImage(name: string): { inspect(): Promise<unknown> } {
    return {
      inspect: () =>
        this.#call("imageInspect", () => {
          if (!this.images.has(name)) throw httpError(404, `No such image: ${name}`);
          return { Id: name };
        }),
    };
  }

  pull(ref: string): Promise<NodeJS.ReadableStream> {
    return this.#call("pull", () => {
      this.pulled.push(ref);
      const events = [{ status: "Pulling" }];
      if (this.pullError) events.push({ error: this.pullError } as never);
      else this.images.set(ref, { labels: {}, env: [], files: new Map() });
      return Readable.from(events.map((e) => `${JSON.stringify(e)}\n`));
    });
  }

  buildImage(context: Buffer, o: { t: string; buildargs?: Record<string, string> }): Promise<NodeJS.ReadableStream> {
    return this.#call("buildImage", () => {
      const dockerfile = unpackTar(context).find((e) => e.name === "Dockerfile");
      this.built.push({ ...o, dockerfile: dockerfile?.type === "file" ? dockerfile.data.toString("utf8") : "" });
      this.images.set(o.t, { labels: {}, env: [], files: new Map() });
      return Readable.from([`${JSON.stringify({ stream: "Step 1/1" })}\n`]);
    });
  }

  // ---- container operations (called by FakeContainerApi) -------------------------------------------------------

  inspect(id: string): Promise<DockerContainerInspect> {
    return this.#call("inspect", () => {
      const c = this.#get(id);
      if (this.pauseLag > 0 && c.state === "paused") this.pauseLag -= 1;
      const visible = this.pauseLag > 0 && c.state === "paused" ? "running" : c.state;
      const ports: Record<string, { HostIp: string; HostPort: string }[]> = {};
      for (const key of Object.keys(c.options.HostConfig.PortBindings ?? {})) {
        ports[key] = [{ HostIp: "127.0.0.1", HostPort: String(30000 + Number.parseInt(key, 10)) }];
      }
      return {
        Id: c.id,
        Name: `/${c.name}`,
        Created: c.created.toISOString(),
        State: {
          Status: visible,
          Running: visible === "running" || visible === "paused",
          Paused: visible === "paused",
          Restarting: false,
          Dead: visible === "dead",
        },
        Config: { Labels: { ...c.labels }, Env: [...c.env], Image: c.image },
        HostConfig: {
          ...(c.options.HostConfig.NetworkMode ? { NetworkMode: c.options.HostConfig.NetworkMode } : {}),
          ...(c.options.HostConfig.PortBindings ? { PortBindings: c.options.HostConfig.PortBindings } : {}),
          ...(c.options.HostConfig.NanoCpus ? { NanoCpus: c.options.HostConfig.NanoCpus } : {}),
          ...(c.options.HostConfig.Memory ? { Memory: c.options.HostConfig.Memory } : {}),
        },
        NetworkSettings: { Ports: ports },
      };
    });
  }

  start(id: string): Promise<unknown> {
    return this.#call("start", () => {
      const c = this.#get(id);
      if (c.state === "running" || c.state === "paused") throw httpError(304, "container already started");
      if (c.state === "dead") throw httpError(500, "container is dead");
      c.state = "running";
      return undefined;
    });
  }

  pause(id: string): Promise<unknown> {
    return this.#call("pause", () => {
      const c = this.#get(id);
      if (c.state === "paused") throw httpError(409, `Container ${id} is already paused`);
      if (c.state !== "running") throw httpError(409, `Container ${id} is not running`);
      c.state = "paused";
      return undefined;
    });
  }

  unpause(id: string): Promise<unknown> {
    return this.#call("unpause", () => {
      const c = this.#get(id);
      if (c.state !== "paused") throw httpError(500, `Container ${id} is not paused`);
      c.state = "running";
      return undefined;
    });
  }

  remove(id: string): Promise<unknown> {
    return this.#call("remove", () => {
      const c = this.#get(id);
      for (const p of c.processes.values()) p.alive = false;
      this.containers.delete(c.id);
      return undefined;
    });
  }

  rename(id: string, name: string): Promise<unknown> {
    return this.#call("rename", () => {
      const c = this.#get(id);
      if (this.byName(name)) throw httpError(409, `name ${name} is in use`);
      c.name = name;
      return undefined;
    });
  }

  commit(id: string, o: { repo: string; tag: string; pause?: boolean }): Promise<{ Id?: string }> {
    return this.#call("commit", async () => {
      const c = this.#get(id);
      // Like the daemon, a pausing commit freezes a running box for the copy, so an exec meanwhile gets a 409.
      if (o.pause && c.state === "running" && this.commitMs > 0) {
        c.state = "paused";
        await new Promise((resolve) => setTimeout(resolve, this.commitMs));
        c.state = "running";
      }
      const files = new Map<string, FakeFile>();
      for (const [p, f] of c.files) {
        if (!VOLUMES.some((v) => p === v || p.startsWith(`${v}/`))) files.set(p, { ...f, data: Buffer.from(f.data) });
      }
      this.images.set(`${o.repo}:${o.tag}`, { labels: { ...c.labels }, env: [...c.env], files });
      return { Id: `sha256:${randomBytes(32).toString("hex")}` };
    });
  }

  putArchive(id: string, data: Buffer, o: { path: string }): Promise<unknown> {
    return this.#call("putArchive", () => {
      const c = this.#get(id);
      for (const entry of unpackTar(data)) {
        const target = path.posix.join(o.path, entry.name);
        if (!c.dirs.has(path.posix.dirname(target)))
          throw httpError(500, `no such directory ${path.posix.dirname(target)}`);
        if (entry.type === "file") c.files.set(target, { data: entry.data, mode: entry.mode, owner: "root" });
      }
      return undefined;
    });
  }

  getArchive(id: string, o: { path: string }): Promise<NodeJS.ReadableStream> {
    return this.#getArchive(id, o).catch((error: unknown) => Promise.reject(archiveError(error)));
  }

  #getArchive(id: string, o: { path: string }): Promise<NodeJS.ReadableStream> {
    return this.#call("getArchive", () => {
      const c = this.#get(id);
      const file = c.files.get(o.path);
      const name = path.posix.basename(o.path);
      if (file?.symlink !== undefined) {
        const entry = Buffer.alloc(512);
        const tar = packTar([]);
        // A symlink entry: built by hand, since the codec only writes regular files.
        entry.write(name, 0);
        entry.write("0000777\0", 100);
        entry.write("0000000\0", 108);
        entry.write("0000000\0", 116);
        entry.write("00000000000\0", 124);
        entry.write("00000000000\0", 136);
        entry.write("2", 156);
        entry.write(file.symlink, 157);
        entry.write("ustar\0", 257);
        entry.write("00", 263);
        entry.fill(" ", 148, 156);
        let sum = 0;
        for (const b of entry) sum += b;
        entry.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        return Readable.from([Buffer.concat([entry, tar])]);
      }
      if (file) return Readable.from([packTar([{ name, data: file.data, mode: file.mode }])]);
      if (c.dirs.has(o.path)) {
        const dir = Buffer.alloc(512);
        dir.write(name, 0);
        dir.write("5", 156);
        return Readable.from([Buffer.concat([dir, Buffer.alloc(1024)])]);
      }
      throw httpError(404, `Could not find the file ${o.path} in container ${id}`);
    });
  }

  async exec(id: string, o: DockerExecCreate): Promise<DockerExec> {
    return this.#call("exec", () => {
      const c = this.#get(id);
      if (c.state === "paused") throw httpError(409, `Container ${id} is paused, unpause the container before exec`);
      if (c.state !== "running") throw httpError(409, `Container ${id} is not running`);
      return new FakeExec(this, c, o);
    });
  }

  // ---- exec interpretation --------------------------------------------------------------------------------------

  async run(c: FakeContainer, o: DockerExecCreate, stdin: Buffer, out: Duplex): Promise<number> {
    const marker = o.Cmd[3];
    const args = o.Cmd.slice(4);
    if (c.guestGone) return new Promise(() => undefined);
    const write = (stream: "stdout" | "stderr", data: string | Buffer) => {
      if (data.length > 0) out.push(frame(stream, data));
    };
    switch (marker) {
      case "sb-layout": {
        for (const d of [
          "/selfbuilding",
          "/selfbuilding/work",
          "/selfbuilding/home",
          "/selfbuilding/out",
          "/selfbuilding/state",
          "/selfbuilding/state/proc",
          "/selfbuilding/bin",
          "/run/selfbuilding/secrets",
        ]) {
          c.dirs.add(d);
        }
        const [expiresAt, lease] = args as [string, string];
        if (expiresAt) c.files.set(lease, { data: Buffer.from(expiresAt), mode: 0o644, owner: "root" });
        return 0;
      }
      case "sb-lease": {
        const [iso, lease] = args as [string, string];
        c.files.set(lease, { data: Buffer.from(iso), mode: 0o644, owner: "root" });
        return 0;
      }
      case "sb-mkdirs": {
        for (let i = 0; i + 1 < args.length; i += 2) c.dirs.add(args[i + 1] as string);
        return 0;
      }
      case "sb-own": {
        for (let i = 0; i + 2 < args.length; i += 3) {
          const file = c.files.get(args[i + 2] as string);
          if (!file) {
            write("stderr", `chown: cannot access '${args[i + 2]}'`);
            return 1;
          }
          file.owner = args[i] as string;
          file.mode = Number.parseInt(args[i + 1] as string, 8);
        }
        return 0;
      }
      case "sb-attach": {
        const [exitPath, logPath, pgid, from, chunk] = args as [string, string, string, string, string];
        const exit = c.files.get(exitPath)?.data.toString() ?? "_";
        const alive = pgid === "" || (c.processes.get(Number(pgid))?.alive ?? false);
        const log = c.files.get(logPath)?.data ?? Buffer.alloc(0);
        const start = Number(from) - 1;
        write(
          "stdout",
          Buffer.concat([Buffer.from(`${exit} ${alive ? 1 : 0}\n`), log.subarray(start, start + Number(chunk))]),
        );
        return 0;
      }
      case "sb-spawn": {
        const [cmdPath, exitPath, logPath] = args as [string, string, string];
        c.files.set(cmdPath, { data: stdin, mode: 0o600, owner: o.User });
        c.files.set(logPath, { data: Buffer.alloc(0), mode: 0o600, owner: o.User });
        const pid = this.#nextPid++;
        const proc: FakeProcess = { pid, alive: true };
        c.processes.set(pid, proc);
        const script = this.onSpawn(this.#context(c, o, stdin.toString().replace(/\n$/, ""), stdin));
        for (const line of script.lines ?? []) {
          setTimeout(() => {
            if (!proc.alive) return;
            const log = c.files.get(logPath);
            if (log) log.data = Buffer.concat([log.data, Buffer.from(line.text)]);
          }, line.afterMs);
        }
        setTimeout(() => {
          if (!proc.alive) return;
          if (!script.killed)
            c.files.set(exitPath, { data: Buffer.from(String(script.exitCode ?? 0)), mode: 0o600, owner: o.User });
          proc.alive = false;
        }, script.exitAfterMs ?? 0);
        write("stdout", `${pid}\n`);
        return 0;
      }
      case "sb-exec": {
        const [seconds, cmd] = args as [string, string];
        const timeoutMs = Number.parseFloat(seconds) * 1000;
        const result = await this.onCommand(this.#context(c, o, cmd, stdin));
        if (result.hang) return new Promise(() => undefined);
        const started = Date.now();
        if (Array.isArray(result.stdout)) {
          for (const piece of result.stdout) {
            const wait = started + piece.afterMs - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            write(piece.stream ?? "stdout", piece.text);
          }
        } else if (result.stdout !== undefined) {
          write("stdout", result.stdout);
        }
        if (result.stderr) write("stderr", result.stderr);
        const duration = result.durationMs ?? 0;
        if (duration > timeoutMs) {
          await new Promise((r) => setTimeout(r, timeoutMs));
          return 137;
        }
        if (duration > 0) await new Promise((r) => setTimeout(r, duration));
        return result.exitCode ?? 0;
      }
      default:
        throw new Error(`fake docker: unknown exec ${JSON.stringify(o.Cmd)}`);
    }
  }

  #context(c: FakeContainer, o: DockerExecCreate, cmd: string, stdin: Buffer): CommandContext {
    const env: Record<string, string> = {};
    for (const entry of [...c.env, ...o.Env]) {
      const eq = entry.indexOf("=");
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return { container: c, cmd, user: o.User, env, cwd: o.WorkingDir, stdin };
  }
}

class FakeExec implements DockerExec {
  readonly #docker: FakeDocker;
  readonly #container: FakeContainer;
  readonly #options: DockerExecCreate;
  #running = false;
  #exitCode: number | null = null;

  constructor(docker: FakeDocker, container: FakeContainer, options: DockerExecCreate) {
    this.#docker = docker;
    this.#container = container;
    this.#options = options;
  }

  get options(): DockerExecCreate {
    return this.#options;
  }

  async start(): Promise<Duplex> {
    const stdin: Buffer[] = [];
    this.#running = true;
    const stream: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        stdin.push(chunk);
        cb();
      },
      final: (cb) => {
        cb();
        this.#docker.run(this.#container, this.#options, Buffer.concat(stdin), stream).then(
          (code) => {
            this.#exitCode = code;
            this.#running = false;
            stream.push(null);
          },
          (error: unknown) => stream.destroy(error as Error),
        );
      },
    });
    return stream;
  }

  async inspect(): Promise<{ Running: boolean; ExitCode: number | null }> {
    return { Running: this.#running, ExitCode: this.#exitCode };
  }
}

class FakeContainerApi implements DockerContainer {
  readonly id: string;
  readonly #docker: FakeDocker;

  constructor(docker: FakeDocker, id: string) {
    this.#docker = docker;
    this.id = id;
  }

  inspect() {
    return this.#docker.inspect(this.id);
  }
  start() {
    return this.#docker.start(this.id);
  }
  pause() {
    return this.#docker.pause(this.id);
  }
  unpause() {
    return this.#docker.unpause(this.id);
  }
  remove() {
    return this.#docker.remove(this.id);
  }
  rename(o: { name: string }) {
    return this.#docker.rename(this.id, o.name);
  }
  exec(o: DockerExecCreate) {
    return this.#docker.exec(this.id, o);
  }
  putArchive(data: Buffer, o: { path: string }) {
    return this.#docker.putArchive(this.id, data, o);
  }
  getArchive(o: { path: string }) {
    return this.#docker.getArchive(this.id, o);
  }
  commit(o: { repo: string; tag: string; pause: boolean }) {
    return this.#docker.commit(this.id, o);
  }
}
