// @selfbuilding/script: agent-written workflow scripts in a QuickJS (WASM) isolate (docs/spec/demo-path.md §8).
// Owner: run-script.
import {
  type Agent,
  type Budget,
  type ConcurrencyOptions,
  type Factory,
  factory,
  type Harness,
  type Json,
  log,
  noteLaunchedBy,
  runArtifacts,
  type SandboxProvider,
  type ScriptCaps,
  ScriptLimitError,
  type ScriptRunInput,
  type SelfbuildingConfig,
} from "@selfbuilding/core";
import { z } from "zod";
import { type EffectiveCaps, tightenCaps } from "./caps.js";
import { Isolate } from "./isolate.js";
import { executeScript, type ResolvedRegistry } from "./runner.js";

/** The deployed factory's name. start_workflow launches this factory. */
export const SCRIPT_FACTORY_NAME = "run-script";

/** The caps a script gets when neither the config nor the input sets one. */
export const DEFAULT_SCRIPT_CAPS: Readonly<Required<ScriptCaps>> = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  cpuSliceMs: 1_000,
  maxAgentCalls: 50,
  maxSandboxes: 4,
  allowedSizes: ["small", "medium"],
  budgetUsd: 20,
  wallClock: "4h",
  maxOutputBytes: 262_144,
  maxSourceBytes: 262_144,
  maxPrWrites: 20,
});

/** What a script can reach by name. Nothing else crosses into the isolate. */
export interface ScriptRegistry {
  /** Default: ImplementSpec, CodeReview, Verify, FindFlows from @selfbuilding/agents. */
  // biome-ignore lint/suspicious/noExplicitAny: agents of any input and output are registered by name
  agents?: Record<string, Agent<any, any>>;
  /** By name: `sb.agent({ harness: "codex" })`. Default claude-code and codex. */
  harnesses?: Record<string, Harness>;
  /** By name: `sb.sandbox({ provider: "e2b" })`. Default: only the run's default provider, as "default". */
  providers?: Record<string, SandboxProvider>;
}

export interface RunScriptOptions extends ScriptRegistry {
  /** Tightens the deployment caps. */
  caps?: ScriptCaps;
  /**
   * The deployment config. Its `scripts` caps tighten the defaults, and `createScriptFactory` takes the run's
   * budget defaults from it. A factory body cannot read the run's config, so the deployment passes it here.
   */
  config?: SelfbuildingConfig;
}

const DEFAULT_AGENT_NAMES = ["ImplementSpec", "CodeReview", "Verify", "FindFlows"] as const;

async function resolveRegistry(opts: RunScriptOptions | undefined): Promise<ResolvedRegistry> {
  let agents = opts?.agents;
  if (agents === undefined) {
    // Loaded on first use: the built-in agents read their skill folders when imported.
    const pack = (await import("@selfbuilding/agents")) as unknown as Record<string, unknown>;
    agents = {};
    for (const name of DEFAULT_AGENT_NAMES) {
      // biome-ignore lint/suspicious/noExplicitAny: see ScriptRegistry.agents
      if (typeof pack[name] === "function") agents[name] = pack[name] as Agent<any, any>;
    }
  }
  let harnesses = opts?.harnesses;
  if (harnesses === undefined) {
    const [{ claudeCode }, { codex }] = await Promise.all([
      import("@selfbuilding/harnesses/claude-code"),
      import("@selfbuilding/harnesses/codex"),
    ]);
    harnesses = { "claude-code": claudeCode(), codex: codex() };
  }
  // With no providers registered, "default" means the run's own provider, which is what omitting it does.
  const providers = opts?.providers ?? {};
  return {
    agents: { ...agents } as ResolvedRegistry["agents"],
    harnesses: { ...harnesses },
    providers: { ...providers },
  };
}

/** The caps a run uses: the defaults, tightened by `config.scripts`, then by `caps` (demo-path §8.3). */
export function effectiveCaps(config?: SelfbuildingConfig, ...caps: (ScriptCaps | undefined)[]): EffectiveCaps {
  return tightenCaps(DEFAULT_SCRIPT_CAPS, config?.scripts, ...caps);
}

/**
 * Runs a script inside the current factory run. Every primitive call is journaled by the host as usual.
 *
 * The script layer enforces every cap it can see. `maxSandboxes`, `budgetUsd` and `wallClock` must also bound the
 * engine's sandbox slots and budget, which count every box and every in-flight call: `createScriptFactory` sets
 * them from its caps and config, so a launcher builds the factory with the run's caps (the node launcher), or
 * passes the run's limits as run options (`scriptRunOptions(input)`, or the Trigger factory task's `limits`).
 */
export function runScript(source: string, input: Json, opts?: RunScriptOptions): Promise<Json> {
  return (async () => {
    if (typeof source !== "string")
      throw new TypeError("runScript(source, input) needs the script source as a string.");
    const caps = effectiveCaps(opts?.config, opts?.caps);
    const registry = await resolveRegistry(opts);
    return executeScript({ source, input: input ?? {}, caps, registry });
  })();
}

/** Checks a script without running it: compiles it and checks its default export. Throws ScriptInvalidError. */
export async function checkScript(source: string, caps?: ScriptCaps): Promise<void> {
  const effective = tightenCaps(DEFAULT_SCRIPT_CAPS, caps);
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > effective.maxSourceBytes) {
    throw new ScriptLimitError({
      limit: "source_bytes",
      max: `${effective.maxSourceBytes} bytes (the script is ${bytes})`,
    });
  }
  const isolate = await Isolate.create(effective);
  try {
    isolate.load(source).dispose();
    if (isolate.poisoned !== undefined) throw isolate.poisoned;
  } finally {
    isolate.dispose();
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

const CapsSchema = z
  .object({
    memoryBytes: z.number().positive().optional(),
    stackBytes: z.number().positive().optional(),
    cpuSliceMs: z.number().positive().optional(),
    maxAgentCalls: z.number().int().positive().optional(),
    maxSandboxes: z.number().int().positive().optional(),
    allowedSizes: z.array(z.string()).optional(),
    budgetUsd: z.number().positive().optional(),
    wallClock: z.union([z.string(), z.number().nonnegative()]).optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    maxSourceBytes: z.number().int().positive().optional(),
    maxPrWrites: z.number().int().positive().optional(),
  })
  .strict();

/** The `run-script` factory's input schema (`ScriptRunInput`). */
export const ScriptRunInputSchema = z
  .object({
    source: z.string().min(1),
    input: z.json().optional(),
    name: z.string().regex(NAME_PATTERN, "name must match ^[a-z0-9][a-z0-9-]{0,47}$"),
    caps: CapsSchema.optional(),
    launchedBy: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("agent"), runId: z.string(), callPath: z.string(), depth: z.number().int().min(0) }),
        z.object({ kind: z.literal("local"), user: z.string() }),
      ])
      .optional(),
  })
  .strict();

/**
 * Run options a launcher passes with a `run-script` input, so the run's own `maxSandboxes`, `budgetUsd` and
 * `wallClock` caps bound the engine's sandbox slots and budget (demo-path §8.3).
 */
export function scriptRunOptions(
  input: Pick<ScriptRunInput, "caps">,
  opts?: Pick<RunScriptOptions, "caps" | "config">,
): { concurrency: ConcurrencyOptions; budget: Budget } {
  const caps = effectiveCaps(opts?.config, opts?.caps, input.caps);
  return { concurrency: { sandboxes: caps.maxSandboxes }, budget: budgetFor(caps, opts?.config) };
}

function budgetFor(caps: EffectiveCaps, config: SelfbuildingConfig | undefined): Budget {
  const base = config?.budget ?? {};
  return {
    ...base,
    usd: base.usd === undefined ? caps.budgetUsd : Math.min(base.usd, caps.budgetUsd),
    wallClock: caps.wallClock,
  };
}

/** The deployable factory (`run-script`): input `ScriptRunInput`, output the script's JSON return value. */
export function createScriptFactory(opts?: RunScriptOptions): Factory<ScriptRunInput, Json> {
  const deployment = effectiveCaps(opts?.config, opts?.caps);
  return factory(
    {
      name: SCRIPT_FACTORY_NAME,
      input: ScriptRunInputSchema,
      concurrency: { sandboxes: deployment.maxSandboxes },
      // A factory budget replaces config.budget for the run, so it is set only when it can carry that config over.
      // Without it the script layer still enforces budgetUsd and wallClock itself.
      ...(opts?.config ? { budget: budgetFor(deployment, opts.config) } : {}),
    },
    async (input) => {
      const caps = tightenCaps(deployment, input.caps as ScriptCaps | undefined);
      // Grants minted inside this run must carry the launcher's depth + 1, whichever host started it.
      if (input.launchedBy) noteLaunchedBy(runArtifacts().runId, input.launchedBy);
      log("info", `workflow script "${input.name}"`, {
        script: input.name,
        bytes: input.source.length,
        ...(input.launchedBy ? { launchedBy: input.launchedBy } : {}),
      });
      return runScript(input.source, (input.input ?? {}) as Json, { ...opts, caps });
    },
  ) as unknown as Factory<ScriptRunInput, Json>;
}
