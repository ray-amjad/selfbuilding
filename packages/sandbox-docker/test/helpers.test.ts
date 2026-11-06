import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SandboxAuthError,
  SandboxNotFoundError,
  SandboxQuotaError,
  SandboxUnavailableError,
  SELFBUILDING_LABELS,
} from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { classify, isPermanent } from "../src/errors.js";
import { containerLabels, containerName, looksSecret, normaliseState, PRIVATE, publicLabels } from "../src/labels.js";
import { SPAWN_SCRIPT, timeoutArgv } from "../src/sandbox.js";
import { Demuxer, frame, LineSplitter, progressError, Tail } from "../src/stream.js";
import { packTar, unpackTar } from "../src/tar.js";
import { httpError, netError } from "./fake-docker.js";

const ctx = { provider: "docker", sandboxId: "abc" };
/** U+2028, which must never split a line. */
const LS = String.fromCharCode(0x2028);

describe("tar codec", () => {
  it("round-trips binary files with their modes", () => {
    const bytes = new Uint8Array(1500).map((_, i) => i % 256);
    const entries = unpackTar(
      packTar([
        { name: "a/b.bin", data: bytes, mode: 0o600 },
        { name: "c.txt", data: Buffer.from("hi") },
      ]),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "file", name: "a/b.bin", mode: 0o600 });
    expect(Buffer.compare((entries[0] as { data: Buffer }).data, Buffer.from(bytes))).toBe(0);
    expect(entries[1]).toMatchObject({ type: "file", name: "c.txt", mode: 0o644 });
  });

  it("carries names over 100 bytes in a PAX header", () => {
    const name = `${"deep/".repeat(40)}file-é.txt`;
    const [entry] = unpackTar(packTar([{ name, data: Buffer.from("x") }]));
    expect(entry).toMatchObject({ type: "file", name });
  });

  it("produces a valid ustar checksum and two zero blocks at the end", () => {
    const archive = packTar([{ name: "f", data: Buffer.from("abc") }]);
    expect(archive.length % 512).toBe(0);
    const header = Buffer.from(archive.subarray(0, 512));
    const stored = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
    header.fill(" ", 148, 156);
    expect(header.reduce((sum, b) => sum + b, 0)).toBe(stored);
    expect(archive.subarray(-1024).every((b) => b === 0)).toBe(true);
  });

  it("reads GNU long names and base-256 sizes", () => {
    const longName = Buffer.from(`${"x".repeat(150)}\0`);
    const gnu = Buffer.alloc(512);
    gnu.write("././@LongLink", 0);
    gnu.write("L", 156);
    gnu.write(longName.length.toString(8).padStart(11, "0"), 124);
    const file = Buffer.alloc(512);
    file.write("short", 0);
    file.write("0", 156);
    file[124] = 0x80;
    file.writeUInt32BE(2, 132);
    const archive = Buffer.concat([
      gnu,
      longName,
      Buffer.alloc(512 - longName.length),
      file,
      Buffer.from("ok"),
      Buffer.alloc(510),
      Buffer.alloc(1024),
    ]);
    const [entry] = unpackTar(archive);
    expect(entry).toMatchObject({ type: "file", name: "x".repeat(150) });
    expect((entry as { data: Buffer }).data.toString()).toBe("ok");
  });
});

describe("streams", () => {
  it("demultiplexes frames split at any byte boundary", () => {
    const out: string[] = [];
    const demux = new Demuxer((stream, chunk) => out.push(`${stream}:${chunk.toString()}`));
    const bytes = Buffer.concat([frame("stdout", "hello "), frame("stderr", "oops"), frame("stdout", "world")]);
    for (const byte of bytes) demux.push(Buffer.from([byte]));
    const joined = (s: string) =>
      out
        .filter((o) => o.startsWith(s))
        .map((o) => o.slice(s.length))
        .join("");
    expect(joined("stdout:")).toBe("hello world");
    expect(joined("stderr:")).toBe("oops");
  });

  it("Tail keeps the last bytes and marks truncation", () => {
    const tail = new Tail(5);
    tail.push(Buffer.from("abc"));
    tail.push(Buffer.from("defgh"));
    expect(tail.toString()).toBe("defgh");
    expect(tail.truncated).toBe(true);
    const cut = new Tail(4);
    cut.push(Buffer.from("aé€"));
    expect(cut.toString()).toBe("€");
  });

  it("LineSplitter splits on \\n only and flushes a trailing partial line", () => {
    const lines: string[] = [];
    const split = new LineSplitter((l) => lines.push(l));
    const text = Buffer.from(`one\na${LS}b\npar`);
    split.push(text.subarray(0, 6));
    split.push(text.subarray(6));
    expect(lines).toEqual(["one", `a${LS}b`]);
    split.end();
    expect(lines).toEqual(["one", `a${LS}b`, "par"]);
  });

  it("progressError finds the first error in a JSON progress stream", async () => {
    const { Readable } = await import("node:stream");
    expect(await progressError(Readable.from(['{"status":"ok"}\n', 'junk\n{"error":"manifest unknown"}\n']))).toBe(
      "manifest unknown",
    );
    expect(await progressError(Readable.from(['{"status":"done"}\n']))).toBeUndefined();
  });
});

describe("error classification", () => {
  it("maps daemon answers onto the sandbox taxonomy", () => {
    expect(classify(httpError(404, "No such container"), ctx)).toBeInstanceOf(SandboxNotFoundError);
    for (const status of [401, 402, 403])
      expect(classify(httpError(status, "no"), ctx)).toBeInstanceOf(SandboxAuthError);
    expect(classify(httpError(429, "slow down"), ctx)).toBeInstanceOf(SandboxQuotaError);
    for (const status of [409, 500, 503]) {
      const error = classify(httpError(status, "busy"), ctx);
      expect(error).toBeInstanceOf(SandboxUnavailableError);
      expect(error).not.toBeInstanceOf(SandboxNotFoundError);
    }
    expect(classify(netError("ECONNREFUSED"), ctx).message).toMatch(/daemon did not answer/);
    expect(classify(Object.assign(new Error("denied"), { code: "EACCES" }), ctx)).toBeInstanceOf(SandboxAuthError);
    expect(classify(new Error("???"), ctx)).toBeInstanceOf(SandboxUnavailableError);
  });

  it("points a paused-container 409 at open()", () => {
    expect(classify(httpError(409, "Container abc is paused, unpause the container"), ctx).message).toMatch(
      /provider\.open/,
    );
  });

  it("keeps a classified error as it is", () => {
    const error = new SandboxNotFoundError(ctx);
    expect(classify(error, ctx)).toBe(error);
  });

  it("treats 400-class refusals as permanent, 404/409/429 and outages as not", () => {
    expect(isPermanent(classify(httpError(400, "bad"), ctx))).toBe(true);
    expect(isPermanent(classify(httpError(409, "conflict"), ctx))).toBe(false);
    expect(isPermanent(classify(httpError(503, "busy"), ctx))).toBe(false);
    expect(isPermanent(new SandboxAuthError(ctx))).toBe(true);
  });
});

describe("labels and names", () => {
  const key = { runId: "r1", scope: "root/2/review", deployment: "dev" };

  it("writes every selfbuilding label, masking the ones the core left out", () => {
    const labels = containerLabels(
      key,
      { [SELFBUILDING_LABELS.name]: "ns-abc", [SELFBUILDING_LABELS.step]: "s1" },
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
        onExpire: "pause",
      },
    );
    expect(labels).toMatchObject({
      "selfbuilding.deployment": "dev",
      "selfbuilding.run": "r1",
      "selfbuilding.name": "ns-abc",
      "selfbuilding.step": "s1",
      "selfbuilding.launch": "",
      "selfbuilding.parent": "",
      "selfbuilding.expiresAt": "2026-01-01T01:00:00.000Z",
      [PRIVATE.scope]: "root/2/review",
    });
    expect(publicLabels(labels)).not.toHaveProperty("selfbuilding.launch");
    expect(Object.keys(publicLabels(labels)).every((k) => k.startsWith("selfbuilding."))).toBe(true);
  });

  it("derives a name when the core sent none", () => {
    const labels = containerLabels(key, {}, { createdAt: "x", expiresAt: "y", onExpire: "kill" });
    expect(labels["selfbuilding.name"]).toMatch(/^sb-[0-9a-f]{20}$/);
  });

  it("container names are valid for the daemon and unique per deployment", () => {
    expect(containerName({ "selfbuilding.name": "ns-abc", "selfbuilding.deployment": "dev" })).toBe("ns-abc.dev");
    expect(containerName({ "selfbuilding.name": "box#0/fork[1]", "selfbuilding.deployment": "ci-1" })).toBe(
      "box-0-fork-1-.ci-1",
    );
    expect(containerName({ "selfbuilding.name": "-x", "selfbuilding.deployment": "d" })).toMatch(/^[a-zA-Z0-9]/);
  });

  it("normalises states without throwing on unknown ones", () => {
    expect(normaliseState("running")).toBe("running");
    expect(normaliseState("running", true)).toBe("paused");
    expect(normaliseState("created")).toBe("starting");
    expect(normaliseState("exited")).toBe("stopped");
    expect(normaliseState("dead")).toBe("error");
    expect(normaliseState("frobnicated")).toBe("unknown");
    expect(normaliseState(undefined)).toBe("unknown");
  });

  it("recognises credential-looking env names", () => {
    for (const name of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "AUTH"]) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ["PATH", "HOME", "NODE_ENV", "AUTHOR_NAME", "TOKENIZER"])
      expect(looksSecret(name), name).toBe(false);
  });

  it("passes the command to GNU timeout as an argument, never spliced into the script", () => {
    const argv = timeoutArgv("echo '$(rm -rf /)'", 1500);
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv[2]).not.toContain("rm -rf");
    expect(argv.slice(3)).toEqual(["sb-exec", "1.5s", "echo '$(rm -rf /)'"]);
  });
});

// The real shim under a real /bin/sh, no Docker needed. A supervisor spawned as root once inherited the shim's 077,
// so every file its boot clone wrote was unreadable to the agent user.
describe.skipIf(spawnSync("/bin/sh", ["-c", "command -v setsid"]).status !== 0)("spawn shim", () => {
  it("keeps the cmd and log files private but runs the command under the caller's umask", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sb-shim-"));
    try {
      const [cmdFile, exitFile, logFile] = ["p.cmd", "p.exit", "p.log"].map((f) => path.join(dir, f)) as [
        string,
        string,
        string,
      ];
      const made = path.join(dir, "made.txt");
      const r = spawnSync(
        "/bin/sh",
        ["-c", 'umask 022; exec /bin/sh -c "$0" sb-spawn "$@"', SPAWN_SCRIPT, cmdFile, exitFile, logFile, "/dev/null"],
        { input: `umask; echo hi > '${made}'\n`, encoding: "utf8" },
      );
      expect(r.status, r.stderr).toBe(0);
      for (let i = 0; i < 300; i++) {
        try {
          statSync(exitFile);
          break;
        } catch {
          await new Promise((res) => setTimeout(res, 10));
        }
      }
      expect(readFileSync(exitFile, "utf8")).toBe("0");
      expect(readFileSync(logFile, "utf8").trim()).toBe("0022");
      expect(statSync(made).mode & 0o777).toBe(0o644);
      expect(statSync(cmdFile).mode & 0o777).toBe(0o600);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
