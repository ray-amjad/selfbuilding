import { ChannelDeliveryError } from "../errors/classes.js";
import type { AskResolution } from "../types/ask.js";
import { type InboxAnswer, RUNTIME_ENV, RUNTIME_EXIT, SANDBOX_PATHS } from "../types/runtime.js";
import type { ProviderSandbox } from "../types/sandbox.js";

// Answer delivery for a hot wait (spec §6.9): one `answer` exec writes inbox/<askId>.json as the agent
// user, only while inbox/.open exists. Running as root would follow a symlink the agent planted.

export interface DeliverAnswerOptions {
  /** The call's step key and attempt number: the attempt directory the inbox lives in. */
  stepKey: string;
  attempt: number;
  resolution: AskResolution;
  /** SandboxProvider.fsRoot, for test providers. */
  fsRoot?: string;
  /** Tries for a transient (exit 75) failure. Default 3. */
  tries?: number;
  timeoutMs?: number;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The exact runtime command, exported for tests and for hosts that batch execs. */
export function answerCommand(stepKey: string, attempt: number, askId: string): string {
  return [
    "node",
    SANDBOX_PATHS.runtimeBundle,
    "answer",
    "--call",
    shellQuote(stepKey),
    "--attempt",
    String(attempt),
    "--ask",
    shellQuote(askId),
  ].join(" ");
}

/**
 * Writes the answer into the box's inbox. `written: false` means the runtime already had it, or the ask is
 * no longer open in the box (it went cold); the answer then reaches the agent as the resume message.
 */
export async function deliverAnswer(box: ProviderSandbox, o: DeliverAnswerOptions): Promise<{ written: boolean }> {
  const askId = o.resolution.askId;
  const body: InboxAnswer = { askId, resolution: o.resolution };
  const tries = o.tries ?? 3;
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = await box.exec(answerCommand(o.stepKey, o.attempt, askId), {
      user: "agent",
      stdin: JSON.stringify(body),
      timeoutMs: o.timeoutMs ?? 30_000,
      idempotent: true,
      ...(o.fsRoot === undefined ? {} : { env: { [RUNTIME_ENV.fsRoot]: o.fsRoot } }),
    });
    if (r.exitCode === RUNTIME_EXIT.ok) {
      try {
        const out = JSON.parse(r.stdoutTail.trim().split("\n").at(-1) ?? "") as { written?: unknown };
        if (typeof out.written === "boolean") return { written: out.written };
      } catch {
        // fall through to the protocol error below
      }
      throw new ChannelDeliveryError(
        `The runtime's answer verb printed no {written} object for ${askId}. Check runtime.log in the attempt directory.`,
      );
    }
    last = `exit ${r.exitCode}: ${r.stderrTail.trim().slice(-500)}`;
    if (r.exitCode !== RUNTIME_EXIT.transient) break;
  }
  throw new ChannelDeliveryError(
    `Could not deliver the answer to ${askId} into the sandbox inbox (${last}). The ask stays answered in the store; a cold resume will deliver it.`,
  );
}
