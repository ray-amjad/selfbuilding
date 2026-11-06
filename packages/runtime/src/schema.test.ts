import type { JsonSchema } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { formatIssues, validateJsonSchema } from "./schema.js";

// Schemas in these tests are plain literals; the validator takes any JSON value as a schema.
const check = (schema: unknown, value: unknown) => validateJsonSchema(schema as JsonSchema | boolean, value);

const pointers = (schema: unknown, value: unknown) => check(schema, value).map((i) => i.pointer);

describe("validateJsonSchema (draft-07)", () => {
  const review = {
    type: "object",
    properties: {
      verdict: { enum: ["approve", "request_changes", "comment"] },
      summary: { type: "string", minLength: 1, maxLength: 20 },
      findings: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
          required: ["file"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdict", "summary"],
  } as const;

  it("accepts a valid value", () => {
    expect(check(review, { verdict: "approve", summary: "ok", findings: [{ file: "a.ts", line: 3 }] })).toEqual([]);
  });

  it("reports every issue with a JSON pointer, the expectation and what was received", () => {
    const issues = check(review, {
      verdict: "maybe",
      summary: "",
      findings: [{ file: 1, line: 0, extra: true }, { file: "b" }, { file: "c" }],
    });
    expect(issues.map((i) => i.pointer).sort()).toEqual(
      ["/verdict", "/summary", "/findings", "/findings/0/file", "/findings/0/line", "/findings/0/extra"].sort(),
    );
    const verdict = issues.find((i) => i.pointer === "/verdict");
    expect(verdict?.expected).toBe('one of "approve", "request_changes", "comment"');
    expect(verdict?.received).toBe('"maybe"');
  });

  it("reports missing required properties and wrong root types", () => {
    expect(pointers(review, {})).toEqual(["/verdict", "/summary"]);
    expect(check(review, [])[0]).toMatchObject({ pointer: "", expected: "object" });
  });

  it("distinguishes integer from number", () => {
    expect(pointers({ type: "integer" }, 1.5)).toEqual([""]);
    expect(pointers({ type: "number" }, 1)).toEqual([]);
    expect(pointers({ type: ["string", "null"] }, null)).toEqual([]);
  });

  it("supports $ref into definitions, anyOf, oneOf, allOf, not and const", () => {
    const schema = {
      definitions: { id: { type: "string", pattern: "^[a-z]+$" } },
      type: "object",
      properties: {
        a: { $ref: "#/definitions/id" },
        b: { anyOf: [{ type: "string" }, { type: "number" }] },
        c: { oneOf: [{ type: "number" }, { type: "integer" }] },
        d: { allOf: [{ minimum: 1 }, { maximum: 3 }] },
        e: { not: { const: "x" } },
        f: { const: { k: [1, 2] } },
      },
    };
    expect(check(schema, { a: "abc", b: 1, c: 1.5, d: 2, e: "y", f: { k: [1, 2] } })).toEqual([]);
    expect([...new Set(pointers(schema, { a: "ABC", b: true, c: 1, d: 5, e: "x", f: { k: [2, 1] } }))].sort()).toEqual(
      ["/a", "/b", "/c", "/d", "/e", "/f"].sort(),
    );
  });

  it("handles patternProperties, additionalProperties schemas, uniqueItems, tuples and dependencies", () => {
    const schema = {
      type: "object",
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: { type: "number" },
      dependencies: { a: ["b"] },
      properties: {
        list: { type: "array", uniqueItems: true },
        pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      },
    };
    expect(check(schema, { "x-1": "s", n: 3, list: [1, 2], pair: ["a", 1] })).toEqual([]);
    expect(pointers(schema, { "x-1": 2, n: "s", list: [1, 1], pair: [1, "a"], a: 1 }).sort()).toEqual(
      ["/x-1", "/n", "/list/1", "/pair/0", "/pair/1", "/b"].sort(),
    );
  });

  it("escapes pointer segments and counts string length in code points", () => {
    expect(pointers({ type: "object", properties: { "a/b~c": { type: "string" } } }, { "a/b~c": 1 })).toEqual([
      "/a~1b~0c",
    ]);
    expect(check({ type: "string", maxLength: 2 }, "😀😀")).toEqual([]);
  });

  it("treats boolean schemas and unresolvable refs", () => {
    expect(check(true, 1)).toEqual([]);
    expect(check(false, 1)).toHaveLength(1);
    expect(check({ $ref: "#/definitions/missing" }, 1)[0]?.received).toBe("unresolved");
  });

  it("does not loop forever on a self-referencing schema", () => {
    expect(check({ $ref: "#" }, 1)[0]?.received).toBe("too deep");
  });

  it("formats a numbered issue list for the model", () => {
    const text = formatIssues(check(review, { verdict: "x" }));
    expect(text).toBe(
      '1. /summary: expected a required property, received nothing\n2. /verdict: expected one of "approve", "request_changes", "comment", received "x"',
    );
  });
});
