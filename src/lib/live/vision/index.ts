/**
 * Vision provider selection.
 *
 * `resolveVisionVendor()` in `../contract.ts` owns the priority order — whichever
 * key exists, Anthropic first — and this module owns the mapping from that
 * decision to a working client. Nothing else in the app should read a vision API
 * key or know a vendor's request shape.
 *
 * `selectProvider()` returns `null` rather than throwing when nothing is
 * configured. That is the whole degradation contract of this layer: a module
 * without a vision key reports a `CapabilityGap` and returns fewer sections, and
 * never a fabricated one.
 */

import type { CapabilityGap, VisionVendor } from '@/lib/live/contract';
import { VISION_GAP, resolveVisionVendor } from '@/lib/live/contract';
import { AnthropicVisionProvider } from './anthropic';
import { GeminiVisionProvider } from './gemini';
import { OpenAiVisionProvider } from './openai';
import type { LiveVisionProvider } from './types';

export type EnvLike = Record<string, string | undefined>;

/**
 * The configured provider, or null.
 *
 * Synchronous. Callers that `await` it (INTERIOR does) are unaffected — awaiting
 * a non-promise is a no-op — and callers that don't get to stay synchronous.
 */
export function selectProvider(env: EnvLike = process.env): LiveVisionProvider | null {
  const vendor = resolveVisionVendor(env as NodeJS.ProcessEnv);
  if (!vendor) return null;
  return providerFor(vendor, env);
}

export function providerFor(vendor: VisionVendor, env: EnvLike = process.env): LiveVisionProvider {
  switch (vendor) {
    case 'anthropic':
      return new AnthropicVisionProvider({
        ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
        ...(env.LANTAGE_ANTHROPIC_VLM_MODEL ? { model: env.LANTAGE_ANTHROPIC_VLM_MODEL } : {}),
      });
    case 'openai':
      return new OpenAiVisionProvider({
        ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
        ...(env.LANTAGE_OPENAI_VLM_MODEL ? { model: env.LANTAGE_OPENAI_VLM_MODEL } : {}),
      });
    case 'gemini':
      return new GeminiVisionProvider({
        ...(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY
          ? { apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY }
          : {}),
      });
  }
}

/** The vendor that would be used, without constructing a client. */
export function selectedVendor(env: EnvLike = process.env): VisionVendor | null {
  return resolveVisionVendor(env as NodeJS.ProcessEnv);
}

/** The gap to report when `selectProvider()` returned null. */
export function visionGap(): CapabilityGap {
  return VISION_GAP;
}

export {
  asPreEncodedJsonProvider,
  type PreEncodedAdapterOptions,
  type PreEncodedJsonProvider,
} from './adapters';
export { AnthropicVisionProvider } from './anthropic';
export { GeminiVisionProvider } from './gemini';
export { OpenAiVisionProvider } from './openai';
export {
  CLUES_SCHEMA_NAME,
  sanitiseVendorJsonSchema,
  vlmCluesJsonSchema,
} from './jsonSchema';
export {
  HIGH_RES_TIER_LONG_EDGE_PX,
  STANDARD_TIER_LONG_EDGE_PX,
  type PreparedImage,
  prepareImage,
} from './image';
export { parseCluePayload, parseStructured, stripNulls, type ParsedCluePayload } from './parse';
export {
  REGION_COORDINATE_ADDENDUM,
  REPAIR_SUFFIX,
  buildCluePrompt,
  buildJsonOnlyPrompt,
} from './prompt';
export { priceFor, sumCostUsd, usageFor, type TokenPrice } from './pricing';
export { callVendorJson } from './net';
export type {
  JsonSchemaObject,
  LiveVisionProvider,
  LiveVlmRequest,
  LiveVlmResult,
  ModelEstimatedRegion,
  SentImageFacts,
  StructuredRequest,
  StructuredResult,
  VisionUsage,
} from './types';
