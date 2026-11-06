import { AskSpecError } from "../errors/classes.js";
import type { AskAnswer, AskChoice, AskSpec } from "../types/ask.js";
import type { JsonSchema, StandardSchema } from "../types/common.js";
import { durationToMs } from "./duration.js";

// Validating an AskSpec (spec §8.2, §8.6, §8.8). Agent asks arrive as JSON with `schema` as JSON Schema;
// factory asks may carry a live Standard Schema. Both normalise to one JSON-safe stored spec.

export const CHOICE_ID = /^[a-z0-9-]{1,20}$/;
export const LIMITS = {
  question: 2_000,
  title: 120,
  context: 4_000,
  choices: 5,
  label: 75,
  schemaFields: 5,
  dedupeKey: 200,
} as const;

/** A validated spec plus the pieces policy and answer checks need. */
export interface NormalizedAsk {
  /** JSON-safe: choices in object form, freeText resolved, schema as JSON Schema. */
  stored: AskSpec;
  choices: AskChoice[];
  freeText: boolean;
  jsonSchema?: JsonSchema;
  /** Present only for a factory ask with a live Standard Schema. */
  live?: StandardSchema;
}

function fail(message: string): never {
  throw new AskSpecError(message);
}

function checkText(name: string, v: unknown, max: number, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || (required && v.trim() === "")) fail(`ask: ${name} must be a non-empty string.`);
  if (v.length > max) fail(`ask: ${name} is ${v.length} chars; the limit is ${max}. Shorten it.`);
  return v;
}

function normalizeChoices(raw: unknown): AskChoice[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("ask: choices must be an array of ids or { id, label } objects.");
  if (raw.length > LIMITS.choices)
    fail(`ask: ${raw.length} choices given; at most ${LIMITS.choices}. Use freeText for more.`);
  const seen = new Set<string>();
  return raw.map((c): AskChoice => {
    let choice: AskChoice;
    if (typeof c === "string") {
      if (!CHOICE_ID.test(c))
        fail(
          `ask: choice "${c}" is not a valid id ([a-z0-9-]{1,20}). Use the object form { id: "short-id", label: ${JSON.stringify(c)} } instead.`,
        );
      choice = { id: c, label: c };
    } else if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.id !== "string" || !CHOICE_ID.test(o.id))
        fail(`ask: choice id ${JSON.stringify(o.id)} must match [a-z0-9-]{1,20}.`);
      const label = checkText(`choice "${o.id}" label`, o.label, LIMITS.label, true) as string;
      if (o.style !== undefined && o.style !== "primary" && o.style !== "danger")
        fail(`ask: choice "${o.id}" style must be "primary" or "danger".`);
      if (o.safe !== undefined && typeof o.safe !== "boolean") fail(`ask: choice "${o.id}" safe must be a boolean.`);
      choice = { id: o.id, label };
      if (o.style !== undefined) choice.style = o.style as "primary" | "danger";
      if (o.safe === true) choice.safe = true;
    } else {
      fail("ask: each choice must be an id string or a { id, label } object.");
    }
    if (seen.has(choice.id)) fail(`ask: choice id "${choice.id}" appears twice.`);
    seen.add(choice.id);
    return choice;
  });
}

function isStandardSchema(v: unknown): v is StandardSchema {
  return typeof v === "object" && v !== null && "~standard" in v;
}

function toJsonSchema(schema: unknown): { json: JsonSchema; live?: StandardSchema } {
  if (isStandardSchema(schema)) {
    const std = schema["~standard"] as StandardSchema["~standard"] & {
      jsonSchema?: { input?: (o: { target: string }) => unknown };
    };
    const viaStandard = std.jsonSchema?.input?.({ target: "draft-07" });
    const viaMethod = (schema as { toJSONSchema?: () => unknown }).toJSONSchema?.();
    const json = viaStandard ?? viaMethod;
    if (!json || typeof json !== "object")
      fail("ask: schema must expose JSON Schema (a Zod v4 schema does). Use freeText or choices otherwise.");
    return { json: json as JsonSchema, live: schema };
  }
  if (schema && typeof schema === "object") return { json: schema as JsonSchema };
  return fail("ask: schema must be a Standard Schema or a JSON Schema object.");
}

function fieldKind(s: JsonSchema): "string" | "number" | "boolean" | "enum" | null {
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === "string")) return "enum";
  if (s.type === "string") return "string";
  if (s.type === "number" || s.type === "integer") return "number";
  if (s.type === "boolean") return "boolean";
  return null;
}

/** Only flat objects of at most 5 string | number | boolean | enum fields render as a form (spec §8.6). */
function checkFlatSchema(json: JsonSchema): void {
  const why = "ask: schema must be a flat object of at most 5 string | number | boolean | enum fields";
  if (json.type !== "object" || !json.properties) fail(`${why}. Re-ask with freeText instead.`);
  const fields = Object.entries(json.properties);
  if (fields.length === 0 || fields.length > LIMITS.schemaFields)
    fail(`${why}; it has ${fields.length}. Re-ask with freeText instead.`);
  for (const [name, f] of fields) {
    if (!fieldKind(f)) fail(`${why}; field "${name}" is not one of them. Re-ask with freeText instead.`);
  }
}

/** Validates a value against a flat JSON Schema form; returns an error message or null. */
export function checkFlatValue(json: JsonSchema, value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "the answer must be an object";
  const obj = value as Record<string, unknown>;
  const props = json.properties ?? {};
  for (const name of json.required ?? []) if (obj[name] === undefined) return `field "${name}" is required`;
  for (const [name, v] of Object.entries(obj)) {
    const f = props[name];
    if (!f) {
      if (json.additionalProperties === false) return `field "${name}" is not in the form`;
      continue;
    }
    const kind = fieldKind(f);
    if (kind === "enum" && !(f.enum as unknown[]).includes(v)) return `field "${name}" must be one of the options`;
    if (kind === "string" && typeof v !== "string") return `field "${name}" must be text`;
    if (kind === "number" && (typeof v !== "number" || !Number.isFinite(v))) return `field "${name}" must be a number`;
    if (kind === "number" && f.type === "integer" && !Number.isInteger(v))
      return `field "${name}" must be a whole number`;
    if (kind === "boolean" && typeof v !== "boolean") return `field "${name}" must be true or false`;
  }
  return null;
}

/** Validates a value against the live schema when there is one, else the stored JSON Schema. */
export async function checkSchemaValue(n: NormalizedAsk, value: unknown): Promise<string | null> {
  if (n.live) {
    const r = await n.live["~standard"].validate(value);
    return r.issues ? r.issues.map((i) => i.message).join("; ") || "invalid value" : null;
  }
  return n.jsonSchema ? checkFlatValue(n.jsonSchema, value) : "this ask takes no form value";
}

/** Validates and normalises a spec. Throws AskSpecError naming the fix. */
export async function normalizeAskSpec(spec: AskSpec): Promise<NormalizedAsk> {
  if (!spec || typeof spec !== "object") fail("ask: the spec must be an object with a question.");
  const question = checkText("question", spec.question, LIMITS.question, true) as string;
  const title = checkText("title", spec.title, LIMITS.title, false);
  const context = checkText("context", spec.context, LIMITS.context, false);
  const choices = normalizeChoices(spec.choices);

  let jsonSchema: JsonSchema | undefined;
  let live: StandardSchema | undefined;
  if (spec.schema !== undefined) {
    const s = toJsonSchema(spec.schema);
    checkFlatSchema(s.json);
    jsonSchema = s.json;
    live = s.live;
  }
  if (spec.freeText !== undefined && typeof spec.freeText !== "boolean") fail("ask: freeText must be a boolean.");
  const freeText = spec.freeText ?? (choices.length === 0 && jsonSchema === undefined);
  if (choices.length === 0 && !freeText && !jsonSchema)
    fail("ask: nobody could answer this. Give choices, a schema, or freeText: true.");

  if (spec.timeout !== undefined && durationToMs(spec.timeout) === null)
    fail(`ask: timeout ${JSON.stringify(spec.timeout)} is not a duration like "30m", "4h" or a number of ms.`);
  if (spec.onTimeout !== undefined && !["default", "auto", "fail"].includes(spec.onTimeout))
    fail('ask: onTimeout must be "default", "auto" or "fail".');
  if (spec.risk !== undefined && spec.risk !== "low" && spec.risk !== "high")
    fail('ask: risk must be "low" or "high".');
  if (spec.dedupeKey !== undefined) checkText("dedupeKey", spec.dedupeKey, LIMITS.dedupeKey, true);
  if (spec.anchor !== undefined) {
    const a = spec.anchor as { path?: unknown; line?: unknown };
    if (typeof a.path !== "string" || a.path === "" || !Number.isInteger(a.line) || (a.line as number) < 1)
      fail("ask: anchor must be { path: string, line: positive integer }.");
  }

  const n: NormalizedAsk = { stored: { question }, choices, freeText };
  if (jsonSchema) n.jsonSchema = jsonSchema;
  if (live) n.live = live;

  if (spec.default !== undefined) {
    const d = spec.default;
    const isChoice = typeof d === "string" && choices.some((c) => c.id === d);
    if (!isChoice) {
      if (jsonSchema) {
        const err = await checkSchemaValue(n, d);
        if (err) fail(`ask: default is neither a choice id nor a valid form value (${err}).`);
      } else if (!(freeText && typeof d === "string")) {
        fail(`ask: default ${JSON.stringify(d)} is not one of the choice ids.`);
      }
    }
  }

  // The stored spec is plain JSON: a live schema is replaced by its JSON Schema (cast: the field is typed
  // for callers, the record is data).
  const stored: AskSpec = { question };
  if (title !== undefined) stored.title = title;
  if (context !== undefined) stored.context = context;
  if (choices.length > 0) stored.choices = choices;
  stored.freeText = freeText;
  if (jsonSchema) stored.schema = jsonSchema as unknown as StandardSchema;
  if (spec.default !== undefined) stored.default = spec.default;
  if (spec.timeout !== undefined) stored.timeout = spec.timeout;
  if (spec.onTimeout !== undefined) stored.onTimeout = spec.onTimeout;
  if (spec.risk !== undefined) stored.risk = spec.risk;
  if (spec.dedupeKey !== undefined) stored.dedupeKey = spec.dedupeKey;
  if (spec.anchor !== undefined) stored.anchor = { path: spec.anchor.path, line: spec.anchor.line };
  n.stored = stored;
  return n;
}

/** Rebuilds the normalised view from a stored (already validated) spec. */
export function fromStored(stored: AskSpec): NormalizedAsk {
  const choices = (stored.choices ?? []).map((c) => (typeof c === "string" ? { id: c, label: c } : c));
  const n: NormalizedAsk = { stored, choices, freeText: stored.freeText ?? choices.length === 0 };
  if (stored.schema) n.jsonSchema = stored.schema as unknown as JsonSchema;
  return n;
}

export function safeChoices(n: NormalizedAsk): AskChoice[] {
  return n.choices.filter((c) => c.safe === true);
}

/**
 * The answer an ask falls back to without a human, or null when there is none. A high-risk ask may only fall
 * back to its one safe choice (spec §8.8).
 */
export function fallbackAnswer(n: NormalizedAsk, risk: "low" | "high"): AskAnswer<unknown> | null {
  const safe = safeChoices(n);
  if (risk === "high") return safe.length === 1 ? { kind: "choice", choiceId: (safe[0] as AskChoice).id } : null;
  const d = n.stored.default;
  if (d !== undefined) {
    if (typeof d === "string" && n.choices.some((c) => c.id === d)) return { kind: "choice", choiceId: d };
    if (n.jsonSchema && typeof d === "object") return { kind: "value", value: d };
    if (typeof d === "string" && n.freeText) return { kind: "text", text: d };
  }
  return safe.length === 1 ? { kind: "choice", choiceId: (safe[0] as AskChoice).id } : null;
}

/** Creation-time policy checks, so a bad ask fails now and never hours later (spec §8.8). */
export function checkPolicy(n: NormalizedAsk, onTimeout: "default" | "auto" | "fail", risk: "low" | "high"): void {
  if (onTimeout !== "default") return;
  const safe = safeChoices(n);
  if (risk === "high") {
    if (safe.length !== 1)
      fail(
        'ask: a high-risk ask with onTimeout: "default" needs exactly one choice marked safe: true. Mark the safe choice or use onTimeout: "fail".',
      );
    return;
  }
  if (n.stored.default === undefined && safe.length !== 1)
    fail('ask: onTimeout: "default" needs a default or exactly one choice marked safe: true.');
}

/** Checks a human (or automatic) answer against the ask; returns an error message or null. */
export async function checkAnswer(n: NormalizedAsk, answer: AskAnswer<unknown>): Promise<string | null> {
  switch (answer?.kind) {
    case "choice":
      return n.choices.some((c) => c.id === answer.choiceId) ? null : `"${answer.choiceId}" is not one of the choices`;
    case "text":
      if (!n.freeText) return "this ask does not take free text";
      return typeof answer.text === "string" && answer.text.trim() !== "" ? null : "the text answer is empty";
    case "value":
      if (!n.jsonSchema) return "this ask takes no form value";
      return checkSchemaValue(n, answer.value);
    default:
      return "an answer must be a choice, text or value";
  }
}

export function choiceLabel(n: NormalizedAsk, id: string): string {
  return n.choices.find((c) => c.id === id)?.label ?? id;
}
