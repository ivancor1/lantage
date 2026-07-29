/**
 * Stage 2 — the cheap embedding prior (GeoCLIP), ~120ms on a warm L4.
 *
 * Its output is a **region to search inside**, not an answer. GeoCLIP's GPS
 * gallery returns the best-matching cells with softmax-ish scores; a high score
 * means "some gallery cell matched well", which is not the same as "the location
 * is known" — the cells can be scattered across three continents. So this stage
 * produces a bbox plus a calibrated score plus a spread measurement, and the
 * spread is what decides whether the VLM has to run at all.
 */

import type { Evidence, StageTrace } from '@/lib/contracts/types';
import type { EmbedResponse } from '@/lib/contracts/schemas';
import { MODEL_VERSIONS, RETRIEVAL, TIMEOUTS_MS, modalCostUsd } from './config';
import { calibrate } from './confidence';
import type { EmbedClient } from './embedClient';
import { bboxFromCenterRadius, haversineM, padBbox, precisionForRadius, spreadKm, weightedCentroid } from './geo';
import type { PreprocessOutput } from './preprocess';
import {
  type RegionPrior,
  type Stage,
  type StageContext,
  type StageOutput,
  failure,
  skipped,
} from './types';

export interface EmbeddingPriorOutput {
  prior: RegionPrior;
  /** Raw GeoCLIP gallery hits, kept for the ledger and for BENCH. */
  galleryHits: Array<{ lat: number; lon: number; score: number }>;
  /** Version the service reported, for `ResultProvenance`. */
  modelVersion: string;
  /** Scored 0..1 before calibration. Exposed so BENCH can refit. */
  rawTopScore: number;
  spreadKm: number;
}

/** How many gallery cells inform the prior. Beyond ~8 the tail is noise. */
const GALLERY_TOP_K = 8;

export function createEmbeddingPriorStage(
  embed: EmbedClient,
): Stage<PreprocessOutput, EmbeddingPriorOutput> {
  return {
    stage: 'embedding-prior',
    async run(
      input: PreprocessOutput,
      ctx: StageContext,
    ): Promise<StageOutput<EmbeddingPriorOutput>> {
      const started = Date.now();
      if (!ctx.budget.canAfford(TIMEOUTS_MS.embed)) {
        return skipped(
          'embedding-prior',
          Date.now() - started,
          failure('budget-exhausted', 'Not enough time left in the search budget to embed.'),
        );
      }

      const res = await embed.embed({
        image: input.image,
        models: ['geoclip'],
        timeoutMs: ctx.budget.timeoutFor(TIMEOUTS_MS.embed),
        signal: ctx.signal,
      });

      const ranMs = Date.now() - started;
      if (!res.ok) {
        return skipped('embedding-prior', ranMs, res.error);
      }

      const hits = (res.value.geoPrior ?? [])
        .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon))
        .sort((a, b) => b.score - a.score)
        .slice(0, GALLERY_TOP_K);

      if (hits.length === 0) {
        return skipped(
          'embedding-prior',
          ranMs,
          failure(
            'invalid-response',
            'The embedding service returned no GPS-gallery prior, so there is no region to prune to.',
          ),
        );
      }

      const output = buildPrior(hits, res.value);
      const trace: StageTrace = {
        stage: 'embedding-prior',
        ranMs,
        costUsd: modalCostUsd(res.value.tookMs || ranMs),
      };
      return { evidence: [priorEvidence(output)], trace, output };
    },
  };
}

export function buildPrior(
  hits: Array<{ lat: number; lon: number; score: number }>,
  response: EmbedResponse | null,
): EmbeddingPriorOutput {
  const total = hits.reduce((s, h) => s + Math.max(0, h.score), 0) || 1;
  const center = weightedCentroid(hits.map((h) => ({ lat: h.lat, lon: h.lon, weight: h.score })));
  const spread = spreadKm(hits.map((h) => ({ lat: h.lat, lon: h.lon })));
  const rawTop = clamp01(hits[0].score);

  // Radius covers the mass of the prior, floored at the city scale: GeoCLIP's
  // gallery spacing cannot support anything tighter, and a tight radius here
  // would be a precision claim the model has not earned.
  const spanM = Math.max(...hits.map((h) => haversineM(center, { lat: h.lat, lon: h.lon })));
  const radiusM = Math.max(RETRIEVAL.cityRadiusM, spanM);

  // Concentration: share of the score mass within a FIXED city-scale radius of the
  // weighted centroid. It has to be a fixed reference distance — measuring it
  // against `radiusM`, which is itself derived from the spread, would make every
  // prior perfectly concentrated by construction and the number meaningless.
  const near = hits.filter(
    (h) => haversineM(center, { lat: h.lat, lon: h.lon }) <= RETRIEVAL.cityRadiusM,
  );
  const concentration = near.reduce((s, h) => s + Math.max(0, h.score), 0) / total;

  const confidence = calibrate({
    set: 'embeddingPrior',
    raw: rawTop * (0.5 + 0.5 * concentration),
    // The prior on its own is exactly one signal. It cannot reach 'high'.
    independentSignals: 1,
    facts: {
      kind: 'embedding-prior',
      topScorePct: Math.round(rawTop * 100),
      spreadKm: spread,
    },
  });

  const prior: RegionPrior = {
    bbox: padBbox(bboxFromCenterRadius(center, radiusM), RETRIEVAL.bboxPaddingKm),
    center,
    radiusM,
    precision: precisionForRadius(radiusM),
    labels: [],
    score: confidence.score,
    source: 'embedding',
  };

  return {
    prior,
    galleryHits: hits,
    modelVersion: response?.embeddings?.geoclip?.version
      ? `geoclip@${response.embeddings.geoclip.version}`
      : MODEL_VERSIONS.embedding,
    rawTopScore: rawTop,
    spreadKm: spread,
  };
}

function priorEvidence(out: EmbeddingPriorOutput): Evidence {
  const { prior } = out;
  return {
    kind: 'embedding-prior',
    claim: `A coarse image-embedding prior (${out.modelVersion}) favours a ${Math.round(prior.radiusM / 1000)} km region around ${prior.center.lat.toFixed(3)}, ${prior.center.lon.toFixed(3)}. Its top ${out.galleryHits.length} gallery cells span ${Math.round(out.spreadKm)} km.`,
    verifiable:
      'This is a search-space prune, not a location. Re-run the published model version named in the result provenance on the same frame to reproduce the same gallery cells, and judge the region by the retrieval matches below rather than by this prior.',
    reference: {
      label: 'prior region on the map',
      url: `https://www.openstreetmap.org/?minlon=${prior.bbox[0]}&minlat=${prior.bbox[1]}&maxlon=${prior.bbox[2]}&maxlat=${prior.bbox[3]}&box=yes`,
    },
    weight: Math.min(0.4, prior.score),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
