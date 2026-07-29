/**
 * Calibration: raw model scores -> `Confidence` (band + score + reason).
 *
 * Why this file exists at all. A cosine similarity of 0.71 is not a 71%
 * probability of anything. Retrieval scores are ranking artifacts, GeoCLIP's
 * gallery score is a softmax over a fixed cell set, and a VLM's self-reported
 * confidence is the least reliable number in the pipeline (the ACL 2026 GeoRC
 * study found frontier models fabricate the supporting evidence for the places
 * they name). Shipping any of those numbers as a percentage would be the exact
 * unverifiable claim this product exists to not make.
 *
 * So: every raw score goes through a named calibration set. Each set is
 * (a) a temperature, (b) a monotone piecewise-linear reliability curve fitted
 * isotonic-regression-style on a held-out set, and (c) the measured FPR/TPR per
 * band that BENCH publishes and VERIFY's PPV arithmetic consumes.
 *
 * BENCH refits `CALIBRATION_SETS` and nothing else. Keep it that way: the
 * mapping lives in data, not in branches scattered through the stages.
 */

import type { Confidence, ConfidenceBand } from '@/lib/contracts/types';

// ---------------------------------------------------------------------------
// Calibration data — the only thing BENCH refits
// ---------------------------------------------------------------------------

export interface CalibrationSet {
  /**
   * Stable identifier written into `Confidence.calibration`. Format:
   * <set>/<model>@<fit-date>. A result whose calibration id is unknown is a
   * result nobody can reproduce, so this string is mandatory, not decorative.
   */
  readonly id: string;
  /**
   * Temperature for the raw score, T > 0. T > 1 softens overconfident scores.
   * Applied in logit space, which is where scaling is monotone and well-behaved.
   */
  readonly temperature: number;
  /**
   * Reliability curve as (rawAfterTemperature -> empiricalAccuracy) knots,
   * strictly increasing in x and non-decreasing in y. Piecewise-linear
   * interpolation between knots; clamped outside. This is the isotonic fit,
   * stored as its knots so it is inspectable in review and in discovery.
   */
  readonly curve: ReadonlyArray<readonly [x: number, y: number]>;
  /**
   * Score thresholds for band assignment, applied AFTER calibration.
   * `high` additionally requires >1 independent signal — see `bandFor`.
   */
  readonly bands: { readonly high: number; readonly moderate: number; readonly weak: number };
  /**
   * Measured error rates per band on the fit set. Published by BENCH (§10) and
   * used by VERIFY to compute PPV at a stated base rate.
   */
  readonly measured: Readonly<
    Record<'high' | 'moderate' | 'weak', { readonly tpr: number; readonly fpr: number }>
  >;
  /** What the numbers were fitted on. Written into the result for discovery. */
  readonly fittedOn: string;
}

/**
 * Initial constants. These are **provisional priors, not measurements** — they
 * encode the published literature until BENCH's first fit replaces them, and
 * they are deliberately pessimistic in the direction that matters:
 *
 * - GWS15k, the only area-weighted geolocation benchmark, puts best published
 *   street-level (1km) accuracy at 0.7%. The retrieval curve therefore tops out
 *   at 0.86 rather than approaching 1.0, and a lone strong match cannot reach
 *   the 'high' band on its own.
 * - Frontier VLMs reach ~90% country / ~40% city on street-view imagery, so the
 *   VLM curve is capped hard at the region level and its raw self-report is
 *   squashed with T=1.8.
 * - Best commercial AI-image detection on in-the-wild media (Deepfake-Eval-2024)
 *   is 82%, with consumer detectors running 5-15% FPR on real photographs. The
 *   detector set's measured FPRs reflect that, which is what makes its PPV
 *   arithmetic honest.
 */
export const CALIBRATION_SETS = {
  /** GeoCLIP GPS-gallery prior -> coarse region. */
  embeddingPrior: {
    id: 'lantage-cal-2026-08/geoclip-prior@provisional',
    temperature: 1.4,
    curve: [
      [0.0, 0.02],
      [0.2, 0.12],
      [0.4, 0.3],
      [0.6, 0.52],
      [0.8, 0.68],
      [1.0, 0.78],
    ],
    bands: { high: 0.8, moderate: 0.55, weak: 0.15 },
    measured: {
      high: { tpr: 0.71, fpr: 0.09 },
      moderate: { tpr: 0.55, fpr: 0.18 },
      weak: { tpr: 0.3, fpr: 0.34 },
    },
    fittedOn: 'im2gps3k + gws15k held-out (provisional literature prior)',
  },
  /** EigenPlaces-512 retrieval against the Mapillary submap. */
  vprRetrieval: {
    id: 'lantage-cal-2026-08/eigenplaces512-mapillary@provisional',
    temperature: 1.15,
    curve: [
      [0.0, 0.01],
      [0.45, 0.18],
      [0.6, 0.42],
      [0.7, 0.63],
      [0.8, 0.77],
      [1.0, 0.86],
    ],
    bands: { high: 0.78, moderate: 0.5, weak: 0.12 },
    measured: {
      high: { tpr: 0.74, fpr: 0.07 },
      moderate: { tpr: 0.52, fpr: 0.16 },
      weak: { tpr: 0.28, fpr: 0.31 },
    },
    fittedOn: 'pittsburgh holdout panoramas (provisional literature prior)',
  },
  /** VLM structured-clue region shortlist. Prunes; never answers. */
  vlmClues: {
    id: 'lantage-cal-2026-08/gemini3flash-clues@provisional',
    temperature: 1.8,
    curve: [
      [0.0, 0.03],
      [0.3, 0.14],
      [0.5, 0.28],
      [0.7, 0.4],
      [0.9, 0.5],
      [1.0, 0.55],
    ],
    bands: { high: 0.9, moderate: 0.45, weak: 0.1 },
    measured: {
      high: { tpr: 0.42, fpr: 0.21 },
      moderate: { tpr: 0.36, fpr: 0.29 },
      weak: { tpr: 0.2, fpr: 0.4 },
    },
    fittedOn: 'georc-style expert-audited clue set (provisional literature prior)',
  },
  /** Signage OCR -> geocode agreement. The highest-precision signal we have. */
  ocrGeocode: {
    id: 'lantage-cal-2026-08/ocr-geocode@provisional',
    temperature: 1.0,
    curve: [
      [0.0, 0.05],
      [0.4, 0.4],
      [0.6, 0.66],
      [0.8, 0.84],
      [1.0, 0.92],
    ],
    bands: { high: 0.7, moderate: 0.45, weak: 0.1 },
    measured: {
      high: { tpr: 0.83, fpr: 0.04 },
      moderate: { tpr: 0.6, fpr: 0.11 },
      weak: { tpr: 0.3, fpr: 0.25 },
    },
    fittedOn: 'legible-signage subset, manual geocode adjudication (provisional)',
  },
  /** Statistical AI-generation detector. Bands only — never a fused percentage. */
  aiDetector: {
    id: 'lantage-cal-2026-08/hive-class-detector@provisional',
    temperature: 2.2,
    curve: [
      [0.0, 0.02],
      [0.5, 0.2],
      [0.7, 0.38],
      [0.85, 0.55],
      [0.95, 0.68],
      [1.0, 0.74],
    ],
    bands: { high: 0.62, moderate: 0.4, weak: 0.12 },
    measured: {
      // Deepfake-Eval-2024 territory: 82% best-commercial accuracy in the wild,
      // and a 2026 NewsGuard audit found the worst detector flagged 40% of real
      // photos. These FPRs are why the UI must show PPV.
      high: { tpr: 0.72, fpr: 0.05 },
      moderate: { tpr: 0.55, fpr: 0.11 },
      weak: { tpr: 0.35, fpr: 0.22 },
    },
    fittedOn: 'deepfake-eval-2024 + chameleon (provisional literature prior)',
  },
} as const satisfies Record<string, CalibrationSet>;

export type CalibrationSetName = keyof typeof CALIBRATION_SETS;

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/** Temperature scaling in logit space. Monotone, so ranking is preserved. */
export function temperatureScale(raw: number, temperature: number): number {
  const p = clamp01(raw);
  const eps = 1e-6;
  const bounded = Math.min(1 - eps, Math.max(eps, p));
  const logit = Math.log(bounded / (1 - bounded));
  return 1 / (1 + Math.exp(-logit / Math.max(eps, temperature)));
}

/** Piecewise-linear interpolation over the fitted reliability knots. */
export function isotonicMap(curve: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (curve.length === 0) return clamp01(x);
  if (x <= curve[0][0]) return clamp01(curve[0][1]);
  const last = curve[curve.length - 1];
  if (x >= last[0]) return clamp01(last[1]);
  for (let i = 1; i < curve.length; i += 1) {
    const [x0, y0] = curve[i - 1];
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return clamp01(y0 + t * (y1 - y0));
    }
  }
  return clamp01(last[1]);
}

/**
 * Band assignment.
 *
 * `independentSignals` is the number of *distinct* evidence kinds supporting the
 * hypothesis. The contract defines 'high' as "calibrated, corroborated by >1
 * independent signal", so a single signal is capped at 'moderate' no matter how
 * high it scores. This is the one rule that stops a confident retrieval match
 * from reading like a confirmed address.
 */
export function bandFor(
  set: CalibrationSet,
  calibratedScore: number,
  independentSignals: number,
): ConfidenceBand {
  if (calibratedScore >= set.bands.high && independentSignals > 1) return 'high';
  if (calibratedScore >= set.bands.moderate) return 'moderate';
  return 'weak';
}

// ---------------------------------------------------------------------------
// Reason generation — a band with no stated reason is not shippable
// ---------------------------------------------------------------------------

/**
 * The facts a reason sentence is generated from. Deliberately a closed union:
 * free-text reasons drift into marketing copy, and every sentence here has to be
 * something the analyst can go and check.
 */
export type ReasonFacts =
  | { kind: 'retrieval-agreement'; within: number; of: number; radiusM: number; place?: string }
  | { kind: 'embedding-prior'; topScorePct: number; spreadKm: number; label?: string }
  | { kind: 'ocr-agreement'; text: string; distanceM: number }
  | { kind: 'vlm-clues'; clueCount: number; categories: number; label?: string }
  | { kind: 'solar-consistent'; elevationDeg: number; toleranceDeg: number }
  | { kind: 'solar-conflict'; elevationDeg: number }
  | { kind: 'detector'; suppressed: boolean }
  | { kind: 'provenance-manifest'; issuer?: string; generator?: string }
  | { kind: 'no-indicators' }
  | { kind: 'insufficient-signal'; detail: string };

export function reasonFor(facts: ReasonFacts, corroborations: number): string {
  const base = ((): string => {
    switch (facts.kind) {
      case 'retrieval-agreement':
        return `${facts.within} of ${facts.of} retrieval matches fall within ${Math.round(facts.radiusM)} m of this location${facts.place ? ` in ${facts.place}` : ''}.`;
      case 'embedding-prior':
        return `Coarse image-embedding prior favours ${facts.label ?? 'this region'}; its top gallery cells are spread over ${Math.round(facts.spreadKm)} km.`;
      case 'ocr-agreement':
        return `Text read in the frame ("${facts.text}") geocodes to a place ${Math.round(facts.distanceM)} m from this location.`;
      case 'vlm-clues':
        return `${facts.clueCount} visual clues across ${facts.categories} independent categories are consistent with ${facts.label ?? 'this region'}.`;
      case 'solar-consistent':
        return `Shadow geometry implies a solar elevation of ${facts.elevationDeg.toFixed(0)}°, consistent with this latitude at the stated capture time (±${facts.toleranceDeg}°).`;
      case 'solar-conflict':
        return `Shadow geometry implies a solar elevation of ${facts.elevationDeg.toFixed(0)}°, which this latitude cannot produce at the stated capture time.`;
      case 'detector':
        return facts.suppressed
          ? 'A known false-positive class was detected, so the statistical detector output is not reportable for this image.'
          : 'Statistical detector output, reported as a calibrated band rather than a score.';
      case 'provenance-manifest':
        return `A cryptographically valid Content Credentials manifest is present${facts.issuer ? `, issued by ${facts.issuer}` : ''}${facts.generator ? ` and naming ${facts.generator} as the generator` : ''}.`;
      case 'no-indicators':
        return 'No indicators of generation or manipulation were found. This is not a finding of authenticity.';
      case 'insufficient-signal':
        return facts.detail;
    }
  })();

  if (corroborations > 1) {
    return `${base} Corroborated by ${corroborations} independent signal types.`;
  }
  return `${base} Single signal type — not corroborated.`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface CalibrateArgs {
  set: CalibrationSetName;
  /** Raw model score, 0..1. Anything outside is clamped, not trusted. */
  raw: number;
  /** Count of distinct evidence kinds supporting this hypothesis. */
  independentSignals: number;
  facts: ReasonFacts;
}

/**
 * The only sanctioned way to construct a `Confidence`. Do not hand-build one:
 * every field here (band, calibrated score, generated reason, calibration id) is
 * required by the contract and three of the four are easy to get wrong by hand.
 */
export function calibrate(args: CalibrateArgs): Confidence {
  const set: CalibrationSet = CALIBRATION_SETS[args.set];
  const scaled = temperatureScale(args.raw, set.temperature);
  const score = isotonicMap(set.curve, scaled);
  const band = bandFor(set, score, args.independentSignals);
  return {
    band,
    score,
    reason: reasonFor(args.facts, args.independentSignals),
    calibration: set.id,
  };
}

/** A refusal carries a band, a zero score, and the analyst-facing reason. */
export function refusedConfidence(reason: string, set: CalibrationSetName = 'vprRetrieval'): Confidence {
  return { band: 'refused', score: 0, reason, calibration: CALIBRATION_SETS[set].id };
}

/**
 * Measured error rates for the band a score landed in. VERIFY's PPV arithmetic
 * needs the operating point, not the score.
 */
export function measuredRatesFor(
  setName: CalibrationSetName,
  band: ConfidenceBand,
): { tpr: number; fpr: number } {
  const set: CalibrationSet = CALIBRATION_SETS[setName];
  if (band === 'high' || band === 'moderate' || band === 'weak') return set.measured[band];
  return { tpr: 0, fpr: 0 };
}

/**
 * Positive predictive value at a stated base rate.
 *
 * This is the arithmetic the category hides. At a 5% caseload prevalence and an
 * 11% FPR, a 'moderate' flag is right about a quarter of the time — so the
 * number belongs on screen next to the verdict, not in a footnote.
 */
export function positivePredictiveValue(
  rates: { tpr: number; fpr: number },
  baseRate: number,
): number {
  const prev = clamp01(baseRate);
  const denom = rates.tpr * prev + rates.fpr * (1 - prev);
  if (denom <= 0) return 0;
  return (rates.tpr * prev) / denom;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
