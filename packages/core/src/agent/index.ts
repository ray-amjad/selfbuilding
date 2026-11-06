import { loadSkill, type SkillDef } from "@selfbuilding/skills";
import { z } from "zod";
import { ConfigError, DuplicateSkillError, SkillLoadError } from "../errors/classes.js";
import { canonicalJson, sha256Hex } from "../sandbox/hash.js";
import type {
  AgentCallOptions,
  Agent as AgentFn,
  AgentPatch,
  AgentResult,
  Contract,
  ContractSpec,
  InlineAgentFn,
  InlineAgentSpec,
  Settled,
} from "../types/index.js";
import { callAgent, settle } from "./call.js";
import { compileContract, contractFingerprint, isContract, jsonSchemaOf, wireOutputSchema } from "./contract.js";
import type { AgentDefinition } from "./plan.js";
import type { DefaultInput, DefaultResult } from "./schemas.js";

export { defineContract } from "./contract.js";
export { DEFAULT_PROTECTED, DefaultInput, DefaultResult, ReviewTarget } from "./schemas.js";

/** A compiled agent. `Agent.fromSkill` is the only public constructor (spec §1.8). */
export type Agent<I, O> = AgentFn<I, O>;

/** kebab-case skill name → PascalCase agent name (spec §2.5.2). */
export function pascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

function compiledAgent<I, O>(def: AgentDefinition<I, O>, skill: SkillDef): AgentFn<I, O> {
  const call = (input: I, opts?: AgentCallOptions): Promise<AgentResult<O>> => callAgent(def, input, opts);
  const fn = Object.assign(call, {
    settled: (input: I, opts?: AgentCallOptions): Promise<Settled<AgentResult<O>>> =>
      settle(() => callAgent(def, input, opts), opts?.signal),
    skill,
    contract: def.contract,
    inputJsonSchema: jsonSchemaOf(def.contract.input, "input"),
    outputJsonSchema: jsonSchemaOf(wireOutputSchema(def.contract.output), "output"),
    with: (patch: AgentPatch<I, O>): AgentFn<I, O> => compiledAgent(patchDefinition(def, patch), skill),
  });
  Object.defineProperty(fn, "name", { value: def.name });
  return fn as AgentFn<I, O>;
}

/** `X.with(patch)`: a new agent with a new hash; the original is unchanged (spec §2.10.4). */
function patchDefinition<I, O>(def: AgentDefinition<I, O>, patch: AgentPatch<I, O>): AgentDefinition<I, O> {
  const base = def.contract;
  const contract = compileContract<I, O>({
    input: base.input,
    output: patch.output ? patch.output(base.output) : base.output,
    workspace: base.workspace,
    ...(base.testCommand !== undefined ? { testCommand: base.testCommand } : {}),
    done: patch.done ? patch.done([...base.done]) : [...base.done],
    protect: {
      extra: [...base.protect.extra, ...(patch.protect?.extra ?? [])],
      allow: [...base.protect.allow, ...(patch.protect?.allow ?? [])],
    },
    artifacts: base.artifacts,
    defaults: { ...base.defaults, ...patch.defaults },
  });
  const body = patch.appendBody ? `${def.body.trimEnd()}\n\n${patch.appendBody}` : def.body;
  const hash = sha256Hex(
    canonicalJson({
      base: def.hash,
      appendBody: patch.appendBody ?? null,
      contract: contractFingerprint(contract as Contract<unknown, unknown>),
      secrets: patch.secrets ?? [],
    }),
  );
  return {
    ...def,
    body,
    contract,
    hash,
    secrets: [...new Set([...def.secrets, ...(patch.secrets ?? [])])],
  };
}

function toPath(dir: URL | string): string {
  if (dir instanceof URL) {
    if (dir.protocol !== "file:")
      throw new ConfigError(`Agent.fromSkill needs a file URL or an absolute path, got ${dir.href}.`);
    return decodeURIComponent(dir.pathname).replace(/\/$/, "");
  }
  if (dir.startsWith("file://")) return toPath(new URL(dir));
  if (!dir.startsWith("/")) {
    throw new ConfigError(
      `Agent.fromSkill got the relative path "${dir}". Pass an absolute path or new URL("./skill/", import.meta.url).`,
    );
  }
  return dir.replace(/\/$/, "");
}

async function load(path: string): Promise<SkillDef> {
  try {
    return await loadSkill(path);
  } catch (error) {
    const e = error as { code?: string; message?: string; issues?: string[]; dirs?: string[]; name?: string };
    if (e.code === "skill_duplicate") {
      throw new DuplicateSkillError({ skill: e.name ?? path, dirs: e.dirs ?? [path] }, { cause: error });
    }
    throw new SkillLoadError({ dir: path, issues: e.issues ?? [e.message ?? String(error)] }, { cause: error });
  }
}

export const Agent: {
  /**
   * Loads and validates a skill folder, so a broken skill fails at import time with SkillLoadError.
   * `dir` is an absolute path or a file URL; a relative string throws ConfigError.
   */
  fromSkill<I = DefaultInput, O = DefaultResult>(
    dir: URL | string,
    contract?: ContractSpec<I, O>,
  ): Promise<AgentFn<I, O>>;
} = {
  async fromSkill<I = DefaultInput, O = DefaultResult>(dir: URL | string, spec?: ContractSpec<I, O>) {
    const skill = await load(toPath(dir));
    const sidecar = isContract(skill.sidecar) ? (skill.sidecar as Contract<I, O>) : undefined;
    const contract = spec ? compileContract<I, O>(spec) : (sidecar ?? compileContract<I, O>());
    // A contract passed in code is not covered by the skill hash, so it is folded in here (spec §2.2.4).
    const hash = spec
      ? sha256Hex(`${skill.hash}:${contractFingerprint(contract as Contract<unknown, unknown>)}`)
      : skill.hash;
    const def: AgentDefinition<I, O> = {
      name: pascalCase(skill.name),
      skill,
      body: skill.body,
      literal: false,
      contract,
      hash,
      secrets: [],
    };
    return compiledAgent(def, skill);
  },
};

function inlineDefinition<O>(spec: InlineAgentSpec<O>): { def: AgentDefinition<unknown, O>; opts: AgentCallOptions } {
  const { name, prompt, input: _input, output, ...opts } = spec;
  if (!name) throw new ConfigError("agent() needs a name; it becomes the Name segment of the callPath.");
  if (typeof prompt !== "string") throw new ConfigError(`agent "${name}" needs a literal string prompt.`);
  const contract = compileContract<unknown, O>({ input: z.unknown(), output, workspace: { repo: "optional" } });
  return {
    def: {
      name,
      body: prompt,
      literal: true,
      contract,
      hash: sha256Hex(prompt),
      secrets: [],
    },
    opts,
  };
}

async function runInlineAgent<O>(spec: InlineAgentSpec<O>): Promise<AgentResult<O>> {
  const { def, opts } = inlineDefinition(spec);
  return callAgent(def, spec.input, opts);
}

async function settleInlineAgent<O>(spec: InlineAgentSpec<O>): Promise<Settled<AgentResult<O>>> {
  const { def, opts } = inlineDefinition(spec);
  return settle(() => callAgent(def, spec.input, opts), spec.signal);
}

/** Runs an inline prompt as one journaled agent call (spec §3.4). Compiled agents are called directly. */
export const agent: InlineAgentFn = Object.assign(runInlineAgent, { settled: settleInlineAgent });
