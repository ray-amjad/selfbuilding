import type { Duration } from "./common.js";

/** USD per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  reasoningPerMTok?: number;
}

/** The one Budget type (spec §9.6). Concurrency is not part of it. */
export interface Budget {
  /** Model spend plus estimated sandbox spend. */
  usd?: number;
  /** Total input + output tokens across the run. */
  tokens?: number;
  /** Whole run, excluding cold ask() waits. */
  wallClock?: Duration;
  perAgent?: { usd?: number; wallClock?: Duration; maxTurns?: number };
  /** Smallest slice worth launching; default min(perAgent.usd, 10% of usd). */
  minAgentUsd?: number;
  /** Overrides or additions to the built-in price table, keyed by model id. */
  prices?: Record<string, ModelPrice>;
  allowUnmetered?: boolean;
}
