import {
  assertStreetPrecisionIsEarned,
  type AuthenticityResult,
  type CorpusMatch,
  type GeoCandidate,
  type ModuleId,
  type QualityGate,
  type ResultProvenance,
  type ReviewState,
  type SearchRequest,
  type StageTrace,
  type VehicleCandidate,
} from '@/lib/contracts/types';

import type { LantageClient } from '../client';
import { DbError, unwrap, unwrapMaybe } from '../errors';
import type {
  AuthenticityResultRow,
  CorpusMatchRow,
  GeoCandidateRow,
  SearchRow,
  VehicleCandidateRow,
} from '../types';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type CreateSearchInput = {
  module: ModuleId;
  imageId: string;
  caseId?: string | null;
  hints?: SearchRequest['hints'];
  orgId?: string;
  createdBy?: string;
};

/**
 * Opens a search row before the cascade runs, so every stage has an id to attach
 * telemetry and audit rows to. `quality`, `stages`, and `provenance` stay `{}`/`[]`
 * until `finalizeSearch`.
 */
export async function createSearch(
  client: LantageClient,
  input: CreateSearchInput,
): Promise<SearchRow> {
  return unwrap(
    'createSearch',
    await client
      .from('searches')
      .insert({
        module: input.module,
        image_id: input.imageId,
        case_id: input.caseId ?? null,
        hints: input.hints ?? {},
        ...(input.orgId ? { org_id: input.orgId } : {}),
        ...(input.createdBy ? { created_by: input.createdBy } : {}),
      })
      .select('*')
      .single(),
  );
}

export type FinalizeSearchInput = {
  quality: QualityGate;
  stages: StageTrace[];
  provenance: ResultProvenance;
};

/**
 * Stamps the result of the run. These are the only three columns an authenticated
 * caller can patch — the grant in the RLS migration enforces that, so a bug that
 * tries to rewrite `image_id` or `module` fails at the database rather than
 * quietly changing what a past result claims to be about.
 *
 * Write this AFTER the candidate rows when the gate passed, and BEFORE them (with
 * no candidates at all) when it failed — the refusal guard trigger rejects
 * candidate inserts against a search whose quality.passed is false.
 */
export async function finalizeSearch(
  client: LantageClient,
  searchId: string,
  input: FinalizeSearchInput,
): Promise<SearchRow> {
  return unwrap(
    'finalizeSearch',
    await client
      .from('searches')
      .update({
        quality: input.quality,
        stages: input.stages,
        provenance: input.provenance,
      })
      .eq('id', searchId)
      .select('*')
      .single(),
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type SearchWithCandidates = SearchRow & {
  geo_candidates: GeoCandidateRow[];
  vehicle_candidates: VehicleCandidateRow[];
  /** One-to-one: authenticity_results.search_id is UNIQUE. */
  authenticity_results: AuthenticityResultRow | null;
  corpus_matches: CorpusMatchRow[];
};

const SEARCH_WITH_CANDIDATES = `
  *,
  geo_candidates ( * ),
  vehicle_candidates ( * ),
  authenticity_results ( * ),
  corpus_matches ( * )
` as const;

/**
 * One round trip, candidates embedded and rank-ordered.
 *
 * PostgREST resolves the embeds from the foreign keys; the `Relationships` metadata
 * in `../types.ts` is what makes them type-check. RLS applies to the embedded
 * relations too, so a search from another org returns null rather than a partial row.
 */
export async function getSearch(
  client: LantageClient,
  searchId: string,
): Promise<SearchWithCandidates | null> {
  return unwrapMaybe(
    'getSearch',
    await client
      .from('searches')
      .select(SEARCH_WITH_CANDIDATES)
      .eq('id', searchId)
      .order('rank', { referencedTable: 'geo_candidates', ascending: true })
      .order('rank', { referencedTable: 'vehicle_candidates', ascending: true })
      .order('rank', { referencedTable: 'corpus_matches', ascending: true })
      .maybeSingle(),
  );
}

export type ListSearchesOptions = {
  caseId?: string;
  imageId?: string;
  module?: ModuleId;
  limit?: number;
};

export async function listSearches(
  client: LantageClient,
  options: ListSearchesOptions = {},
): Promise<SearchRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  let q = client.from('searches').select('*').order('created_at', { ascending: false }).limit(limit);
  if (options.caseId) q = q.eq('case_id', options.caseId);
  if (options.imageId) q = q.eq('image_id', options.imageId);
  if (options.module) q = q.eq('module', options.module);

  return unwrap('listSearches', await q);
}

// ---------------------------------------------------------------------------
// Candidate writes
// ---------------------------------------------------------------------------

/** A candidate as the cascade produces it: contract shape, no id yet. */
export type GeoCandidateDraft = Omit<GeoCandidate, 'id' | 'review'> & { review?: ReviewState };

/**
 * Ranks are 1-based and unique per search (enforced by a unique index).
 *
 * `assertStreetPrecisionIsEarned` runs here as well as in the database, and that is
 * on purpose: the TypeScript assertion gives the cascade a stack trace pointing at
 * the stage that overclaimed, while the CHECK constraint guarantees the row can
 * never exist even if this path is bypassed.
 */
export async function insertGeoCandidates(
  client: LantageClient,
  searchId: string,
  candidates: readonly GeoCandidateDraft[],
): Promise<GeoCandidateRow[]> {
  if (candidates.length === 0) return [];

  const rows = candidates.map((c) => {
    assertStreetPrecisionIsEarned({ ...c, id: `${searchId}#${c.rank}`, review: 'unreviewed' });

    if (c.radiusM <= 0) {
      throw new Error(
        `insertGeoCandidates: rank ${c.rank} has radiusM ${c.radiusM}. A region needs a radius — ` +
          `a point estimate is a claim this product does not make.`,
      );
    }

    return {
      search_id: searchId,
      rank: c.rank,
      lat: c.center.lat,
      lon: c.center.lon,
      radius_m: c.radiusM,
      precision: c.precision,
      place: c.place,
      confidence: c.confidence,
      evidence: c.evidence,
      review: c.review ?? 'unreviewed',
    };
  });

  return unwrap(
    'insertGeoCandidates',
    await client.from('geo_candidates').insert(rows).select('*'),
  );
}

export type VehicleCandidateDraft = Omit<VehicleCandidate, 'review'> & { review?: ReviewState };

export async function insertVehicleCandidates(
  client: LantageClient,
  searchId: string,
  candidates: readonly VehicleCandidateDraft[],
): Promise<VehicleCandidateRow[]> {
  if (candidates.length === 0) return [];

  const rows = candidates.map((c) => ({
    search_id: searchId,
    rank: c.rank,
    make: c.make,
    model: c.model,
    generation: c.generation,
    color: c.color ?? null,
    vpic: c.vpic ?? {},
    similarity: c.similarity,
    reference_image_url: c.referenceImageUrl ?? null,
    review: c.review ?? 'unreviewed',
  }));

  return unwrap(
    'insertVehicleCandidates',
    await client.from('vehicle_candidates').insert(rows).select('*'),
  );
}

export async function insertAuthenticityResult(
  client: LantageClient,
  searchId: string,
  result: AuthenticityResult,
): Promise<AuthenticityResultRow> {
  // The database enforces the biconditional too; this message is clearer than 23514.
  const suppressed = result.suppressedBy ?? [];
  if ((result.verdict === 'inconclusive') !== suppressed.length > 0) {
    throw new Error(
      `insertAuthenticityResult: verdict "${result.verdict}" with ${suppressed.length} suppression ` +
        `reasons. suppressedBy is present iff the verdict is 'inconclusive'.`,
    );
  }

  return unwrap(
    'insertAuthenticityResult',
    await client
      .from('authenticity_results')
      .insert({
        search_id: searchId,
        verdict: result.verdict,
        confidence: result.confidence,
        evidence: result.evidence,
        suppressed_by: suppressed,
        ppv: result.ppv,
        provenance: result.provenance,
      })
      .select('*')
      .single(),
  );
}

export type CorpusMatchDraft = Omit<CorpusMatch, 'review'> & { review?: ReviewState };

export async function insertCorpusMatches(
  client: LantageClient,
  searchId: string,
  matches: readonly CorpusMatchDraft[],
): Promise<CorpusMatchRow[]> {
  if (matches.length === 0) return [];

  const rows = matches.map((m) => ({
    search_id: searchId,
    corpus_id: m.corpusId,
    record_id: m.recordId,
    rank: m.rank,
    similarity: m.similarity,
    relation: m.relation,
    thumbnail_url: m.thumbnailUrl ?? null,
    review: m.review ?? 'unreviewed',
  }));

  return unwrap(
    'insertCorpusMatches',
    await client.from('corpus_matches').insert(rows).select('*'),
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export type ReviewableTable = 'geo_candidates' | 'vehicle_candidates' | 'corpus_matches';

/**
 * The analyst's disposition is the only mutable field on a candidate. Everything
 * else is what the model said, and rewriting that would rewrite history.
 *
 * Marking something 'confirmed' is a claim about the world, so the caller must also
 * append a ledger entry carrying the corroboration — that is the Detroit rule as
 * workflow, not as a policy PDF.
 */
export async function setCandidateReview(
  client: LantageClient,
  table: ReviewableTable,
  candidateId: string,
  review: ReviewState,
): Promise<void> {
  const { error } = await client.from(table).update({ review }).eq('id', candidateId);
  if (error) throw new DbError(`setCandidateReview(${table})`, error);
}
