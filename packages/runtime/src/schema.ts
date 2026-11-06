import type { JsonSchema } from "@selfbuilding/core";

// A draft-07 JSON Schema validator for result submissions (spec §2.6.1). It covers the keywords result schemas use;
// `format` is not asserted (draft-07 makes it optional) and remote `$ref`s are not followed.

export interface SchemaIssue {
  /** JSON pointer into the submitted value; "" is the root. */
  pointer: string;
  expected: string;
  received: string;
}

type Schema = JsonSchema | boolean;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value);
  if (text === undefined) return typeOf(value);
  return text.length > 80 ? `${typeOf(value)} ${text.slice(0, 77)}...` : text;
}

function escapePointer(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointer(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.hasOwn(b as object, k) && deepEqual((a as never)[k], (b as never)[k]))
  );
}

function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith("#")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[unescapePointer(raw)];
  }
  return typeof node === "boolean" || (node !== null && typeof node === "object") ? (node as Schema) : undefined;
}

class Validator {
  readonly issues: SchemaIssue[] = [];
  #depth = 0;

  constructor(private readonly root: Schema) {}

  validate(schema: Schema, value: unknown, pointer: string): void {
    if (schema === true) return;
    if (schema === false) {
      this.issues.push({ pointer, expected: "no value here", received: describe(value) });
      return;
    }
    if (++this.#depth > 64) {
      this.#depth--;
      this.issues.push({ pointer, expected: "a schema without a $ref cycle", received: "too deep" });
      return;
    }
    try {
      this.#validate(schema, value, pointer);
    } finally {
      this.#depth--;
    }
  }

  /** Validates in a scratch validator, so failed branches of anyOf/oneOf do not leak issues. */
  #probe(schema: Schema, value: unknown, pointer: string): SchemaIssue[] {
    const scratch = new Validator(this.root);
    scratch.validate(schema, value, pointer);
    return scratch.issues;
  }

  #validate(schema: JsonSchema, value: unknown, pointer: string): void {
    if (typeof schema.$ref === "string") {
      const target = resolveRef(this.root, schema.$ref);
      if (target === undefined)
        this.issues.push({ pointer, expected: `resolvable $ref ${schema.$ref}`, received: "unresolved" });
      else this.validate(target, value, pointer);
      // Draft-07: siblings of $ref are ignored.
      return;
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => matchesType(value, t))) {
        this.issues.push({ pointer, expected: types.join(" | "), received: `${typeOf(value)} ${describe(value)}` });
        return;
      }
    }
    if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(option, value))) {
      this.issues.push({
        pointer,
        expected: `one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`,
        received: describe(value),
      });
    }
    if ("const" in schema && !deepEqual(schema.const, value)) {
      this.issues.push({ pointer, expected: JSON.stringify(schema.const), received: describe(value) });
    }
    if (typeof value === "string") this.#string(schema, value, pointer);
    if (typeof value === "number") this.#number(schema, value, pointer);
    if (Array.isArray(value)) this.#array(schema, value, pointer);
    else if (value !== null && typeof value === "object")
      this.#object(schema, value as Record<string, unknown>, pointer);

    for (const sub of schema.allOf ?? []) this.validate(sub, value, pointer);
    if (schema.anyOf !== undefined) {
      const results = schema.anyOf.map((sub) => this.#probe(sub, value, pointer));
      if (!results.some((r) => r.length === 0)) {
        const closest = results.reduce((a, b) => (b.length < a.length ? b : a));
        if (schema.anyOf.length === 1) this.issues.push(...closest);
        else
          this.issues.push(
            {
              pointer,
              expected: `a value matching one of ${schema.anyOf.length} alternatives`,
              received: describe(value),
            },
            ...closest,
          );
      }
    }
    if (schema.oneOf !== undefined) {
      const results = schema.oneOf.map((sub) => this.#probe(sub, value, pointer));
      const passing = results.filter((r) => r.length === 0).length;
      if (passing !== 1) {
        this.issues.push({
          pointer,
          expected: `a value matching exactly one of ${schema.oneOf.length} alternatives`,
          received: `${describe(value)} (matches ${passing})`,
        });
      }
    }
    if (schema.not !== undefined && this.#probe(schema.not, value, pointer).length === 0) {
      this.issues.push({ pointer, expected: "a value not matching the excluded schema", received: describe(value) });
    }
    if (schema.if !== undefined) {
      const branch = this.#probe(schema.if as Schema, value, pointer).length === 0 ? schema.then : schema.else;
      if (branch !== undefined) this.validate(branch as Schema, value, pointer);
    }
  }

  #string(schema: JsonSchema, value: string, pointer: string): void {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength)
      this.issues.push({
        pointer,
        expected: `at least ${schema.minLength} characters`,
        received: `${length} characters`,
      });
    if (schema.maxLength !== undefined && length > schema.maxLength)
      this.issues.push({
        pointer,
        expected: `at most ${schema.maxLength} characters`,
        received: `${length} characters`,
      });
    if (schema.pattern !== undefined) {
      let ok = true;
      try {
        ok = new RegExp(schema.pattern, "u").test(value);
      } catch {
        ok = true;
      }
      if (!ok)
        this.issues.push({ pointer, expected: `a string matching /${schema.pattern}/`, received: describe(value) });
    }
  }

  #number(schema: JsonSchema, value: number, pointer: string): void {
    if (schema.minimum !== undefined && value < schema.minimum)
      this.issues.push({ pointer, expected: `>= ${schema.minimum}`, received: String(value) });
    if (schema.maximum !== undefined && value > schema.maximum)
      this.issues.push({ pointer, expected: `<= ${schema.maximum}`, received: String(value) });
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      this.issues.push({ pointer, expected: `> ${schema.exclusiveMinimum}`, received: String(value) });
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      this.issues.push({ pointer, expected: `< ${schema.exclusiveMaximum}`, received: String(value) });
    const multipleOf = schema.multipleOf;
    if (typeof multipleOf === "number" && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9)
        this.issues.push({ pointer, expected: `a multiple of ${multipleOf}`, received: String(value) });
    }
  }

  #array(schema: JsonSchema, value: unknown[], pointer: string): void {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      this.issues.push({ pointer, expected: `at least ${schema.minItems} items`, received: `${value.length} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      this.issues.push({ pointer, expected: `at most ${schema.maxItems} items`, received: `${value.length} items` });
    if (schema.uniqueItems === true) {
      for (let i = 1; i < value.length; i++) {
        if (value.slice(0, i).some((earlier) => deepEqual(earlier, value[i]))) {
          this.issues.push({
            pointer: `${pointer}/${i}`,
            expected: "a unique item",
            received: `a duplicate of an earlier item`,
          });
          break;
        }
      }
    }
    if (Array.isArray(schema.items)) {
      schema.items.forEach((sub, i) => {
        if (i < value.length) this.validate(sub, value[i], `${pointer}/${i}`);
      });
      const extra = schema.additionalItems as Schema | undefined;
      if (extra !== undefined)
        for (let i = schema.items.length; i < value.length; i++) this.validate(extra, value[i], `${pointer}/${i}`);
    } else if (schema.items !== undefined) {
      const items = schema.items;
      for (const [i, item] of value.entries()) this.validate(items, item, `${pointer}/${i}`);
    }
    const contains = schema.contains as Schema | undefined;
    if (contains !== undefined && !value.some((item, i) => this.#probe(contains, item, `${pointer}/${i}`).length === 0))
      this.issues.push({ pointer, expected: "at least one item matching `contains`", received: describe(value) });
  }

  #object(schema: JsonSchema, value: Record<string, unknown>, pointer: string): void {
    const keys = Object.keys(value);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key))
        this.issues.push({
          pointer: `${pointer}/${escapePointer(key)}`,
          expected: "a required property",
          received: "nothing",
        });
    }
    const minProperties = schema.minProperties;
    if (typeof minProperties === "number" && keys.length < minProperties)
      this.issues.push({ pointer, expected: `at least ${minProperties} properties`, received: `${keys.length}` });
    const maxProperties = schema.maxProperties;
    if (typeof maxProperties === "number" && keys.length > maxProperties)
      this.issues.push({ pointer, expected: `at most ${maxProperties} properties`, received: `${keys.length}` });

    const properties = schema.properties ?? {};
    const patterns = Object.entries((schema.patternProperties as Record<string, Schema> | undefined) ?? {});
    for (const key of keys) {
      const child = `${pointer}/${escapePointer(key)}`;
      let matched = false;
      if (Object.hasOwn(properties, key)) {
        matched = true;
        this.validate(properties[key] as Schema, value[key], child);
      }
      for (const [pattern, sub] of patterns) {
        let hit = false;
        try {
          hit = new RegExp(pattern, "u").test(key);
        } catch {
          hit = false;
        }
        if (hit) {
          matched = true;
          this.validate(sub, value[key], child);
        }
      }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false)
          this.issues.push({
            pointer: child,
            expected: "no additional properties",
            received: `unexpected property "${key}"`,
          });
        else if (schema.additionalProperties !== true) this.validate(schema.additionalProperties, value[key], child);
      }
    }
    const dependencies = schema.dependencies as Record<string, Schema | string[]> | undefined;
    for (const [key, dependency] of Object.entries(dependencies ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      if (Array.isArray(dependency)) {
        for (const needed of dependency)
          if (!Object.hasOwn(value, needed))
            this.issues.push({
              pointer: `${pointer}/${escapePointer(needed)}`,
              expected: `a property required by "${key}"`,
              received: "nothing",
            });
      } else this.validate(dependency, value, pointer);
    }
    const propertyNames = schema.propertyNames as Schema | undefined;
    if (propertyNames !== undefined)
      for (const key of keys) this.validate(propertyNames, key, `${pointer}/${escapePointer(key)}`);
  }
}

export function validateJsonSchema(schema: JsonSchema | boolean, value: unknown): SchemaIssue[] {
  const validator = new Validator(schema);
  validator.validate(schema, value, "");
  return validator.issues;
}

/** The numbered issue list returned to the model (spec §2.6.1). */
export function formatIssues(issues: SchemaIssue[]): string {
  const lines = issues
    .slice(0, 50)
    .map(
      (issue, i) => `${i + 1}. ${issue.pointer || "(root)"}: expected ${issue.expected}, received ${issue.received}`,
    );
  if (issues.length > 50) lines.push(`... and ${issues.length - 50} more`);
  return lines.join("\n");
}
