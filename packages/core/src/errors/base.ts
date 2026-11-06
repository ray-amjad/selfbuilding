import type { ErrorCode, Recovery, SerializedSelfbuildingError } from "./codes.js";

export interface SelfbuildingErrorOptions {
  /** Overrides the class's default message. Messages say what to do next. */
  message?: string;
  runId?: string;
  callPath?: string;
  recovery?: Recovery;
  cause?: unknown;
}

/** The base of every error Selfbuilding throws (spec §9.8). Switch on `code`, never on `message`. */
export abstract class SelfbuildingError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;
  /** "usage" errors extend SelfbuildingUsageError and throw through every primitive, including `.settled()`. */
  readonly kind: "usage" | "agent" = "agent";
  readonly runId?: string;
  readonly callPath?: string;
  readonly recovery?: Recovery;

  constructor(defaultMessage: string, opts: SelfbuildingErrorOptions = {}) {
    super(opts.message ?? defaultMessage, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    if (opts.runId !== undefined) this.runId = opts.runId;
    if (opts.callPath !== undefined) this.callPath = opts.callPath;
    if (opts.recovery !== undefined) this.recovery = opts.recovery;
  }

  /** Class-specific fields for the serialised form. Subclasses with extra fields override this. */
  protected details(): Record<string, unknown> | undefined {
    return undefined;
  }

  toJSON(): SerializedSelfbuildingError {
    const details = this.details();
    const { transcript, ...rest } = this.recovery ?? {};
    return {
      name: this.name,
      code: this.code,
      kind: this.kind,
      retryable: this.retryable,
      message: this.message,
      ...(this.runId === undefined ? {} : { runId: this.runId }),
      ...(this.callPath === undefined ? {} : { callPath: this.callPath }),
      ...(this.recovery === undefined
        ? {}
        : {
            recovery: {
              ...rest,
              ...(transcript === undefined
                ? {}
                : {
                    transcript: {
                      uri: transcript.uri,
                      bytes: transcript.bytes,
                      sha256: transcript.sha256,
                      contentType: transcript.contentType,
                    },
                  }),
            },
          }),
      ...(details === undefined ? {} : { details }),
    };
  }
}

/** Bugs in the factory or its configuration. Never retried; they throw through every primitive. */
export abstract class SelfbuildingUsageError extends SelfbuildingError {
  override readonly kind: "usage" | "agent" = "usage";
}
