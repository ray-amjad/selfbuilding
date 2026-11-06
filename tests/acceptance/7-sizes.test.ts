// Acceptance 7 (docs/spec/demo-path.md §1): machine sizes end to end on tmpdir boxes running the real runtime. A
// call names a size; the box is created at it (label, event, journal, usage), the factory default and the shared
// handle apply where the precedence table says, a size the provider cannot give fails with a typed error that
// names the fix before any capacity is taken, forks follow the provider's fork rule, and a resume keeps the size
// the first launch journaled.
import fs from "node:fs/promises";
import path from "node:path";
import {
  agent,
  factory,
  fileArtifacts,
  fileJournal,
  type JournalEntry,
  type ProviderSizing,
  run,
  type SelfbuildingConfig,
  type SizeName,
  SizeUnavailableError,
  SizeUnknownError,
  sandbox,
} from "@selfbuilding/core";
import {
  createLocalRemote,
  type ScriptCall,
  scripted,
  type TmpdirProvider,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

let dir: string;
let sized: TmpdirProvider;
let unsized: TmpdirProvider;
let templated: TmpdirProvider;
let repo: string;

const templateSizing: ProviderSizing = {
  kind: "template",
  forkSize: "inherit",
  resize: false,
  available: ["small", "medium"],
  limits: { maxVcpu: 8, maxMemoryMiB: 8192 },
  templateFor: (base, size) => (size === "small" ? base : `${base}-${size}`),
};

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-sizes-");
  sized = tmpdirProvider({ id: "tmpdir-sized", root: path.join(dir, "sized") });
  unsized = tmpdirProvider({ id: "tmpdir-plain", root: path.join(dir, "plain"), sizing: false });
  // Stands in for a template provider (E2B, Impello): sizes fixed per built template, forks inherit.
  templated = tmpdirProvider({ id: "e2b", root: path.join(dir, "templated"), sizing: templateSizing });
  repo = (await createLocalRemote(path.join(dir, "remote"), { files: { "README.md": "# sizes\n" } })).url;
});

afterAll(async () => {
  await sized?.close();
  await unsized?.close();
  await templated?.close();
});

const Ok = z.object({ ok: z.literal(true) });
const ok = scripted.submit({ ok: true });

const call = (label: string, extra: object = {}) =>
  agent({ name: label, prompt: `Size step ${label}.`, output: Ok, label, repo, ...extra });

async function runSized(
  name: string,
  body: () => Promise<unknown>,
  o: {
    provider?: TmpdirProvider;
    size?: SizeName;
    config?: Partial<SelfbuildingConfig>;
    runId?: string;
    script?: (c: ScriptCall) => ReturnType<typeof scripted.submit>[];
  } = {},
) {
  const events = recorder();
  const out = await run(
    factory({ name, input: z.object({}), ...(o.size ? { defaults: { size: o.size } } : {}) }, body),
    {},
    {
      ...(o.runId ? { runId: o.runId } : {}),
      config: {
        deployment: "acceptance",
        sandbox: o.provider ?? sized,
        harness: scriptedClaude(o.script ?? (() => [ok])),
        artifacts: fileArtifacts(path.join(dir, "artifacts")),
        ...o.config,
      },
      events: [events.sink],
    },
  );
  return { out, events };
}

type Created = {
  ref: { labels: Record<string, string>; size?: string };
  size?: string;
  vcpu?: number;
  memoryMiB?: number;
  template?: string;
};
const created = (r: Awaited<ReturnType<typeof runSized>>) =>
  r.events.of("sandbox.created").map((e) => e.data as Created);

describe("acceptance 7: machine sizes", () => {
  it("a call's size reaches the box: label, ref, event data, and vCPU-weighted usage", async () => {
    let usage: { sandboxMs: number; sandboxVcpuMs?: number } | undefined;
    const r = await runSized("call-size", async () => {
      const res = await call("big", { size: "large" });
      usage = res.usage;
      return null;
    });
    expect(r.out.status).toBe("ok");
    const [box] = created(r);
    expect(box).toMatchObject({ size: "large", vcpu: 8, memoryMiB: 16384 });
    expect(box?.template).toBeUndefined();
    expect(box?.ref.labels["selfbuilding.size"]).toBe("large");
    expect(box?.ref.size).toBe("large");
    expect(usage?.sandboxVcpuMs).toBe((usage?.sandboxMs ?? 0) * 8);
    expect(r.out.usage.sandboxVcpuMs).toBe(usage?.sandboxVcpuMs);
  });

  it("no size anywhere: the box carries none, exactly as before sizes existed", async () => {
    const r = await runSized("no-size", async () => {
      await call("plain");
      return null;
    });
    expect(r.out.status).toBe("ok");
    const [box] = created(r);
    expect(box?.size).toBeUndefined();
    expect(box?.ref.labels["selfbuilding.size"]).toBeUndefined();
    expect(r.out.usage.sandboxVcpuMs).toBeUndefined();
  });

  it("precedence: the call's size beats the factory default; a custom config size resolves", async () => {
    const r = await runSized(
      "precedence",
      async () => {
        await call("default");
        await call("override", { size: "xlarge" });
        return null;
      },
      { size: "medium", config: { sizes: { xlarge: { vcpu: 16, memoryMiB: 32768 } } } },
    );
    expect(r.out.status).toBe("ok");
    expect(created(r).map((b) => [b.size, b.vcpu])).toEqual([
      ["medium", 4],
      ["xlarge", 16],
    ]);
  });

  it("an unknown size is a usage error naming the known sizes", async () => {
    let caught: unknown;
    const r = await runSized("unknown", async () => {
      try {
        await call("typo", { size: "medum" });
      } catch (error) {
        caught = error;
      }
      return null;
    });
    expect(r.out.status).toBe("ok");
    expect(caught).toBeInstanceOf(SizeUnknownError);
    expect((caught as SizeUnknownError).known).toEqual(["small", "medium", "large"]);
    expect(created(r)).toEqual([]);
  });

  it("a provider that takes no sizes refuses with the fix, emits size_refused once, and holds no slot", async () => {
    let settled: Awaited<ReturnType<typeof agent.settled>> | undefined;
    const r = await runSized(
      "not-sizable",
      async () => {
        settled = await agent.settled({ name: "x", prompt: "x", output: Ok, label: "x", repo, size: "small" });
        // A refused size took no slot: a cap of one still admits the next call.
        await call("after");
        return null;
      },
      { provider: unsized, config: { concurrency: { sandboxes: 1 } } },
    );
    expect(r.out.status).toBe("ok");
    expect(settled?.ok).toBe(false);
    if (settled?.ok === false) {
      expect(settled.code).toBe("size_unavailable");
      const error = settled.error as SizeUnavailableError;
      expect(error).toBeInstanceOf(SizeUnavailableError);
      expect(error.reason).toBe("not-sizable");
      expect(error.message).toContain('Provider "tmpdir-plain" takes no sizes.');
    }
    const refused = r.events.of("sandbox.size_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.level).toBe("error");
    expect(refused[0]?.data).toMatchObject({ provider: "tmpdir-plain", size: "small", reason: "not-sizable" });
    expect(created(r)).toHaveLength(1);
  });

  it("template provider: a built size names its template; an unbuilt or over-limit size is refused", async () => {
    const outcomes: unknown[] = [];
    const r = await runSized(
      "template",
      async () => {
        await call("medium", { size: "medium" });
        for (const size of ["large"]) {
          const s = await agent.settled({ name: size, prompt: "x", output: Ok, label: size, repo, size });
          outcomes.push(s.ok ? "ok" : (s.error as SizeUnavailableError).reason);
        }
        return null;
      },
      { provider: templated },
    );
    expect(r.out.status).toBe("ok");
    expect(created(r)[0]).toMatchObject({ size: "medium", template: "selfbuilding-scripted-claude-code-medium" });
    expect(outcomes).toEqual(["over-limit"]);
    const fixes = r.events.of("sandbox.size_refused").map((e) => (e.data as { fix: string }).fix);
    expect(fixes[0]).toMatch(/^E2B Hobby allows 8 vCPU and 8 GiB per sandbox/);
  });

  it("template provider: a size whose template was never built names the build command", async () => {
    const limited = tmpdirProvider({
      id: "impello",
      root: path.join(dir, "impello"),
      sizing: { ...templateSizing, available: ["small"], limits: { maxVcpu: 4 } },
    });
    try {
      let reason: string | undefined;
      const r = await runSized(
        "not-built",
        async () => {
          const s = await agent.settled({ name: "m", prompt: "x", output: Ok, label: "m", repo, size: "medium" });
          if (!s.ok) reason = (s.error as SizeUnavailableError).reason;
          return null;
        },
        { provider: limited },
      );
      expect(reason).toBe("not-built");
      expect(r.events.of("sandbox.size_refused")[0]?.data?.fix).toBe(
        'Build it: selfbuilding images build --provider impello --harness scripted-claude-code --size medium, then add "medium" to impello({ sizes }).',
      );
    } finally {
      await limited.close();
    }
  });

  it("shared handle: sandbox({ size }) sizes the box; a call's own size is ignored with one warning", async () => {
    const r = await runSized("handle", async () => {
      await using box = sandbox({ label: "work", repo, size: "medium" });
      await call("a", { sandbox: box, size: "large" });
      await call("b", { sandbox: box });
      return null;
    });
    expect(r.out.status).toBe("ok");
    expect(created(r).map((b) => b.size)).toEqual(["medium"]);
    const warnings = r.events.of("log").filter((e) => (e.data as { scope?: string }).scope === "size");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe("warn");
    expect(String(warnings[0]?.data?.message)).toContain('"medium"');
  });

  it("the factory default sizes sandbox() handles too", async () => {
    const r = await runSized(
      "handle-default",
      async () => {
        await using box = sandbox({ label: "work", repo });
        await box.exec("true");
        return null;
      },
      { size: "large" },
    );
    expect(r.out.status).toBe("ok");
    expect(created(r).map((b) => b.size)).toEqual(["large"]);
  });

  it("fork: children keep the parent's size by default and may take another where forks override", async () => {
    let sizes: (string | undefined)[] = [];
    const r = await runSized("fork-override", async () => {
      await using box = sandbox({ label: "work", repo, size: "small" });
      await box.exec("echo hi > a.txt");
      const same = await box.fork(1);
      const bigger = await box.fork(1, { size: "large" });
      const kids = [...same, ...bigger];
      try {
        for (const kid of kids) await kid?.exec("test -e a.txt");
        sizes = kids.map((k) => (k as unknown as { ref?: { size?: string } })?.ref?.size);
      } finally {
        await Promise.all(kids.map((k) => k?.dispose()));
      }
      return null;
    });
    expect(r.out.status, JSON.stringify(r.events.of("error").map((e) => e.data))).toBe("ok");
    expect(sizes).toEqual(["small", "large"]);
  });

  it("fork: a provider whose forks inherit refuses a child of another size before taking a slot", async () => {
    let caught: unknown;
    const r = await runSized(
      "fork-inherit",
      async () => {
        await using box = sandbox({ label: "work", repo, size: "small" });
        await box.exec("true");
        try {
          await box.fork(1, { mode: "filesystem", size: "medium" });
        } catch (error) {
          caught = error;
        }
        const same = await box.fork(1, { mode: "filesystem" });
        await Promise.all(same.map((k) => k?.dispose()));
        return same.length;
      },
      { provider: templated },
    );
    expect(r.out.status).toBe("ok");
    expect(r.out.output).toBe(1);
    expect(caught).toBeInstanceOf(SizeUnavailableError);
    expect((caught as SizeUnavailableError).reason).toBe("fork-inherits");
    expect((caught as SizeUnavailableError).fix).toBe(
      'Forks on "e2b" keep the parent\'s size (small). Create the parent at "medium", or run this call on a fresh box.',
    );
  });

  it("journal and resume: the size is journaled, and a resumed call keeps the size the first launch used", async () => {
    const journalDir = path.join(dir, "journal-resume");
    const runId = "sizes-resume-1";
    const first = await runSized(
      "resume",
      async () => {
        await call("w", { size: "medium" }).catch(() => undefined);
        return null;
      },
      {
        runId,
        config: { journal: fileJournal(journalDir) },
        script: () => [scripted.error("boom", "the harness broke") as never],
      },
    );
    expect(created(first).map((b) => b.size)).toEqual(["medium"]);
    const entries = await readJournal(journalDir);
    const agentEntry = entries.find((e) => e.kind === "agent" && e.callPath.endsWith("w"));
    expect(agentEntry?.sandbox?.size).toBe("medium");

    // The code now asks for another size; the resumed call recreates its box at the journaled one.
    const second = await runSized(
      "resume",
      async () => {
        await call("w", { size: "large" });
        return null;
      },
      { runId, config: { journal: fileJournal(journalDir) } },
    );
    expect(second.out.status, JSON.stringify(second.events.of("error").map((e) => e.data))).toBe("ok");
    expect(created(second).map((b) => b.size)).toEqual(["medium"]);
  });

  it("sandbox registry rows carry the handle's size", async () => {
    const journalDir = path.join(dir, "journal-rows");
    const r = await runSized(
      "rows",
      async () => {
        await using box = sandbox({ label: "work", repo, size: "medium" });
        await box.exec("true");
        return null;
      },
      { config: { journal: fileJournal(journalDir) } },
    );
    expect(r.out.status).toBe("ok");
    const rows = (await readJournal(journalDir)).filter((e) => e.kind === "sandbox" && e.callPath.includes("work"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.sandbox?.size === "medium")).toBe(true);
  });
});

async function readJournal(root: string): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith(".json")) {
        const parsed = JSON.parse(await fs.readFile(p, "utf8")) as JournalEntry | { entry?: JournalEntry };
        const e = "stepKey" in parsed ? parsed : parsed.entry;
        if (e && "stepKey" in e) out.push(e);
      }
    }
  };
  await walk(root);
  return out;
}
