import type { AskSpec } from "@selfbuilding/core";
import { truncate } from "./text.js";

/** One modal input. Compact keys, because the field list rides in a button value (≤ 2,000 chars). */
export interface FormField {
  /** Property name. */
  n: string;
  /** Label. */
  l: string;
  /** s = string, n = number, b = boolean, e = enum. */
  t: "s" | "n" | "b" | "e";
  /** Enum options. */
  o?: string[];
  /** Required. */
  r?: boolean;
}

export const MAX_FORM_FIELDS = 5;

type JsonSchemaLike = {
  type?: unknown;
  properties?: Record<string, { type?: unknown; enum?: unknown; title?: unknown; description?: unknown }>;
  required?: unknown;
};

/**
 * Finds a JSON Schema for the ask's schema: a plain JSON Schema (what `ask_human` carries), a schema
 * library's `toJSONSchema()`, or Standard JSON Schema's `~standard.jsonSchema.input()`.
 */
function jsonSchemaOf(schema: unknown): JsonSchemaLike | null {
  if (!schema || typeof schema !== "object") return null;
  const candidate = schema as {
    properties?: unknown;
    toJSONSchema?: () => unknown;
    "~standard"?: { jsonSchema?: { input?: (o: { target: string }) => unknown } };
  };
  try {
    if (candidate.properties && typeof candidate.properties === "object") return candidate as JsonSchemaLike;
    const standard = candidate["~standard"]?.jsonSchema?.input;
    if (typeof standard === "function") return standard({ target: "draft-07" }) as JsonSchemaLike;
    if (typeof candidate.toJSONSchema === "function") return candidate.toJSONSchema() as JsonSchemaLike;
  } catch {
    return null;
  }
  return null;
}

/**
 * The modal fields for a flat object schema (spec §8.6: at most 5 string | number | boolean | enum fields),
 * or null when the schema has another shape. The core rejects other shapes when the ask is created.
 */
export function formFields(spec: AskSpec): FormField[] | null {
  if (!spec.schema) return null;
  const json = jsonSchemaOf(spec.schema);
  if (!json?.properties) return null;
  const required = new Set(Array.isArray(json.required) ? json.required.filter((r) => typeof r === "string") : []);
  const fields: FormField[] = [];
  for (const [name, prop] of Object.entries(json.properties)) {
    const label = truncate(typeof prop.title === "string" ? prop.title : name, 48);
    const base = { n: name, l: label, ...(required.has(name) ? { r: true } : {}) };
    if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) {
      fields.push({ ...base, t: "e", o: prop.enum as string[] });
    } else if (prop.type === "string") fields.push({ ...base, t: "s" });
    else if (prop.type === "number" || prop.type === "integer") fields.push({ ...base, t: "n" });
    else if (prop.type === "boolean") fields.push({ ...base, t: "b" });
    else return null;
  }
  return fields.length > 0 && fields.length <= MAX_FORM_FIELDS ? fields : null;
}

const option = (value: string, label = value) => ({ text: { type: "plain_text", text: truncate(label, 75) }, value });

/** The modal's input blocks; block ids carry the property name so the submission maps back. */
export function formInputBlocks(fields: FormField[]): Record<string, unknown>[] {
  return fields.map((field) => {
    let element: Record<string, unknown>;
    if (field.t === "s") element = { type: "plain_text_input", action_id: "value", multiline: true };
    else if (field.t === "n") element = { type: "number_input", action_id: "value", is_decimal_allowed: true };
    else if (field.t === "b")
      element = { type: "static_select", action_id: "value", options: [option("true", "Yes"), option("false", "No")] };
    else
      element = {
        type: "static_select",
        action_id: "value",
        options: (field.o ?? []).slice(0, 100).map((o) => option(o)),
      };
    return {
      type: "input",
      block_id: `ns_field:${field.t}:${field.n}`,
      optional: field.r !== true,
      label: { type: "plain_text", text: field.l },
      element,
    };
  });
}

type StateValue = { value?: string | null; selected_option?: { value?: string } | null };

/** Reads a view submission's state back into a plain object, typed per field. */
export function readFormValues(state: Record<string, Record<string, StateValue>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [blockId, actions] of Object.entries(state)) {
    const match = /^ns_field:([snbe]):(.+)$/.exec(blockId);
    const input = actions.value;
    if (!match?.[2] || !input) continue;
    const [, type, name] = match;
    if (type === "n") {
      if (input.value != null && input.value !== "") out[name] = Number(input.value);
    } else if (type === "b" || type === "e") {
      const picked = input.selected_option?.value;
      if (picked === undefined) continue;
      out[name] = type === "b" ? picked === "true" : picked;
    } else if (input.value != null) out[name] = input.value;
  }
  return out;
}
