/**
 * Stage 6 — optional MegaLoc re-rank of the top 50. **Off by default.**
 *
 * The cost, plainly: MegaLoc-8448 takes **2.8 s per image** against
 * EigenPlaces-512's 0.13 s — 21x — out of a 10 s end-to-end budget, which means
 * turning this on converts a 3 s search into a 6 s search. It also cannot be
 * HNSW-indexed in pgvector at all (8,448 dims vs. the 2,000-dim limit) and costs
 * 33.8 GB per million vectors against 2.0 GB, so it can only ever be a re-ranker
 * over an already-retrieved shortlist, never the retriever.
 *
 * It is the stronger model in isolation (SOTA on Tokyo24/7, 97.1% R@1), so the
 * flag exists — but it stays off until BENCH measures that the accuracy it buys
 * is worth half the latency budget. Enable with `LANTAGE_RERANK=1`.
 */

import type { StageTrace } from '@/lib/contracts/types';
import { MODEL_VERSIONS, RERANK_ENABLED, TIMEOUTS_MS, modalCostUsd } from './config';
import type { WorkingCandidate } from './candidate';
import type { EmbedClient } from './embedClient';
import type { GeoVectorHit } from './vprRetrieval';
import type { PreprocessOutput } from './preprocess';
import {
  type Result,
  type StageContext,
  type StageFailure,
  type StageOutput,
  failure,
  skipped,
} from './types';

/**
 * TODO(A2): stored MegaLoc descriptors for a shortlist of Mapillary ids. These
 * live in a separate table from the EigenPlaces vectors precisely because they
 * cannot share an index — see the header. Register in `wiring.ts`.
 */
export interface RerankVectorStore {
  fetchDescriptors(args: {
    mapillaryIds: string[];
    model: 'megaloc';
    signal?: AbortSignal;
  }): Promise<Result<Record<string, number[]>, StageFailure>>;
}

export interface RerankInput {
  preprocessed: PreprocessOutput;
  candidates: WorkingCandidate[];
  hits: GeoVectorHit[];
}

export interface RerankOutput {
  reordered: boolean;
  modelVersion: string;
}

export function createRerankStage(
  embed: EmbedClient,
  store: RerankVectorStore | null,
  enabled: boolean = RERANK_ENABLED,
) {
  return {
    stage: 'rerank' as const,
    async run(input: RerankInput, ctx: StageContext): Promise<StageOutput<RerankOutput>> {
      const started = Date.now();

      if (!enabled) {
        return skipped(
          'rerank',
          Date.now() - started,
          failure(
            'gated-off',
            'MegaLoc re-rank is off by default: it costs 2.8s per image out of a 10s budget for an accuracy gain BENCH has not yet justified. Enable with LANTAGE_RERANK=1.',
          ),
        );
      }
      if (!store) {
        return skipped(
          'rerank',
          Date.now() - started,
          failure('not-configured', 'No stored MegaLoc descriptors are available to re-rank against.'),
        );
      }
      if (!ctx.budget.canAfford(TIMEOUTS_MS.rerank)) {
        return skipped(
          'rerank',
          Date.now() - started,
          failure(
            'budget-exhausted',
            'Skipped the re-rank rather than overrun the latency budget. The retrieval ranking stands.',
          ),
        );
      }

      const query = await embed.embed({
        image: input.preprocessed.image,
        models: ['megaloc'],
        timeoutMs: ctx.budget.timeoutFor(TIMEOUTS_MS.rerank),
        signal: ctx.signal,
      });
      if (!query.ok) return skipped('rerank', Date.now() - started, query.error);
      const queryVector = query.value.embeddings.megaloc?.vector;
      if (!queryVector) {
        return skipped(
          'rerank',
          Date.now() - started,
          failure('invalid-response', 'The embedding service returned no re-rank descriptor.'),
        );
      }

      const ids = input.hits.map((h) => h.mapillaryId);
      const stored = await store.fetchDescriptors({ mapillaryIds: ids, model: 'megaloc', signal: ctx.signal });
      if (!stored.ok) return skipped('rerank', Date.now() - started, stored.error);

      const before = input.candidates.map((c) => c.id).join('|');
      for (const candidate of input.candidates) {
        const memberIds = candidate.evidence
          .map((e) => e.reference?.mapillaryId)
          .filter((id): id is string => typeof id === 'string');
        const sims = memberIds
          .map((id) => stored.value[id])
          .filter((v): v is number[] => Array.isArray(v))
          .map((v) => cosine(queryVector, v));
        if (sims.length === 0) continue;
        // The re-rank replaces the score, it does not add to it: two descriptors
        // of the same pixels are not two independent signals.
        candidate.rawScore = Math.max(...sims);
      }
      const after = [...input.candidates].sort((a, b) => b.rawScore - a.rawScore).map((c) => c.id).join('|');

      const trace: StageTrace = {
        stage: 'rerank',
        ranMs: Date.now() - started,
        costUsd: modalCostUsd(query.value.tookMs || Date.now() - started),
      };
      return {
        evidence: [],
        trace,
        output: { reordered: before !== after, modelVersion: MODEL_VERSIONS.rerank },
      };
    },
  };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
