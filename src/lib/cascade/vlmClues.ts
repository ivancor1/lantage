/**
 * Stage 4 — confidence-gated structured clue extraction.
 *
 * Gated, not always-on. At ~$2.25/1k calls the VLM is 3x the entire per-search
 * marginal cost of everything else combined, and on the ~75% of frames where the
 * cheap prior is already unimodal and confident it adds latency without adding
 * information. The gate is `shouldEscalate()` and its threshold lives in
 * `config.ts` under `ESCALATION` so BENCH can refit it against measured traffic.
 *
 * What comes back is a clue list, never an answer. `regionPrior` from the model
 * is used for exactly one thing: choosing the retrieval submap.
 */

import type { Evidence, StageTrace } from '@/lib/contracts/types';
import type { VlmClues } from '@/lib/contracts/schemas';
import { COSTS, ESCALATION, MODEL_VERSIONS, RETRIEVAL, TIMEOUTS_MS } from './config';
import { calibrate } from './confidence';
import { bboxFromCenterRadius, bboxIntersection, padBbox, precisionForRadius } from './geo';
import type { PreprocessOutput } from './preprocess';
import type { Geocoder } from '@/lib/verify/ocrGeocode';
import { cropUrl } from '@/lib/verify/ocrGeocode';
import type { SolarObservation } from '@/lib/verify/solar';
import {
  type Bbox,
  type RegionPrior,
  type Stage,
  type StageContext,
  type StageOutput,
  failure,
  skipped,
} from './types';
import type { VlmProvider } from './vlmProvider';

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface EscalationDecision {
  escalate: boolean;
  /** Recorded verbatim in the stage trace either way. The gate is auditable. */
  reason: string;
}

/**
 * Two independent reasons to spend the money:
 *
 *  1. The prior is *weak* — calibrated score at or below `maxPriorScore` (the
 *     ~25th percentile of the calibration set, which is what makes the ~25%
 *     traffic target true rather than aspirational).
 *  2. The prior is *multimodal* — a decent top score whose top gallery cells are
 *     spread across more than `multimodalSpreadKm`. GeoCLIP's score says "a cell
 *     matched well", not "the region is unimodal", and pruning to the centroid of
 *     three continents prunes away the answer.
 */
export function shouldEscalate(args: {
  priorScore: number | null;
  spreadKm: number | null;
  remainingMs: number;
}): EscalationDecision {
  if (args.remainingMs < ESCALATION.minRemainingMs) {
    return {
      escalate: false,
      reason: `Not enough of the ${Math.round(args.remainingMs)}ms left in the budget to run clue extraction and still retrieve.`,
    };
  }
  if (args.priorScore === null) {
    return {
      escalate: true,
      reason:
        'The cheap embedding prior produced nothing, so clue extraction is the only way to get a region to search inside.',
    };
  }
  if (args.priorScore <= ESCALATION.maxPriorScore) {
    return {
      escalate: true,
      reason: `The embedding prior scored ${args.priorScore.toFixed(2)}, at or below the ${ESCALATION.maxPriorScore} escalation threshold.`,
    };
  }
  if (
    args.spreadKm !== null &&
    args.spreadKm > ESCALATION.multimodalSpreadKm &&
    args.priorScore < ESCALATION.spreadOverrideScoreCeiling
  ) {
    return {
      escalate: true,
      reason: `The prior scored ${args.priorScore.toFixed(2)} but its top cells span ${Math.round(args.spreadKm)} km, which is multimodal — a centroid of that would prune away the answer.`,
    };
  }
  return {
    escalate: false,
    reason: `The embedding prior scored ${args.priorScore.toFixed(2)} over a ${Math.round(args.spreadKm ?? 0)} km spread, above the escalation threshold, so the vision model was not needed.`,
  };
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export interface VlmCluesInput {
  preprocessed: PreprocessOutput;
  priorScore: number | null;
  spreadKm: number | null;
}

export interface VlmCluesOutput {
  clues: VlmClues;
  modelVersion: string;
  attempts: number;
}

export function createVlmCluesStage(
  provider: VlmProvider | null,
): Stage<VlmCluesInput, VlmCluesOutput> {
  return {
    stage: 'vlm-clues',
    async run(input, ctx): Promise<StageOutput<VlmCluesOutput>> {
      const started = Date.now();

      const decision = shouldEscalate({
        priorScore: input.priorScore,
        spreadKm: input.spreadKm,
        remainingMs: ctx.budget.remainingMs(),
      });
      if (!decision.escalate) {
        return skipped('vlm-clues', Date.now() - started, failure('gated-off', decision.reason));
      }
      if (!provider) {
        return skipped(
          'vlm-clues',
          Date.now() - started,
          failure(
            'not-configured',
            'Clue extraction was warranted but no vision provider is configured, so the cascade continued on the coarse prior alone.',
          ),
        );
      }

      const res = await provider.extractClues({
        image: input.preprocessed.image,
        timeoutMs: ctx.budget.timeoutFor(TIMEOUTS_MS.vlm),
        signal: ctx.signal,
      });
      const ranMs = Date.now() - started;

      if (!res.ok) {
        // A dead or off-contract VLM degrades the cascade; it never fails the search.
        return skipped('vlm-clues', ranMs, res.error);
      }

      const { clues } = res.value;
      const trace: StageTrace = {
        stage: 'vlm-clues',
        ranMs,
        costUsd: COSTS.vlmUsdPerCall * res.value.attempts,
      };

      if (clues.insufficientSignal) {
        // A model saying "I can't tell" is a result, and a more useful one than a
        // guess. Keep the clue evidence, record the honest note.
        return {
          evidence: clueEvidence(clues, ctx),
          trace: {
            ...trace,
            skipped: {
              reason:
                'The vision model reported insufficient signal in the frame to constrain a region. Its individual observations are still in the ledger.',
            },
          },
          output: {
            clues,
            modelVersion: res.value.modelVersion,
            attempts: res.value.attempts,
          },
        };
      }

      return {
        evidence: clueEvidence(clues, ctx),
        trace,
        output: {
          clues,
          modelVersion: res.value.modelVersion || MODEL_VERSIONS.vlm,
          attempts: res.value.attempts,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Clues -> evidence
// ---------------------------------------------------------------------------

/** Legibility is about seeing, not meaning — so it sets the weight directly. */
const LEGIBILITY_WEIGHT = { clear: 0.45, partial: 0.25, guessed: 0.08 } as const;

export function clueEvidence(clues: VlmClues, ctx: StageContext): Evidence[] {
  const out: Evidence[] = [];

  const push = (
    observed: string,
    kindLabel: string,
    legibility: keyof typeof LEGIBILITY_WEIGHT,
    bbox: readonly number[] | undefined,
    implies: string[] | undefined,
  ): void => {
    out.push({
      kind: 'vlm-clue',
      claim: implies?.length
        ? `${kindLabel}: "${observed}" (${legibility}). Consistent with ${implies.slice(0, 4).join(', ')}.`
        : `${kindLabel}: "${observed}" (${legibility}).`,
      verifiable: bbox
        ? 'Look at the linked crop and decide for yourself whether the frame shows what this line says it shows. A clue you cannot see is a clue to discard.'
        : 'Look at the frame and decide for yourself whether it shows what this line says it shows. The model localised nothing for this observation, which is itself a reason to weight it lightly.',
      cropUrl: bbox ? cropUrl(ctx.image.imageId, bbox) : undefined,
      reference: bbox
        ? { label: `crop [${bbox.map((n) => n.toFixed(2)).join(', ')}]` }
        : undefined,
      weight: LEGIBILITY_WEIGHT[legibility],
    });
  };

  for (const t of clues.text) push(t.observed, `Text (${t.kind})`, t.legibility, t.bbox, undefined);
  for (const i of clues.infrastructure) {
    push(i.observed, `Infrastructure (${i.kind})`, i.legibility, i.bbox, i.impliesRegions);
  }
  for (const e of clues.environment) {
    push(e.observed, `Environment (${e.kind})`, e.legibility, e.bbox, e.impliesRegions);
  }
  for (const a of clues.architecture) {
    push(a.observed, `Architecture (${a.kind})`, a.legibility, a.bbox, a.impliesRegions);
  }

  return out;
}

/** Count of clue categories that produced at least one non-guessed observation. */
export function clueCategoryCount(clues: VlmClues): number {
  const groups = [clues.text, clues.infrastructure, clues.environment, clues.architecture];
  return groups.filter((g) => g.some((c) => c.legibility !== 'guessed')).length;
}

export function clueCount(clues: VlmClues): number {
  return (
    clues.text.length +
    clues.infrastructure.length +
    clues.environment.length +
    clues.architecture.length
  );
}

// ---------------------------------------------------------------------------
// Clues -> region prior
// ---------------------------------------------------------------------------

/**
 * Turn the model's region shortlist into a bbox by **geocoding its label**.
 *
 * This is deliberately not a model-supplied bounding box. Asking a vision model
 * for coordinates invites exactly the hallucinated-precision failure the clue
 * schema exists to prevent; asking it for a place *name* and then resolving that
 * name against a gazetteer keeps the geometry in a source we can cite. With no
 * geocoder wired there is no VLM prior, and the cascade keeps the embedding one.
 */
export async function refinePriorFromClues(args: {
  clues: VlmClues;
  existing: RegionPrior | null;
  geocoder: Geocoder | null;
  ctx: StageContext;
}): Promise<{ prior: RegionPrior | null; evidence: Evidence[] }> {
  const { clues, existing, geocoder, ctx } = args;
  const top = [...clues.regionPrior].sort((a, b) => b.rawConfidence - a.rawConfidence)[0];
  if (!top || !geocoder || clues.insufficientSignal) return { prior: existing, evidence: [] };
  if (!ctx.budget.canAfford(TIMEOUTS_MS.geocode)) return { prior: existing, evidence: [] };

  const query = [top.label, top.admin1, top.country].filter(Boolean).join(', ');
  const res = await geocoder.geocode(query, {
    limit: 1,
    timeoutMs: ctx.budget.timeoutFor(TIMEOUTS_MS.geocode),
    signal: ctx.signal,
  });
  if (!res.ok || res.value.length === 0) return { prior: existing, evidence: [] };

  const hit = res.value[0];
  const rawBbox: Bbox =
    hit.bbox ?? padBbox(bboxFromCenterRadius({ lat: hit.lat, lon: hit.lon }, RETRIEVAL.cityRadiusM), 0);
  const bbox = padBbox(rawBbox, RETRIEVAL.bboxPaddingKm);

  const confidence = calibrate({
    set: 'vlmClues',
    raw: top.rawConfidence,
    independentSignals: 1,
    facts: {
      kind: 'vlm-clues',
      clueCount: clueCount(clues),
      categories: clueCategoryCount(clues),
      label: top.label,
    },
  });

  // Intersect rather than replace: two independent priors agreeing is a narrower
  // search space, and disagreeing means we keep the cheaper, better-calibrated one.
  const merged = existing ? bboxIntersection(existing.bbox, bbox) : bbox;
  const evidence: Evidence[] = [
    {
      kind: 'vlm-clue',
      claim: `${clueCount(clues)} visual clues across ${clueCategoryCount(clues)} categories point at ${top.label}${merged === null ? ', which does not overlap the coarse embedding prior — the cheaper prior was kept' : ''}. Used only to choose which part of the index to search.`,
      verifiable: `Check the individual clue lines above: each is a separate observation you can confirm or reject in the frame. The region name resolves to ${hit.label} in the gazetteer named in the result provenance.`,
      reference: { label: hit.label },
      weight: Math.min(0.35, confidence.score),
    },
  ];

  if (merged === null) return { prior: existing, evidence };

  const center = { lat: (merged[1] + merged[3]) / 2, lon: (merged[0] + merged[2]) / 2 };
  const radiusM = Math.max(
    RETRIEVAL.cityRadiusM,
    ((merged[3] - merged[1]) / 2) * 111_320,
  );

  return {
    prior: {
      bbox: merged,
      center,
      radiusM,
      precision: precisionForRadius(radiusM),
      labels: [top.label, ...(top.admin1 ? [top.admin1] : []), ...(top.country ? [top.country] : [])],
      score: Math.max(existing?.score ?? 0, confidence.score),
      source: existing ? 'merged' : 'vlm',
    },
    evidence,
  };
}

/** Solar observation extracted from the clue list, for the ShadowFinder verifier. */
export function solarObservationFrom(
  clues: VlmClues | null,
  capturedAt?: string,
): SolarObservation {
  return {
    shadowsVisible: clues?.solar?.shadowsVisible,
    shadowToHeightRatio: clues?.solar?.shadowToHeightRatio,
    shadowAzimuthDeg: clues?.solar?.shadowAzimuthDeg,
    capturedAt,
  };
}
