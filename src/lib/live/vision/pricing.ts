/**
 * Per-token prices, so `costUsd` is arithmetic on real token counts rather than a
 * plausible-looking number.
 *
 * THE RULE: if the model in play is not in a table below, `costUsd` is **absent**
 * from the result. Not zero, not the nearest sibling model's price, not another
 * vendor's. `VisionUsage.costBasis` then says why there is no number. An operator
 * auditing a per-search cost has to be able to trust that a present number was
 * computed and an absent one was never known.
 *
 * Sources, both fetched 2026-07-30:
 *   - Anthropic: the model/pricing table in the `claude-api` skill reference
 *     (published prices, per million tokens).
 *   - OpenAI: https://developers.openai.com/api/docs/pricing
 *
 * Prices move. When they do, the fix is this file and the `SOURCE_*` strings —
 * nothing else reads a price.
 */

import type { VisionVendor } from '@/lib/live/contract';
import type { VisionUsage } from './types';

export interface TokenPrice {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTok: number;
  /** USD per 1,000,000 cache-read input tokens, when the vendor publishes one. */
  cachedInputPerMTok?: number;
  /** Where these numbers came from, verbatim into `costBasis`. */
  source: string;
}

const SOURCE_ANTHROPIC = 'Anthropic published per-MTok prices, recorded 2026-07-30';
const SOURCE_OPENAI = 'developers.openai.com/api/docs/pricing, recorded 2026-07-30';

/**
 * Longest-prefix matched, so a dated snapshot id (`claude-sonnet-5-20260115`)
 * resolves to its family price without needing its own row.
 *
 * Anthropic cache-read is ~0.1x base input; that multiplier is applied rather
 * than tabulated. Note for the reader: Claude Sonnet 5 has promotional input
 * pricing running to 2026-08-31 that is *lower* than the list price below, so a
 * cost computed here can over-state the invoice. Over-stating is the safe
 * direction for a cost ceiling and the list price is the durable number.
 */
const ANTHROPIC_PRICES: ReadonlyArray<readonly [string, TokenPrice]> = [
  ['claude-fable-5', { inputPerMTok: 10, outputPerMTok: 50, source: SOURCE_ANTHROPIC }],
  ['claude-mythos-5', { inputPerMTok: 10, outputPerMTok: 50, source: SOURCE_ANTHROPIC }],
  ['claude-opus-5', { inputPerMTok: 5, outputPerMTok: 25, source: SOURCE_ANTHROPIC }],
  ['claude-opus-4-8', { inputPerMTok: 5, outputPerMTok: 25, source: SOURCE_ANTHROPIC }],
  ['claude-opus-4-7', { inputPerMTok: 5, outputPerMTok: 25, source: SOURCE_ANTHROPIC }],
  ['claude-opus-4-6', { inputPerMTok: 5, outputPerMTok: 25, source: SOURCE_ANTHROPIC }],
  ['claude-opus-4-5', { inputPerMTok: 5, outputPerMTok: 25, source: SOURCE_ANTHROPIC }],
  ['claude-sonnet-5', { inputPerMTok: 3, outputPerMTok: 15, source: SOURCE_ANTHROPIC }],
  ['claude-sonnet-4-6', { inputPerMTok: 3, outputPerMTok: 15, source: SOURCE_ANTHROPIC }],
  ['claude-sonnet-4-5', { inputPerMTok: 3, outputPerMTok: 15, source: SOURCE_ANTHROPIC }],
  ['claude-haiku-4-5', { inputPerMTok: 1, outputPerMTok: 5, source: SOURCE_ANTHROPIC }],
];

const OPENAI_PRICES: ReadonlyArray<readonly [string, TokenPrice]> = [
  ['gpt-5.6-sol', { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, source: SOURCE_OPENAI }],
  ['gpt-5.6-terra', { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, source: SOURCE_OPENAI }],
  ['gpt-5.6-luna', { inputPerMTok: 1, outputPerMTok: 6, cachedInputPerMTok: 0.1, source: SOURCE_OPENAI }],
  ['gpt-5.5', { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, source: SOURCE_OPENAI }],
  ['gpt-5.4', { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, source: SOURCE_OPENAI }],
];

/** Anthropic does not tabulate cache reads per model; the published ratio is ~0.1x. */
const ANTHROPIC_CACHE_READ_RATIO = 0.1;

export function priceFor(vendor: VisionVendor, model: string): TokenPrice | null {
  const table = vendor === 'anthropic' ? ANTHROPIC_PRICES : vendor === 'openai' ? OPENAI_PRICES : [];
  const id = model.trim().toLowerCase();
  let best: TokenPrice | null = null;
  let bestLength = -1;
  for (const [prefix, price] of table) {
    if (id.startsWith(prefix) && prefix.length > bestLength) {
      best = price;
      bestLength = prefix.length;
    }
  }
  return best;
}

export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/**
 * Build the usage block. Three honest outcomes, and no fourth:
 *   1. tokens + a known price  -> a real `costUsd`;
 *   2. tokens, unknown price   -> no `costUsd`, and `costBasis` names the model;
 *   3. no tokens at all        -> no `costUsd`, and `costBasis` says the vendor
 *      returned no usage block.
 */
export function usageFor(args: {
  vendor: VisionVendor;
  model: string;
  tokens: TokenCounts;
}): VisionUsage {
  const { vendor, model, tokens } = args;
  const hasTokens = tokens.inputTokens !== undefined || tokens.outputTokens !== undefined;
  const counts: VisionUsage = {
    ...(tokens.inputTokens === undefined ? {} : { inputTokens: tokens.inputTokens }),
    ...(tokens.outputTokens === undefined ? {} : { outputTokens: tokens.outputTokens }),
    ...(tokens.cachedInputTokens === undefined ? {} : { cachedInputTokens: tokens.cachedInputTokens }),
    costBasis: '',
  };

  if (!hasTokens) {
    return {
      ...counts,
      costBasis: `${vendor} returned no token usage for ${model}, so no cost could be computed. The field is omitted rather than zeroed.`,
    };
  }

  const price = priceFor(vendor, model);
  if (!price) {
    return {
      ...counts,
      costBasis: `Token usage is real, but no published price is on file for "${model}", so cost is omitted rather than guessed. Add it to src/lib/live/vision/pricing.ts to enable cost accounting.`,
    };
  }

  const cachedRate =
    price.cachedInputPerMTok ?? price.inputPerMTok * ANTHROPIC_CACHE_READ_RATIO;
  const cached = tokens.cachedInputTokens ?? 0;
  // The two vendors count cache reads differently and getting this backwards
  // silently double-bills: OpenAI's `input_tokens` INCLUDES `cached_tokens`,
  // Anthropic reports `cache_read_input_tokens` as a separate bucket.
  const uncachedInput =
    vendor === 'openai'
      ? Math.max(0, (tokens.inputTokens ?? 0) - cached)
      : (tokens.inputTokens ?? 0);
  const costUsd =
    (uncachedInput / 1_000_000) * price.inputPerMTok +
    (cached / 1_000_000) * cachedRate +
    ((tokens.outputTokens ?? 0) / 1_000_000) * price.outputPerMTok;

  return {
    ...counts,
    costUsd,
    costBasis: `${tokens.inputTokens ?? 0} input + ${tokens.outputTokens ?? 0} output tokens at ${price.inputPerMTok}/${price.outputPerMTok} USD per MTok (${price.source}).`,
  };
}

/** Sum costs that exist. An unknown cost contributes nothing and is not a zero. */
export function sumCostUsd(values: ReadonlyArray<number | undefined>): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}
