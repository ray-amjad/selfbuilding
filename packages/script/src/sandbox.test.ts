// Sandbox handles from a script: sb.sandbox, exec, fork and dispose on the tmpdir provider, offline.
import fs from "node:fs/promises";
import path from "node:path";
import { createLocalRemote, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeAgents, runSource, tempDir } from "../test/kit.js";

let dir: string;
let boxes: TmpdirProvider;
let other: TmpdirProvider;
let repo: string;

beforeAll(async () => {
  dir = await tempDir("sbs-box-");
  boxes = tmpdirProvider({ root: path.join(dir, "boxes") });
  other = tmpdirProvider({ id: "tmpdir-other", root: path.join(dir, "other") });
  repo = `file://${(await createLocalRemote(dir, { files: { "README.md": "# playground\n" } })).bareDir}`;
});

afterAll(async () => {
  await boxes.close();
  await other.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function live(p: TmpdirProvider, runId: string): Promise<number> {
  let n = 0;
  for await (const ref of p.list({ deployment: "test", runId })) if (ref.state !== "stopped") n++;
  return n;
}

describe("sb.sandbox handles", () => {
  it("creates a handle, runs commands in it, forks it and disposes the forks", async () => {
    const runId = "ns_script_handles";
    const out = await runSource(
      `export default async (input, sb) => {
  const box = sb.sandbox({ label: "build", repo: input.repo });
  const wrote = await box.exec("echo built > out.txt && cat out.txt");
  const forks = await box.fork(2);
  const seen = await sb.parallel(forks.map((f) => () => f.exec("cat out.txt")));
  await Promise.all(forks.map((f) => f.dispose()));
  await box.dispose();
  return { id: box.id, wrote: wrote.stdoutTail.trim(), exit: wrote.exitCode, forks: forks.length, seen: seen.map((r) => r.stdoutTail.trim()) };
}`,
      { dir, runId, input: { repo }, config: { sandbox: boxes } },
    );
    expect(out.status).toBe("ok");
    expect(out.output).toEqual({ id: "build", wrote: "built", exit: 0, forks: 2, seen: ["built", "built"] });
    expect(await live(boxes, runId)).toBe(0);
  });

  it("passes a handle to an agent call as its sandbox", async () => {
    const fakes = fakeAgents({ A: {} });
    fakes.reset();
    const out = await runSource(
      `export default async (input, sb) => {
  const box = sb.sandbox({ label: "work", repo: input.repo });
  await sb.agents.A({}, { sandbox: box });
  await sb.agents.A({}, { sandbox: "fresh", provider: "other" });
  return true;
}`,
      { dir, input: { repo }, config: { sandbox: boxes }, script: { agents: fakes.agents, providers: { other } } },
    );
    expect(out.status).toBe("ok");
    expect((fakes.calls[0]?.opts?.sandbox as { id?: string } | undefined)?.id).toBe("work");
    expect(fakes.calls[1]?.opts?.sandbox).toBe(other);
  });

  it("a handle on a registered provider is created there", async () => {
    const runId = "ns_script_other";
    const out = await runSource(
      `export default async (input, sb) => {
  const box = sb.sandbox({ provider: "other", label: "elsewhere", repo: input.repo });
  const r = await box.exec("pwd");
  await box.dispose();
  return r.exitCode;
}`,
      { dir, runId, input: { repo }, config: { sandbox: boxes }, script: { providers: { other } } },
    );
    expect(out.output).toBe(0);
  });

  it("exec options are checked", async () => {
    await expect(
      runSource(
        `export default async (input, sb) => sb.sandbox({ repo: input.repo }).exec("true", { user: "root" });`,
        {
          dir,
          input: { repo },
          config: { sandbox: boxes },
        },
      ),
    ).rejects.toThrow('handle.exec option "user" is not supported');
  });
});
