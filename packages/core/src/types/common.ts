/** A public duration: `"45m"`, `"2h"`, or a number of milliseconds (spec §3.3). Wire types use numeric `*Ms` fields. */
export type Duration = `${number}${"s" | "m" | "h" | "d"}` | number;

/** Any JSON value. Journal values, step values and wire payloads must be JSON. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The one effort union (spec §4.2). A vendor level above `high` maps to `max`. */
export type Effort = "low" | "medium" | "high" | "max";

/** Support tier of an adapter (spec §1.10). Every adapter value exposes it as `stability`. */
export type Stability = "stable" | "experimental";

/** Which deployment owns a sandbox: `^[a-z0-9-]{1,32}$`, e.g. "prod", "ci-12345", "local-rays-mbp" (spec §5.2). */
export type DeploymentId = string;

/**
 * A JSON Schema (draft-07) document. Declared locally because public types may not import
 * third-party type packages (spec §1.7).
 */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  [keyword: string]: unknown;
}

export type JsonSchemaTypeName = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

/** Alias kept for the spec's `inputJsonSchema` / `outputJsonSchema` fields (spec §2.5.1). */
export type JSONSchema7 = JsonSchema;

/**
 * The Standard Schema v1 interface (standardschema.dev), declared locally. Zod v4 schemas implement it.
 * Used for human-answer forms in `AskSpec.schema` (spec §8.2).
 */
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: Output; readonly issues?: undefined }
      | {
          readonly issues: ReadonlyArray<{
            readonly message: string;
            readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
          }>;
        }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | {
              readonly issues: ReadonlyArray<{
                readonly message: string;
                readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
              }>;
            }
        >;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}
