/**
 * Stage 5 — region-pruned visual place recognition.
 *
 * The order of operations here IS the architecture (arXiv 2507.17455): the bbox
 * prune is applied **inside the SQL, before the ANN query**, so pgvector searches
 * a submap rather than the planet. A full-index scan followed by a geographic
 * filter would return the same rows in the easy cases and the wrong rows in every
 * case that matters, because the nearest neighbours of an ambiguous facade are
 * scattered globally. If there is no region to prune to, this stage refuses to
 * run rather than scanning the index — see the `policy` failure below.
 *
 * Descriptor is EigenPlaces-512, not MegaLoc-8448: 512 dims is HNSW-indexable in
 * pgvector (whose limit is 2,000), 0.13s vs 2.80s per image, and 2.0GB vs 33.8GB
 * per million vectors. MegaLoc is the better model in isolation and is confined
 * to `rerank.ts` for exactly that reason.
 */

import type { Evidence, StageTrace } from '@/lib/contracts/types';
import { COSTS, INDEX_BUILD, MODEL_VERSIONS, RETRIEVAL, TIMEOUTS_MS, modalCostUsd } from './config';
import type { WorkingCandidate } from './candidate';
import type { EmbedClient } from './embedClient';
import { bboxIntersection, clusterByProximity, haversineM, precisionForRadius } from './geo';
import type { PreprocessOutput } from './preprocess';
import {
  type Bbox,
  type RegionPrior,
  type Result,
  type Stage,
  type StageContext,
  type StageFailure,
  type StageOutput,
  failure,
  skipped,
} from './types';

// ---------------------------------------------------------------------------
// A2's vector search — narrow local interface
// ---------------------------------------------------------------------------

/**
 * TODO(A2): this is the shape B2 needs from `src/lib/db`. When the real
 * `searchGeoCandidates` SQL function lands, register the implementation in
 * `wiring.ts`; nothing in this file changes.
 *
 * The `bbox` argument is not optional-by-convenience — it is the prune, and the
 * SQL is expected to apply it as a WHERE clause on the geography column *before*
 * the `<=>` ANN ordering, with the HNSW index doing the ordering inside the
 * surviving set (`SET LOCAL hnsw.ef_search` tuned per call if needed).
 */
export interface GeoVectorHit {
  mapillaryId: string;
  lat: number;
  lon: number;
  /** Cosine similarity in 0..1 (1 = identical). Not a distance. */
  similarity: number;
  compassAngle?: number | null;
  thumbUrl?: string;
  sequenceId?: string;
  capturedAt?: string;
}

export interface GeoVectorSearch {
  searchGeoCandidates(args: {
    embedding: number[];
    /** [west, south, east, north]. Applied before the ANN query. */
    bbox: Bbox;
    limit: number;
    signal?: AbortSignal;
  }): Promise<Result<{ hits: GeoVectorHit[]; indexBuild?: string }, StageFailure>>;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export interface VprRetrievalInput {
  preprocessed: PreprocessOutput;
  prior: RegionPrior | null;
  /** Analyst-supplied bbox from `SearchRequest.hints`. Intersected with the prior. */
  hintBbox?: Bbox;
}

export interface VprRetrievalOutput {
  candidates: WorkingCandidate[];
  hits: GeoVectorHit[];
  prunedBbox: Bbox;
  modelVersion: string;
  indexBuild: string;
  /** Embedding kept for the optional re-rank so it is not recomputed. */
  queryEmbedding: number[];
}

export function createVprRetrievalStage(
  embed: EmbedClient,
  search: GeoVectorSearch | null,
): Stage<VprRetrievalInput, VprRetrievalOutput> {
  return {
    stage: 'vpr-retrieval',
    async run(input, ctx): Promise<StageOutput<VprRetrievalOutput>> {
      const started = Date.now();

      if (!search) {
        return skipped(
          'vpr-retrieval',
          Date.now() - started,
          failure(
            'not-configured',
            'The panorama index is not wired, so no retrieval matches could be produced. Without them no candidate can claim street precision.',
          ),
        );
      }

      const bbox = resolvePrunedBbox(input.prior, input.hintBbox);
      if (!bbox) {
        return skipped(
          'vpr-retrieval',
          Date.now() - started,
          failure(
            'policy',
            'No region prior survived, and retrieval is not permitted to scan the whole index: an unpruned planet-scale ANN query returns globally scattered lookalikes, which is the failure this architecture exists to avoid. Supply a bbox hint or accept the coarse prior alone.',
          ),
        );
      }

      if (!ctx.budget.canAfford(TIMEOUTS_MS.embed + TIMEOUTS_MS.vectorSearch)) {
        return skipped(
          'vpr-retrieval',
          Date.now() - started,
          failure('budget-exhausted', 'Not enough time left in the search budget for retrieval.'),
        );
      }

      const embedded = await embed.embed({
        image: input.preprocessed.image,
        models: ['eigenplaces'],
        timeoutMs: ctx.budget.timeoutFor(TIMEOUTS_MS.embed),
        signal: ctx.signal,
      });
      if (!embedded.ok) {
        return skipped('vpr-retrieval', Date.now() - started, embedded.error);
      }
      const vector = embedded.value.embeddings.eigenplaces?.vector;
      if (!vector || vector.length === 0) {
        return skipped(
          'vpr-retrieval',
          Date.now() - started,
          failure('invalid-response', 'The embedding service returned no place-recognition vector.'),
        );
      }

      const found = await search.searchGeoCandidates({
        embedding: vector,
        bbox,
        limit: RETRIEVAL.annLimit,
        signal: ctx.signal,
      });
      if (!found.ok) {
        return skipped('vpr-retrieval', Date.now() - started, found.error);
      }

      const hits = found.value.hits.filter(
        (h) => Number.isFinite(h.lat) && Number.isFinite(h.lon) && Number.isFinite(h.similarity),
      );
      const ranMs = Date.now() - started;

      if (hits.length === 0) {
        return skipped(
          'vpr-retrieval',
          ranMs,
          failure(
            'no-input',
            'No indexed panorama in the pruned region matched this frame. Either the metro index does not cover it, or the frame is not of an indexed street.',
          ),
        );
      }

      const { candidates, evidence } = buildCandidates(hits, ctx);
      const trace: StageTrace = {
        stage: 'vpr-retrieval',
        ranMs,
        costUsd: modalCostUsd(embedded.value.tookMs || ranMs) + COSTS.vectorSearchUsdPerCall,
      };

      return {
        evidence,
        trace,
        output: {
          candidates,
          hits,
          prunedBbox: bbox,
          modelVersion: embedded.value.embeddings.eigenplaces?.version
            ? `eigenplaces-512@${embedded.value.embeddings.eigenplaces.version}`
            : MODEL_VERSIONS.vpr,
          indexBuild: found.value.indexBuild ?? INDEX_BUILD,
          queryEmbedding: vector,
        },
      };
    },
  };
}

/**
 * Intersect the model prior with the analyst's bbox hint.
 *
 * An empty intersection is meaningful, not an error: it means the imagery does
 * not look like the place the claim says it was taken. We keep the analyst's
 * hint in that case — they asked "is this consistent with my loss address?", and
 * answering "no match inside your county" is the useful answer.
 */
export function resolvePrunedBbox(prior: RegionPrior | null, hint?: Bbox): Bbox | null {
  if (prior && hint) return bboxIntersection(prior.bbox, hint) ?? hint;
  if (hint) return hint;
  if (prior) return prior.bbox;
  return null;
}

function buildCandidates(
  hits: GeoVectorHit[],
  ctx: StageContext,
): { candidates: WorkingCandidate[]; evidence: Evidence[] } {
  const clusters = clusterByProximity(hits, RETRIEVAL.clusterRadiusM);
  const evidence: Evidence[] = [];

  const candidates = clusters.map((cluster, index) => {
    const members = [...cluster.members].sort((a, b) => b.similarity - a.similarity);
    const top = members[0];
    const spanM = Math.max(...members.map((m) => haversineM(cluster.center, m)));
    const radiusM = Math.max(RETRIEVAL.streetRadiusM, spanM);

    // Cluster score: the best match, nudged by how many independent panoramas in
    // the cluster agree with it. Agreement across headings and sequences is the
    // thing that separates a real match from one lucky descriptor.
    const agreement = Math.min(1, members.length / 5);
    const rawScore = Math.min(1, top.similarity * (0.85 + 0.15 * agreement));

    const earnsStreet = top.similarity >= RETRIEVAL.streetPrecisionMinSimilarity;
    const memberEvidence = members.slice(0, 3).map((m) => matchEvidence(m));
    evidence.push(...memberEvidence);

    const candidate: WorkingCandidate = {
      id: `${ctx.searchId}-geo-${index + 1}`,
      center: cluster.center,
      radiusM,
      precision: earnsStreet ? 'street' : precisionForRadius(radiusM),
      place: { label: `${cluster.center.lat.toFixed(4)}, ${cluster.center.lon.toFixed(4)}` },
      rawScore,
      evidence: memberEvidence,
      calibrationSet: 'vprRetrieval',
      facts: {
        kind: 'retrieval-agreement',
        within: members.length,
        of: hits.length,
        radiusM,
      },
    };
    return candidate;
  });

  return { candidates, evidence };
}

function matchEvidence(hit: GeoVectorHit): Evidence {
  return {
    kind: 'vpr-match',
    claim: `This frame matches indexed street imagery at ${hit.lat.toFixed(5)}, ${hit.lon.toFixed(5)} (similarity ${hit.similarity.toFixed(3)}${hit.compassAngle != null ? `, camera heading ${Math.round(hit.compassAngle)}°` : ''}).`,
    verifiable:
      'Open the linked Mapillary image and compare it with the frame side by side — roofline, window spacing, kerb, pole placement. If they are not the same place, mark this candidate incorrect and the ranking updates.',
    cropUrl: hit.thumbUrl,
    reference: {
      label: `Mapillary ${hit.mapillaryId}`,
      url: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(hit.mapillaryId)}&focus=photo`,
      mapillaryId: hit.mapillaryId,
    },
    weight: Math.max(0, Math.min(1, hit.similarity)),
  };
}
