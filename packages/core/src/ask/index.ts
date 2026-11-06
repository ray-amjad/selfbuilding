import { NoActiveRunError } from "../errors/classes.js";
import type { AskResolution, AskSpec } from "../types/ask.js";
import { currentAskScope } from "./context.js";

/** Asks a human from factory code, between agents (spec §8.2). Throws AskTimeoutError / AskCancelledError. */
export async function ask<T = unknown, const C extends string = string>(
  spec: AskSpec<T, C>,
): Promise<AskResolution<T, C>> {
  const scope = currentAskScope();
  if (!scope) throw new NoActiveRunError({ primitive: "ask" });
  const res = await scope.session.ask(spec as AskSpec, { callPath: scope.callPath() });
  return res as AskResolution<T, C>;
}

export { answerAsk, onAskSettled, updateCards, wakeAsk } from "./answer.js";
export { type AskScope, currentAskScope, runWithAskScope } from "./context.js";
export { durationToMs, formatDuration } from "./duration.js";
export {
  formatLateAnswer,
  formatResumeMessage,
  formatSettledCard,
  formatSuspended,
  formatToolResult,
} from "./format.js";
export { base32, canonicalJson, computeSpecHash, deriveAskId } from "./identity.js";
export { describeApprovers, handleInbound, isApprover, routeInbound } from "./inbound.js";
export { answerCommand, type DeliverAnswerOptions, deliverAnswer } from "./inbox.js";
export { memoryChannel } from "./memory-channel.js";
export {
  type AgentAskRequest,
  type AgentAskTicket,
  type AgentHitl,
  AskSession,
  type AskSessionOptions,
  type AskWaitpoints,
  type AutoAnswerer,
  type AutoAnswerRequest,
  type AutoAnswerResult,
  type ColdInfo,
  type EmitFn,
  mergeHitlOptions,
  nodeWaitpoints,
  type RunSummary,
  validateHitlConfig,
} from "./session.js";
export { checkAnswer, fallbackAnswer, type NormalizedAsk, normalizeAskSpec } from "./spec.js";
export { fileAskStore, memoryAskStore } from "./store.js";
export {
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_HOT_WAIT_MS,
  HOT_MARGIN_MS,
  hotLimitMs,
  MIN_HOT_MS,
  SHARED_HOT_CAP_MS,
  selectWaitMode,
  type WaitModeInput,
  type WaitPlan,
} from "./wait-mode.js";
