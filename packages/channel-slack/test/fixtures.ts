import type { AskRecord, AskSpec } from "@selfbuilding/core";

let seq = 0;

/** An open ask record as the core would store it, before any card is posted. */
export function askRecord(spec: AskSpec, over: Partial<AskRecord> = {}): AskRecord {
  seq += 1;
  const askId = over.askId ?? `ask_${String(seq).padStart(20, "0")}`;
  return {
    askId,
    runId: "run_test",
    ordinal: seq,
    callPath: "factory#0",
    origin: { kind: "factory", askSeq: seq },
    specHash: `hash${seq}`,
    spec,
    status: "open",
    waitpoint: { host: "node", ref: askId },
    messages: [],
    createdAt: "2026-11-01T10:00:00.000Z",
    expiresAt: "2026-11-01T14:00:00.000Z",
    ...over,
  };
}

/** A flat object schema in both forms the channel reads: JSON Schema properties and a Standard validator. */
export function flatSchema(): AskSpec["schema"] & { properties: Record<string, unknown> } {
  return {
    type: "object",
    properties: {
      branch: { type: "string", title: "Branch" },
      retries: { type: "integer" },
      force: { type: "boolean" },
      env: { enum: ["staging", "prod"] },
    },
    required: ["branch"],
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value: unknown) {
        const v = value as Record<string, unknown>;
        if (typeof v?.branch !== "string" || v.branch.length === 0) {
          return { issues: [{ message: "required", path: ["branch"] }] };
        }
        return { value: v };
      },
    },
  } as AskSpec["schema"] & { properties: Record<string, unknown> };
}
