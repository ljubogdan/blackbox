import type { TokenUsage } from '@mozaik-ai/core';

// Dollars per million tokens, input and output, at Anthropic's list prices. A model not listed
// here is priced at zero and named once, so a run on it says it was not metered.
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

// What one call cost. Mozaik reports cache writes and reads together as cached input, so they are
// priced as cache writes (1.25× input), the dearer of the two: the meter may overstate, never understate.
export function callCost(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const cached = usage.inputTokenDetails?.cached_tokens ?? 0;
  return (usage.inputTokens * price.input + cached * price.input * 1.25 + usage.outputTokens * price.output) / 1_000_000;
}

export interface Spend {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number; // calls that reported their usage
}
