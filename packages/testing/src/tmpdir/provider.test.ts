import { existsSync } from "node:fs";
import path from "node:path";
import { RUNTIME_ENV, SANDBOX_PATHS, SandboxNotFoundError, SandboxUnavailableError } from "@selfbuilding/core";
import { afterAll, describe, expect, it } from "vitest";
import { rewriteCommand } from "./paths.js";
import { tmpdirProvider } from "./provider.js";

const provider = tmpdirProvider();
afterAll(() => provider.close());

const image = { name: "base", ref: "base:test", version: "0" };
let n = 0;
const key = (scope = `s${n++}`) => ({ runId: "run-1", scope, deployment: "test" });
const spec = (over: Record<string, unknown> = {}) => ({
  image,
  env: {},
  lifetimeMs: 60_000,
  onExpire: "pause" as const,
  labels: {},
  ...over,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("rewriteCommand", () => {
  it("maps canonical paths at token boundaries only", () => {
    const root = "/tmp/sbt-x/sb1";
    expect(rewriteCommand(root, "node /selfbuilding/bin/r.mjs launch")).toBe(
      `node ${root}/selfbuilding/bin/r.mjs launch`,
    );
    expect(rewriteCommand(root, "cat </run/selfbuilding/x;ls '/tmp/a'")).toBe(
      `cat <${root}/run/selfbuilding/x;ls '${root}/tmp/a'`,
    );
    expect(rewriteCommand(root, "echo a/selfbuilding/b $HOME/selfbuilding")).toBe(
      "echo a/selfbuilding/b $HOME/selfbuilding",
    );
    expect(rewriteCommand(root, `ls ${root}/selfbuilding/work /selfbuildings`)).toBe(
      `ls ${root}/selfbuilding/work /selfbuildings`,
    );
  });
});

describe("tmpdirProvider", () => {
  it("gives every box its own root, passed to execs as SELFBUILDING_FS_ROOT", async () => {
    const { handle } = await provider.openOrCreate(key(), spec());
    const root = provider.boxRoot(handle.ref);
    expect(handle.ref.meta?.fsRoot).toBe(root);
    expect(root.startsWith(provider.fsRoot)).toBe(true);
    const out = await handle.exec(`echo "$${RUNTIME_ENV.fsRoot}"; pwd -P; echo "$HOME"`);
    expect(out.stdoutTail.split("\n").slice(0, 3)).toEqual([
      root,
      path.join(root, SANDBOX_PATHS.workdir),
      path.join(root, SANDBOX_PATHS.home),
    ]);
    // The whole canonical layout exists, and paths cannot climb out of the box.
    expect(existsSync(path.join(root, SANDBOX_PATHS.proc))).toBe(true);
    await handle.writeFiles([{ path: "../../../../escape.txt", data: "x" }]);
    expect(existsSync(path.join(root, "escape.txt"))).toBe(true);
  });

  it("pause freezes running processes (SIGSTOP) and open resumes them", async () => {
    const { handle } = await provider.openOrCreate(key(), spec());
    const proc = await handle.spawn(
      `node -e "setInterval(() => require('fs').appendFileSync('/tmp/ticks', Date.now() + '\\n'), 50)"`,
    );
    await sleep(300);
    await provider.pause(handle.ref);
    const frozenAt = Date.now();
    await sleep(500);
    const reopened = await provider.open(handle.ref, { lifetimeMs: 60_000 });
    await sleep(200);
    const ticks = new TextDecoder()
      .decode(await reopened.readFile("/tmp/ticks"))
      .trim()
      .split("\n")
      .map(Number);
    const gaps = ticks.slice(1).map((t, i) => t - (ticks[i] as number));
    expect(Math.max(...gaps)).toBeGreaterThan(400);
    expect(ticks.some((t) => t > frozenAt + 450)).toBe(true);
    await reopened.exec(`kill -KILL -${proc.pgid}`);
  });

  it("refuses handle calls on a paused box instead of waking it", async () => {
    const { handle } = await provider.openOrCreate(key(), spec());
    await provider.pause(handle.ref);
    await expect(handle.exec("true")).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect((await provider.find({ ...handle.ref.key }))?.state).toBe("paused");
  });

  it("applies onExpire when the lifetime runs out", async () => {
    const paused = await provider.openOrCreate(key("expire-pause"), spec({ lifetimeMs: 50 }));
    const killed = await provider.openOrCreate(key("expire-kill"), spec({ lifetimeMs: 50, onExpire: "kill" }));
    await sleep(120);
    expect((await provider.find(key("expire-pause")))?.state).toBe("paused");
    expect(await provider.find(key("expire-kill"))).toBeNull();
    await expect(killed.handle.exec("true")).rejects.toBeInstanceOf(SandboxNotFoundError);
    expect(paused.handle.ref.labels["selfbuilding.expiresAt"]).toBeDefined();
  });

  it("a not-found ghost drops out of the listing once open confirms it", async () => {
    const { handle } = await provider.openOrCreate(key("ghost-404"), spec());
    await provider.ghost(handle.ref, "not-found");
    expect((await provider.find(key("ghost-404")))?.id).toBe(handle.ref.id);
    await expect(provider.open(handle.ref, { lifetimeMs: 1000 })).rejects.toBeInstanceOf(SandboxNotFoundError);
    expect(await provider.find(key("ghost-404"))).toBeNull();
  });

  it("keys fork children as <parent scope>/fork[i] and keeps secrets and sockets out of copies", async () => {
    const { handle } = await provider.openOrCreate(key("parent"), spec());
    await handle.writeFiles([
      { path: `${SANDBOX_PATHS.secrets}/TOKEN`, data: "secret", mode: 0o600 },
      { path: `${SANDBOX_PATHS.workdir}/keep.txt`, data: "kept" },
    ]);
    const [child] = await provider.fork(handle.ref, { children: [{ name: "child", labels: {} }], lifetimeMs: 60_000 });
    if (!child || child instanceof Error) throw child ?? new Error("no child");
    expect(child.ref.key.scope).toBe("parent/fork[0]");
    expect(child.ref.labels["selfbuilding.parent"]).toBe(handle.ref.id);
    expect(new TextDecoder().decode(await child.readFile(`${SANDBOX_PATHS.workdir}/keep.txt`))).toBe("kept");
    await expect(child.readFile(`${SANDBOX_PATHS.secrets}/TOKEN`)).rejects.toThrow(/does not exist/);
    const snap = await provider.snapshot(handle.ref);
    const snapRoot = path.join(provider.fsRoot, ".meta", "snapshots", snap.snapshotId);
    expect(existsSync(path.join(snapRoot, SANDBOX_PATHS.workdir, "keep.txt"))).toBe(true);
    expect(existsSync(path.join(snapRoot, SANDBOX_PATHS.secrets, "TOKEN"))).toBe(false);
  });

  it("two providers on one root see the same boxes, as two processes on one vendor would", async () => {
    const other = tmpdirProvider({ root: provider.fsRoot });
    const { handle } = await provider.openOrCreate(key("shared-root"), spec());
    const proc = await handle.spawn("echo from-elsewhere");
    const ref = await other.find(key("shared-root"));
    expect(ref?.id).toBe(handle.ref.id);
    const reopened = await other.open(ref as NonNullable<typeof ref>, { lifetimeMs: 60_000 });
    const lines: string[] = [];
    await reopened.attach(proc, { fromOffset: 0, onLine: (_s, line) => lines.push(line) });
    expect(lines).toEqual(["from-elsewhere"]);
  });

  it("close() kills every box and removes a root it created", async () => {
    const own = tmpdirProvider();
    const { handle } = await own.openOrCreate(key(), spec());
    const proc = await handle.spawn("sleep 30");
    await own.close();
    expect(existsSync(own.fsRoot)).toBe(false);
    expect(() => process.kill(-(proc.pgid as number), 0)).toThrow();
  });
});
