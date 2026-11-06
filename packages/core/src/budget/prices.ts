import type { ModelPrice } from "../types/budget.js";

/**
 * Built-in USD-per-million-token prices for token-metered harnesses (spec §9.6). Harnesses that report a
 * native cost (Claude Code) never consult it. Override or extend through `budget.prices`.
 */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-5": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5-codex": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5-mini": { inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2 },
  "gpt-5-nano": { inputPerMTok: 0.05, cachedInputPerMTok: 0.005, outputPerMTok: 0.4 },
  "gpt-5.1": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5.1-codex": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5.1-codex-mini": { inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2 },
  "o4-mini": { inputPerMTok: 1.1, cachedInputPerMTok: 0.275, outputPerMTok: 4.4 },
  "claude-opus-4-1": { inputPerMTok: 15, cachedInputPerMTok: 1.5, outputPerMTok: 75 },
  "claude-sonnet-4-5": { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 5 },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/** Looks a model up, tolerating a provider prefix ("openai/gpt-5") and a dated suffix ("-2025-08-07"). */
export function findPrice(model: string, overrides?: Record<string, ModelPrice>): ModelPrice | undefined {
  const table = { ...DEFAULT_PRICES, ...overrides };
  const bare = model.includes("/") ? (model.split("/").pop() as string) : model;
  for (const candidate of [model, bare, bare.replace(/-\d{4}-\d{2}-\d{2}$/, ""), bare.replace(/-\d{8}$/, "")]) {
    const price = table[candidate];
    if (price) return price;
  }
  return undefined;
}

export function priceTokens(price: ModelPrice, t: TokenCounts): number {
  const cached = t.cachedInputTokens ?? 0;
  const uncached = Math.max(0, t.inputTokens - cached);
  const usd =
    (uncached * price.inputPerMTok +
      cached * (price.cachedInputPerMTok ?? price.inputPerMTok) +
      t.outputTokens * price.outputPerMTok +
      (t.reasoningTokens ?? 0) * (price.reasoningPerMTok ?? 0)) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
