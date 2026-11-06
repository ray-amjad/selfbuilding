import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AskSpecError } from "../errors/classes.js";
import type { AskSpec } from "../types/ask.js";
import { checkAnswer, checkFlatValue, checkPolicy, fallbackAnswer, fromStored, normalizeAskSpec } from "./spec.js";

const bad = async (spec: unknown, pattern: RegExp) => {
  const p = normalizeAskSpec(spec as AskSpec);
  await expect(p).rejects.toBeInstanceOf(AskSpecError);
  await expect(p).rejects.toThrow(pattern);
};

describe("normalizeAskSpec", () => {
  it("expands choice shorthand to the object form", async () => {
    const n = await normalizeAskSpec({ question: "Ship?", choices: ["yes", "no"] });
    expect(n.choices).toEqual([
      { id: "yes", label: "yes" },
      { id: "no", label: "no" },
    ]);
    expect(n.freeText).toBe(false);
    expect(n.stored.choices).toEqual(n.choices);
  });

  it("names the object form when a shorthand string is not a valid id", async () => {
    await bad({ question: "Ship?", choices: ["Yes please"] }, /object form/);
  });

  it("enforces the length and count limits", async () => {
    await bad({ question: "" }, /question/);
    await bad({ question: "x".repeat(2001) }, /2000/);
    await bad({ question: "q", title: "t".repeat(121) }, /120/);
    await bad({ question: "q", context: "c".repeat(4001) }, /4000/);
    await bad({ question: "q", choices: ["a", "b", "c", "d", "e", "f"] }, /at most 5/);
    await bad({ question: "q", choices: [{ id: "a", label: "l".repeat(76) }] }, /75/);
    await bad({ question: "q", choices: ["a", "a"] }, /twice/);
    await bad({ question: "q", choices: [{ id: "a", label: "A", style: "loud" }] }, /style/);
  });

  it("defaults freeText to true only when there is nothing else to answer with", async () => {
    expect((await normalizeAskSpec({ question: "Why?" })).freeText).toBe(true);
    expect((await normalizeAskSpec({ question: "Why?", choices: ["a"], freeText: true })).freeText).toBe(true);
    await bad({ question: "Why?", freeText: false }, /nobody could answer/);
  });

  it("accepts a flat Zod schema and stores its JSON Schema", async () => {
    const schema = z.object({
      name: z.string(),
      count: z.number().int(),
      ok: z.boolean(),
      env: z.enum(["dev", "prod"]),
    });
    const n = await normalizeAskSpec({ question: "Fill in", schema });
    expect(n.live).toBe(schema);
    expect(n.jsonSchema?.type).toBe("object");
    expect(Object.keys(n.jsonSchema?.properties ?? {})).toEqual(["name", "count", "ok", "env"]);
    expect(JSON.parse(JSON.stringify(n.stored))).toEqual(n.stored);
  });

  it("accepts a flat JSON Schema from an agent", async () => {
    const schema = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] };
    const n = await normalizeAskSpec({ question: "Why?", schema } as unknown as AskSpec);
    expect(n.live).toBeUndefined();
    expect(n.jsonSchema).toEqual(schema);
  });

  it("rejects schemas that cannot render as a form", async () => {
    await bad({ question: "q", schema: z.object({ nested: z.object({ a: z.string() }) }) }, /flat object/);
    const six = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((k) => [k, z.string()]));
    await bad({ question: "q", schema: z.object(six) }, /it has 6/);
    await bad({ question: "q", schema: z.array(z.string()) }, /flat object/);
  });

  it("checks the default against the choices or the schema", async () => {
    await normalizeAskSpec({ question: "q", choices: ["a", "b"], default: "a" });
    await bad({ question: "q", choices: ["a", "b"], default: "c" }, /not one of the choice ids/);
    const schema = z.object({ n: z.number() });
    await normalizeAskSpec({ question: "q", schema, default: { n: 1 } });
    await bad({ question: "q", schema, default: { n: "x" } }, /valid form value/);
    await normalizeAskSpec({ question: "q", default: "anything" });
  });

  it("validates timeout, onTimeout, risk and anchor", async () => {
    await bad({ question: "q", timeout: "soon" }, /duration/);
    await bad({ question: "q", onTimeout: "later" }, /onTimeout/);
    await bad({ question: "q", risk: "medium" }, /risk/);
    await bad({ question: "q", anchor: { path: "a.ts", line: 0 } }, /anchor/);
  });
});

describe("policy checks", () => {
  const merge: AskSpec = {
    question: "Merge?",
    choices: [
      { id: "merge", label: "Merge", style: "primary" },
      { id: "hold", label: "Hold", safe: true },
    ],
  };

  it('requires a default or one safe choice for onTimeout: "default"', async () => {
    checkPolicy(await normalizeAskSpec(merge), "default", "low");
    checkPolicy(await normalizeAskSpec({ question: "q", choices: ["a"], default: "a" }), "default", "low");
    const none = await normalizeAskSpec({ question: "q", choices: ["a", "b"] });
    expect(() => checkPolicy(none, "default", "low")).toThrow(AskSpecError);
    expect(() => checkPolicy(none, "fail", "low")).not.toThrow();
  });

  it("lets a high-risk ask default only to its safe choice", async () => {
    const unsafeDefault = await normalizeAskSpec({ question: "Deploy?", choices: ["yes", "no"], default: "yes" });
    expect(() => checkPolicy(unsafeDefault, "default", "high")).toThrow(/safe: true/);
    const n = await normalizeAskSpec({ ...merge, default: "merge" });
    expect(fallbackAnswer(n, "high")).toEqual({ kind: "choice", choiceId: "hold" });
    expect(fallbackAnswer(n, "low")).toEqual({ kind: "choice", choiceId: "merge" });
    expect(fallbackAnswer(unsafeDefault, "high")).toBeNull();
  });

  it("falls back to a text or value default", async () => {
    expect(fallbackAnswer(await normalizeAskSpec({ question: "q", default: "skip it" }), "low")).toEqual({
      kind: "text",
      text: "skip it",
    });
    const schema = z.object({ n: z.number() });
    expect(fallbackAnswer(await normalizeAskSpec({ question: "q", schema, default: { n: 2 } }), "low")).toEqual({
      kind: "value",
      value: { n: 2 },
    });
  });
});

describe("checkAnswer", () => {
  it("accepts only answers the ask allows", async () => {
    const n = await normalizeAskSpec({ question: "q", choices: ["a", "b"] });
    expect(await checkAnswer(n, { kind: "choice", choiceId: "a" })).toBeNull();
    expect(await checkAnswer(n, { kind: "choice", choiceId: "z" })).toMatch(/not one of/);
    expect(await checkAnswer(n, { kind: "text", text: "hi" })).toMatch(/free text/);
    expect(await checkAnswer(n, { kind: "value", value: {} })).toMatch(/no form/);
  });

  it("validates form values against the stored JSON Schema after a restart", async () => {
    const n = await normalizeAskSpec({
      question: "q",
      schema: z.object({ n: z.number().int(), env: z.enum(["dev", "prod"]) }),
    });
    const restored = fromStored(JSON.parse(JSON.stringify(n.stored)));
    expect(await checkAnswer(restored, { kind: "value", value: { n: 2, env: "dev" } })).toBeNull();
    expect(await checkAnswer(restored, { kind: "value", value: { n: 2.5, env: "dev" } })).toMatch(/whole/);
    expect(await checkAnswer(restored, { kind: "value", value: { n: 2, env: "qa" } })).toMatch(/options/);
    expect(await checkAnswer(restored, { kind: "value", value: { env: "dev" } })).toMatch(/required/);
  });

  it("checkFlatValue rejects non-objects", () => {
    expect(checkFlatValue({ type: "object", properties: {} }, [1])).toMatch(/object/);
  });
});
