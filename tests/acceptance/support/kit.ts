// Shared setup for the acceptance suite: the built runtime bundles, scripted harnesses that print each real
// harness's native stream (parsed by that harness's own parser), temp dirs and event capture.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Harness, type SelfbuildingEvent, setRuntimeBundles } from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { codex } from "@selfbuilding/harnesses/codex";
import { type ScriptedHarnessOptions, type ScriptSource, scriptedHarness } from "@selfbuilding/testing";

/** The dist directory of @selfbuilding/runtime. `pnpm build` must have run. */
export function runtimeDist(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.resolve("@selfbuilding/runtime/package.json"))), "dist");
}

/** Registers the built runtime, MCP server and reaper bundles, so every box runs the real runtime. */
export function useBuiltRuntime(): void {
  const dist = runtimeDist();
  setRuntimeBundles({
    runtime: readFileSync(path.join(dist, "selfbuilding-runtime.mjs")),
    mcp: readFileSync(path.join(dist, "selfbuilding-mcp.mjs")),
    nsReap: readFileSync(path.join(dist, "ns-reap.mjs")),
  });
}

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * A scripted harness that plays Claude Code's stream-json, parsed by the real Claude Code adapter's parser. The id
 * names the harness it stands in for, so reports and events tell the two apart.
 */
export function scriptedClaude(script: ScriptSource, opts: ScriptedHarnessOptions = {}): Harness {
  const real = claudeCode();
  return {
    ...scriptedHarness(script, { format: "claude-code", parser: (ctx) => real.createParser(ctx), ...opts }),
    id: "scripted-claude-code",
  };
}

/** The Codex counterpart of `scriptedClaude`: Codex's JSONL, parsed by the real Codex adapter's parser. */
export function scriptedCodex(script: ScriptSource, opts: ScriptedHarnessOptions = {}): Harness {
  const real = codex();
  return {
    ...scriptedHarness(script, { format: "codex", parser: (ctx) => real.createParser(ctx), ...opts }),
    id: "scripted-codex",
  };
}

export interface Recorder {
  events: SelfbuildingEvent[];
  sink: (e: SelfbuildingEvent) => void;
  of(type: string): SelfbuildingEvent[];
  /** callPaths of every `agent.launched` event, in order. */
  launched(): string[];
}

export function recorder(): Recorder {
  const events: SelfbuildingEvent[] = [];
  return {
    events,
    sink: (e) => {
      events.push(e);
    },
    of: (type) => events.filter((e) => e.type === type),
    launched: () => events.filter((e) => e.type === "agent.launched").map((e) => e.callPath ?? ""),
  };
}
