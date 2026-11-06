import type { z } from "zod";
import { validateBudget, validateConcurrency } from "../config/index.js";
import { AgentInputError, ConfigError, NestingDepthError, NoActiveRunError } from "../errors/classes.js";
import type { Factory, FactoryOptions } from "../types/orchestration.js";
import { maybeFrame, withScope } from "./context.js";
import { foldHeads } from "./scope.js";

/** Wraps a plain async body as a factory (spec §1.8, §3.3). */
export function factory<I extends z.ZodType, O extends z.ZodType = z.ZodUnknown>(
  opts: FactoryOptions<I, O>,
  body: (input: z.infer<I>) => Promise<z.infer<O>>,
): Factory<z.infer<I>, z.infer<O>> {
  if (opts === null || typeof opts !== "object") throw new ConfigError("factory(opts, body) needs an options object.");
  if (typeof opts.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(opts.name)) {
    throw new ConfigError(
      `factory name "${String(opts.name)}" must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  if (!isSchema(opts.input)) throw new ConfigError(`factory "${opts.name}" needs input: a Zod schema.`);
  if (opts.output !== undefined && !isSchema(opts.output)) {
    throw new ConfigError(`factory "${opts.name}" output must be a Zod schema.`);
  }
  if (typeof body !== "function") throw new ConfigError(`factory "${opts.name}" needs a body function.`);
  if (opts.budget !== undefined) validateBudget(opts.budget, `factory "${opts.name}" budget`);
  validateConcurrency(opts.concurrency, `factory "${opts.name}" concurrency`);

  type In = z.infer<I>;
  type Out = z.infer<O>;

  // Calling a factory from another factory's body runs it as a child scope of the caller (spec §3.7).
  const callable = async (input: In): Promise<Out> => {
    const frame = maybeFrame();
    if (!frame) throw new NoActiveRunError({ primitive: opts.name });
    if (frame.scope.factory.depth >= 1) {
      throw new NestingDepthError(undefined, { runId: frame.run.runId, callPath: frame.scope.path });
    }
    const parsed = parseInput(opts.name, opts.input as z.ZodType<In>, input);
    const path = frame.scope.allocate(opts.name);
    const link = frame.scope.reserveLink();
    const child = frame.scope.child({
      path,
      concurrent: false,
      factory: { name: opts.name, options: opts, depth: frame.scope.factory.depth + 1 },
    });
    let output: Out;
    try {
      output = await withScope(child, () => body(parsed));
    } catch (error) {
      link((head) => foldHeads("factory", head, [child.chainHead]));
      throw error;
    }
    link((head) => foldHeads("factory", head, [child.chainHead]));
    return parseOutput(opts.name, opts.output as z.ZodType<Out> | undefined, output);
  };

  Object.defineProperties(callable, {
    name: { value: opts.name, configurable: true },
    inputSchema: { value: opts.input, enumerable: true },
    outputSchema: { value: opts.output, enumerable: true },
    options: { value: opts, enumerable: true },
    body: { value: body, enumerable: true },
  });
  return callable as unknown as Factory<In, Out>;
}

function isSchema(value: unknown): value is z.ZodType {
  return value !== null && typeof value === "object" && typeof (value as z.ZodType).safeParse === "function";
}

export function parseInput<T>(name: string, schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AgentInputError({
    agent: name,
    issues: result.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`),
  });
}

export function parseOutput<T>(name: string, schema: z.ZodType<T> | undefined, output: unknown): T {
  if (!schema) return output as T;
  const result = schema.safeParse(output);
  if (result.success) return result.data;
  throw new ConfigError(
    `factory "${name}" returned output that does not match its output schema:\n- ${result.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(output)"}: ${i.message}`)
      .join("\n- ")}`,
  );
}

export function isFactory(value: unknown): value is Factory<unknown, unknown> {
  return (
    typeof value === "function" &&
    typeof (value as Partial<Factory<unknown, unknown>>).body === "function" &&
    isSchema((value as Partial<Factory<unknown, unknown>>).inputSchema)
  );
}
