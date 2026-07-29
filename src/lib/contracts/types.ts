/**
 * Lantage core domain contracts.
 *
 * Every module codes against this file. Do not redefine these types locally.
 *
 * Design rule encoded here: a result cannot exist without the evidence that
 * produced it. `Candidate.evidence` is a non-empty tuple by construction, and
 * every `Evidence` carries a `verifiable` field describing how a human can
 * independently check it. If you find yourself wanting to return a bare
 * coordinate and a confidence number, that is the thing this product does not do.
 */

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Confidence is always a band, never a bare percentage.
 *
 * Rationale (docs/MASTER_PLAN.md §0, §5): raw model scores are not
 * probabilities, and published street-level accuracy on unbiased benchmarks is
 * ~0.7%. A point percentage implies precision we cannot support. Bands are
 * calibrated against a held-out set and each band publishes its own measured
 * false-positive rate via `BENCH`.
 */
export type ConfidenceBand =
  | 'high'      // signal green   — calibrated, corroborated by >1 independent signal
  | 'moderate'  // signal green   — single strong signal
  | 'weak'      // caution orange — present but not actionable alone
  | 'refused';  // alert red      — input failed the quality gate; no ranking returned

export interface Confidence {
  band: ConfidenceBand;
  /**
   * Raw calibrated score, 0..1. For internal ranking, logging, and benchmark
   * evaluation only. MUST NOT be rendered as a standalone number in the UI
   * without its band and its reason.
   */
  score: number;
  /**
   * One line of plain English explaining the band, shown next to it.
   * e.g. "4 of 5 retrieval results fall within this region."
   * Required — a band with no stated reason is not shippable.
   */
  reason: string;
  /** Calibration set + model version this score was calibrated against. */
  calibration: string;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'exif'            // metadata found in the file (never trusted, always recorded)
  | 'signage-ocr'     // text read from the frame, then geocoded
  | 'vpr-match'       // retrieval hit against an indexed Mapillary panorama
  | 'embedding-prior' // coarse region from GeoCLIP / OSV-5M
  | 'vlm-clue'        // a structured observation from the vision model
  | 'solar'           // ShadowFinder constraint band
  | 'ecoregion'       // biome / Köppen mask
  | 'c2pa'            // Content Credentials manifest
  | 'quantization'    // JPEG quantization-table fingerprint
  | 'detector'        // statistical AI-generation detector
  | 'localization'    // splice / copy-move map
  | 'corpus-match';   // near-duplicate hit in the customer's own corpus

export interface Evidence {
  kind: EvidenceKind;
  /** What this signal asserts, in plain English. */
  claim: string;
  /**
   * How a human independently verifies this claim without trusting us.
   * e.g. "Open the linked Street View pano and compare the roofline."
   * Required. If a signal cannot be independently checked, it does not belong
   * in the ledger as evidence — log it as telemetry instead.
   */
  verifiable: string;
  /** Optional crop of the source frame that produced this signal. */
  cropUrl?: string;
  /** Optional external reference: Mapillary image id, GSV pano id, geocode result. */
  reference?: { label: string; url?: string; panoId?: string; mapillaryId?: string };
  /** This signal's own weight, 0..1. Not the overall confidence. */
  weight: number;
}

/** At least one piece of evidence. Enforced by the type, not by review. */
export type EvidenceChain = [Evidence, ...Evidence[]];

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * A geolocation hypothesis. Deliberately a REGION with a radius, not a pin.
 * `precision: 'street'` is only permitted when a retrieval match or an OCR
 * geocode is present in the evidence chain — see assertStreetPrecisionIsEarned().
 */
export interface GeoCandidate {
  id: string;
  rank: number;
  center: LatLon;
  /** Radius in metres. Never zero. A point estimate is a claim we don't make. */
  radiusM: number;
  precision: 'continent' | 'country' | 'region' | 'city' | 'street';
  place: { label: string; admin1?: string; country?: string };
  confidence: Confidence;
  evidence: EvidenceChain;
  /** Analyst disposition. Starts unreviewed; drives the corroboration workflow. */
  review: ReviewState;
}

export type ReviewState = 'unreviewed' | 'confirmed' | 'nearby' | 'incorrect';

// ---------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------

/**
 * Always returned as a ranked set. Fine-grained make/model/year has high
 * intra-class and low inter-class variance; top-1 is unreliable and the
 * literature is consistent on this. UI renders top-5 minimum.
 */
export interface VehicleCandidate {
  rank: number;
  make: string;
  model: string;
  /** Generation or year range — not a single year unless the gallery supports it. */
  generation: string;
  color?: string;
  /** NHTSA vPIC identifiers, so the taxonomy is auditable. */
  vpic?: { makeId?: number; modelId?: number };
  similarity: number;
  referenceImageUrl?: string;
  review: ReviewState;
}

// ---------------------------------------------------------------------------
// Verify (authenticity)
// ---------------------------------------------------------------------------

/**
 * Note the asymmetry, and preserve it: we can find indicators of generation,
 * but we never assert authenticity. There is no 'authentic' variant here on
 * purpose — absence of indicators is not proof of anything, and platforms strip
 * C2PA manifests on upload ~100% of the time.
 */
export type AuthenticityVerdict =
  | 'strong-indicators'    // multiple independent signals agree
  | 'moderate-indicators'
  | 'weak-indicators'
  | 'no-indicators-found'  // NOT "authentic"
  | 'inconclusive';        // known false-positive class detected; verdict suppressed

/** Conditions that trigger verdict suppression — documented FP classes. */
export type SuppressionReason =
  | 'computational-photography' // HDR / night mode / AI denoise
  | 'ai-upscaled'
  | 'heavy-retouching'
  | 'screenshot'
  | 'recompressed'
  | 'resolution-too-low';

export interface AuthenticityResult {
  verdict: AuthenticityVerdict;
  confidence: Confidence;
  evidence: EvidenceChain;
  /** Present iff verdict === 'inconclusive'. */
  suppressedBy?: SuppressionReason[];
  /**
   * Positive predictive value at the operating threshold given a stated base
   * rate. Surfaced in the UI because at 5-15% FPR and low prevalence, most
   * positive flags are false positives — and the user must see that math.
   */
  ppv: { value: number; assumedBaseRate: number };
  /** C2PA manifest, if any. Deterministic, checked first. */
  provenance: { hasManifest: boolean; issuer?: string; valid?: boolean; generator?: string };
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/**
 * Runs before any matching. A tool that refuses unmatchable input is the tool
 * you can trust when it does return something.
 *
 * Face thresholds (v2/MATCH): recognition floor is ~21px inter-eye, 40px
 * recommended, ISO/IEC 39794-5 wants 90px for enrollment. Below ~24-32px we
 * refuse to rank. Super-resolution does not help — it preserves visual detail
 * without recovering biometric information.
 */
export interface QualityGate {
  passed: boolean;
  /** OFIQ (ISO/IEC 29794-5) unified score where applicable, 0..100. */
  unifiedScore?: number;
  components: {
    resolutionPx: { w: number; h: number };
    blur?: number;
    exposure?: number;
    occlusion?: number;
    interEyeDistancePx?: number; // MATCH only
  };
  /** Why it was refused, in words the analyst can act on. */
  refusalReason?: string;
  /** Degraded means: proceed, but band ceiling is 'weak'. */
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Search + ledger
// ---------------------------------------------------------------------------

export type ModuleId = 'GEO' | 'STREET' | 'VEHICLE' | 'VERIFY' | 'CLAIM' | 'MATCH';

export interface SearchRequest {
  module: ModuleId;
  imageId: string;
  caseId?: string;
  /** Optional analyst-supplied priors. Narrowing the search is legitimate; seeding the answer is not. */
  hints?: {
    /** Constrain to a bbox — e.g. the claimed loss address's county. */
    bbox?: [number, number, number, number];
    /** Known or claimed capture time, ISO 8601. Enables the solar verifier. */
    capturedAt?: string;
    /** For CLAIM: the corpus to self-match against. */
    corpusId?: string;
  };
}

export interface SearchResult {
  id: string;
  module: ModuleId;
  imageId: string;
  quality: QualityGate;
  geo?: GeoCandidate[];
  vehicles?: VehicleCandidate[];
  authenticity?: AuthenticityResult;
  corpusMatches?: CorpusMatch[];
  /** Which cascade stages actually ran, with timings. Drives the ledger + BENCH. */
  stages: StageTrace[];
  /** Model + index versions. Every result must be reproducible and discoverable. */
  provenance: ResultProvenance;
  createdAt: string;
}

export interface StageTrace {
  stage:
    | 'preprocess'
    | 'quality-gate'
    | 'embedding-prior'
    | 'vlm-clues'
    | 'vpr-retrieval'
    | 'rerank'
    | 'verify-ocr'
    | 'verify-solar'
    | 'verify-ecoregion'
    | 'provenance'
    | 'detector'
    | 'corpus-match';
  ranMs: number;
  skipped?: { reason: string };
  costUsd?: number;
}

/** Versioning is a Daubert requirement, not bookkeeping. */
export interface ResultProvenance {
  models: Record<string, string>; // e.g. { embedding: 'geoclip@1.0', vpr: 'eigenplaces-512@1.2' }
  indexBuild?: string;            // e.g. 'mapillary-pittsburgh@2026-08-02'
  benchmarkRef?: string;          // published error-rate page this version maps to
  totalCostUsd: number;
}

export interface CorpusMatch {
  rank: number;
  /** Customer-owned record this matched. We store the pointer, not their pixels. */
  recordId: string;
  corpusId: string;
  similarity: number;
  /** Near-duplicate vs. same-scene-different-angle — a materially different finding. */
  relation: 'near-duplicate' | 'same-scene' | 'similar';
  thumbnailUrl?: string;
  review: ReviewState;
}

// ---------------------------------------------------------------------------
// Case file
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  id: string;
  caseId: string;
  searchId: string;
  /** Immutable once written. Corrections are new entries, never edits. */
  writtenAt: string;
  writtenBy: string;
  summary: string;
  /** Corroboration is a required step before a finding can be marked confirmed. */
  corroboration?: {
    method: string;
    note: string;
    by: string;
    at: string;
  };
}

export interface CaseFile {
  id: string;
  orgId: string;
  title: string;
  reference?: string;
  status: 'open' | 'closed';
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Invariants — import and call these; do not reimplement
// ---------------------------------------------------------------------------

/**
 * Street-level precision must be EARNED by a retrieval match or an OCR geocode.
 * Inference alone cannot support it: best published 1km accuracy on the only
 * area-weighted benchmark (GWS15k) is 0.7%.
 */
export function assertStreetPrecisionIsEarned(c: GeoCandidate): void {
  if (c.precision !== 'street') return;
  const earned = c.evidence.some((e) => e.kind === 'vpr-match' || e.kind === 'signage-ocr');
  if (!earned) {
    throw new Error(
      `GeoCandidate ${c.id} claims street precision without a vpr-match or signage-ocr ` +
        `in its evidence chain. Street precision comes from retrieval or OCR, not inference.`,
    );
  }
}

/** A refused quality gate must not produce a ranked result. */
export function assertRefusalIsHonoured(r: SearchResult): void {
  if (r.quality.passed) return;
  const ranked = (r.geo?.length ?? 0) + (r.vehicles?.length ?? 0) + (r.corpusMatches?.length ?? 0);
  if (ranked > 0) {
    throw new Error(
      `SearchResult ${r.id} failed the quality gate but returned ${ranked} ranked ` +
        `candidates. Show the refusal, not a ranking.`,
    );
  }
}

/** Degraded input caps the band at 'weak'. */
export function bandCeiling(q: QualityGate, band: ConfidenceBand): ConfidenceBand {
  if (!q.passed) return 'refused';
  if (q.degraded && (band === 'high' || band === 'moderate')) return 'weak';
  return band;
}

/** Permanent UI furniture on every result surface. Not dismissible. */
export const LEAD_DISCLAIMER = 'INVESTIGATIVE LEAD · VERIFY INDEPENDENTLY' as const;
