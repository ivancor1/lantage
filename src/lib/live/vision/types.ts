/**
 * The LIVE vision boundary.
 *
 * This is the same `VlmProvider` contract the cascade defines
 * (`src/lib/cascade/vlmProvider.ts`) — widened, never replaced. Everything here
 * is a *structural superset*, so a `LiveVisionProvider` can be handed to any
 * consumer that only knows about `VlmProvider` (or INTERIOR's
 * `InteriorVlmProvider`) without a cast:
 *
 *   - the request type adds only optional fields, so a plain `VlmRequest` is
 *     still a legal argument;
 *   - the result type only adds fields, so a `LiveVlmResult` is still a
 *     `VlmResult`.
 *
 * Two additions matter beyond that:
 *
 * 1. `usage` carries **provider-reported token counts** and a cost computed from
 *    published per-token prices. `costUsd` is OPTIONAL and is omitted — not
 *    zeroed, not borrowed from another vendor — when the price of the model in
 *    play is not known to `pricing.ts`. An absent cost is honest; a fabricated
 *    one poisons the ledger.
 * 2. `extractStructured` exists because `VlmClues` is a *geolocation* schema.
 *    VEHICLE (and anything else needing attributes rather than places) hands in
 *    its own zod schema and gets it validated, with one repair retry, against
 *    the same vendor plumbing. `extractClues` is left exactly as the cascade
 *    defines it so nothing downstream has to change.
 */

import type { z } from 'zod';
import type { ImageRef, Result, StageFailure } from '@/lib/cascade/types';
import type { VlmProvider, VlmRequest, VlmResult } from '@/lib/cascade/vlmProvider';
import type { VisionVendor } from '@/lib/live/contract';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * `VlmRequest` plus optional levers. Every added field is optional on purpose:
 * that is what keeps `VlmRequest` assignable to this type, which is what lets
 * this provider satisfy the narrower cascade and INTERIOR interfaces.
 */
export interface LiveVlmRequest extends VlmRequest {
  /**
   * Full prompt override. INTERIOR passes its indoor prompt here; when absent
   * the shared `CLUE_EXTRACTION_PROMPT` is used verbatim.
   */
  prompt?: string;
  /** Appended after the prompt — e.g. a region-technique checklist. */
  promptSuffix?: string;
  /**
   * Ask the model for the approximate centre of each region it names, as an
   * extra top-level key. Only set this when no gazetteer is configured: the
   * coordinates are the model's own recollection and are labelled as such.
   */
  requestRegionCoordinates?: boolean;
  /** Long edge, in pixels, to downscale to before encoding. Vendor default when unset. */
  maxLongEdgePx?: number;
}

// ---------------------------------------------------------------------------
// Usage + cost
// ---------------------------------------------------------------------------

export interface VisionUsage {
  /** Provider-reported. Absent when the vendor returned no usage block. */
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /**
   * Real cost from real token counts against a published price.
   * ABSENT when the model's price is unknown — see `pricing.ts`. Never guessed.
   */
  costUsd?: number;
  /** Where the number came from, or why there isn't one. Always present. */
  costBasis: string;
}

/** The model's own recollection of where a region it named sits. Never a geocode. */
export interface ModelEstimatedRegion {
  label: string;
  lat: number;
  lon: number;
  /** The model's own stated uncertainty. Absent when it did not give one. */
  radiusKm?: number;
}

/** What was actually sent to the vendor, so a result is reproducible. */
export interface SentImageFacts {
  /** preparedLongEdge / originalLongEdge. 1 when the bytes went unmodified. */
  scale: number;
  /** Pixel dimensions of the image the model actually saw, when measurable. */
  px?: { w: number; h: number };
  mediaType: string;
  bytes: number;
  /** e.g. 'passthrough', 'sharp-downscale'. */
  method: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface LiveVlmResult extends VlmResult {
  usage: VisionUsage;
  image: SentImageFacts;
  /** Present only when `requestRegionCoordinates` was set and the model complied. */
  regionCoordinates?: ModelEstimatedRegion[];
  /** Honest caveats: recompression applied, suffix ignored, price unknown, … */
  notes: string[];
}

export interface StructuredRequest<T> {
  image: ImageRef;
  /** The whole prompt. Must itself demand JSON — see `buildJsonOnlyPrompt`. */
  prompt: string;
  /** The contract. Validation happens here, never in the caller. */
  schema: z.ZodType<T>;
  /**
   * Optional vendor-side JSON Schema to force the shape. Must already satisfy
   * the vendor rules (`additionalProperties: false`, every property required) —
   * run it through `sanitiseVendorJsonSchema` if unsure. When absent, plain
   * JSON mode is used and the zod schema is the only guarantee.
   */
  jsonSchema?: JsonSchemaObject;
  /** Name for the schema, required by some vendors. Defaults to 'structured_output'. */
  schemaName?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  maxLongEdgePx?: number;
}

export interface StructuredResult<T> {
  value: T;
  modelVersion: string;
  attempts: number;
  usage: VisionUsage;
  image: SentImageFacts;
  /** The raw JSON text the model returned, for the audit record. */
  raw: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** A JSON Schema fragment. `unknown` rather than `any`: callers must narrow. */
export interface JsonSchemaObject {
  [key: string]: unknown;
}

/**
 * Structurally a `VlmProvider`. Declared with `extends` so the compiler proves
 * it, which is what lets `selectProvider()` feed LOCATE, INTERIOR and the
 * cascade from one implementation.
 */
export interface LiveVisionProvider extends VlmProvider {
  readonly name: string;
  readonly vendor: VisionVendor;
  /** Model id as sent to the vendor. Lands in `ResultProvenance.models`. */
  readonly model: string;
  extractClues(req: LiveVlmRequest): Promise<Result<LiveVlmResult, StageFailure>>;
  /**
   * Generic structured extraction. Forces JSON, validates with the caller's zod
   * schema, retries once on a schema mismatch, and never throws.
   */
  extractStructured<T>(req: StructuredRequest<T>): Promise<Result<StructuredResult<T>, StageFailure>>;
}
