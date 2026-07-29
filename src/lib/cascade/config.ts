/**
 * Every tunable number in the cascade, in one place, with the reason it has the
 * value it has.
 *
 * Two rules for this file:
 *  1. No magic numbers anywhere else in `src/lib/cascade` or `src/lib/verify`.
 *  2. Anything BENCH refits (thresholds, calibration) is exported by name so the
 *     harness can vary it without editing logic. See `confidence.ts` for the
 *     calibration tables themselves.
 */

// ---------------------------------------------------------------------------
// Latency budget (docs/MASTER_PLAN.md §3: total 3-8s, hard ceiling 10s)
// ---------------------------------------------------------------------------

/** Hard wall-clock ceiling for one search. Stages skip rather than overrun. */
export const CASCADE_BUDGET_MS = 10_000;

/**
 * Per-stage preferred timeouts. These deliberately sum to more than the budget:
 * the gated stages are mutually exclusive in practice (~25% of traffic runs the
 * VLM), and `Budget.timeoutFor()` clamps each call to what is actually left.
 */
export const TIMEOUTS_MS = {
  /** Fetching the image bytes / signed URL from storage. */
  imageFetch: 2_000,
  /** Modal `/embed`, warm L4. Measured ~120ms; 2.5s covers a cold-ish path. */
  embed: 2_500,
  /** Gemini 3 Flash structured extraction. Measured 2-4s in the plan. */
  vlm: 6_000,
  /** pgvector HNSW ANN inside a pruned bbox. Measured ~170ms. */
  vectorSearch: 1_500,
  /** MegaLoc re-rank, off by default. 2.8s is the whole reason it is off. */
  rerank: 4_000,
  /** Self-hosted Nominatim. Local network, so this is generous. */
  geocode: 1_200,
  /** Statistical AI-generation detector (Hive-class). */
  detector: 4_000,
  /** C2PA manifest read — local, deterministic. */
  c2pa: 1_500,
} as const;

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/**
 * GEO/STREET resolution floors.
 *
 * Retrieval is the thing resolution has to serve: EigenPlaces ingests a 512px
 * crop, so below ~320px on the long edge there is no descriptor worth matching
 * and we refuse rather than rank noise. Between the floor and
 * `degradedLongEdgePx` we proceed with the band capped at 'weak' via
 * `bandCeiling()`.
 *
 * MATCH's face floors (~21px inter-eye recognition floor, 40px recommended,
 * ISO/IEC 39794-5's 90px for enrollment) are v2 and live with that module.
 */
export const QUALITY = {
  refuseLongEdgePx: 320,
  degradedLongEdgePx: 640,
  /**
   * JPEG quality factor estimated from the quantization tables. Below this the
   * frame has been through enough recompression that high-frequency facade
   * detail — the thing retrieval actually keys on — is gone.
   */
  degradedJpegQuality: 45,
  /** Under this, treat as a thumbnail regardless of pixel dimensions. */
  refuseBytes: 2_048,
} as const;

// ---------------------------------------------------------------------------
// The escalation gate — the cost lever of the whole product
// ---------------------------------------------------------------------------

/**
 * The VLM is confidence-gated, targeting ~25% of traffic (docs/MASTER_PLAN.md
 * §3). At $2.25/1k calls, 100% escalation is 3x the entire per-search marginal
 * cost; 25% keeps GEO at the ~$0.60-0.70/1k the plan budgets for.
 *
 * `maxPriorScore` is the operating point: escalate when the *calibrated*
 * GeoCLIP prior score is at or below it. 0.55 is the ~25th percentile of
 * calibrated prior scores on the initial calibration set, which is what makes
 * "25% of traffic" true. It is a named constant precisely so BENCH can refit it
 * when the measured distribution moves — do not inline it.
 *
 * `multimodalSpreadKm` catches the other failure mode: a *confident* prior whose
 * top-k gallery hits are scattered across continents. GeoCLIP's score says
 * "some gallery cell matched well", not "the region is unimodal", so spread is
 * an independent reason to escalate.
 */
export const ESCALATION = {
  maxPriorScore: 0.55,
  multimodalSpreadKm: 400,
  /** Above this score, spread alone will not trigger escalation. */
  spreadOverrideScoreCeiling: 0.75,
  /** Never escalate if we cannot also afford retrieval afterwards. */
  minRemainingMs: TIMEOUTS_MS.vlm + TIMEOUTS_MS.vectorSearch,
} as const;

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export const RETRIEVAL = {
  /** ANN candidates pulled from pgvector inside the pruned bbox. */
  annLimit: 50,
  /** Hits within this distance collapse into one candidate region. */
  clusterRadiusM: 180,
  /** Max candidate regions returned to the analyst. */
  maxCandidates: 5,
  /**
   * Cosine similarity a top hit must reach before a candidate may claim street
   * precision. Street precision is *earned* by the match, and a weak match is
   * not earned — see `assertStreetPrecisionIsEarned`.
   */
  streetPrecisionMinSimilarity: 0.62,
  /** Radius floor for a street-precision candidate. A pin is a claim we don't make. */
  streetRadiusM: 120,
  cityRadiusM: 8_000,
  regionRadiusM: 60_000,
  /** Margin added around the prior before pruning, so an edge match isn't lost. */
  bboxPaddingKm: 12,
} as const;

/**
 * MegaLoc re-rank of the top 50.
 *
 * OFF by default and it should stay off until measurement justifies it: MegaLoc
 * costs **2.8s per image** (21x EigenPlaces' 0.13s) out of a 10s budget, cannot
 * be HNSW-indexed in pgvector at all (8448 dims vs. the 2000-dim limit), and is
 * 16.5x the storage. It is a re-ranker, never the retriever.
 */
export const RERANK_ENABLED = process.env.LANTAGE_RERANK === '1';

// ---------------------------------------------------------------------------
// Verifiers
// ---------------------------------------------------------------------------

export const VERIFIERS = {
  /** A geocode hit this close to a candidate corroborates it. */
  ocrAgreementRadiusM: 400,
  /** Multiplicative boost applied for an agreeing geocode. Capped: OCR is strong, not decisive. */
  ocrBoost: 1.35,
  /** Solar band half-width in degrees of solar elevation. ShadowFinder-style tolerance. */
  solarToleranceDeg: 4,
  /** Grid step for the solar feasibility sweep, degrees. */
  solarGridStepDeg: 2,
  /** Penalty when the solar band excludes a candidate. Soft: never eliminate. */
  solarConflictPenalty: 0.7,
  /** Penalty when the ecoregion mask disagrees with a biome clue. Soft mask. */
  ecoregionConflictPenalty: 0.85,
} as const;

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * Costs are computed from measured milliseconds where the resource is billed by
 * time, so `StageTrace.costUsd` is real and not a guess. Fixed monthly
 * infrastructure (Supabase, Nominatim VPS, R2) is deliberately $0 per search —
 * it is not marginal, and pretending otherwise makes the per-search number
 * unauditable.
 */
export const COSTS = {
  /** Modal L4 at $0.80/hr, per-second billing, one warm container. */
  modalL4UsdPerSecond: 0.8 / 3600,
  /** Gemini 3 Flash class structured extraction: ~$2.25 per 1,000 calls. */
  vlmUsdPerCall: 0.00225,
  /** Hive-class AI-generation detector. */
  detectorUsdPerImage: 0.003,
  /** Self-hosted Nominatim: unlimited queries on a $35/mo VPS. */
  geocodeUsdPerCall: 0,
  /** pgvector query on the app database. Fixed cost, not marginal. */
  vectorSearchUsdPerCall: 0,
} as const;

export function modalCostUsd(ms: number): number {
  return (ms / 1000) * COSTS.modalL4UsdPerSecond;
}

// ---------------------------------------------------------------------------
// Versions — Daubert bookkeeping, not decoration
// ---------------------------------------------------------------------------

/**
 * Fallbacks only. When a service reports its own version (Modal `/embed`
 * returns one per model), the reported value wins and this is never used. A
 * result whose provenance says `geoclip@unknown` is a result we cannot
 * reproduce, so the fallbacks are explicit rather than absent.
 */
export const MODEL_VERSIONS = {
  embedding: 'geoclip@1.0',
  vpr: 'eigenplaces-512@1.2',
  rerank: 'megaloc-8448@1.0',
  vlm: process.env.LANTAGE_VLM_MODEL ?? 'gemini-3-flash',
  detector: 'hive-ai-generated@2026-05',
  geocoder: 'nominatim-selfhosted@us-extract',
} as const;

/** Published error-rate page this build's numbers map to (BENCH, §10). */
export const BENCHMARK_REF = 'bench/gws15k+im2gps3k@2026-08';

/** Set by the ingest job; surfaced in `ResultProvenance.indexBuild`. */
export const INDEX_BUILD = process.env.LANTAGE_INDEX_BUILD ?? 'mapillary-pittsburgh@unbuilt';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const ENDPOINTS = {
  /** B1's Modal inference service. */
  embed: process.env.MODAL_EMBED_URL,
  /** Self-hosted Nominatim. The public instance is blocked in code — see ocrGeocode.ts. */
  nominatim: process.env.NOMINATIM_URL,
  vlm: process.env.LANTAGE_VLM_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
  detector: process.env.HIVE_API_URL,
} as const;
