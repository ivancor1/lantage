/**
 * ANN retrieval, region-pruned.
 *
 * Both helpers are thin wrappers over SQL functions, and that is the point: the
 * filter-then-rank ordering, the per-query `hnsw.ef_search`, and the iterative-scan
 * setting all live in the database where the planner can see them. Doing this as a
 * PostgREST query builder chain instead would send an unfiltered ANN order-by and
 * lose the pruning that the whole cascade design depends on.
 */

import type { LantageClient } from '../client';
import { unwrap } from '../errors';
import type { CorpusAnnHit, GeoAnnHit } from '../types';

/** [minLon, minLat, maxLon, maxLat] — GeoJSON order, same as SearchRequest.hints.bbox. */
export type Bbox = readonly [number, number, number, number];

export type SearchGeoCandidatesInput = {
  /** EigenPlaces / GeoCLIP descriptor. 512-d, L2-normalized. */
  embedding: number[];
  /** The retrieval submap. Omit only for a deliberate cross-metro query. */
  metro?: string;
  /** Pin results to one index build for reproducibility. */
  indexBuild?: string;
  /** Hard geographic prune — e.g. the county of the claimed loss address. */
  bbox?: Bbox;
  limit?: number;
  /**
   * HNSW search breadth. Raise it when the bbox is tight: a hard filter makes the
   * graph walk discard more of what it finds, so it needs to look at more.
   */
  efSearch?: number;
};

export async function searchGeoCandidates(
  client: LantageClient,
  input: SearchGeoCandidatesInput,
): Promise<GeoAnnHit[]> {
  if (input.embedding.length !== 512) {
    throw new Error(
      `searchGeoCandidates: expected a 512-d descriptor, got ${input.embedding.length}. ` +
        `mapillary_images.embedding is halfvec(512) — EigenPlaces-512, not MegaLoc-8448.`,
    );
  }
  if (input.bbox && (input.bbox[0] > input.bbox[2] || input.bbox[1] > input.bbox[3])) {
    throw new Error(
      `searchGeoCandidates: bbox is inverted. Order is [minLon, minLat, maxLon, maxLat] — lon first.`,
    );
  }

  return unwrap(
    'searchGeoCandidates',
    await client.rpc('search_geo_candidates', {
      query_embedding: input.embedding,
      p_metro: input.metro ?? null,
      p_index_build: input.indexBuild ?? null,
      p_bbox: input.bbox ? [...input.bbox] : null,
      p_limit: input.limit ?? 50,
      p_ef_search: input.efSearch ?? 100,
    }),
  );
}

export type SearchCorpusRecordsInput = {
  /** DINOv2 ViT-L/14 descriptor. 1024-d, L2-normalized. */
  embedding: number[];
  /** Required: the corpus is the tenancy boundary. */
  corpusId: string;
  limit?: number;
  /**
   * Cosine distance ceiling. ~0.10 reads as near-duplicate, 0.10–0.25 as the same
   * scene from another angle — which for SIU is the recycled-damage signal.
   */
  maxDistance?: number;
  efSearch?: number;
};

export async function searchCorpusRecords(
  client: LantageClient,
  input: SearchCorpusRecordsInput,
): Promise<CorpusAnnHit[]> {
  if (input.embedding.length !== 1024) {
    throw new Error(
      `searchCorpusRecords: expected a 1024-d descriptor, got ${input.embedding.length}. ` +
        `corpus_records.embedding is halfvec(1024) — DINOv2 ViT-L/14.`,
    );
  }

  return unwrap(
    'searchCorpusRecords',
    await client.rpc('search_corpus_records', {
      query_embedding: input.embedding,
      p_corpus_id: input.corpusId,
      p_limit: input.limit ?? 20,
      p_max_distance: input.maxDistance ?? 0.35,
      p_ef_search: input.efSearch ?? 100,
    }),
  );
}
