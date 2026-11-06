import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkill } from "@selfbuilding/skills";
import { describe, expect, it } from "vitest";
import { memoryAskStore } from "../ask/store.js";
import { ConfigError, NonDeterminismError } from "../errors/classes.js";
import { memoryResultStore } from "../host-node/stores.js";
import type { Harness } from "../types/harness.js";
import type { HostAgentCall, Json } from "../types/index.js";
import type { SandboxProvider } from "../types/sandbox.js";
import { type AgentCallSpec, agentCallDriver } from "./driver.js";
import { launchDepthOf } from "./start-grant.js";

// The child side of a dispatched call rebuilds it from JSON plus the worker's own registry. What it cannot rebuild
// fails before any box exists, with a message that names the fix.

const harness = { id: "scripted", options: {} } as unknown as Harness;
const provider = { id: "tmpdir" } as unknown as SandboxProvider;

function spec(over: Partial<AgentCallSpec> = {}): AgentCallSpec {
  return {
    v: 1,
    agent: { kind: "inline", name: "one", hash: "h", prompt: "Do one thing." },
    harness: { id: "scripted", model: null },
    provider: "tmpdir",
    placement: { kind: "fresh" },
    protectAllow: [],
    plan: { secrets: [] } as unknown as AgentCallSpec["plan"],
    ...over,
  };
}

function call(s: AgentCallSpec | null): HostAgentCall {
  return {
    runId: "ns_driver",
    epoch: 0,
    stepKey: "abcdefghijklmnopqrstuvwxyz",
    callPath: "one",
    launch: 0,
    spec: s as unknown as Json,
  };
}

const LAUNCH = "abcdefghijklmnopqrstuvwxyz_e0_l0" as const;

function driver(over: { harnesses?: Harness[]; providers?: SandboxProvider[] } = {}) {
  return agentCallDriver({
    config: { deployment: "test" },
    store: memoryResultStore(),
    asks: memoryAskStore(),
    registry: { harnesses: over.harnesses ?? [harness], providers: over.providers ?? [provider] },
  });
}

describe("agentCallDriver", () => {
  it("refuses a spec it did not write", async () => {
    await expect(driver().launch(call(null), LAUNCH)).rejects.toThrow(/cannot read/);
  });

  it("names the missing registration for an unknown harness or provider", async () => {
    await expect(driver({ harnesses: [] }).launch(call(spec()), LAUNCH)).rejects.toThrow(
      /harness "scripted".*registry: \{ harnesses \}/,
    );
    await expect(driver({ providers: [] }).launch(call(spec()), LAUNCH)).rejects.toThrow(ConfigError);
    await expect(driver({ providers: [] }).launch(call(spec()), LAUNCH)).rejects.toThrow(/registry: \{ providers \}/);
  });

  it("refuses a harness whose model differs from the one the run called", async () => {
    const s = spec({ harness: { id: "scripted", model: "big" } });
    await expect(driver().launch(call(s), LAUNCH)).rejects.toThrow(/model big/);
  });

  it("refuses a skill whose files changed since the run called it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-driver-skill-"));
    const skillDir = path.join(dir, "greet");
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: greet\ndescription: Greets.\n---\n\nGreet.\n");
    const skill = await loadSkill(skillDir);
    const agent = {
      kind: "skill" as const,
      name: "Greet",
      hash: skill.hash,
      skill: "greet",
      skillHash: skill.hash,
      dir: skillDir,
      body: skill.body,
    };
    // Same files: the call rebuilds and goes on to need a box, which this fake provider cannot open.
    await expect(driver().launch(call(spec({ agent })), LAUNCH)).rejects.not.toThrow(NonDeterminismError);
    const stale = spec({ agent: { ...agent, skillHash: "0".repeat(64) } });
    await expect(driver().launch(call(stale), LAUNCH)).rejects.toThrow(NonDeterminismError);
  });

  it("restores the run's launch depth from the spec, so grants minted in the child carry depth + 1", async () => {
    const c = { ...call(spec({ launchDepth: 3 })), runId: "ns_wf_driver_depth" };
    expect(launchDepthOf(c.runId)).toBe(1);
    await expect(driver({ providers: [] }).launch(c, LAUNCH)).rejects.toThrow(ConfigError);
    expect(launchDepthOf(c.runId)).toBe(3);
  });

  it("settles a launch whose outcome record exists without touching a box", async () => {
    const store = memoryResultStore();
    const raw = { ok: false, launchId: LAUNCH, error: { name: "X", code: "harness_error", message: "m" } };
    await store.createIfAbsent(`outcomes/ns_driver/${LAUNCH}`, raw as unknown as Json);
    const d = agentCallDriver({ config: {}, store, asks: memoryAskStore() });
    expect(await d.launch(call(null), LAUNCH)).toEqual({ kind: "settled", outcome: raw });
  });
});
