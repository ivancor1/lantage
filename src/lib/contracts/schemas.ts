/**
 * Zod schemas for boundaries where we don't control the input:
 * the vision model's output, and our own HTTP API.
 *
 * The VLM schema is the load-bearing one. Per docs/MASTER_PLAN.md §3, the
 * vision model's job is to PRUNE the search space, not to answer. So it is
 * never asked "where is this?" — it is asked to enumerate discrete, individually
 * checkable observations. The ACL 2026 GeoRC study found frontier models
 * "couldn't provide reasoning for their guesses or were vague," with experts
 * identifying "many suspicious or hallucinated attributes": the model
 * recognises a place and then fabricates the evidence. Forcing a structured
 * clue list makes that failure visible instead of invisible.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// VLM structured clue extraction
// ---------------------------------------------------------------------------

/** Every clue carries its own legibility, separate from what it implies. */
const clueBase = {
  /** Verbatim what is visible. No inference in this field. */
  observed: z.string().min(1).max(300),
  /** How sure the model is that it SEES this — not what it means. */
  legibility: z.enum(['clear', 'partial', 'guessed']),
  /** Normalised 0..1 box, so the UI can crop the citation next to the claim. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
};

export const VlmCluesSchema = z.object({
  /**
   * Readable text in the frame. The single highest-yield street-level signal —
   * a legible business name plus a geocode beats any embedding model.
   */
  text: z
    .array(
      z.object({
        ...clueBase,
        kind: z.enum([
          'business-name',
          'street-sign',
          'address-number',
          'transit-sign',
          'phone-number',
          'license-plate-region', // jurisdiction STYLE only, never plate characters
          'other',
        ]),
        /** Language / script is itself a geographic signal. */
        script: z.string().optional(),
      }),
    )
    .max(20),

  /** Infrastructure conventions — the GeoGuessr reference-guide signals. */
  infrastructure: z
    .array(
      z.object({
        ...clueBase,
        kind: z.enum([
          'driving-side',
          'road-marking',
          'utility-pole',
          'bollard',
          'traffic-light',
          'curb-style',
          'guardrail',
          'fire-hydrant',
          'manhole',
        ]),
        /** Regions this convention is consistent with. May be wrong — that's why it's cited. */
        impliesRegions: z.array(z.string()).max(10),
      }),
    )
    .max(20),

  /** Natural environment. Cross-referenced against an ecoregion raster downstream. */
  environment: z
    .array(
      z.object({
        ...clueBase,
        kind: z.enum(['vegetation', 'soil', 'terrain', 'sky', 'snow', 'water']),
        impliesRegions: z.array(z.string()).max(10),
      }),
    )
    .max(12),

  /** Built environment. Strong in distinctive cities — a reason Pittsburgh is metro #1. */
  architecture: z
    .array(
      z.object({
        ...clueBase,
        kind: z.enum([
          'building-material',
          'roof-style',
          'window-style',
          'row-house',
          'bridge',
          'stair-street',
          'signage-style',
        ]),
        impliesRegions: z.array(z.string()).max(10),
      }),
    )
    .max(15),

  /** Sun/shadow geometry, feeding the ShadowFinder verifier. */
  solar: z
    .object({
      shadowsVisible: z.boolean(),
      /** Compass bearing shadows point toward, degrees. */
      shadowAzimuthDeg: z.number().min(0).max(360).optional(),
      /** Shadow length / object height. Pixels are fine — it's a ratio. */
      shadowToHeightRatio: z.number().positive().optional(),
      estimatedTimeOfDay: z.enum([
        'dawn',
        'morning',
        'midday',
        'afternoon',
        'dusk',
        'night',
        'unknown',
      ]),
    })
    .optional(),

  /**
   * The model's own region shortlist. Deliberately LAST, and used downstream
   * ONLY to select the retrieval submap — never surfaced as an answer.
   */
  regionPrior: z
    .array(
      z.object({
        label: z.string(),
        country: z.string().optional(),
        admin1: z.string().optional(),
        /** 0..1, recalibrated downstream. The model's self-report is not trusted. */
        rawConfidence: z.number().min(0).max(1),
        /** Which observations above support this. Non-empty by construction. */
        supportedBy: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(5),

  /** A model that says "I can't tell" is more useful than one that guesses. */
  insufficientSignal: z.boolean(),
});

export type VlmClues = z.infer<typeof VlmCluesSchema>;

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

export const SearchRequestSchema = z.object({
  module: z.enum(['GEO', 'STREET', 'VEHICLE', 'VERIFY', 'CLAIM', 'MATCH']),
  imageId: z.string().min(1),
  caseId: z.string().optional(),
  hints: z
    .object({
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      capturedAt: z.string().optional(),
      corpusId: z.string().optional(),
    })
    .optional(),
});

/** Contract for the Modal inference service. Owned by B1, consumed by B2. */
export const EmbedRequestSchema = z
  .object({
    /** Prefer a signed URL — keeps payloads small. */
    imageUrl: z.string().url().optional(),
    imageBase64: z.string().optional(),
    models: z.array(z.enum(['geoclip', 'eigenplaces', 'megaloc', 'dinov2'])).min(1),
  })
  .refine((v) => !!v.imageUrl || !!v.imageBase64, {
    message: 'one of imageUrl or imageBase64 is required',
  });

export const EmbedResponseSchema = z.object({
  embeddings: z.record(
    z.string(),
    z.object({
      vector: z.array(z.number()),
      dim: z.number().int().positive(),
      model: z.string(),
      /** Propagated into ResultProvenance.models — required for reproducibility. */
      version: z.string(),
    }),
  ),
  /** GeoCLIP additionally returns its GPS-gallery prior. */
  geoPrior: z.array(z.object({ lat: z.number(), lon: z.number(), score: z.number() })).optional(),
  tookMs: z.number(),
});

export type EmbedRequest = z.infer<typeof EmbedRequestSchema>;
export type EmbedResponse = z.infer<typeof EmbedResponseSchema>;

// ---------------------------------------------------------------------------
// Mapillary ingest
// ---------------------------------------------------------------------------

/**
 * Shape retained per harvested image: id, geometry, heading, plus a derived
 * embedding.
 *
 * Mapillary ToS §12 permits commercial dataset/algorithm construction and §11
 * permits self-hosting with attribution, but requires "technical safeguards and
 * business processes that prohibit reidentification or unblurring of any
 * Content, including any individual or license plate." Hence `blurApplied`:
 * we assert upstream blur is intact at ingest and run no process that undoes it.
 */
export const MapillaryRecordSchema = z.object({
  mapillaryId: z.string(),
  lat: z.number(),
  lon: z.number(),
  /** Compass heading. Essential — 4 headings per location is our density unit. */
  compassAngle: z.number().min(0).max(360).nullable(),
  capturedAt: z.string().optional(),
  thumbUrl: z.string().url(),
  sequenceId: z.string().optional(),
  isPano: z.boolean().default(false),
  /** Must be true. Asserted at ingest — see docs/MASTER_PLAN.md §3. */
  blurApplied: z.literal(true),
});

export type MapillaryRecord = z.infer<typeof MapillaryRecordSchema>;
