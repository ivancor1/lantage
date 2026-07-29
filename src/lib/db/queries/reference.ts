/**
 * Global reference data: the Mapillary VPR index and BENCH runs.
 *
 * Both are readable by every authenticated user and writable only by the service
 * role, so these two writers must be called with the client from
 * `src/lib/db/service.ts`.
 */

import type { LantageServiceClient } from '../service';
import type { LantageClient } from '../client';
import { DbError, unwrap } from '../errors';
import type { BenchmarkRunRow, Json, MapillaryImageInsert, MapillaryImageRow } from '../types';

export type MapillaryImageDraft = {
  mapillaryId: string;
  lat: number;
  lon: number;
  compassAngle?: number | null;
  capturedAt?: string | null;
  thumbUrl: string;
  sequenceId?: string | null;
  isPano?: boolean;
  /** Must be true. Asserted at ingest; CHECK-enforced in the database. */
  blurApplied: true;
  metro: string;
  indexBuild: string;
  /** EigenPlaces / GeoCLIP, 512-d, L2-normalized. */
  embedding?: number[];
};

/**
 * Harvester write path. Upserts on the Mapillary id so re-harvesting a metro
 * refreshes rows instead of duplicating them.
 *
 * `blurApplied` is a required literal `true` rather than a default: the assertion
 * that upstream blur is intact has to be made explicitly by the ingest code that
 * actually looked at the image, because Mapillary ToS §12 requires technical
 * safeguards against unblurring and reidentification. We ship no ALPR and never
 * persist plate characters.
 */
export async function upsertMapillaryImages(
  client: LantageServiceClient,
  images: readonly MapillaryImageDraft[],
): Promise<MapillaryImageRow[]> {
  if (images.length === 0) return [];

  const rows: MapillaryImageInsert[] = images.map((m) => {
    if (m.embedding && m.embedding.length !== 512) {
      throw new Error(
        `upsertMapillaryImages: ${m.mapillaryId} has a ${m.embedding.length}-d embedding. ` +
          `mapillary_images.embedding is halfvec(512).`,
      );
    }
    return {
      mapillary_id: m.mapillaryId,
      lat: m.lat,
      lon: m.lon,
      compass_angle: m.compassAngle ?? null,
      captured_at: m.capturedAt ?? null,
      thumb_url: m.thumbUrl,
      sequence_id: m.sequenceId ?? null,
      is_pano: m.isPano ?? false,
      blur_applied: m.blurApplied,
      metro: m.metro,
      index_build: m.indexBuild,
      embedding: m.embedding ?? null,
    };
  });

  return unwrap(
    'upsertMapillaryImages',
    await client
      .from('mapillary_images')
      .upsert(rows, { onConflict: 'mapillary_id' })
      .select('*'),
  );
}

/** Row counts per metro and index build. Drives the index-sizing view. */
export async function countMapillaryImages(
  client: LantageClient,
  metro?: string,
): Promise<number> {
  let q = client.from('mapillary_images').select('mapillary_id', { count: 'exact', head: true });
  if (metro) q = q.eq('metro', metro);

  const { count, error } = await q;
  if (error) throw new DbError('countMapillaryImages', error);
  return count ?? 0;
}

export type BenchmarkRunDraft = {
  name: string;
  dataset: string;
  modelVersions?: Record<string, string>;
  indexBuild?: string | null;
  metrics?: Json;
};

/** BENCH publishes our error rate. This is where the published numbers come from. */
export async function recordBenchmarkRun(
  client: LantageServiceClient,
  input: BenchmarkRunDraft,
): Promise<BenchmarkRunRow> {
  return unwrap(
    'recordBenchmarkRun',
    await client
      .from('benchmark_runs')
      .insert({
        name: input.name,
        dataset: input.dataset,
        model_versions: input.modelVersions ?? {},
        index_build: input.indexBuild ?? null,
        metrics: input.metrics ?? {},
      })
      .select('*')
      .single(),
  );
}

export async function listBenchmarkRuns(
  client: LantageClient,
  dataset?: string,
  limit = 50,
): Promise<BenchmarkRunRow[]> {
  let q = client
    .from('benchmark_runs')
    .select('*')
    .order('at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (dataset) q = q.eq('dataset', dataset);

  return unwrap('listBenchmarkRuns', await q);
}
