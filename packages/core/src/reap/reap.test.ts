import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryJournal, type TmpdirProvider, tmpdirProvider } from "../../test/agent-kit/kit.js";
import { SELFBUILDING_LABELS, sandboxName } from "../sandbox/names.js";
import { imageFor } from "../sandbox/spec.js";
import type { AskRecord, AskStore } from "../types/ask.js";
import type { JournalEntry } from "../types/orchestration.js";
import type { SandboxProvider, SandboxRef } from "../types/sandbox.js";
import { ORPHAN_AGE_MS, reap } from "./index.js";

const DEPLOYMENT = "reap-test";

function asks(records: AskRecord[] = []): AskStore {
  return {
    async create() {
      return { status: "created" };
    },
    async get() {
      return null;
    },
    async resolve() {
      throw new Error("unused");
    },
    async openForThread() {
      return [];
    },
    async *open(filter) {
      for (const r of records) if (!filter.runId || r.runId === filter.runId) yield r;
    },
    async setStatus() {},
  };
}

/** Wraps a provider so its listing rewrites each ref (the tmpdir provider keeps private fields, so bind every method). */
function relisted(provider: SandboxProvider, rewrite: (ref: SandboxRef) => SandboxRef): SandboxProvider {
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === "list") {
        return async function* (filter: Parameters<SandboxProvider["list"]>[0]) {
          for await (const ref of target.list(filter)) yield rewrite(ref);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function aged(provider: SandboxProvider, ageMs: number): SandboxProvider {
  return relisted(provider, (ref) => ({ ...ref, createdAt: new Date(Date.now() - ageMs).toISOString() }));
}

let provider: TmpdirProvider;

beforeEach(() => {
  provider = tmpdirProvider({});
});

afterEach(async () => {
  await provider.close();
});

async function makeBox(runId: string, scope: string, extra: Record<string, string> = {}) {
  const key = { runId, scope, deployment: DEPLOYMENT };
  const name = sandboxName(key);
  const { handle } = await provider.openOrCreate(key, {
    image: imageFor(undefined),
    env: {},
    lifetimeMs: 3_600_000,
    onExpire: "pause",
    labels: {
      [SELFBUILDING_LABELS.deployment]: DEPLOYMENT,
      [SELFBUILDING_LABELS.run]: runId,
      [SELFBUILDING_LABELS.name]: name,
      ...extra,
    },
  });
  return { handle, name, ref: handle.ref as SandboxRef };
}

function entry(
  runId: string,
  stepKey: string,
  status: JournalEntry["status"],
  kind: JournalEntry["kind"] = "agent",
): JournalEntry {
  return {
    runId,
    stepKey,
    callPath: `${stepKey}#0`,
    kind,
    status,
    startedAt: new Date().toISOString(),
  } as unknown as JournalEntry;
}

async function live(): Promise<SandboxRef[]> {
  const out: SandboxRef[] = [];
  for await (const ref of provider.list({ deployment: DEPLOYMENT })) if (ref.state !== "stopped") out.push(ref);
  return out;
}

describe("reap", () => {
  it("holds young orphans and kills old ones", async () => {
    await makeBox("ns_orphan", "A#0");
    const journal = memoryJournal();
    const young = await reap({ providers: [provider], journal, asks: asks(), deployment: DEPLOYMENT });
    expect(young.decisions.map((d) => d.reason)).toEqual(["orphan-young"]);
    expect(young.held).toBe(1);

    const old = await reap({
      providers: [aged(provider, ORPHAN_AGE_MS + 1_000)],
      journal,
      asks: asks(),
      deployment: DEPLOYMENT,
    });
    expect(old.decisions.map((d) => d.reason)).toEqual(["orphan"]);
    expect(old).toMatchObject({ killed: 1, leaked: 1 });
    expect(await live()).toHaveLength(0);
  });

  it("holds boxes whose call is live and kills boxes whose call finished", async () => {
    const journal = memoryJournal();
    await journal.lease("ns_r", "test", "1h");
    const lease = (await journal.lease("ns_r", "test", "1h")) as NonNullable<Awaited<ReturnType<typeof journal.lease>>>;
    const a = await makeBox("ns_r", "Live#0", { [SELFBUILDING_LABELS.step]: "steplive" });
    await makeBox("ns_r", "Done#0", { [SELFBUILDING_LABELS.step]: "stepdone" });
    await journal.put(entry("ns_r", "steplive", "started"), { lease });
    await journal.put(entry("ns_r", "stepdone", "ok"), { lease });
    const report = await reap({ providers: [provider], journal, asks: asks(), deployment: DEPLOYMENT });
    const reasons = Object.fromEntries(report.decisions.map((d) => [d.sandbox.name, d.reason]));
    expect(reasons[a.name]).toBe("call-live");
    expect(Object.values(reasons)).toContain("call-terminal");
    expect(report.killed).toBe(1);
    expect((await live()).map((r) => r.name)).toEqual([a.name]);
  });

  it("kills every box of a run that has ended", async () => {
    const journal = memoryJournal();
    const lease = (await journal.lease("ns_end", "test", "1h")) as NonNullable<
      Awaited<ReturnType<typeof journal.lease>>
    >;
    await journal.put(entry("ns_end", "run", "ok", "run"), { lease });
    await makeBox("ns_end", "Gone#0");
    const report = await reap({ providers: [provider], journal, asks: asks(), deployment: DEPLOYMENT });
    expect(report.decisions.map((d) => d.reason)).toEqual(["run-terminal"]);
    expect(report.killed).toBe(1);
  });

  it("holds boxes with no run label as owner-unknown", async () => {
    await makeBox("ns_x", "A#0");
    const unlabelled = relisted(aged(provider, ORPHAN_AGE_MS * 2), (ref) => {
      const { [SELFBUILDING_LABELS.run]: _run, ...labels } = ref.labels;
      return { ...ref, labels };
    });
    const report = await reap({
      providers: [unlabelled],
      journal: memoryJournal(),
      asks: asks(),
      deployment: DEPLOYMENT,
    });
    expect(report.decisions.map((d) => d.reason)).toEqual(["owner-unknown"]);
  });

  it("reports a listing outage instead of treating it as empty", async () => {
    await makeBox("ns_o", "A#0");
    provider.faults.inject("503", "list");
    const report = await reap({
      providers: [provider],
      journal: memoryJournal(),
      asks: asks(),
      deployment: DEPLOYMENT,
    });
    expect(report.errors).toHaveLength(1);
    expect(report.decisions).toHaveLength(0);
    expect(await live()).toHaveLength(1);
  });

  it("changes nothing on a dry run", async () => {
    await makeBox("ns_dry", "A#0");
    const report = await reap({
      providers: [aged(provider, ORPHAN_AGE_MS * 2)],
      journal: memoryJournal(),
      asks: asks(),
      deployment: DEPLOYMENT,
      dryRun: true,
    });
    expect(report.decisions.map((d) => d.action)).toEqual(["kill"]);
    expect(report.killed).toBe(0);
    expect(await live()).toHaveLength(1);
  });

  it("holds a box whose turn lock is held", async () => {
    const { ref } = await makeBox("ns_busy", "A#0");
    const root = path.join(provider.fsRoot, ref.id);
    const lock = path.join(root, "run/selfbuilding/call.lock");
    await fs.mkdir(path.dirname(lock), { recursive: true });
    const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const report = await reap({
        providers: [aged(provider, ORPHAN_AGE_MS * 2)],
        journal: memoryJournal(),
        asks: asks(),
        deployment: DEPLOYMENT,
      });
      expect(report.decisions.map((d) => d.reason)).toEqual(["turn-lock-busy"]);
      expect(await live()).toHaveLength(1);
    } finally {
      holder.kill();
    }
  });
});
