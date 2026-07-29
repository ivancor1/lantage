/**
 * The one place snake_case rows become the camelCase domain types in
 * `src/lib/contracts/types.ts`.
 *
 * Keep it here. A mapper copy-pasted into a component is how two definitions of
 * "confirmed" end up in the codebase.
 */

import type {
  AuthenticityResult,
  CaseFile,
  CorpusMatch,
  GeoCandidate,
  LedgerEntry,
  QualityGate,
  ResultProvenance,
  SearchResult,
  StageTrace,
  VehicleCandidate,
} from '@/lib/contracts/types';

import type { SearchWithCandidates } from './queries/searches';
import type {
  AuthenticityResultRow,
  CaseRow,
  CorpusMatchRow,
  GeoCandidateRow,
  LedgerEntryRow,
  SearchRow,
} from './types';

export function toGeoCandidate(row: GeoCandidateRow): GeoCandidate {
  return {
    id: row.id,
    rank: row.rank,
    center: { lat: row.lat, lon: row.lon },
    radiusM: row.radius_m,
    precision: row.precision,
    place: row.place,
    confidence: row.confidence,
    evidence: row.evidence,
    review: row.review,
  };
}

export function toVehicleCandidate(row: {
  rank: number;
  make: string;
  model: string;
  generation: string;
  color: string | null;
  vpic: { makeId?: number; modelId?: number } | Record<string, never>;
  similarity: number;
  reference_image_url: string | null;
  review: GeoCandidate['review'];
}): VehicleCandidate {
  return {
    rank: row.rank,
    make: row.make,
    model: row.model,
    generation: row.generation,
    ...(row.color ? { color: row.color } : {}),
    ...(Object.keys(row.vpic).length > 0 ? { vpic: row.vpic } : {}),
    similarity: row.similarity,
    ...(row.reference_image_url ? { referenceImageUrl: row.reference_image_url } : {}),
    review: row.review,
  };
}

/**
 * `provenance` is `{}` on a row written before the C2PA check ran. `in` alone does
 * not narrow the empty-object branch away, so the predicate is explicit.
 */
function hasManifestField(
  value: AuthenticityResultRow['provenance'],
): value is Extract<AuthenticityResultRow['provenance'], { hasManifest: boolean }> {
  return 'hasManifest' in value;
}

export function toAuthenticityResult(row: AuthenticityResultRow): AuthenticityResult {
  return {
    verdict: row.verdict,
    confidence: row.confidence,
    evidence: row.evidence,
    ...(row.suppressed_by.length > 0 ? { suppressedBy: row.suppressed_by } : {}),
    ppv: row.ppv,
    // Absence of a C2PA manifest means nothing and must never read as fakery —
    // platforms strip manifests on upload ~100% of the time. `hasManifest: false`
    // is the honest default for a row written before the provenance check ran.
    provenance: hasManifestField(row.provenance) ? row.provenance : { hasManifest: false },
  };
}

export function toCorpusMatch(row: CorpusMatchRow): CorpusMatch {
  return {
    rank: row.rank,
    // A purged corpus nulls these pointers. Empty string would be a lie about a
    // record we no longer hold; the UI must show the match as orphaned instead.
    recordId: row.record_id ?? '',
    corpusId: row.corpus_id ?? '',
    similarity: row.similarity,
    relation: row.relation,
    ...(row.thumbnail_url ? { thumbnailUrl: row.thumbnail_url } : {}),
    review: row.review,
  };
}

export function toCaseFile(row: CaseRow): CaseFile {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    ...(row.reference ? { reference: row.reference } : {}),
    status: row.status,
    createdBy: row.created_by ?? '',
    createdAt: row.created_at,
  };
}

export function toLedgerEntry(row: LedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    caseId: row.case_id,
    searchId: row.search_id,
    writtenAt: row.written_at,
    writtenBy: row.written_by ?? '',
    summary: row.summary,
    ...(row.corroboration ? { corroboration: row.corroboration } : {}),
  };
}

/** A search whose cascade has not reached the quality gate yet. */
const PENDING_QUALITY: QualityGate = {
  passed: false,
  components: { resolutionPx: { w: 0, h: 0 } },
  refusalReason: 'The quality gate has not run yet.',
  degraded: false,
};

const PENDING_PROVENANCE: ResultProvenance = { models: {}, totalCostUsd: 0 };

function isQualityGate(value: SearchRow['quality']): value is QualityGate {
  return 'passed' in value;
}

function isProvenance(value: SearchRow['provenance']): value is ResultProvenance {
  return 'models' in value;
}

/**
 * Builds the `SearchResult` the UI renders.
 *
 * Note what is NOT done here: nothing invents a passing quality gate for a search
 * still in flight. An unfinished search reads as refused-with-a-reason, so a
 * half-rendered result surface can never look like a finished one.
 */
export function toSearchResult(row: SearchWithCandidates): SearchResult {
  const geo = row.geo_candidates.map(toGeoCandidate);
  const vehicles = row.vehicle_candidates.map(toVehicleCandidate);
  const corpusMatches = row.corpus_matches.map(toCorpusMatch);

  return {
    id: row.id,
    module: row.module,
    imageId: row.image_id,
    quality: isQualityGate(row.quality) ? row.quality : PENDING_QUALITY,
    ...(geo.length > 0 ? { geo } : {}),
    ...(vehicles.length > 0 ? { vehicles } : {}),
    ...(row.authenticity_results
      ? { authenticity: toAuthenticityResult(row.authenticity_results) }
      : {}),
    ...(corpusMatches.length > 0 ? { corpusMatches } : {}),
    stages: row.stages as StageTrace[],
    provenance: isProvenance(row.provenance) ? row.provenance : PENDING_PROVENANCE,
    createdAt: row.created_at,
  };
}
