/**
 * What a call cost, from the response's token counts and a price table in dollars per
 * million tokens. The defaults are Anthropic's list prices at the time of writing; the
 * config's `pricing` section overrides or extends them.
 */

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** A five-minute cache write. */
  cacheWrite: number;
  /** A one-hour cache write; twice the input price when absent, which is Anthropic's rate. */
  cacheWrite1h?: number;
  /** A second rate card for long prompts (Haiku 5.5): a call whose prompt is over `tokens` is priced at it instead. */
  over?: { tokens: number; price: Price };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** All cache writes; the two below split it by lifetime, when the response said. */
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

/** Dollars per million tokens. Cache reads are a tenth of input, cache writes a quarter more. */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, over: { tokens: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } } },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * Cost in dollars, rounded to a millionth. Null when the model has no price. A one-hour
 * cache write costs more than a five-minute one, so the split is used when the response
 * carried it; without it every write is priced as five-minute.
 */
export function costOf(price: Price | null, tokens: TokenCounts): number | null {
  if (!price) return null;
  if (price.over && tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens > price.over.tokens) return costOf(price.over.price, tokens);
  const write1h = tokens.cacheWrite1hTokens ?? 0;
  const write5m = tokens.cacheWrite1hTokens !== undefined ? tokens.cacheWriteTokens - write1h : tokens.cacheWriteTokens;
  const usd =
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      Math.max(0, write5m) * price.cacheWrite +
      write1h * (price.cacheWrite1h ?? price.input * 2)) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
