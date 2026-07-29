/**
 * Customer-owned corpora for the CLAIM module.
 *
 * We hold the pointer and the derived embedding, never their pixels — the same
 * discipline as persisting Street View pano IDs only. That is what makes CLAIM
 * shippable in v1 while the MLS interior index stays blocked (MASTER_PLAN §8).
 */

import type { LantageClient } from '../client';
import { DbError, unwrap } from '../errors';
import type { CorpusKind, CorpusRecordInsert, CorpusRecordRow, CorpusRow, Json } from '../types';

export type CreateCorpusInput = {
  name: string;
  kind: CorpusKind;
  orgId?: string;
};

export async function createCorpus(
  client: LantageClient,
  input: CreateCorpusInput,
): Promise<CorpusRow> {
  return unwrap(
    'createCorpus',
    await client
      .from('corpora')
      .insert({
        name: input.name,
        kind: input.kind,
        ...(input.orgId ? { org_id: input.orgId } : {}),
      })
      .select('*')
      .single(),
  );
}

export async function listCorpora(client: LantageClient): Promise<CorpusRow[]> {
  return unwrap(
    'listCorpora',
    await client.from('corpora').select('*').order('created_at', { ascending: false }),
  );
}

export type CorpusRecordDraft = {
  externalRef: string;
  thumbnailUrl?: string | null;
  meta?: Json;
  /** DINOv2 ViT-L/14, 1024-d, L2-normalized. */
  embedding?: number[];
};

/**
 * Bulk ingest. Upserts on (corpus_id, external_ref) so a re-run after a partial
 * failure is safe — an ingest that cannot be resumed is an ingest that will be
 * abandoned halfway through a million-image corpus.
 *
 * `record_count` is not maintained by a trigger on purpose: a per-row trigger
 * firing a million times during a bulk load is a self-inflicted wound. Call
 * `refreshCorpusRecordCount` when the load finishes.
 */
export async function insertCorpusRecords(
  client: LantageClient,
  corpusId: string,
  records: readonly CorpusRecordDraft[],
): Promise<CorpusRecordRow[]> {
  if (records.length === 0) return [];

  const rows: CorpusRecordInsert[] = records.map((r) => {
    if (r.embedding && r.embedding.length !== 1024) {
      throw new Error(
        `insertCorpusRecords: ${r.externalRef} has a ${r.embedding.length}-d embedding. ` +
          `corpus_records.embedding is halfvec(1024) — DINOv2 ViT-L/14.`,
      );
    }
    return {
      corpus_id: corpusId,
      external_ref: r.externalRef,
      thumbnail_url: r.thumbnailUrl ?? null,
      meta: r.meta ?? {},
      embedding: r.embedding ?? null,
    };
  });

  return unwrap(
    'insertCorpusRecords',
    await client
      .from('corpus_records')
      .upsert(rows, { onConflict: 'corpus_id,external_ref' })
      .select('*'),
  );
}

export async function refreshCorpusRecordCount(
  client: LantageClient,
  corpusId: string,
): Promise<number> {
  const { count, error } = await client
    .from('corpus_records')
    .select('id', { count: 'exact', head: true })
    .eq('corpus_id', corpusId);

  if (error) throw new DbError('refreshCorpusRecordCount', error);

  const total = count ?? 0;
  unwrap(
    'refreshCorpusRecordCount(update)',
    await client
      .from('corpora')
      .update({ record_count: total })
      .eq('id', corpusId)
      .select('id')
      .single(),
  );

  return total;
}
