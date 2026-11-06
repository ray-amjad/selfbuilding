import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelDeliveryError } from "../errors/classes.js";
import type { AskResolution } from "../types/ask.js";
import { ATTEMPT_FILES, SANDBOX_PATHS } from "../types/runtime.js";
import type { ExecOpts, ExecResult, ProviderSandbox } from "../types/sandbox.js";
import { answerCommand, deliverAnswer } from "./inbox.js";

const resolution: AskResolution = {
  askId: "ask_abcdefghijklmnopqrst",
  answer: { kind: "choice", choiceId: "hold" },
  choiceId: "hold",
  answeredBy: { kind: "human", channel: "slack", userId: "user-1", displayName: "user-1" },
  answeredAt: "2026-11-01T00:00:00.000Z",
};

function fakeBox(results: Partial<ExecResult>[]): ProviderSandbox & { calls: { cmd: string; o?: ExecOpts }[] } {
  const calls: { cmd: string; o?: ExecOpts }[] = [];
  return {
    calls,
    ref: { id: "box-1" } as ProviderSandbox["ref"],
    async exec(cmd, o) {
      calls.push({ cmd, ...(o ? { o } : {}) });
      const r = results.shift() ?? {};
      return { exitCode: 0, stdoutTail: "", stderrTail: "", truncated: false, ...r };
    },
    spawn: () => Promise.reject(new Error("unused")),
    attach: () => Promise.reject(new Error("unused")),
    readFile: () => Promise.reject(new Error("unused")),
    writeFiles: () => Promise.reject(new Error("unused")),
    extendLifetime: () => Promise.reject(new Error("unused")),
  };
}

describe("deliverAnswer", () => {
  it("runs the runtime's answer verb as the agent user with the InboxAnswer on stdin", async () => {
    const box = fakeBox([{ stdoutTail: '{"written":true}\n' }]);
    expect(await deliverAnswer(box, { stepKey: "step1", attempt: 2, resolution, fsRoot: "/tmp/root" })).toEqual({
      written: true,
    });
    const call = box.calls[0];
    expect(call?.cmd).toBe(
      `node ${SANDBOX_PATHS.runtimeBundle} answer --call 'step1' --attempt 2 --ask 'ask_abcdefghijklmnopqrst'`,
    );
    expect(call?.o).toMatchObject({ user: "agent", idempotent: true, env: { SELFBUILDING_FS_ROOT: "/tmp/root" } });
    expect(JSON.parse(String(call?.o?.stdin))).toEqual({ askId: resolution.askId, resolution });
  });

  it("retries a transient failure, then reports written: false as is", async () => {
    const box = fakeBox([{ exitCode: 75 }, { stdoutTail: '{"written":false}' }]);
    expect(await deliverAnswer(box, { stepKey: "s", attempt: 1, resolution })).toEqual({ written: false });
    expect(box.calls).toHaveLength(2);
  });

  it("throws ChannelDeliveryError on a config failure or a malformed reply", async () => {
    await expect(
      deliverAnswer(fakeBox([{ exitCode: 78, stderrTail: "no such call" }]), { stepKey: "s", attempt: 1, resolution }),
    ).rejects.toThrow(ChannelDeliveryError);
    await expect(
      deliverAnswer(fakeBox([{ stdoutTail: "hello" }]), { stepKey: "s", attempt: 1, resolution }),
    ).rejects.toThrow(/printed no \{written\}/);
  });

  it("quotes ids so a hostile value cannot break out of the command", () => {
    expect(answerCommand("a'; rm -rf /; '", 1, "ask_x")).toContain(`--call 'a'\\''; rm -rf /; '\\'''`);
  });
});

// The same command run for real: a stub runtime implements the answer verb's contract (write once, only
// while inbox/.open exists) inside a temp dir standing in for "/".
describe("deliverAnswer through a shell", () => {
  let root = "";
  const attemptDir = () => join(root, SANDBOX_PATHS.calls.slice(1), "step1", "1");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sb-inbox-"));
    const bundle = join(root, SANDBOX_PATHS.runtimeBundle.slice(1));
    await mkdir(join(bundle, ".."), { recursive: true });
    await writeFile(
      bundle,
      `import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const arg = (k) => args[args.indexOf(k) + 1];
const dir = join(process.env.SELFBUILDING_FS_ROOT, "${SANDBOX_PATHS.calls}", arg("--call"), arg("--attempt"));
const body = JSON.parse(readFileSync(0, "utf8"));
if (body.askId !== arg("--ask")) { process.stderr.write("askId mismatch"); process.exit(78); }
if (!existsSync(join(dir, "${ATTEMPT_FILES.inboxOpen}"))) { console.log(JSON.stringify({ written: false })); process.exit(0); }
try { writeFileSync(join(dir, "inbox", body.askId + ".json"), JSON.stringify(body), { flag: "wx" }); console.log(JSON.stringify({ written: true })); }
catch { console.log(JSON.stringify({ written: false })); }
`,
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function shellBox(): ProviderSandbox {
    const box = fakeBox([]);
    box.exec = (cmd, o) =>
      new Promise((resolve) => {
        const mapped = cmd.replaceAll("/selfbuilding/", `${root}/selfbuilding/`);
        const child = spawn("/bin/sh", ["-c", mapped], { env: { PATH: process.env.PATH ?? "", ...o?.env } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
          stdout += d;
        });
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("close", (code) =>
          resolve({ exitCode: code ?? 1, stdoutTail: stdout, stderrTail: stderr, truncated: false }),
        );
        child.stdin.end(o?.stdin ?? "");
      });
    return box;
  }

  it("writes inbox/<askId>.json only while the inbox is open, and only once", async () => {
    const box = shellBox();
    const opts = { stepKey: "step1", attempt: 1, resolution, fsRoot: root };
    await mkdir(join(attemptDir(), "inbox"), { recursive: true });
    expect(await deliverAnswer(box, opts)).toEqual({ written: false });

    await writeFile(join(attemptDir(), ATTEMPT_FILES.inboxOpen), "");
    expect(await deliverAnswer(box, opts)).toEqual({ written: true });
    const file = join(attemptDir(), "inbox", `${resolution.askId}.json`);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ askId: resolution.askId, resolution });
    expect(await deliverAnswer(box, opts)).toEqual({ written: false });
  });
});
