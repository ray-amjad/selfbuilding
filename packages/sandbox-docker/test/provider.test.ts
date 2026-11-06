import {
  ConfigError,
  EgressPolicyUnsupportedError,
  ImageUnavailableError,
  type OnLine,
  type ProviderSandbox,
  SANDBOX_PATHS,
  SandboxAuthError,
  SandboxCommandTimeoutError,
  SandboxFileNotFoundError,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxQuotaError,
  type SandboxRef,
  type SandboxSpec,
  SandboxUnavailableError,
  SandboxUnsupportedError,
  SELFBUILDING_LABELS,
  SecretInEnvError,
} from "@selfbuilding/core";
import { conformanceSandboxName } from "@selfbuilding/sandbox-conformance";
import { describe, expect, it } from "vitest";
import { type DockerOptions, docker, SNAPSHOT_REPO } from "../src/index.js";
import { PRIVATE } from "../src/labels.js";
import { LEASE_PATH } from "../src/sandbox.js";
import { FakeDocker, httpError, netError } from "./fake-docker.js";

const DEPLOYMENT = "dev";
/** U+2028, which must never split a line. */
const LS = String.fromCharCode(0x2028);
const RUN = "run-1";
const IMAGE = { name: "selfbuilding-base", ref: "selfbuilding/base:test", version: "0.0.0-test" };

const key = (scope: string, deployment = DEPLOYMENT) => ({ runId: RUN, scope, deployment });

function spec(scope: string, over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: IMAGE,
    env: {},
    lifetimeMs: 10 * 60 * 1000,
    onExpire: "pause",
    ...over,
    labels: {
      [SELFBUILDING_LABELS.deployment]: DEPLOYMENT,
      [SELFBUILDING_LABELS.run]: RUN,
      [SELFBUILDING_LABELS.name]: conformanceSandboxName(key(scope)),
      ...over.labels,
    },
  };
}

function setup(opts: DockerOptions = {}, images?: string[]) {
  const fake = new FakeDocker(images);
  const provider = docker({
    client: fake,
    backoff: { baseMs: 1, capMs: 5 },
    pollMs: 5,
    probeBudgetMs: 150,
    deadlineMs: 1_500,
    execGraceMs: 150,
    ...opts,
  });
  const box = async (scope: string, over: Partial<SandboxSpec> = {}) =>
    (await provider.openOrCreate(key(scope), spec(scope, over))).handle;
  return { fake, provider, box };
}

async function drain(iterable: AsyncIterable<SandboxRef>): Promise<SandboxRef[]> {
  const out: SandboxRef[] = [];
  for await (const ref of iterable) out.push(ref);
  return out;
}

async function rejects<T extends Error>(p: Promise<unknown>, ctor: abstract new (...args: never[]) => T): Promise<T> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ctor);
  return error as T;
}

describe("docker(): construction", () => {
  it("is a SandboxProvider with fork and snapshot, and touches no daemon until used", () => {
    const provider: SandboxProvider = docker({ socketPath: "/nonexistent/docker.sock" });
    expect(provider.id).toBe("docker");
    expect(provider.limits).toMatchObject({ lifetimeGuaranteed: true, expireKeeps: "filesystem" });
    expect(typeof provider.snapshot).toBe("function");
    expect(typeof provider.fork).toBe("function");
    expect(provider.fsRoot).toBeUndefined();
  });

  it("a worktree mount needs an absolute worktree path", () => {
    expect(() => docker({ mount: "worktree" })).toThrow(ConfigError);
    expect(() => docker({ mount: "worktree", worktree: "relative/path" })).toThrow(ConfigError);
  });

  it("an unreachable daemon is an outage, never a miss", async () => {
    const provider = docker({ socketPath: "/nonexistent/selfbuilding-test.sock" });
    await rejects(provider.find(key("x")), SandboxUnavailableError);
  });
});

describe("openOrCreate", () => {
  it("creates an idle, labelled container and is idempotent per key [inv 7]", async () => {
    const { fake, provider } = setup();
    const first = await provider.openOrCreate(key("idem"), spec("idem"));
    expect(first).toMatchObject({ created: true, rebuilt: false });
    const c = fake.only();
    expect(c.state).toBe("running");
    expect(c.name).toBe(`${conformanceSandboxName(key("idem"))}.${DEPLOYMENT}`);
    expect(c.options).toMatchObject({
      Image: IMAGE.ref,
      Entrypoint: ["sleep"],
      Cmd: ["infinity"],
      Tty: false,
      User: "root",
      WorkingDir: SANDBOX_PATHS.workdir,
      HostConfig: { Init: true, RestartPolicy: { Name: "no" } },
    });
    expect(c.options.HostConfig.Mounts.map((m) => m.Target)).toEqual([SANDBOX_PATHS.run, "/tmp"]);
    expect(c.labels).toMatchObject({
      "selfbuilding.deployment": DEPLOYMENT,
      "selfbuilding.run": RUN,
      "selfbuilding.name": conformanceSandboxName(key("idem")),
      [PRIVATE.scope]: "idem",
      [PRIVATE.onExpire]: "pause",
    });
    expect(Date.parse(c.labels["selfbuilding.expiresAt"] ?? "")).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect(first.handle.ref).toMatchObject({
      provider: "docker",
      id: c.id,
      key: key("idem"),
      deployment: DEPLOYMENT,
      state: "running",
    });
    const second = await provider.openOrCreate(key("idem"), spec("idem"));
    expect(second).toMatchObject({ created: false, rebuilt: false });
    expect(second.handle.ref.id).toBe(c.id);
    expect(fake.containers.size).toBe(1);
  });

  it("concurrent calls for one key converge on one container [inv 7]", async () => {
    const { fake, provider } = setup();
    const results = await Promise.all([0, 1, 2].map(() => provider.openOrCreate(key("race"), spec("race"))));
    expect(new Set(results.map((r) => r.handle.ref.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(fake.containers.size).toBe(1);
  });

  it("a create whose response was lost converges on the box it made [inv 8]", async () => {
    const { fake, provider } = setup();
    fake.fail("createContainer", netError("ECONNRESET"), { after: true });
    const result = await provider.openOrCreate(key("lost"), spec("lost"));
    expect(fake.containers.size).toBe(1);
    expect(result.handle.ref.id).toBe(fake.only().id);
    // The orphaned create was never started; open started it and laid out the box.
    expect(fake.only().state).toBe("running");
    expect(result.created).toBe(false);
  });

  it("retries a 429 within the deadline, then raises SandboxQuotaError", async () => {
    const { fake, provider } = setup();
    fake.fail("createContainer", httpError(429, "too many"), { times: 2 });
    expect((await provider.openOrCreate(key("q1"), spec("q1"))).created).toBe(true);
    const tight = setup({ deadlineMs: 30 });
    tight.fake.fail("createContainer", httpError(429, "too many"), { times: 1000 });
    await rejects(tight.provider.openOrCreate(key("q2"), spec("q2")), SandboxQuotaError);
  });

  it("an outage on create is retried; a 401 fails at once", async () => {
    const { fake, provider } = setup();
    fake.fail("createContainer", httpError(503, "busy"), { times: 2 });
    expect((await provider.openOrCreate(key("o1"), spec("o1"))).created).toBe(true);
    fake.fail("listContainers", httpError(401, "unauthorized"), { times: 1000 });
    await rejects(provider.openOrCreate(key("o2"), spec("o2")), SandboxAuthError);
    expect(fake.calls.filter((c) => c === "listContainers").length).toBeLessThan(5);
  });

  it("removes the box when setup fails after create [inv 9]", async () => {
    const { fake, provider } = setup();
    fake.fail("exec", httpError(400, "unable to find user root"), { times: 1000 });
    await expect(provider.openOrCreate(key("setup"), spec("setup"))).rejects.toThrow();
    expect(fake.containers.size).toBe(0);
    expect(fake.calls).toContain("remove");
  });

  it("refuses secrets in env and unsupported egress before touching the daemon [inv 18]", async () => {
    const { fake, provider } = setup();
    await rejects(provider.openOrCreate(key("s"), spec("s", { env: { GITHUB_TOKEN: "x" } })), SecretInEnvError);
    const egress = await rejects(
      provider.openOrCreate(key("e"), spec("e", { network: { allow: ["github.com"] } })),
      EgressPolicyUnsupportedError,
    );
    expect(egress.supported).toEqual(["open", "deny-all"]);
    expect(fake.calls).toEqual([]);
  });

  it("maps deny-all, resources, ports and env onto the container", async () => {
    const { fake, box } = setup();
    const handle = await box("shape", {
      network: "deny-all",
      resources: { vcpu: 2, memoryMiB: 4096 },
      ports: [3000],
      env: { NODE_ENV: "test" },
    });
    const { options } = fake.only();
    expect(options.HostConfig).toMatchObject({
      NetworkMode: "none",
      NanoCpus: 2e9,
      Memory: 4096 * 1024 * 1024,
      PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
    });
    expect(options.ExposedPorts).toEqual({ "3000/tcp": {} });
    expect(options.Env).toEqual(["NODE_ENV=test"]);
    expect(await handle.previewUrl?.(3000)).toEqual({ url: "http://127.0.0.1:33000", headers: {} });
    await rejects(handle.previewUrl?.(4000) ?? Promise.resolve(), SandboxUnsupportedError);
  });

  it("ghost refs converge: rebuild once, rename the ghost aside, then stick to the new box [inv 6]", async () => {
    const { fake, provider, box } = setup();
    const first = await box("ghost");
    const ghost = fake.only();
    ghost.guestGone = true;
    const rebuilt = await provider.openOrCreate(key("ghost"), spec("ghost"));
    expect(rebuilt).toMatchObject({ created: true, rebuilt: true });
    expect(rebuilt.handle.ref.id).not.toBe(first.ref.id);
    // Never removed on a silent guest (invariant 5); renamed so the key's name is free.
    expect(fake.containers.get(ghost.id)?.name).toMatch(/\.ghost-/);
    const again = await provider.openOrCreate(key("ghost"), spec("ghost"));
    expect(again).toMatchObject({ created: false, rebuilt: false });
    expect(again.handle.ref.id).toBe(rebuilt.handle.ref.id);
    expect((await provider.find(key("ghost")))?.id).toBe(rebuilt.handle.ref.id);
  });

  it("a dead container is a ghost without waiting out the probe budget", async () => {
    const { fake, provider, box } = setup({ probeBudgetMs: 60_000, deadlineMs: 60_000 });
    await box("dead");
    const dead = fake.only();
    dead.state = "dead";
    const started = Date.now();
    const result = await provider.openOrCreate(key("dead"), spec("dead"));
    expect(result.rebuilt).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("images", () => {
  it("pulls a missing image once", async () => {
    const { fake, provider } = setup({}, []);
    await provider.openOrCreate(key("p1"), { ...spec("p1"), image: { ...IMAGE, ref: "example/tool:1" } });
    await provider.openOrCreate(key("p2"), { ...spec("p2"), image: { ...IMAGE, ref: "example/tool:1" } });
    expect(fake.pulled).toEqual(["example/tool:1"]);
  });

  it("a failed pull is ImageUnavailableError and creates nothing", async () => {
    const { fake, provider } = setup({}, []);
    fake.pullError = "manifest unknown";
    const error = await rejects(provider.openOrCreate(key("p"), spec("p")), ImageUnavailableError);
    expect(error.message).toMatch(/build: true/);
    expect(fake.containers.size).toBe(0);
  });

  it("build: true builds the official images locally with the host UID, base first", async () => {
    const { fake, provider } = setup({ build: true }, []);
    await provider.openOrCreate(key("b"), {
      ...spec("b"),
      image: { name: "selfbuilding-codex", ref: "selfbuilding/codex:9.9.9", version: "9.9.9" },
    });
    expect(fake.built.map((b) => b.t)).toEqual(["selfbuilding/base:9.9.9", "selfbuilding/codex:9.9.9"]);
    expect(fake.built[0]?.buildargs).toHaveProperty("AGENT_UID");
    expect(fake.built[1]?.buildargs?.BASE_IMAGE).toBe("selfbuilding/base:9.9.9");
    expect(fake.built[1]?.dockerfile).toContain("@openai/codex@");
    expect(fake.pulled).toEqual([]);
  });

  it("the image option overrides every image except a snapshot", async () => {
    const { fake, provider } = setup({ image: "custom/box:1" }, ["custom/box:1", `${SNAPSHOT_REPO}:abc`]);
    await provider.openOrCreate(key("i1"), spec("i1"));
    expect(fake.only().image).toBe("custom/box:1");
    await provider.openOrCreate(key("i2"), { ...spec("i2"), image: { ...IMAGE, ref: `${SNAPSHOT_REPO}:abc` } });
    expect([...fake.containers.values()].map((c) => c.image).sort()).toEqual(["custom/box:1", `${SNAPSHOT_REPO}:abc`]);
  });
});

describe("find and list", () => {
  it("find returns the ref with only selfbuilding labels, scoped to the deployment [inv 20]", async () => {
    const { provider, box } = setup();
    const handle = await box("find", { labels: { [SELFBUILDING_LABELS.step]: "s-1" } });
    const ref = await provider.find(key("find"));
    expect(ref?.id).toBe(handle.ref.id);
    expect(ref?.labels).toMatchObject({ "selfbuilding.deployment": DEPLOYMENT, "selfbuilding.step": "s-1" });
    expect(ref?.labels["selfbuilding.name"]).toBe(ref?.name);
    expect(Object.keys(ref?.labels ?? {}).every((k) => k.startsWith("selfbuilding."))).toBe(true);
    expect(ref?.labels).not.toHaveProperty("selfbuilding.launch");
    expect(ref?.meta?.container).toBe(`${ref?.name}.${DEPLOYMENT}`);
    expect(await provider.find(key("find", "other"))).toBeNull();
    expect(await provider.find(key("never"))).toBeNull();
  });

  it("find and list never wake a paused box [inv 1]", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("sleep");
    expect(await provider.pause(handle.ref)).toEqual({ confirmed: true, kept: "memory" });
    fake.calls.length = 0;
    expect((await provider.find(key("sleep")))?.state).toBe("paused");
    expect((await drain(provider.list({ deployment: DEPLOYMENT, states: ["paused"] }))).map((r) => r.id)).toEqual([
      handle.ref.id,
    ]);
    expect(fake.calls.filter((c) => ["unpause", "start", "exec"].includes(c))).toEqual([]);
    expect(fake.only().state).toBe("paused");
  });

  it("list filters by deployment, run and state, oldest first", async () => {
    const { provider, box } = setup();
    const a = await box("a");
    await new Promise((r) => setTimeout(r, 5));
    const b = await box("b");
    await provider.pause(b.ref);
    expect((await drain(provider.list({ deployment: DEPLOYMENT }))).map((r) => r.id)).toEqual([a.ref.id, b.ref.id]);
    expect((await drain(provider.list({ deployment: DEPLOYMENT, states: ["running"] }))).map((r) => r.id)).toEqual([
      a.ref.id,
    ]);
    expect(await drain(provider.list({ deployment: DEPLOYMENT, runId: "other" }))).toEqual([]);
    expect(await drain(provider.list({ deployment: "other" }))).toEqual([]);
  });

  it("an outage throws, never reads as empty [inv 2]", async () => {
    const { fake, provider, box } = setup();
    await box("outage");
    fake.fail("listContainers", httpError(503, "busy"));
    await rejects(provider.find(key("outage")), SandboxUnavailableError);
    fake.fail("listContainers", netError());
    await rejects(drain(provider.list({ deployment: DEPLOYMENT })), SandboxUnavailableError);
    fake.fail("listContainers", httpError(401, "nope"));
    await rejects(provider.find(key("outage")), SandboxAuthError);
    expect(await provider.find(key("outage"))).not.toBeNull();
  });
});

describe("open, pause and kill", () => {
  it("open resumes a paused box, probes it and extends its lease [inv 3]", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("open");
    await provider.pause(handle.ref);
    const ref = JSON.parse(JSON.stringify(await provider.find(key("open")))) as SandboxRef;
    const reopened = await provider.open(ref, { lifetimeMs: 60 * 60 * 1000 });
    expect(fake.only().state).toBe("running");
    expect(reopened.ref.state).toBe("running");
    const lease = Date.parse(fake.only().files.get(LEASE_PATH)?.data.toString() ?? "");
    expect(lease).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
    expect((await provider.find(key("open")))?.labels["selfbuilding.expiresAt"]).toBe(new Date(lease).toISOString());
  });

  it("open starts a stopped box (filesystem only)", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("stopped");
    fake.only().state = "exited";
    expect((await provider.find(key("stopped")))?.state).toBe("stopped");
    await provider.open(handle.ref, { lifetimeMs: 1000 });
    expect(fake.only().state).toBe("running");
  });

  it("open of a removed box is SandboxNotFoundError; of an outage, SandboxUnavailableError", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("gone");
    fake.fail("inspect", httpError(503, "busy"));
    await rejects(provider.open(handle.ref, { lifetimeMs: 1000 }), SandboxUnavailableError);
    await provider.kill(handle.ref);
    await rejects(provider.open(handle.ref, { lifetimeMs: 1000 }), SandboxNotFoundError);
  });

  it("pause confirms, is idempotent and waits for the freezer [inv 4]", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("pause");
    fake.pauseLag = 3;
    expect(await provider.pause(handle.ref)).toEqual({ confirmed: true, kept: "memory" });
    expect(await provider.pause(handle.ref)).toEqual({ confirmed: true, kept: "memory" });
    expect(fake.calls.filter((c) => c === "pause")).toHaveLength(1);
  });

  it("pause reports a stopped box as parked on its filesystem, and a missing one as gone", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("p-stop");
    fake.only().state = "exited";
    expect(await provider.pause(handle.ref)).toEqual({ confirmed: true, kept: "filesystem" });
    await provider.kill(handle.ref);
    expect(await provider.pause(handle.ref)).toMatchObject({ confirmed: false, reason: "gone", status: 404 });
  });

  it("a refused pause is a typed outcome; outages and fleet errors throw [inv 4, 5]", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("p-refuse");
    fake.fail("pause", httpError(400, "plan limit"));
    expect(await provider.pause(handle.ref)).toEqual({
      confirmed: false,
      reason: "refused",
      status: 400,
      message: "plan limit (HTTP code 400) plan limit",
    });
    fake.fail("pause", httpError(503, "busy"));
    await rejects(provider.pause(handle.ref), SandboxUnavailableError);
    fake.fail("pause", httpError(403, "forbidden"));
    await rejects(provider.pause(handle.ref), SandboxAuthError);
    fake.fail("pause", httpError(429, "slow"));
    await rejects(provider.pause(handle.ref), SandboxQuotaError);
    expect(fake.only().state).toBe("running");
  });

  it("kill is idempotent and removes the volumes; an outage leaves the box [inv 5]", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("kill");
    fake.fail("remove", httpError(500, "driver busy"));
    await rejects(provider.kill(handle.ref), SandboxUnavailableError);
    expect(fake.containers.size).toBe(1);
    expect(await provider.kill(handle.ref)).toEqual({ path: "killed" });
    expect(await provider.kill(handle.ref)).toEqual({ path: "already-gone" });
    expect(await provider.find(key("kill"))).toBeNull();
  });
});

describe("exec", () => {
  it("returns a non-zero exit with separate stdout and stderr tails", async () => {
    const { fake, box } = setup();
    const handle = await box("exec");
    fake.onCommand = () => ({ stdout: "out\n", stderr: "err\n", exitCode: 3 });
    expect(await handle.exec("false")).toEqual({
      exitCode: 3,
      stdoutTail: "out\n",
      stderrTail: "err\n",
      truncated: false,
    });
  });

  it("runs as the agent with an explicit HOME, the workdir and per-exec env", async () => {
    const { fake, box } = setup();
    const handle = await box("env", { env: { AT_CREATE: "yes" } });
    const seen: Array<{ user: string; home?: string; cwd: string; env: Record<string, string> }> = [];
    fake.onCommand = (ctx) => {
      seen.push({ user: ctx.user, home: ctx.env.HOME, cwd: ctx.cwd, env: ctx.env });
      return {};
    };
    await handle.exec("env", { env: { PER_EXEC: "1" } });
    await handle.exec("id", { user: "root", cwd: "sub/dir" });
    expect(seen[0]).toMatchObject({ user: "agent", home: SANDBOX_PATHS.home, cwd: SANDBOX_PATHS.workdir });
    expect(seen[0]?.env).toMatchObject({ AT_CREATE: "yes", PER_EXEC: "1", LANG: "C.UTF-8" });
    expect(seen[1]).toMatchObject({ user: "root", home: "/root", cwd: `${SANDBOX_PATHS.workdir}/sub/dir` });
    expect(seen[1]?.env).not.toHaveProperty("PER_EXEC");
  });

  it("refuses a secret in per-exec env before calling the daemon [inv 18]", async () => {
    const { fake, box } = setup();
    const handle = await box("secret-exec");
    fake.calls.length = 0;
    await rejects(handle.exec("true", { env: { ANTHROPIC_API_KEY: "x" } }), SecretInEnvError);
    expect(fake.calls).toEqual([]);
  });

  it("streams lines as they arrive, split on \\n only [inv 10]", async () => {
    const { fake, box } = setup();
    const handle = await box("stream");
    fake.onCommand = () => ({
      stdout: [
        { text: "first\n", afterMs: 0 },
        { text: `a${LS}`, afterMs: 120, stream: "stderr" },
        { text: "b\nerr\n", afterMs: 130, stream: "stderr" },
        { text: "tail", afterMs: 140 },
      ],
    });
    const lines: Array<{ stream: string; line: string; at: number }> = [];
    const onLine: OnLine = (stream, line) => lines.push({ stream, line, at: Date.now() });
    const result = await handle.exec("x", { onLine });
    expect(lines.filter((l) => l.stream === "stdout").map((l) => l.line)).toEqual(["first", "tail"]);
    expect(lines.filter((l) => l.stream === "stderr").map((l) => l.line)).toEqual([`a${LS}b`, "err"]);
    expect((lines[1]?.at ?? 0) - (lines[0]?.at ?? 0)).toBeGreaterThanOrEqual(100);
    expect(result.stdoutTail).toBe("first\ntail");
  });

  it("pipes stdin over 128 KiB and closes it [inv 11]", async () => {
    const { fake, box } = setup();
    const handle = await box("stdin");
    let received = -1;
    fake.onCommand = (ctx) => {
      received = ctx.stdin.length;
      return { stdout: `${ctx.stdin.length}\n` };
    };
    const input = "x".repeat(200 * 1024);
    expect((await handle.exec("wc -c", { stdin: input })).stdoutTail).toBe(`${input.length}\n`);
    expect(received).toBe(input.length);
    await handle.exec("wc -c");
    expect(received).toBe(0);
  });

  it("keeps a bounded tail [inv 10]", async () => {
    const { fake, box } = setup();
    const handle = await box("tail");
    fake.onCommand = () => ({ stdout: `${"y".repeat(300_000)}\nEND\n` });
    const result = await handle.exec("big", { maxTailBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(1024);
    expect(result.stdoutTail.endsWith("END\n")).toBe(true);
  });

  it("the in-box timeout raises SandboxCommandTimeoutError with mayStillBeRunning: false", async () => {
    const { fake, box } = setup();
    const handle = await box("timeout");
    fake.onCommand = () => ({ durationMs: 30_000 });
    const error = await rejects(
      handle.exec("sleep 30", { timeoutMs: 300, idempotent: true }),
      SandboxCommandTimeoutError,
    );
    expect(error).toMatchObject({ cmd: "sleep 30", mayStillBeRunning: false, retryable: true });
  });

  it("a stream that outlives the deadline is abandoned with mayStillBeRunning: true", async () => {
    const { fake, box } = setup();
    const handle = await box("hang");
    fake.onCommand = () => ({ hang: true });
    const error = await rejects(handle.exec("hang", { timeoutMs: 100 }), SandboxCommandTimeoutError);
    expect(error).toMatchObject({ mayStillBeRunning: true, retryable: false });
  });

  it("is never retried on a transient error, and a paused box points at open()", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("no-retry");
    fake.calls.length = 0;
    fake.fail("exec", httpError(503, "busy"));
    await rejects(handle.exec("echo ran"), SandboxUnavailableError);
    expect(fake.calls.filter((c) => c === "exec")).toHaveLength(1);
    await provider.pause(handle.ref);
    const paused = await rejects(handle.exec("true"), SandboxUnavailableError);
    expect(paused.message).toMatch(/provider\.open/);
  });
});

describe("spawn and attach [inv 12]", () => {
  it("spawn hands the command over stdin and returns a plain-JSON ref with the process group", async () => {
    const { fake, box } = setup();
    const handle = await box("spawn");
    const cmd = "echo '$(not expanded)'; sleep 1";
    const proc = await handle.spawn(cmd, { user: "agent" });
    expect(proc.id).toMatch(/^p/);
    expect(proc.pgid).toBeGreaterThan(0);
    expect(proc.logPath).toBe(`${SANDBOX_PATHS.proc}/${proc.id}.log`);
    expect(proc.exitPath).toBe(`${SANDBOX_PATHS.proc}/${proc.id}.exit`);
    expect(JSON.parse(JSON.stringify(proc))).toEqual(proc);
    expect(fake.only().files.get(`${SANDBOX_PATHS.proc}/${proc.id}.cmd`)?.data.toString()).toBe(`${cmd}\n`);
  });

  it("attach streams to exit, then resumes by byte offset from any handle", async () => {
    const { fake, provider, box } = setup();
    const handle = await box("attach");
    fake.onSpawn = () => ({
      lines: [
        { text: "one\n", afterMs: 0 },
        { text: "two\n", afterMs: 20 },
      ],
      exitCode: 4,
      exitAfterMs: 40,
    });
    const proc = await handle.spawn("work");
    const reopened = await provider.open(JSON.parse(JSON.stringify(handle.ref)) as SandboxRef, { lifetimeMs: 1000 });
    const seen: string[] = [];
    const done = await reopened.attach(JSON.parse(JSON.stringify(proc)), {
      fromOffset: 0,
      onLine: (_s, l) => seen.push(l),
    });
    expect(done).toEqual({ state: "exited", exitCode: 4, offset: 8 });
    expect(seen).toEqual(["one", "two"]);
    const tail: string[] = [];
    expect(await reopened.attach(proc, { fromOffset: 8, onLine: (_s, l) => tail.push(l) })).toMatchObject({
      offset: 8,
    });
    expect(tail).toEqual([]);
    const partial: string[] = [];
    await reopened.attach(proc, { fromOffset: 4, onLine: (_s, l) => partial.push(l) });
    expect(partial).toEqual(["two"]);
  });

  it("attach returns running when its signal aborts, and only whole lines are reported", async () => {
    const { fake, box } = setup();
    const handle = await box("abort");
    fake.onSpawn = () => ({ lines: [{ text: "started\npart", afterMs: 0 }], exitAfterMs: 60_000 });
    const proc = await handle.spawn("server");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const seen: string[] = [];
    const result = await handle.attach(proc, {
      fromOffset: 0,
      signal: controller.signal,
      onLine: (_s, l) => seen.push(l),
    });
    expect(result).toEqual({ state: "running", offset: 8 });
    expect(seen).toEqual(["started"]);
  });

  it("a process killed before writing its exit code is exited without one", async () => {
    const { fake, box } = setup();
    const handle = await box("killed");
    fake.onSpawn = () => ({ lines: [{ text: "last words", afterMs: 0 }], killed: true, exitAfterMs: 10 });
    const proc = await handle.spawn("doomed");
    const seen: string[] = [];
    const result = await handle.attach(proc, { fromOffset: 0, onLine: (_s, l) => seen.push(l) });
    expect(result).toEqual({ state: "exited", offset: 10 });
    expect(seen).toEqual(["last words"]);
  });
});

describe("files", () => {
  it("binary data round-trips through the archive API with owner and mode set", async () => {
    const { fake, box } = setup();
    const handle = await box("files");
    const bytes = new Uint8Array(1024).map((_, i) => i % 256);
    await handle.writeFiles([
      { path: `${SANDBOX_PATHS.workdir}/bin/all-bytes.bin`, data: bytes },
      { path: `${SANDBOX_PATHS.secrets}/EXAMPLE`, data: "value", mode: 0o600 },
      { path: SANDBOX_PATHS.runtimeBundle, data: "export {}", mode: 0o755, owner: "root" },
    ]);
    const files = fake.only().files;
    expect(files.get(`${SANDBOX_PATHS.workdir}/bin/all-bytes.bin`)).toMatchObject({ owner: "agent", mode: 0o644 });
    expect(files.get(`${SANDBOX_PATHS.secrets}/EXAMPLE`)).toMatchObject({ owner: "agent", mode: 0o600 });
    expect(files.get(SANDBOX_PATHS.runtimeBundle)).toMatchObject({ owner: "root", mode: 0o755 });
    expect(
      Buffer.from(await handle.readFile(`${SANDBOX_PATHS.workdir}/bin/all-bytes.bin`)).equals(Buffer.from(bytes)),
    ).toBe(true);
    expect(Buffer.from(await handle.readFile("bin/all-bytes.bin")).length).toBe(1024);
  });

  it("creates missing parents, owned like the file, and handles long paths", async () => {
    const { fake, box } = setup();
    const handle = await box("deep");
    const deep = `/selfbuilding/work/${"nested/".repeat(20)}file.txt`;
    await handle.writeFiles([{ path: deep, data: "deep" }]);
    expect(Buffer.from(await handle.readFile(deep)).toString()).toBe("deep");
    expect(fake.only().dirs.has(deep.slice(0, deep.lastIndexOf("/")))).toBe(true);
  });

  it("a missing file is SandboxFileNotFoundError; a missing box is SandboxNotFoundError", async () => {
    const { provider, box } = setup();
    const handle = await box("missing");
    const error = await rejects(handle.readFile("/selfbuilding/out/missing.json"), SandboxFileNotFoundError);
    expect(error.path).toBe("/selfbuilding/out/missing.json");
    await rejects(handle.readFile(SANDBOX_PATHS.workdir), SandboxFileNotFoundError);
    await provider.kill(handle.ref);
    await rejects(handle.readFile("/selfbuilding/out/missing.json"), SandboxNotFoundError);
  });

  it("a missing file is never a missing box, even though the client calls every archive 404 'no such container'", async () => {
    const { fake, box } = setup();
    const handle = await box("missing-reason");
    const error = await rejects(handle.readFile("/selfbuilding/out/missing.json"), SandboxFileNotFoundError);
    expect(error).not.toBeInstanceOf(SandboxNotFoundError);
    // A 404 with no daemon body is settled by asking whether the box still exists.
    fake.fail("getArchive", Object.assign(new Error("(HTTP code 404) no such container"), { statusCode: 404 }));
    await rejects(handle.readFile("/selfbuilding/out/missing.json"), SandboxFileNotFoundError);
  });

  it("readFile follows a symlink", async () => {
    const { fake, box } = setup();
    const handle = await box("link");
    await handle.writeFiles([{ path: "/selfbuilding/out/real.txt", data: "real" }]);
    fake.only().files.set("/selfbuilding/out/link.txt", {
      data: Buffer.alloc(0),
      mode: 0o777,
      owner: "root",
      symlink: "real.txt",
    });
    expect(Buffer.from(await handle.readFile("/selfbuilding/out/link.txt")).toString()).toBe("real");
  });

  it("an archive outage is SandboxUnavailableError", async () => {
    const { fake, box } = setup();
    const handle = await box("files-outage");
    fake.fail("putArchive", httpError(500, "io"));
    await rejects(handle.writeFiles([{ path: "/tmp/x", data: "x" }]), SandboxUnavailableError);
  });
});

describe("lifetime [inv 15]", () => {
  it("extendLifetime takes an absolute target, clamps to the session cap and is visible to the reaper", async () => {
    const { fake, provider, box } = setup({ limits: { maxLifetimeMs: 60 * 60 * 1000 } });
    const handle = await box("lifetime");
    const target = Date.now() + 30 * 60 * 1000;
    expect(await handle.extendLifetime(target)).toEqual({ untilMs: target, clamped: false });
    expect(fake.only().files.get(LEASE_PATH)?.data.toString()).toBe(new Date(target).toISOString());
    expect((await provider.find(key("lifetime")))?.labels["selfbuilding.expiresAt"]).toBe(
      new Date(target).toISOString(),
    );
    const far = await handle.extendLifetime(Date.now() + 10 * 60 * 60 * 1000);
    expect(far.clamped).toBe(true);
    expect(far.untilMs).toBe(Date.parse(handle.ref.createdAt) + 60 * 60 * 1000);
  });
});

describe("snapshot and fork", () => {
  async function seeded() {
    const ctx = setup();
    const parent = await ctx.box("parent", { labels: { [SELFBUILDING_LABELS.step]: "step-1" }, ports: [8080] });
    await parent.writeFiles([
      { path: `${SANDBOX_PATHS.workdir}/state.txt`, data: "v1" },
      { path: `${SANDBOX_PATHS.secrets}/TOKEN`, data: "secret", mode: 0o600 },
    ]);
    return { ...ctx, parent };
  }

  it("snapshot commits the filesystem without the secrets volume; a box made from it has the files", async () => {
    const { fake, provider, parent, box } = await seeded();
    const snap = await provider.snapshot?.(parent.ref, { name: "Before Review!" });
    expect(snap).toMatchObject({ fidelity: "filesystem", sourceState: "running" });
    expect(snap?.snapshotId).toMatch(new RegExp(`^${SNAPSHOT_REPO}:before-review-[0-9a-f]{12}$`));
    const restored = await box("restored", { image: { ...IMAGE, ref: snap?.snapshotId ?? "" } });
    expect(Buffer.from(await restored.readFile(`${SANDBOX_PATHS.workdir}/state.txt`)).toString()).toBe("v1");
    await rejects(restored.readFile(`${SANDBOX_PATHS.secrets}/TOKEN`), SandboxFileNotFoundError);
    // The source's step label is inherited by the image, and masked on the new box.
    expect(restored.ref.labels).not.toHaveProperty("selfbuilding.step");
    expect(fake.containers.size).toBe(2);
  });

  it("a snapshot of a paused box reports it paused", async () => {
    const { provider, parent } = await seeded();
    await provider.pause(parent.ref);
    expect((await provider.snapshot?.(parent.ref))?.sourceState).toBe("paused");
  });

  it("a snapshot that is not on the daemon is ImageUnavailableError, never pulled", async () => {
    const { fake, provider } = setup();
    await rejects(
      provider.openOrCreate(key("s"), { ...spec("s"), image: { ...IMAGE, ref: `${SNAPSHOT_REPO}:nope` } }),
      ImageUnavailableError,
    );
    expect(fake.pulled).toEqual([]);
  });

  it("fork gives every child the parent's files, a new identity and independent state", async () => {
    const { fake, provider, parent } = await seeded();
    const children = (await provider.fork?.(parent.ref, {
      children: [0, 1].map((i) => ({
        name: `${parent.ref.name}-f${i}`,
        labels: { [SELFBUILDING_LABELS.launch]: `launch-${i}` },
      })),
      lifetimeMs: 60_000,
    })) as ProviderSandbox[];
    expect(children).toHaveLength(2);
    const [a, b] = children as [ProviderSandbox, ProviderSandbox];
    expect(new Set([parent.ref.id, a.ref.id, b.ref.id]).size).toBe(3);
    for (const [i, child] of [a, b].entries()) {
      expect(child.ref.key).toEqual({ ...key("parent"), scope: `parent/fork[${i}]` });
      expect(child.ref.labels).toMatchObject({
        "selfbuilding.name": `${parent.ref.name}-f${i}`,
        "selfbuilding.parent": parent.ref.id,
        "selfbuilding.launch": `launch-${i}`,
        "selfbuilding.run": RUN,
        "selfbuilding.deployment": DEPLOYMENT,
      });
      expect(child.ref.labels).not.toHaveProperty("selfbuilding.step");
      expect(Buffer.from(await child.readFile(`${SANDBOX_PATHS.workdir}/state.txt`)).toString()).toBe("v1");
    }
    await a.writeFiles([{ path: `${SANDBOX_PATHS.workdir}/state.txt`, data: "from-a" }]);
    expect(Buffer.from(await b.readFile(`${SANDBOX_PATHS.workdir}/state.txt`)).toString()).toBe("v1");
    expect(Buffer.from(await parent.readFile(`${SANDBOX_PATHS.workdir}/state.txt`)).toString()).toBe("v1");
    const childContainer = fake.containers.get(a.ref.id);
    expect(childContainer?.image).toMatch(new RegExp(`^${SNAPSHOT_REPO}:fork-`));
    expect(childContainer?.options.HostConfig.PortBindings).toHaveProperty("8080/tcp");
    expect((await provider.find({ ...key("parent"), scope: "parent/fork[1]" }))?.id).toBe(b.ref.id);
  });

  it("an exec on the parent while a fork commits it waits out the commit's freeze", async () => {
    const { fake, provider, parent } = await seeded();
    fake.commitMs = 60;
    const forking = provider.fork?.(parent.ref, {
      children: [{ name: `${parent.ref.name}-f0`, labels: {} }],
      lifetimeMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.containers.get(parent.ref.id)?.state).toBe("paused");
    const result = await parent.exec("echo during-fork");
    expect(result.exitCode).toBe(0);
    expect((await forking)?.[0]).toHaveProperty("ref");
    // A pause the caller asked for still fails loudly.
    await provider.pause(parent.ref);
    await rejects(parent.exec("true"), SandboxUnavailableError);
  });

  it("keys children by the core's key and adopts them when the same fork runs again after a crash", async () => {
    const { provider, parent } = await seeded();
    const request = {
      children: [0, 1].map((i) => ({
        name: `${parent.ref.name}-r${i}`,
        labels: {},
        key: { ...key("parent"), scope: `parent/fork[${4 + i}]` },
      })),
      lifetimeMs: 60_000,
    };
    const first = (await provider.fork?.(parent.ref, request)) as ProviderSandbox[];
    expect(first.map((c) => c.ref.key.scope)).toEqual(["parent/fork[4]", "parent/fork[5]"]);
    const again = (await provider.fork?.(parent.ref, request)) as ProviderSandbox[];
    expect(again.every((c) => !(c instanceof Error))).toBe(true);
    expect(again.map((c) => c.ref.id)).toEqual(first.map((c) => c.ref.id));
  });

  it("a failed child comes back as an error item, never one throw", async () => {
    const { fake, provider, parent } = await seeded();
    fake.fail("createContainer", httpError(503, "busy"));
    const children = await provider.fork?.(parent.ref, {
      children: [0, 1].map((i) => ({ name: `${parent.ref.name}-x${i}`, labels: {} })),
      lifetimeMs: 60_000,
    });
    expect(children).toHaveLength(2);
    expect(children?.filter((c) => c instanceof Error)).toHaveLength(1);
    expect(children?.find((c) => c instanceof Error)).toBeInstanceOf(SandboxUnavailableError);
  });

  it("forking a missing box throws SandboxNotFoundError", async () => {
    const { provider, parent } = await seeded();
    await provider.kill(parent.ref);
    await rejects(
      provider.fork?.(parent.ref, { children: [], lifetimeMs: 1 }) ?? Promise.resolve(),
      SandboxNotFoundError,
    );
  });
});

describe("worktree mount", () => {
  it("binds the worktree with .git config, hooks and info read-only, and refuses snapshot and fork", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const worktree = mkdtempSync(join(tmpdir(), "sb-docker-wt-"));
    try {
      mkdirSync(join(worktree, ".git", "hooks"), { recursive: true });
      writeFileSync(join(worktree, ".git", "config"), "");
      const { fake, provider, box } = setup({ mount: "worktree", worktree });
      const handle = await box("wt");
      expect(fake.only().options.HostConfig.Binds).toEqual([
        `${worktree}:${SANDBOX_PATHS.workdir}`,
        `${join(worktree, ".git", "config")}:${SANDBOX_PATHS.workdir}/.git/config:ro`,
        `${join(worktree, ".git", "hooks")}:${SANDBOX_PATHS.workdir}/.git/hooks:ro`,
      ]);
      await rejects(provider.snapshot?.(handle.ref) ?? Promise.resolve(), SandboxUnsupportedError);
      await rejects(
        provider.fork?.(handle.ref, { children: [], lifetimeMs: 1 }) ?? Promise.resolve(),
        SandboxUnsupportedError,
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
