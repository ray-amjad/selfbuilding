import { currentAskScope } from "../ask/context.js";
import { NoActiveRunError } from "../errors/classes.js";
import type { ArtifactStore } from "../types/artifacts.js";
import { currentFrame } from "./context.js";

// Run services for factory code that publishes its own pages (demo-path §4.4): the run's artifact store, and one
// note to the run's thread. Added for verifyFlows; additive only.

/** The current run's id and ArtifactStore (the one agent artifacts are stored in). Throws outside a run. */
export function runArtifacts(): { runId: string; artifacts: ArtifactStore } {
  const frame = currentFrame("runArtifacts");
  return { runId: frame.run.runId, artifacts: frame.run.artifacts };
}

/**
 * `text` with every secret this run delivered to a box, and every known token shape, replaced. For factory code
 * that stores what it reads off a box itself, which the per-call artifact redaction never sees. Throws outside a run.
 */
export function redactForRun(text: string): string {
  return currentFrame("redactForRun").run.events.redact(text);
}

/**
 * Posts `text` as an FYI to the run's thread on every configured channel, with the same redaction, truncation and
 * retries as an agent's `notify_human`. It posts in AFK mode too (AFK means nobody answers asks, not silence).
 * Never throws on delivery; `delivered` is false with no channel, or when every channel failed. Not journaled:
 * wrap it in `step()` so a resumed run does not post twice.
 */
export async function notify(text: string): Promise<{ delivered: boolean; note: string }> {
  const scope = currentAskScope();
  if (!scope) throw new NoActiveRunError({ primitive: "notify" });
  const res = await scope.session.notifyHuman({ callPath: scope.callPath(), text, postInAfk: true });
  // notifyHuman answers in tool-result prose; only this sentence means a channel accepted the post.
  return { delivered: !res.isError && res.toolText === "Posted to the run thread.", note: res.toolText };
}
