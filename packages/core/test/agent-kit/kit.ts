// Test helpers for core's agent and sandbox modules. The test kit is reached by path because core cannot depend on
// @selfbuilding/testing (which depends on core) without a workspace cycle.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillDef } from "@selfbuilding/skills";
import type { AgentRunContext } from "../../src/agent/context.js";
import { standaloneContext } from "../../src/agent/context.js";
import { setRuntimeBundles } from "../../src/sandbox/runtime-client.js";
import type { SelfbuildingConfig } from "../../src/types/config.js";
import type { SelfbuildingEvent } from "../../src/types/events.js";
import type { JournalEntry, JournalStore, Lease } from "../../src/types/orchestration.js";

export type { TmpdirProvider } from "../../../testing/src/index.js";
export { createLocalRemote, scriptedHarness, tmpdirProvider } from "../../../testing/src/index.js";

const FAKE_RUNTIME = readFileSync(fileURLToPath(new URL("./fake-runtime.mjs", import.meta.url)), "utf8");

/** What the fake runtime plays for one attempt of one call. */
export interface FakeBehaviour {
  status?: "succeeded" | "failed" | "timed_out" | "cancelled";
  result?: unknown;
  reason?: string;
  message?: string;
  commit?: { file: string; content: string; message?: string };
  dirty?: string;
  events?: { type: string; data?: Record<string, unknown>; turnIndex?: number }[];
  delayMs?: number;
  hang?: boolean;
  die?: boolean;
  files?: Record<string, string>;
  /** Files written from base64, for bytes that are not UTF-8. */
  binaryFiles?: Record<string, string>;
  isolation?: "isolated" | "same-user";
  checks?: { id: string; ok: boolean; verified: boolean }[];
  usage?: Record<string, unknown>;
  failure?: { code: string; retryable: boolean; message: string };
}

/** Installs the fake runtime with a script: `{ "<callPath>" | "*": [attempt1, attempt2, ...] }`. */
export function useFakeRuntime(behaviour: Record<string, FakeBehaviour[]> = {}): void {
  setRuntimeBundles({
    runtime: `globalThis.__FAKE_BEHAVIOUR = ${JSON.stringify(behaviour)};\n${FAKE_RUNTIME}`,
    mcp: "// fake selfbuilding-mcp\n",
  });
}

export async function tempDir(prefix = "sbc-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A skill folder plus the SkillDef the real loader would produce for it. */
export async function makeSkill(name: string, body = `Do the ${name} task.\n`): Promise<SkillDef> {
  const dir = await tempDir("sbc-skill-");
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: test skill\n---\n${body}`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), text);
  return {
    name,
    description: "test skill",
    body,
    dir: skillDir,
    files: [{ path: "SKILL.md", mode: 0o644, size: text.length, sha256: "x" }],
    frontmatter: { name, description: "test skill" },
    allowedTools: [],
    contract: "inferred",
    hash: `hash-${name}-${body.length}`,
    warnings: [],
  };
}

/** An in-memory journal with a real fenced lease, for replay and interrupted-call tests. */
export function memoryJournal(): JournalStore & { entries: Map<string, JournalEntry> } {
  const entries = new Map<string, JournalEntry>();
  let epoch = 0;
  let current: Lease | null = null;
  const k = (runId: string, stepKey: string) => `${runId}/${stepKey}`;
  return {
    entries,
    async get(runId, stepKey) {
      const e = entries.get(k(runId, stepKey));
      return e ? (JSON.parse(JSON.stringify(e)) as JournalEntry) : null;
    },
    async *list(runId) {
      for (const e of entries.values()) if (e.runId === runId) yield e;
    },
    async lease(_runId, owner) {
      current = { owner, leaseEpoch: ++epoch, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      return current;
    },
    async renew(lease) {
      return current?.leaseEpoch === lease.leaseEpoch ? lease : null;
    },
    async assertLease(lease) {
      if (current?.leaseEpoch !== lease.leaseEpoch) throw new Error("lease lost");
    },
    async put(entry, opts) {
      if (current?.leaseEpoch !== opts.lease.leaseEpoch) return false;
      const prev = entries.get(k(entry.runId, entry.stepKey));
      if (opts.expectStatus !== undefined) {
        if (opts.expectStatus === null ? prev !== undefined : prev?.status !== opts.expectStatus) return false;
      }
      entries.set(k(entry.runId, entry.stepKey), JSON.parse(JSON.stringify(entry)) as JournalEntry);
      return true;
    },
  };
}

/** A standalone context with a fixed run id, a journal, an event list and the given config. */
export async function testContext(
  config: SelfbuildingConfig,
  opts: { runId?: string; journal?: JournalStore } = {},
): Promise<{ ctx: AgentRunContext; events: SelfbuildingEvent[] }> {
  const events: SelfbuildingEvent[] = [];
  const base = standaloneContext({ config, events, ...(opts.runId ? { runId: opts.runId } : {}) });
  if (!opts.journal) return { ctx: base, events };
  const lease = (await opts.journal.lease(base.runId, "test", "1h")) as Lease;
  return { ctx: { ...base, journal: { store: opts.journal, lease } }, events };
}
