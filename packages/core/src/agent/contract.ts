import { z } from "zod";
import { ContractError } from "../errors/classes.js";
import { canonicalJson, sha256Hex } from "../sandbox/hash.js";
import type { Contract, ContractDefinition, ContractSpec, DoneCheck } from "../types/agent.js";
import type { JsonSchema } from "../types/common.js";
import { DefaultInput, DefaultResult } from "./schemas.js";

/** Input keys that name placement, never task data (spec §2.4.3). */
export const RESERVED_INPUT_KEYS = ["repo", "base", "branch", "git", "pr", "sandbox", "harness", "model"] as const;

const CONTRACT_BRAND = Symbol.for("selfbuilding.contract");

/** Draft-07 JSON Schema of a Zod schema as the agent sees it (`io: "input"`). Throws ContractError if unrepresentable. */
export function jsonSchemaOf(schema: z.ZodType, what: string): JsonSchema {
  try {
    const out = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as JsonSchema;
    return out;
  } catch (error) {
    throw new ContractError(
      `The ${what} schema cannot be represented as JSON Schema: ${(error as Error).message}. Use JSON-friendly types (dates as z.iso.datetime(), no functions, bigint, Map or Set).`,
      { cause: error },
    );
  }
}

/** True when the schema's top level is an object, as MCP tool inputs must be (spec §2.4.2). */
export function isObjectSchema(schema: z.ZodType): boolean {
  return schema instanceof z.ZodObject;
}

/** The schema the agent submits against: the output itself, or `{ value: T }` for a non-object output. */
export function wireOutputSchema(output: z.ZodType): z.ZodType {
  return isObjectSchema(output) ? output : z.object({ value: output });
}

/** Undoes the `{ value }` wrapper, so the caller sees T. */
export function unwrapResult(output: z.ZodType, wire: unknown): unknown {
  if (isObjectSchema(output)) return wire;
  return wire !== null && typeof wire === "object" && "value" in wire ? (wire as { value: unknown }).value : wire;
}

function checkReservedKeys(input: z.ZodType): void {
  if (!(input instanceof z.ZodObject)) return;
  const shape = (input as z.ZodObject).shape as Record<string, unknown>;
  const clash = RESERVED_INPUT_KEYS.filter((key) => key in shape);
  if (clash.length > 0) {
    throw new ContractError(
      `The input schema declares reserved key(s) ${clash.map((k) => `"${k}"`).join(", ")}. Where the work happens is a call option (repo, git, pr, sandbox, harness), never skill input.`,
    );
  }
}

function checkDoneIds(done: readonly DoneCheck<unknown, unknown>[]): void {
  const seen = new Set<string>();
  for (const check of done) {
    if (!check.id) throw new ContractError("Every done check needs an id.");
    if (seen.has(check.id)) throw new ContractError(`Two done checks share the id "${check.id}".`);
    seen.add(check.id);
  }
}

/** Builds and validates a compiled contract from its parts. */
export function compileContract<I, O>(spec: ContractSpec<I, O> = {}): Contract<I, O> {
  const input = (spec.input ?? DefaultInput) as z.ZodType<unknown, I>;
  const output = (spec.output ?? DefaultResult) as unknown as z.ZodType<O>;
  checkReservedKeys(input);
  jsonSchemaOf(input, "input");
  jsonSchemaOf(wireOutputSchema(output), "output");
  const done = [...(spec.done ?? [])];
  checkDoneIds(done as DoneCheck<unknown, unknown>[]);
  const contract: Contract<I, O> = {
    input,
    output,
    workspace: { repo: spec.workspace?.repo ?? "required", target: spec.workspace?.target ?? "none" },
    ...(spec.testCommand === undefined ? {} : { testCommand: spec.testCommand }),
    done,
    protect: { extra: [...(spec.protect?.extra ?? [])], allow: [...(spec.protect?.allow ?? [])] },
    artifacts: { branch: spec.artifacts?.branch ?? "optional", pr: spec.artifacts?.pr ?? "optional" },
    defaults: { ...(spec.defaults ?? {}) },
  };
  Object.defineProperty(contract, CONTRACT_BRAND, { value: true });
  return Object.freeze(contract);
}

/** Defines a contract, usually as the default export of a skill's `selfbuilding.ts` sidecar (spec §2.4). */
export function defineContract<I extends z.ZodType, O extends z.ZodType>(
  c: ContractDefinition<I, O>,
): Contract<z.input<I>, z.infer<O>> {
  return compileContract<z.input<I>, z.infer<O>>(c as unknown as ContractSpec<z.input<I>, z.infer<O>>);
}

export function isContract(value: unknown): value is Contract<unknown, unknown> {
  return value !== null && typeof value === "object" && CONTRACT_BRAND in value;
}

/**
 * The contract fingerprint (spec §2.2.4): schemas, workspace, protected paths and done checks. Function checks
 * contribute their id, never their code.
 */
export function contractFingerprint(contract: Contract<unknown, unknown>): string {
  return sha256Hex(
    canonicalJson({
      input: jsonSchemaOf(contract.input, "input"),
      output: jsonSchemaOf(wireOutputSchema(contract.output), "output"),
      workspace: contract.workspace,
      protect: contract.protect,
      testCommand: typeof contract.testCommand === "function" ? "fn" : (contract.testCommand ?? null),
      artifacts: {
        branch: typeof contract.artifacts.branch === "function" ? "fn" : contract.artifacts.branch,
        pr: contract.artifacts.pr,
      },
      done: contract.done.map((d) =>
        "cmd" in d
          ? { id: d.id, cmd: typeof d.cmd === "function" ? "fn" : d.cmd, cwd: d.cwd, expectExit: d.expectExit }
          : "judge" in d
            ? { id: d.id, judge: d.judge.rubric }
            : { id: d.id, assert: true },
      ),
    }),
  );
}
