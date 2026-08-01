/**
 * REFINE — stage 2: street-level search scoped to ONE stage-1 region.
 *
 * This is the only path in the LIVE build that can produce `precision: 'street'`,
 * and the reason it can is that it is the only one that matches the frame against
 * indexed street imagery. Everything here is arranged around that single fact.
 *
 * Order of operations, and each step exists to stop a specific failure:
 *
 *   1. **Require a scope.** A refine with no bbox — or with a bbox so large it
 *      prunes nothing — is refused with a `policy` failure, the same refusal
 *      `vprRetrieval` makes for an unpruned index scan. The nearest neighbours of
 *      an ambiguous facade are scattered globally; an unscoped ANN query returns
 *      confident lookalikes from three continents.
 *   2. **Resolve the frame and gate it.** Local, free, and a refused gate returns
 *      no ranking at all.
 *   3. **Check coverage before spending.** `coverage.ts` counts rows. No rows, no
 *      street candidates — and critically, *no fallback*: we do not re-run a
 *      region-level guess and label it street. The result comes back well-formed,
 *      with zero candidates and the reason, and names the env var / harvest
 *      command that would change the answer.
 *   4. **Embed, then search inside the bbox.** The bbox is applied in SQL before
 *      the ANN ordering (`search_geo_candidates`), not as a post-filter.
 *   5. **Optionally boost with signage.** A sign stage 1 already read, geocoded
 *      and agreeing with a retrieval cluster, is the strongest combination this
 *      product produces. It corroborates; it never seeds.
 *   6. **Assemble under the invariants.** Every candidate carries a `vpr-match`
 *      citing the Mapillary image it matched, and `assertStreetPrecisionIsEarned`
 *      is called on every one. A candidate that cannot satisfy it is dropped and
 *      the drop is reported — not softened into a city-level result wearing the
 *      street candidate's rank.
 *
 * NOTHING IS FABRICATED. With no index configured — the current state of this
 * deployment — this module returns zero candidates and says so. There is no demo
 * mode, no sample metro, and no synthesised coordinate.
 */

import { z } from 'zod';
import {
  type Evidence,
  type EvidenceChain,
  type GeoCandidate,
  type QualityGate,
  type StageTrace,
  assertStreetPrecisionIsEarned,
  bandCeiling,
} from '@/lib/contracts/types';
import type { VlmClues } from '@/lib/contracts/schemas';
import {
  type WorkingCandidate,
  hasEarnedStreetPrecision,
  independentSignalCount,
} from '@/lib/cascade/candidate';
import { calibrate } from '@/lib/cascade/confidence';
import { COSTS, RETRIEVAL, TIMEOUTS_MS, modalCostUsd } from '@/lib/cascade/config';
import { type EmbedClient, ModalEmbedClient } from '@/lib/cascade/embedClient';
import { clusterByProximity, haversineM, precisionForRadius } from '@/lib/cascade/geo';
import { readImageHeader } from '@/lib/cascade/imageHeader';
import { callJson } from '@/lib/cascade/net';
import { extractMetadata } from '@/lib/cascade/preprocess';
import { evaluateQualityGate } from '@/lib/cascade/qualityGate';
import {
  Budget,
  type Bbox,
  type ImageRef,
  type Result,
  type StageContext,
  type StageFailure,
  failure,
  ok,
} from '@/lib/cascade/types';
import type { GeoVectorHit, GeoVectorSearch } from '@/lib/cascade/vprRetrieval';
import { type Geocoder, NominatimGeocoder, runOcrGeocodeVerifier } from '@/lib/verify/ocrGeocode';
import {
  COVERAGE,
  type CoverageInfo,
  type CoverageQuery,
  STREET_INDEX_GAP,
  getCoverage,
  resolveIndexEndpoint,
} from './coverage';
import type {
  CapabilityGap,
  EnvLike,
  LiveRefineRequest,
  RefineBbox,
  RefineRefusalKind,
  RefineRegion,
  RefineResult,
  RefineSignageClue,
} from './contract';
import { readUpload } from './uploads';

export type { RefineResult } from './contract';

// ---------------------------------------------------------------------------
// Tunables, with the reason each has the value it has
// ---------------------------------------------------------------------------

/**
 * Wall-clock ceiling for one refinement.
 *
 * Larger than `CASCADE_BUDGET_MS` (10s) and smaller than `LOCATE_BUDGET_MS`
 * (45s): there is no frontier-model call in this path, but there are two network
 * hops that can be cold — Modal's embed container and the first HNSW page after
 * an idle database.
 */
export const REFINE_BUDGET_MS = 20_000;

export const REFINE = {
  /**
   * ANN rows pulled inside the bbox. Higher than `RETRIEVAL.annLimit` (50)
   * because this surface returns 10 clusters rather than 5, and a cluster needs
   * several agreeing panoramas before its agreement score means anything.
   */
  annLimit: 100,
  /** Street candidates returned. The refine surface is specified at ~10. */
  maxCandidates: 10,
  /** Hits within this distance collapse into one candidate. Same as the cascade's. */
  clusterRadiusM: RETRIEVAL.clusterRadiusM,
  /**
   * HNSW read breadth. Deliberately above the pgvector default: a hard bbox
   * filter makes the graph walk discard more of what it finds, so it has to look
   * at more to fill a page.
   */
  efSearch: 300,
  /**
   * Widest scope we will run, measured on the bbox diagonal.
   *
   * The point of a scoped search is that the prune prunes. 400 km comfortably
   * contains any metro submap plus `RETRIEVAL.bboxPaddingKm` of margin — the
   * Allegheny County fallback in docs/HARVEST.md is ~50 km across — while still
   * refusing "refine in North America", which is an unpruned scan wearing a bbox
   * costume.
   */
  maxScopeKm: 400,
  /** Below this the bbox is a rounding error, not a region. */
  minScopeM: 50,
} as const;

const EMBED_GAP: CapabilityGap = {
  capability: 'Place-recognition descriptors',
  impact:
    'The frame could not be turned into an EigenPlaces-512 descriptor, so it could not be matched against the street index. Without a match there is no `vpr-match`, and without one nothing may claim street precision.',
  envVar: 'MODAL_EMBED_URL',
  howTo:
    'Deploy services/inference/app.py to Modal and set MODAL_EMBED_URL (plus MODAL_EMBED_TOKEN if the endpoint is protected).',
};

const GEOCODER_GAP: CapabilityGap = {
  capability: 'Signage geocoding',
  impact:
    'Text stage 1 read in the frame could not be geocoded, so it could not corroborate a retrieval match. This is the highest-yield street-level signal available; without it candidates rest on the descriptor alone.',
  envVar: 'NOMINATIM_URL',
  howTo:
    'Point it at a self-hosted Nominatim instance. The public instance is refused in code: its usage policy forbids exactly this query pattern.',
};

// ---------------------------------------------------------------------------
// Input / dependencies
// ---------------------------------------------------------------------------

export interface RefineInput {
  uploadId: string;
  region: RefineRegion;
  /**
   * Optional in the TYPE only, so the refusal path is reachable and testable.
   * A call without it is refused; it is not run unscoped. See `resolveScope`.
   */
  bbox?: RefineBbox;
  signage?: readonly RefineSignageClue[];
  budgetMs?: number;
  signal?: AbortSignal;
}

export interface StoredFrame {
  bytes: Uint8Array;
  mime?: string;
}

export interface RefineDeps {
  /** `undefined` resolves from env; explicit `null` forces the unconfigured path. */
  coverage?: CoverageQuery | null;
  embed?: EmbedClient | null;
  search?: GeoVectorSearch | null;
  geocoder?: Geocoder | null;
  /** Reads the uploaded frame. Injected by tests; production uses the local store. */
  readFrame?: (uploadId: string) => Promise<StoredFrame | null>;
  env?: EnvLike;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function refineInRegion(
  input: RefineInput,
  deps: RefineDeps = {},
): Promise<RefineResult> {
  try {
    return await run(input, deps);
  } catch (e) {
    // Nothing in this module is permitted to throw across its boundary. Reaching
    // here is a bug, and it is reported as one rather than as a 500.
    return refusal(
      input,
      'not-configured',
      `Refinement failed before it could produce a result: ${describe(e)}. This is an internal fault, not an input problem.`,
      unconfiguredCoverage(input.bbox),
    );
  }
}

async function run(input: RefineInput, deps: RefineDeps): Promise<RefineResult> {
  const env = deps.env ?? process.env;
  const budget = new Budget(input.budgetMs ?? REFINE_BUDGET_MS);
  const stages: StageTrace[] = [];
  const evidence: Evidence[] = [];
  const unavailable: CapabilityGap[] = [];
  const models: Record<string, string> = {};
  const sources: Record<string, string> = {};

  // --- 1. the scope IS the architecture -----------------------------------
  const scope = resolveScope(input.bbox);
  if (!scope.ok) {
    return refusal(input, 'policy', scope.error.reason, unconfiguredCoverage(input.bbox));
  }
  const bbox = scope.value;

  // --- 2. resolve the frame + gate it (local, free) ------------------------
  const readFrame = deps.readFrame ?? defaultReadFrame;
  const frame = await readFrame(input.uploadId);
  if (!frame) {
    return refusal(
      input,
      'no-input',
      `No stored upload for ${input.uploadId}. Upload the image again — .lantage-uploads may have been cleared.`,
      unconfiguredCoverage(bbox),
      bbox,
    );
  }

  const preprocessStart = Date.now();
  const header = readImageHeader(frame.bytes);
  const metadata = await extractMetadata(frame.bytes);
  const image: ImageRef = {
    imageId: input.uploadId,
    bytes: frame.bytes,
    ...(frame.mime ? { mimeType: frame.mime } : {}),
  };
  const quality = evaluateQualityGate({ image, header, metadata, bytes: frame.bytes });
  stages.push({ stage: 'preprocess', ranMs: Date.now() - preprocessStart, costUsd: 0 });
  stages.push({
    stage: 'quality-gate',
    ranMs: 0,
    costUsd: 0,
    ...(quality.passed ? {} : { skipped: { reason: quality.refusalReason ?? 'refused' } }),
  });

  if (!quality.passed) {
    return {
      ...emptyResult(input, bbox, unconfiguredCoverage(bbox), quality),
      stages,
      refusal: {
        kind: 'quality-gate',
        reason:
          quality.refusalReason ??
          'The frame failed the quality gate, so no ranking was produced and nothing was spent.',
      },
      unavailable: [
        {
          capability: 'Street-level refinement',
          impact: `The quality gate refused this frame, so no retrieval ran and no ranking was produced. ${quality.refusalReason ?? ''}`.trim(),
          howTo: 'Upload the original file rather than a resized copy or a screenshot of it.',
        },
      ],
    };
  }

  // --- 3. coverage, before a single cent is spent --------------------------
  const coverageStart = Date.now();
  const coverage = await getCoverage(bbox, {
    ...(deps.coverage === undefined ? {} : { query: deps.coverage }),
    env,
    timeoutMs: budget.timeoutFor(COVERAGE.timeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const coverageMs = Date.now() - coverageStart;

  if (!coverage.available) {
    // The whole point of the module. No index here means no street candidates —
    // NOT a region-level guess relabelled. The array is empty and stays empty.
    stages.push({
      stage: 'vpr-retrieval',
      ranMs: coverageMs,
      costUsd: 0,
      skipped: { reason: coverage.reason },
    });
    if (coverage.gap) unavailable.push(coverage.gap);
    return {
      ...emptyResult(input, bbox, coverage, quality),
      stages,
      unavailable,
    };
  }

  if (coverage.indexBuilds && coverage.indexBuilds.length > 0) {
    sources.mapillary = coverage.indexBuilds.join(', ');
  }

  // --- 4. embed, then search inside the bbox -------------------------------
  const embed = deps.embed === undefined ? defaultEmbedClient(env) : deps.embed;
  const search = deps.search === undefined ? defaultVectorSearch(env) : deps.search;

  if (!embed || !search) {
    const gap = !embed ? EMBED_GAP : STREET_INDEX_GAP;
    stages.push({
      stage: 'vpr-retrieval',
      ranMs: coverageMs,
      costUsd: 0,
      skipped: {
        reason: !embed
          ? 'The index covers this area, but no embedding service is wired, so the frame could not be turned into a descriptor to match with.'
          : 'The index covers this area, but no vector-search endpoint is wired, so the ANN query could not run.',
      },
    });
    unavailable.push(gap);
    return { ...emptyResult(input, bbox, coverage, quality), stages, unavailable };
  }

  const retrievalStart = Date.now();
  if (!budget.canAfford(TIMEOUTS_MS.embed + TIMEOUTS_MS.vectorSearch)) {
    stages.push({
      stage: 'vpr-retrieval',
      ranMs: Date.now() - retrievalStart,
      costUsd: 0,
      skipped: { reason: 'Not enough time left in the refine budget to run retrieval.' },
    });
    return {
      ...emptyResult(input, bbox, coverage, quality),
      stages,
      refusal: { kind: 'budget-exhausted', reason: 'The refine budget ran out before retrieval.' },
    };
  }

  const embedded = await embed.embed({
    image,
    models: ['eigenplaces'],
    timeoutMs: budget.timeoutFor(TIMEOUTS_MS.embed),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!embedded.ok) {
    stages.push({
      stage: 'vpr-retrieval',
      ranMs: Date.now() - retrievalStart,
      costUsd: 0,
      skipped: { reason: embedded.error.reason },
    });
    if (embedded.error.kind === 'not-configured') unavailable.push(EMBED_GAP);
    return { ...emptyResult(input, bbox, coverage, quality), stages, unavailable };
  }

  const descriptor = embedded.value.embeddings.eigenplaces;
  const vector = descriptor?.vector;
  if (!vector || vector.length === 0) {
    stages.push({
      stage: 'vpr-retrieval',
      ranMs: Date.now() - retrievalStart,
      costUsd: 0,
      skipped: {
        reason: 'The embedding service returned no place-recognition vector, so nothing was searched.',
      },
    });
    return { ...emptyResult(input, bbox, coverage, quality), stages, unavailable };
  }
  models.vpr = descriptor?.version ? `eigenplaces-512@${descriptor.version}` : 'eigenplaces-512';

  const found = await search.searchGeoCandidates({
    embedding: vector,
    bbox,
    limit: REFINE.annLimit,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const retrievalMs = Date.now() - retrievalStart;

  if (!found.ok) {
    stages.push({
      stage: 'vpr-retrieval',
      ranMs: retrievalMs,
      costUsd: modalCostUsd(embedded.value.tookMs || retrievalMs),
      skipped: { reason: found.error.reason },
    });
    return { ...emptyResult(input, bbox, coverage, quality), stages, unavailable };
  }

  const hits = found.value.hits.filter(
    (h) => Number.isFinite(h.lat) && Number.isFinite(h.lon) && Number.isFinite(h.similarity),
  );
  const indexBuild = found.value.indexBuild ?? coverage.indexBuilds?.[0];

  stages.push({
    stage: 'vpr-retrieval',
    ranMs: retrievalMs,
    costUsd: modalCostUsd(embedded.value.tookMs || retrievalMs) + COSTS.vectorSearchUsdPerCall,
    ...(hits.length === 0
      ? {
          skipped: {
            reason: `The index holds ${coverage.indexedImages?.toLocaleString('en-US') ?? 'imagery'} image(s) in this region but none of them matched this frame. The frame may not be of an indexed street, or the street it shows has no contributed coverage.`,
          },
        }
      : {}),
  });

  if (hits.length === 0) {
    return { ...emptyResult(input, bbox, coverage, quality), stages, unavailable };
  }

  // --- 5. clusters -> working candidates ----------------------------------
  const working = buildWorkingCandidates(hits, input, bbox);
  for (const candidate of working) evidence.push(...candidate.evidence);

  // --- 6. optional signage corroboration ----------------------------------
  const geocoder = deps.geocoder === undefined ? defaultGeocoder(env) : deps.geocoder;
  const signage = [...(input.signage ?? [])];
  if (signage.length > 0) {
    if (!geocoder) {
      unavailable.push(GEOCODER_GAP);
    } else {
      const verified = await runOcrGeocodeVerifier({
        candidates: working,
        clues: cluesFromSignage(signage),
        geocoder,
        priorBbox: bbox,
        ctx: stageContext(input.uploadId, image, budget, input.signal),
      });
      stages.push(verified.trace);
      evidence.push(...verified.evidence);
      if (verified.evidence.length > 0) models.geocoder = geocoder.name;
    }
  }

  // --- 7. assembly under the invariants -----------------------------------
  const assembled = finaliseStreetCandidates(working, quality);
  if (assembled.rejected.length > 0) {
    unavailable.push({
      capability: 'Street-level precision',
      impact: `${assembled.rejected.length} retrieval cluster(s) could not be shown because their evidence chain carried no vpr-match or signage-ocr, and street precision is earned by one of those or not at all. They were dropped rather than downgraded — this surface exists to return street candidates.`,
      howTo: 'This is an integrity guard firing, not an input problem. Report it.',
    });
  }

  return {
    id: crypto.randomUUID(),
    uploadId: input.uploadId,
    region: input.region,
    bbox,
    coverage,
    quality,
    candidates: assembled.candidates,
    evidence,
    stages,
    unavailable,
    provenance: {
      models,
      sources,
      ...(indexBuild ? { indexBuild } : {}),
      totalCostUsd: stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
    },
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scope — the refusal that makes this a *scoped* search
// ---------------------------------------------------------------------------

/**
 * Validates the prune, or refuses.
 *
 * This mirrors `vprRetrieval`'s `policy` failure deliberately: both refuse to
 * run an ANN query that has not been geographically constrained first. The extra
 * checks here are the ones a hand-built request can get wrong — an inverted
 * bbox silently returns zero rows in SQL, and a planet-sized one is technically
 * a bbox while pruning nothing at all.
 */
export function resolveScope(bbox: RefineBbox | undefined): Result<Bbox, StageFailure> {
  if (!bbox) {
    return {
      ok: false,
      error: failure(
        'policy',
        'Refinement is a SCOPED search and will not run without a bbox. An unpruned planet-scale ANN query returns globally scattered lookalikes with high similarity scores, which is precisely the failure this two-stage design exists to avoid. Pick a region from the stage-1 results and refine inside it.',
      ),
    };
  }

  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every((n) => Number.isFinite(n))) {
    return {
      ok: false,
      error: failure('policy', 'The bbox contains a non-finite number, so no scope could be applied.'),
    };
  }
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return {
      ok: false,
      error: failure(
        'policy',
        'The bbox falls outside the coordinate system. Order is [west, south, east, north] = [minLon, minLat, maxLon, maxLat] — longitude first.',
      ),
    };
  }
  if (west >= east || south >= north) {
    return {
      ok: false,
      error: failure(
        'policy',
        'The bbox is inverted or empty. Order is [west, south, east, north] — longitude first. An inverted bbox matches zero rows in SQL, which would read as "no coverage" rather than as the input error it is.',
      ),
    };
  }

  const diagonalM = haversineM({ lat: south, lon: west }, { lat: north, lon: east });
  if (diagonalM < REFINE.minScopeM) {
    return {
      ok: false,
      error: failure(
        'policy',
        `The bbox is ${Math.round(diagonalM)} m across, which is smaller than a single indexed camera position. Scope the refinement to the region, not to a point.`,
      ),
    };
  }
  if (diagonalM > REFINE.maxScopeKm * 1000) {
    return {
      ok: false,
      error: failure(
        'policy',
        `The bbox is ${Math.round(diagonalM / 1000).toLocaleString('en-US')} km across, above the ${REFINE.maxScopeKm} km ceiling for a scoped search. A prune this wide prunes nothing: the ANN query would return lookalikes from across the area with scores indistinguishable from a real match. Refine one stage-1 region at a time.`,
      ),
    };
  }

  return ok([west, south, east, north]);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function buildWorkingCandidates(
  hits: GeoVectorHit[],
  input: RefineInput,
  bbox: Bbox,
): WorkingCandidate[] {
  const clusters = clusterByProximity(hits, REFINE.clusterRadiusM);

  const working = clusters.map((cluster, index) => {
    const members = [...cluster.members].sort((a, b) => b.similarity - a.similarity);
    const top = members[0];
    const spanM = Math.max(0, ...members.map((m) => haversineM(cluster.center, m)));
    const radiusM = Math.max(RETRIEVAL.streetRadiusM, spanM);

    // Cluster score: the best match, nudged by how many independent panoramas
    // agree with it. Agreement across headings and sequences is what separates a
    // real match from one lucky descriptor.
    const agreement = Math.min(1, members.length / 5);
    const rawScore = Math.min(1, top.similarity * (0.85 + 0.15 * agreement));
    const earnsStreet = top.similarity >= RETRIEVAL.streetPrecisionMinSimilarity;

    const candidate: WorkingCandidate = {
      id: `${input.uploadId}-refine-${index + 1}`,
      center: cluster.center,
      radiusM,
      precision: earnsStreet ? 'street' : precisionForRadius(radiusM),
      place: {
        label: `${cluster.center.lat.toFixed(5)}, ${cluster.center.lon.toFixed(5)}`,
        ...(input.region.admin1 ? { admin1: input.region.admin1 } : {}),
        ...(input.region.country ? { country: input.region.country } : {}),
      },
      rawScore,
      // Up to three cited panoramas per candidate: enough for an analyst to
      // check agreement across headings, few enough to read.
      evidence: members.slice(0, 3).map((m) => vprMatchEvidence(m, input.region, bbox)),
      calibrationSet: 'vprRetrieval',
      facts: {
        kind: 'retrieval-agreement',
        within: members.length,
        of: hits.length,
        radiusM,
        place: input.region.label,
      },
    };
    return candidate;
  });

  return working.sort((a, b) => b.rawScore - a.rawScore).slice(0, REFINE.maxCandidates);
}

/**
 * The citation that earns street precision.
 *
 * Mirrors `vprRetrieval`'s match evidence — which is module-private — and adds
 * the scope, because on this surface the analyst also needs to see that the
 * search was confined to the region they picked rather than run worldwide.
 */
export function vprMatchEvidence(hit: GeoVectorHit, region: RefineRegion, bbox: Bbox): Evidence {
  return {
    kind: 'vpr-match',
    claim: `This frame matches indexed street imagery at ${hit.lat.toFixed(5)}, ${hit.lon.toFixed(5)} (cosine similarity ${hit.similarity.toFixed(3)}${hit.compassAngle != null ? `, camera heading ${Math.round(hit.compassAngle)}°` : ''}), found by searching only inside ${region.label} — bbox [${bbox.map((n) => n.toFixed(3)).join(', ')}].`,
    verifiable:
      'Open the linked Mapillary image and compare it with the frame side by side — roofline, window spacing, kerb, pole placement, street furniture. If they are not the same place, mark this candidate incorrect: the ranking is only as good as this comparison.',
    ...(hit.thumbUrl ? { cropUrl: hit.thumbUrl } : {}),
    reference: {
      label: `Mapillary ${hit.mapillaryId}`,
      url: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(hit.mapillaryId)}&focus=photo`,
      mapillaryId: hit.mapillaryId,
    },
    weight: Math.max(0, Math.min(1, hit.similarity)),
  };
}

export interface AssembledCandidates {
  candidates: GeoCandidate[];
  /** Ids dropped because their evidence chain could not earn street precision. */
  rejected: string[];
}

/**
 * Working candidates -> contract candidates, for the refine surface.
 *
 * Why not `finaliseCandidates` from `cascade/candidate.ts`: that helper hard-caps
 * at `RETRIEVAL.maxCandidates` (5), which is the stage-1 *region* cap, and it
 * downgrades an unearned street claim to `city`. Neither is right here — this
 * surface is specified at ~10 street candidates, and a refine result that
 * silently contains a city-level region is the exact confusion the two-stage
 * split exists to prevent.
 *
 * Everything that is an invariant is still the shared implementation:
 * `independentSignalCount`, `calibrate`, `bandCeiling`,
 * `hasEarnedStreetPrecision` and `assertStreetPrecisionIsEarned` are all
 * imported, never reimplemented.
 */
export function finaliseStreetCandidates(
  working: readonly WorkingCandidate[],
  gate: QualityGate,
): AssembledCandidates {
  const ranked = [...working]
    .sort((a, b) => b.rawScore - a.rawScore)
    .slice(0, REFINE.maxCandidates);

  const candidates: GeoCandidate[] = [];
  const rejected: string[] = [];

  for (const c of ranked) {
    if (c.evidence.length === 0) {
      rejected.push(c.id);
      continue;
    }
    // A refine candidate exists because retrieval found it. One that reaches
    // here without a vpr-match or a signage-ocr is a bug upstream, and the
    // honest response is to drop it rather than to publish a street claim the
    // contract forbids or a region-level result the operator did not ask for.
    if (!hasEarnedStreetPrecision(c.evidence)) {
      rejected.push(c.id);
      continue;
    }

    const signals = independentSignalCount(c.evidence);
    const confidence = calibrate({
      set: c.calibrationSet,
      raw: c.rawScore,
      independentSignals: signals,
      facts: c.facts,
    });
    const ceiling = bandCeiling(gate, confidence.band);
    const capped = ceiling !== confidence.band;

    const candidate: GeoCandidate = {
      id: c.id,
      rank: candidates.length + 1,
      center: c.center,
      // Never zero: a point estimate is a claim this product does not make.
      radiusM: Math.max(RETRIEVAL.streetRadiusM, Math.round(c.radiusM)),
      precision: c.precision,
      place: c.place,
      confidence: {
        ...confidence,
        band: ceiling,
        reason: capped
          ? `${confidence.reason} Capped at '${ceiling}': ${gate.refusalReason ?? 'the input failed a quality check'}`
          : confidence.reason,
      },
      evidence: c.evidence as EvidenceChain,
      review: 'unreviewed',
    };

    // The law. `hasEarnedStreetPrecision` above already guarantees it passes, so
    // a throw here means a future edit broke the guard — fail loudly rather than
    // ship an unearned street claim.
    assertStreetPrecisionIsEarned(candidate);
    candidates.push(candidate);
  }

  return { candidates, rejected };
}

// ---------------------------------------------------------------------------
// Request schema — validated at the HTTP boundary
// ---------------------------------------------------------------------------

const BboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const LiveRefineRequestSchema = z.object({
  uploadId: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'An upload id is the sha256 of the stored bytes: 64 lowercase hex characters.'),
  region: z.object({
    candidateId: z.string().max(200).optional(),
    label: z.string().min(1).max(200),
    admin1: z.string().max(200).optional(),
    country: z.string().max(200).optional(),
  }),
  // Required, with no default. A default here would silently turn a client bug
  // into an unscoped search, which is the one thing this module refuses to be.
  bbox: BboxSchema,
  signage: z
    .array(
      z.object({
        observed: z.string().min(1).max(300),
        legibility: z.enum(['clear', 'partial', 'guessed']),
        kind: z.enum(['business-name', 'street-sign', 'address-number', 'transit-sign']),
        bbox: BboxSchema.optional(),
      }),
    )
    .max(20)
    .optional(),
});

/**
 * Compile-time proof that what the schema parses IS the contract's request.
 *
 * Directional on purpose: if a future edit loosens the schema — makes `bbox`
 * optional, widens a signage kind — this stops compiling instead of letting an
 * off-contract body through the route.
 */
const _schemaMatchesContract: (parsed: z.infer<typeof LiveRefineRequestSchema>) => LiveRefineRequest =
  (parsed) => parsed;
void _schemaMatchesContract;

// ---------------------------------------------------------------------------
// Wiring — defaults resolved from env, all of them degradable
// ---------------------------------------------------------------------------

async function defaultReadFrame(uploadId: string): Promise<StoredFrame | null> {
  const found = await readUpload(uploadId);
  return found ? { bytes: found.bytes, mime: found.mime } : null;
}

function defaultEmbedClient(env: EnvLike): EmbedClient | null {
  if (!env.MODAL_EMBED_URL) return null;
  return new ModalEmbedClient(env.MODAL_EMBED_URL, env.MODAL_EMBED_TOKEN);
}

function defaultGeocoder(env: EnvLike): Geocoder | null {
  // The class itself refuses the public Nominatim instance; this only decides
  // whether there is anything to call at all.
  return env.NOMINATIM_URL ? new NominatimGeocoder(env.NOMINATIM_URL) : null;
}

/**
 * Region-pruned ANN over PostgREST.
 *
 * `src/lib/cascade/wiring.ts` already binds this for the audited `/api/search`
 * path, but it is `server-only` and builds its client through `next/headers`,
 * which the LIVE path cannot use. The RPC contract is identical and the bbox is
 * still applied inside the SQL, before the `<=>` ordering.
 */
export function defaultVectorSearch(env: EnvLike = process.env): GeoVectorSearch | null {
  const endpoint = resolveIndexEndpoint(env);
  if (!endpoint) return null;

  return {
    async searchGeoCandidates({ embedding, bbox, limit, signal }) {
      if (embedding.length !== 512) {
        return {
          ok: false,
          error: failure(
            'invalid-response',
            `Expected a 512-d EigenPlaces descriptor, got ${embedding.length}. mapillary_images.embedding is halfvec(512) — MegaLoc-8448 cannot be HNSW-indexed in pgvector at all.`,
          ),
        };
      }

      const res = await callJson({
        url: `${endpoint.restUrl}/rpc/search_geo_candidates`,
        method: 'POST',
        headers: {
          apikey: endpoint.key,
          authorization: `Bearer ${endpoint.key}`,
        },
        body: {
          query_embedding: embedding,
          p_metro: null,
          p_index_build: null,
          // The prune. Applied as a WHERE before the ANN ordering by the SQL
          // function — see supabase/migrations/…_search_functions.sql.
          p_bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
          p_limit: limit,
          p_ef_search: REFINE.efSearch,
        },
        timeoutMs: TIMEOUTS_MS.vectorSearch,
        schema: GeoRpcRowsSchema,
        ...(signal ? { signal } : {}),
        label: 'street index',
      });
      if (!res.ok) return res;

      return ok({
        hits: res.value.map((r) => ({
          mapillaryId: r.mapillary_id,
          lat: r.lat,
          lon: r.lon,
          similarity: r.similarity,
          compassAngle: r.compass_angle ?? null,
          ...(r.thumb_url ? { thumbUrl: r.thumb_url } : {}),
          ...(r.sequence_id ? { sequenceId: r.sequence_id } : {}),
          ...(r.captured_at ? { capturedAt: r.captured_at } : {}),
        })),
        ...(res.value[0]?.index_build ? { indexBuild: res.value[0].index_build } : {}),
      });
    },
  };
}

const GeoRpcRowsSchema = z.array(
  z.object({
    mapillary_id: z.string(),
    lat: z.number(),
    lon: z.number(),
    similarity: z.number(),
    compass_angle: z.number().nullable().optional(),
    captured_at: z.string().nullable().optional(),
    thumb_url: z.string().nullable().optional(),
    sequence_id: z.string().nullable().optional(),
    index_build: z.string().nullable().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A `VlmClues` carrying only what stage 1 actually read.
 *
 * `runOcrGeocodeVerifier` reads `clues.text` and nothing else, so the remaining
 * arrays are empty rather than filled with plausible-looking observations. An
 * invented clue here would geocode into a confident wrong street address, which
 * is the documented VLM failure mode this codebase is built around.
 */
export function cluesFromSignage(signage: readonly RefineSignageClue[]): VlmClues {
  return {
    text: signage.map((s) => ({
      observed: s.observed,
      legibility: s.legibility,
      kind: s.kind,
      ...(s.bbox ? { bbox: s.bbox } : {}),
    })),
    infrastructure: [],
    environment: [],
    architecture: [],
    regionPrior: [],
    insufficientSignal: false,
  };
}

/** `runOcrGeocodeVerifier` wants a full StageContext; four fields are ever read. */
function stageContext(
  searchId: string,
  image: ImageRef,
  budget: Budget,
  signal?: AbortSignal,
): StageContext {
  return {
    searchId,
    image,
    budget,
    signal: signal ?? new AbortController().signal,
    emit: () => {},
  };
}

/**
 * Coverage placeholder for the paths that refuse before the probe runs.
 *
 * It reports `no-index-configured` because that is literally what is known at
 * that point: nothing was counted. It never reports `available: true`.
 */
function unconfiguredCoverage(bbox: RefineBbox | undefined): CoverageInfo {
  return {
    available: false,
    code: 'no-index-configured',
    reason:
      'Coverage was not checked: the request was refused before any index query ran, so nothing about this area has been verified either way.',
    bbox: bbox ? [bbox[0], bbox[1], bbox[2], bbox[3]] : [0, 0, 0, 0],
    gap: STREET_INDEX_GAP,
  };
}

function emptyResult(
  input: RefineInput,
  bbox: RefineBbox,
  coverage: CoverageInfo,
  quality: QualityGate,
): RefineResult {
  return {
    id: crypto.randomUUID(),
    uploadId: input.uploadId,
    region: input.region,
    bbox,
    coverage,
    quality,
    candidates: [],
    evidence: [],
    stages: [],
    unavailable: [],
    provenance: { models: {}, sources: {}, totalCostUsd: 0 },
    createdAt: new Date().toISOString(),
  };
}

/** A well-formed refusal. Zero candidates, a stated kind, and a reason. */
export function refusal(
  input: RefineInput,
  kind: RefineRefusalKind,
  reason: string,
  coverage: CoverageInfo,
  bbox?: RefineBbox,
): RefineResult {
  const scope: RefineBbox = bbox ?? input.bbox ?? [0, 0, 0, 0];
  return {
    ...emptyResult(input, scope, coverage, {
      passed: false,
      // Zero is not a measurement and must not read as one: the refusal reason
      // states that nothing was measured.
      components: { resolutionPx: { w: 0, h: 0 } },
      degraded: false,
      refusalReason: reason,
    }),
    unavailable: kind === 'policy' ? [] : [STREET_INDEX_GAP],
    refusal: { kind, reason },
  };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
