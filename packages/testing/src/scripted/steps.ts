/** One step of a scripted turn (spec §10.3 L1). Steps run in order inside the sandbox. */
export type ScriptStep =
  /** Assistant text. The last one becomes the turn's final message. */
  | { say: string }
  /** A real shell command, reported as the harness's shell tool. `expectExit` fails the turn on a mismatch. */
  | { sh: string; cwd?: string; expectExit?: number }
  /** A selfbuilding tool call. `expect: "suspended"` asserts the ask moved to a cold wait. */
  | { tool: "ask_human" | "notify_human"; input: unknown; expect?: "accepted" | "rejected" | "suspended" }
  /** `submit_result` through the real MCP server. `expect` makes the player exit 3 when the verdict differs. */
  | { submit: unknown; expect?: "accepted" | "rejected" }
  /**
   * Dies mid-turn with a tool call in flight. `when` makes the step conditional on whether a submit was accepted
   * earlier in this turn. `"exit"` exits with `code` (default 1) instead of a signal.
   */
  | { crash: "SIGKILL" | "SIGINT" | "exit"; code?: number; when?: "before-submit" | "after-submit" }
  /** Blocks until cancelled. `"ignore-sigint"` ignores SIGINT/SIGTERM too, so only the SIGKILL escalation ends it. */
  | { hang: true | "ignore-sigint" }
  | { sleep: number }
  /** One raw native stream line, printed as-is (JSON-encoded). */
  | { event: unknown }
  /** Ends the turn with a native error event and exit 1. Put the vendor wording in `message`; adapters classify it. */
  | { error: { code: string; message: string; retryable?: boolean } }
  /** Overrides the token counts reported at the end of the turn. */
  | { usage: { inputTokens: number; outputTokens: number } };

/** Builders for common steps. */
export const scripted = {
  say: (text: string): ScriptStep => ({ say: text }),
  sh: (command: string, opts: { cwd?: string; expectExit?: number } = {}): ScriptStep => ({ sh: command, ...opts }),
  submit: (value: unknown, expect: "accepted" | "rejected" = "accepted"): ScriptStep => ({ submit: value, expect }),
  /** An invalid submission the server must reject, then a valid one it must accept, in one turn. */
  invalidThenValid: (invalid: unknown, valid: unknown): ScriptStep[] => [
    { submit: invalid, expect: "rejected" },
    { submit: valid, expect: "accepted" },
  ],
  askHuman: (input: unknown, expect?: "accepted" | "suspended"): ScriptStep => ({
    tool: "ask_human",
    input,
    ...(expect === undefined ? {} : { expect }),
  }),
  notifyHuman: (input: unknown): ScriptStep => ({ tool: "notify_human", input }),
  crash: (signal: "SIGKILL" | "SIGINT" = "SIGKILL", when?: "before-submit" | "after-submit"): ScriptStep => ({
    crash: signal,
    ...(when === undefined ? {} : { when }),
  }),
  hangUntilCancelled: (opts: { ignoreSigint?: boolean } = {}): ScriptStep => ({
    hang: opts.ignoreSigint ? "ignore-sigint" : true,
  }),
  error: (code: string, message: string): ScriptStep => ({ error: { code, message } }),
} as const;
