// Test support for the CLI: temp projects, an in-memory journal and ask store, and a fake core.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
  AskRecord,
  AskResolution,
  AskStore,
  Factory,
  JournalEntry,
  JournalStore,
  Lease,
  ReapOptions,
  ReapReport,
  RunOptions,
  RunOutcome,
  RunStatus,
  SelfbuildingEvent,
  ThreadKey,
} from "@selfbuilding/core";
import type { CliContext, CoreApi } from "../src/context.js";
import { main } from "../src/main.js";

export const DEPLOYMENT = "test-cli";

function packageDir(specifier: string, name: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve(specifier)));
  while (!existsSync(path.join(dir, "package.json")) || readPackageName(dir) !== name) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot find the ${name} package directory`);
    dir = parent;
  }
  return dir;
}

function readPackageName(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string }).name;
  } catch {
    return undefined;
  }
}

export interface TestProject {
  root: string;
  write(rel: string, content: string): string;
  read(rel: string): string;
  exists(rel: string): boolean;
  cleanup(): void;
}

/**
 * A temp project with a `.git` marker, and the workspace's core, testing and zod linked into its node_modules so
 * its config and factory files resolve them through jiti.
 */
export function makeProject(): TestProject {
  const root = mkdtempSync(path.join(os.tmpdir(), "sbcli-"));
  mkdirSync(path.join(root, ".git"));
  const modules = path.join(root, "node_modules");
  mkdirSync(path.join(modules, "@selfbuilding"), { recursive: true });
  symlinkSync(packageDir("@selfbuilding/core", "@selfbuilding/core"), path.join(modules, "@selfbuilding/core"));
  symlinkSync(
    packageDir("@selfbuilding/testing", "@selfbuilding/testing"),
    path.join(modules, "@selfbuilding/testing"),
  );
  symlinkSync(packageDir("zod", "zod"), path.join(modules, "zod"));
  return {
    root,
    write(rel, content) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    exists: (rel) => existsSync(path.join(root, rel)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A factory file with no imports: just the shape `run()` and the CLI loader check for. */
export const FACTORY_SOURCE = `
function make(name: string) {
  const body = async (input: { n?: number }) => ({ doubled: (input?.n ?? 0) * 2 });
  const f = Object.assign(async (input: { n?: number }) => body(input), {
    body,
    inputSchema: { parse: (v: unknown) => v },
    options: { name },
  });
  Object.defineProperty(f, "name", { value: name });
  return f;
}
export default make("double");
export const other = make("other");
export const notAFactory = 42;
`;

export function configSource(opts: { providerRoot?: string; secondRoot?: string; extra?: string } = {}): string {
  return `import { defineConfig } from "@selfbuilding/core";
import { scripted, scriptedHarness, tmpdirProvider } from "@selfbuilding/testing";

${opts.secondRoot ? `export const providers = [tmpdirProvider({ root: ${JSON.stringify(opts.secondRoot)}, id: "second" })];` : ""}

export default defineConfig({
  deployment: "${DEPLOYMENT}",
  harness: scriptedHarness([scripted.submit({ ok: true })]),
  ${opts.providerRoot ? `sandbox: tmpdirProvider({ root: ${JSON.stringify(opts.providerRoot)} }),` : ""}
  ${opts.extra ?? ""}
});
`;
}

// ───────────────────────────── in-memory stores ─────────────────────────────

export class MemAskStore implements AskStore {
  readonly records = new Map<string, AskRecord>();

  add(partial: Partial<AskRecord> & Pick<AskRecord, "askId" | "runId" | "ordinal" | "spec">): AskRecord {
    const record: AskRecord = {
      callPath: "review",
      origin: { kind: "factory", askSeq: partial.ordinal },
      specHash: "h",
      status: "open",
      waitpoint: { host: "node", ref: partial.askId },
      messages: [],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...partial,
    };
    this.records.set(record.askId, record);
    return record;
  }

  async create(r: AskRecord) {
    const existing = this.records.get(r.askId);
    if (existing) return { status: "exists" as const, record: existing };
    this.records.set(r.askId, r);
    return { status: "created" as const };
  }
  async get(askId: string) {
    return this.records.get(askId) ?? null;
  }
  async resolve(askId: string, res: AskResolution) {
    const current = this.records.get(askId);
    if (!current) throw new Error(`no ask ${askId}`);
    if (current.status !== "open") return { won: false as const, current };
    this.records.set(askId, { ...current, status: "answered", resolution: res });
    return { won: true as const };
  }
  async openForThread(_thread: ThreadKey) {
    return [...this.records.values()].filter((r) => r.status === "open");
  }
  async *open(filter: { channel?: string; runId?: string }) {
    for (const r of [...this.records.values()]) {
      if (r.status === "open" && (!filter.runId || r.runId === filter.runId)) yield r;
    }
  }
  async setStatus(askId: string, s: "expired" | "cancelled") {
    const current = this.records.get(askId);
    if (current) this.records.set(askId, { ...current, status: s });
  }
}

export class MemJournal implements JournalStore {
  readonly entries = new Map<string, JournalEntry>();
  constructor(
    readonly dir: string,
    readonly asks: AskStore | undefined,
  ) {}
  async get(runId: string, stepKey: string) {
    return this.entries.get(`${runId}/${stepKey}`) ?? null;
  }
  async *list(runId: string) {
    for (const e of this.entries.values()) if (e.runId === runId) yield e;
  }
  async lease(_runId: string, owner: string): Promise<Lease> {
    return { owner, leaseEpoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
  async renew(lease: Lease) {
    return lease;
  }
  async assertLease() {}
  async put(entry: JournalEntry) {
    this.entries.set(`${entry.runId}/${entry.stepKey}`, entry);
    return true;
  }
}

// ───────────────────────────── fake core ─────────────────────────────

export interface RunCall {
  factory: Factory<unknown, unknown>;
  input: unknown;
  opts: RunOptions;
}

export type RunImpl = (call: RunCall) => Promise<Partial<RunOutcome<unknown>> & { status: RunStatus }>;

export interface FakeCore extends CoreApi {
  runs: RunCall[];
  reaps: ReapOptions[];
  journals: Map<string, MemJournal>;
  /** The journal the CLI gets for a directory; one per directory, so state survives across commands. */
  journalFor(dir: string): MemJournal;
}

export function event(runId: string, type: string, data: Record<string, unknown> = {}, seq = 0): SelfbuildingEvent {
  return {
    v: 1,
    runId,
    callPath: "run",
    launchId: "epoch-1",
    attempt: 1,
    seq,
    ts: "2026-11-01T12:00:00.000Z",
    traceId: runId,
    type,
    level: "info",
    data,
  };
}

export function fakeCore(
  opts: { run?: RunImpl; reap?: (o: ReapOptions) => Promise<ReapReport>; asks?: boolean } = {},
): FakeCore {
  const runs: RunCall[] = [];
  const reaps: ReapOptions[] = [];
  const journals = new Map<string, MemJournal>();
  const journalFor = (dir: string) => {
    let j = journals.get(dir);
    if (!j) {
      j = new MemJournal(dir, opts.asks === false ? undefined : new MemAskStore());
      journals.set(dir, j);
    }
    return j;
  };
  const impl: RunImpl =
    opts.run ??
    (async ({ factory, input, opts: o }) => {
      o.events?.forEach((sink) => {
        sink(event(o.runId ?? "?", "phase", { name: "work" }, 0));
        sink(event(o.runId ?? "?", "run.end", { status: "ok" }, 1));
      });
      return { status: "ok", output: await factory.body(input) };
    });
  return {
    runs,
    reaps,
    journals,
    journalFor,
    fileJournal: (dir: string) => journalFor(dir),
    fileArtifacts: (dir: string) => ({ dir }) as unknown as ReturnType<CoreApi["fileArtifacts"]>,
    run: (async (factory: Factory<unknown, unknown>, input: unknown, o: RunOptions = {}) => {
      const call = { factory, input, opts: o };
      runs.push(call);
      const partial = await impl(call);
      return {
        runId: o.runId ?? "generated",
        output: null,
        usage: { usd: 0.5, inputTokens: 0, outputTokens: 0, turns: 0, wallClockMs: 0, sandboxMs: 0 },
        replayedUsd: 0,
        events: [],
        ...partial,
      };
    }) as CoreApi["run"],
    reap: async (o: ReapOptions) => {
      reaps.push(o);
      return (await opts.reap?.(o)) ?? { killed: 0, parked: 0, held: 0, leaked: 0, errors: [], decisions: [] };
    },
  };
}

// ───────────────────────────── running the CLI ─────────────────────────────

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InvokeOptions extends Partial<CliContext> {
  stdinText?: string;
}

export async function cli(argv: string[], opts: InvokeOptions = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const { stdinText, ...overrides } = opts;
  const stdin = new PassThrough();
  stdin.end(stdinText ?? "");
  const code = await main(argv, {
    env: {},
    isTTY: false,
    pollMs: 10,
    user: { id: "tester", name: "Test User" },
    prompt: async () => {
      throw new Error("unexpected prompt");
    },
    stdin,
    ...overrides,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { code, stdout, stderr };
}

export function jsonLines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}
