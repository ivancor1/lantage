/**
 * The working candidate: what the stages mutate, and how it becomes a contract
 * `GeoCandidate`.
 *
 * Assembly is centralised here because four contract rules have to hold on every
 * candidate that leaves this system, and they are too easy to forget in a stage:
 *
 *  - a non-empty evidence chain (a candidate with no citations cannot exist);
 *  - 'high' only with more than one independent signal type;
 *  - `bandCeiling()` applied whenever the input was degraded;
 *  - street precision earned by a vpr-match or a signage-ocr, asserted.
 */

import {
  type ConfidenceBand,
  type Evidence,
  type EvidenceChain,
  type EvidenceKind,
  type GeoCandidate,
  type LatLon,
  type QualityGate,
  assertStreetPrecisionIsEarned,
  bandCeiling,
} from '@/lib/contracts/types';
import { RETRIEVAL } from './config';
import { type CalibrationSetName, type ReasonFacts, calibrate } from './confidence';

export interface WorkingCandidate {
  id: string;
  center: LatLon;
  radiusM: number;
  /** What the candidate *wants* to claim. Downgraded at assembly if unearned. */
  precision: GeoCandidate['precision'];
  place: { label: string; admin1?: string; country?: string };
  /** Uncalibrated 0..1 score. Verifiers multiply into it; nothing else. */
  rawScore: number;
  evidence: Evidence[];
  /** Which calibration set the dominant signal came from. */
  calibrationSet: CalibrationSetName;
  /** Facts the plain-English reason is generated from. */
  facts: ReasonFacts;
}

/**
 * Evidence kinds that appear in the ledger but do not count as corroboration.
 *
 *  - `exif`: metadata is recorded, never trusted. Letting it count toward the
 *    "more than one independent signal" test would mean a falsified EXIF tag could
 *    promote a confidence band, which is the exact failure this product exists to
 *    avoid.
 *  - `embedding-prior` and `vlm-clue`: these are **circular by construction**.
 *    Retrieval only searched inside the region those two signals chose, so a match
 *    agreeing with them is not new information — it is the consequence of the
 *    prune. They are shown because the analyst needs to see how the search space
 *    was narrowed, not because they confirm anything.
 *
 * What is left as corroboration is genuinely independent: a retrieval match, an
 * OCR geocode against a gazetteer, a solar constraint from physics, an ecoregion
 * raster, a corpus hit. Reaching 'high' therefore takes two of *those*.
 */
const NON_CORROBORATING: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'exif',
  'embedding-prior',
  'vlm-clue',
]);

export function independentSignalCount(evidence: readonly Evidence[]): number {
  const kinds = new Set<EvidenceKind>();
  for (const e of evidence) {
    if (NON_CORROBORATING.has(e.kind)) continue;
    if (e.weight <= 0) continue;
    kinds.add(e.kind);
  }
  return kinds.size;
}

export function hasEarnedStreetPrecision(evidence: readonly Evidence[]): boolean {
  return evidence.some((e) => e.kind === 'vpr-match' || e.kind === 'signage-ocr');
}

/** Multiplicative, clamped. Verifiers re-rank; they never author a candidate's score. */
export function applyMultiplier(candidate: WorkingCandidate, factor: number): void {
  candidate.rawScore = Math.max(0, Math.min(1, candidate.rawScore * factor));
}

/**
 * Working candidates -> contract candidates.
 *
 * Anything that cannot satisfy the contract is dropped rather than softened: an
 * unsupported candidate is not a weaker finding, it is not a finding.
 */
export function finaliseCandidates(
  working: WorkingCandidate[],
  gate: QualityGate,
  regionEvidence: readonly Evidence[] = [],
): GeoCandidate[] {
  const ranked = [...working].sort((a, b) => b.rawScore - a.rawScore).slice(0, RETRIEVAL.maxCandidates);

  const out: GeoCandidate[] = [];
  ranked.forEach((c, index) => {
    // Region-level evidence (the prior, the metadata record) rides on every
    // candidate so each ledger row is independently readable.
    const evidence = [...c.evidence, ...regionEvidence];
    if (evidence.length === 0) return;

    const signals = independentSignalCount(evidence);
    const confidence = calibrate({
      set: c.calibrationSet,
      raw: c.rawScore,
      independentSignals: signals,
      facts: c.facts,
    });

    const ceiling: ConfidenceBand = bandCeiling(gate, confidence.band);
    const capped = ceiling !== confidence.band;
    const precision = downgradeIfUnearned(c.precision, evidence);

    const candidate: GeoCandidate = {
      id: c.id,
      rank: index + 1,
      center: c.center,
      // A zero radius is a point estimate, which is a claim we do not make.
      radiusM: Math.max(RETRIEVAL.streetRadiusM, Math.round(c.radiusM)),
      precision,
      place: c.place,
      confidence: {
        ...confidence,
        band: ceiling,
        reason: capped
          ? `${confidence.reason} Capped at '${ceiling}': ${stripDegradedPrefix(gate.refusalReason) ?? 'the input failed a quality check'}`
          : confidence.reason,
      },
      evidence: evidence as EvidenceChain,
      review: 'unreviewed',
    };

    // Belt and braces: `downgradeIfUnearned` already prevents this, so a throw
    // here means a future code path invented a street claim. Fail loudly.
    assertStreetPrecisionIsEarned(candidate);
    out.push(candidate);
  });

  return out;
}

function downgradeIfUnearned(
  precision: GeoCandidate['precision'],
  evidence: readonly Evidence[],
): GeoCandidate['precision'] {
  if (precision !== 'street') return precision;
  return hasEarnedStreetPrecision(evidence) ? 'street' : 'city';
}

function stripDegradedPrefix(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.startsWith('Degraded: ') ? reason.slice('Degraded: '.length) : reason;
}
