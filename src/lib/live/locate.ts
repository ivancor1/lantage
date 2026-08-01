/**
 * LOCATE — where an outdoor photo was taken.
 *
 * Five measurements, in this order, and every one of them is a thing that
 * actually happened:
 *
 *   1. EXIF/XMP        local, no key, no network. GPS is recorded as a CLAIM.
 *   2. quality gate    real pixel dimensions from the container header.
 *   3. clue extraction the vision model enumerates observations, not places.
 *   4. resolution      region *labels* become coordinates via a gazetteer, or
 *                      via the model's own stated estimate, or not at all.
 *   5. assembly        `finaliseCandidates` applies the contract invariants.
 *
 * What this module will not do, and the reasons:
 *
 * - **EXIF GPS never becomes the answer.** It is trivially editable. It rides in
 *   the ledger at weight 0 as a claim for the analyst to test against the visual
 *   evidence, which is the standard o3 was observed holding itself to when it
 *   rejected falsified GPS rather than parroting it.
 * - **Nothing here can claim street precision.** LOCATE has no retrieval index
 *   and does no OCR geocode, so there is no `vpr-match` and no `signage-ocr` in
 *   any evidence chain it produces. `assertStreetPrecisionIsEarned` is called on
 *   every candidate anyway: if a future edit invents a street claim, it throws.
 * - **A region the model cannot place is reported unresolved, not centred.**
 *   `GeoCandidate.center` is required by the contract, so a candidate without
 *   coordinates cannot exist. The alternative to inventing one is to say the
 *   region could not be resolved and name the env var that would fix it — which
 *   is what `unresolvedRegions` and the `CapabilityGap` are for.
 * - **A prior whose `supportedBy` cites nothing we can find is discarded.** That
 *   is the documented VLM failure mode (the ACL 2026 GeoRC study: the model
 *   recognises a place, then fabricates the support). An unsupported region is
 *   not a weaker lead, it is not a lead.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Evidence,
  type GeoCandidate,
  type QualityGate,
  type StageTrace,
  assertStreetPrecisionIsEarned,
} from '@/lib/contracts/types';
import type { VlmClues } from '@/lib/contracts/schemas';
import { type WorkingCandidate, finaliseCandidates } from '@/lib/cascade/candidate';
import { COSTS, RETRIEVAL, TIMEOUTS_MS } from '@/lib/cascade/config';
import { bboxContains, bboxRadiusM, precisionForRadius } from '@/lib/cascade/geo';
import { type HeaderInfo, readImageHeader } from '@/lib/cascade/imageHeader';
import { type MetadataFacts, extractMetadata } from '@/lib/cascade/preprocess';
import { evaluateQualityGate } from '@/lib/cascade/qualityGate';
import { Budget, type Bbox, type ImageRef, type StageContext } from '@/lib/cascade/types';
import { clueEvidence } from '@/lib/cascade/vlmClues';
import { type Geocoder, NominatimGeocoder, cropUrl } from '@/lib/verify/ocrGeocode';
import { type CapabilityGap, type LiveAnalyzeRequest, VISION_GAP } from './contract';
// Explicit `/index`: the unit tests run on Node's type-stripping loader, whose
// shim appends `.ts` to an extensionless relative specifier and would resolve
// './vision' to a non-existent './vision.ts' rather than to the directory.
import { type EnvLike, type LiveVisionProvider, selectProvider, sumCostUsd } from './vision/index';

// ---------------------------------------------------------------------------
// Tunables, with the reason each has the value it has
// ---------------------------------------------------------------------------

/**
 * Wall-clock ceiling for one LOCATE run.
 *
 * Deliberately larger than `CASCADE_BUDGET_MS` (10s). The cascade's budget is
 * sized for a six-stage pipeline where the VLM is one gated call among several;
 * LOCATE *is* the vision call and has no retrieval to preserve time for.
 *
 * Measured 2026-07-31 on the current defaults (`scripts/bench-locate.ts`, 12 runs,
 * 1568px frame): the vision call is 6.8-9.3s, and everything else in this module
 * together is under 5ms. It was 22.4s before the model and reasoning-effort
 * defaults changed, which is where the old "10-20s legitimately" note came from.
 * The ceiling stays well above the median on purpose — one run in that set stalled
 * at the vendor and was cut off by the 30s vision timeout, and a budget trimmed to
 * the median would convert ordinary tail latency into a refusal.
 */
export const LOCATE_BUDGET_MS = 45_000;

export const LOCATE_TIMEOUTS_MS = {
  vision: 30_000,
  /** Self-hosted gazetteer on the local network. */
  geocode: TIMEOUTS_MS.geocode,
} as const;

/**
 * Radius floors, in metres. A candidate's radius must express real uncertainty,
 * and these are the smallest honest values for each resolution route.
 *
 * `geocoded`: a gazetteer gives a precise centroid for the *place name*, but the
 * claim being made is "the frame was taken in this place" on the strength of
 * inferred visual conventions. Frontier VLMs run ~90% country / ~40% city on
 * street-view imagery, so nothing below city scale is earned — hence the repo's
 * own `RETRIEVAL.cityRadiusM`.
 *
 * `modelEstimated`: the centre came from the model's recollection of where a
 * place is, with no gazetteer to check it. That is coarser again, so the floor is
 * region scale.
 */
const RADIUS_FLOOR_M = {
  geocoded: RETRIEVAL.cityRadiusM,
  modelEstimated: 25_000,
} as const;

/** Cap on how much of the technique doc is appended to the prompt. */
const TECHNIQUE_CHARS = 4_000;

const GEOCODER_GAP: CapabilityGap = {
  capability: 'Region-label geocoding',
  impact:
    'The vision model returns place NAMES, not coordinates. With no gazetteer wired, a named region cannot be turned into a mappable candidate — so those regions are listed as unresolved rather than given an invented centre.',
  envVar: 'NOMINATIM_URL',
  howTo:
    'Point it at a self-hosted Nominatim instance. The public instance is refused in code: its usage policy forbids exactly this query pattern.',
};

const TECHNIQUE_GAP: CapabilityGap = {
  capability: 'Geolocation technique checklist',
  impact:
    'docs/GEOGUESSR.md was not found, so the model ran on the base clue prompt without the delineator, route-shield, guardrail and utility-pole checklist. Fewer region-level signals get enumerated.',
  howTo: 'Add docs/GEOGUESSR.md, or set LANTAGE_TECHNIQUE_DOC to a path.',
};

const RANKING_GAP: CapabilityGap = {
  capability: 'Measured region ranking',
  impact:
    "Candidate order comes from the vision model's own self-reported confidence, recalibrated against a provisional literature prior — not from a measured retrieval score. There is no index to match against in this deployment, so treat the order as a reading list, not a ranking.",
  howTo:
    'Build the Mapillary VPR index (docs/HARVEST.md) to add an independently measured signal.',
};

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface LocateInput {
  /**
   * Upload id. Used as the image id in every evidence citation and in every crop
   * URL, so it is the difference between a checkable citation and a dead link.
   *
   * Optional here only because the orchestrator's LOCATE adapter does not send
   * this key — it sends `upload` and `image` instead. It went unnoticed because
   * nothing throws on a missing id: candidates came back as `undefined-region-1`
   * with crops at `/api/images/undefined/crop`, which is a silently broken
   * evidence trail rather than an error. `resolveUploadId` accepts any of the
   * three, so both callers work.
   */
  uploadId?: string;
  /** The upload record, as the orchestrator's adapter passes it. */
  upload?: { id?: string };
  /** The resolved image reference, as the orchestrator's adapter passes it. */
  image?: ImageRef;
  /** The bytes as uploaded. Never a URL: vendors cannot reach local disk. */
  bytes: Uint8Array;
  mime?: string;
  filename?: string;
  hints?: LiveAnalyzeRequest['hints'];
  budgetMs?: number;
  signal?: AbortSignal;
  /**
   * The caller's own quality gate, when it already ran one.
   *
   * Supplying this means "preprocess and the quality gate are already done and
   * already reported" — the orchestrator runs both before dispatching, and passes
   * the verdict in. LOCATE then neither re-runs the gate nor emits its own
   * `preprocess` / `quality-gate` traces, which is what produced two of each row
   * in a real run's stage list. Omit it and LOCATE does the whole thing itself,
   * which is how the unit tests and the bench drive it.
   */
  quality?: QualityGate;
  /** Container dimensions, when the caller already read them. */
  header?: HeaderInfo;
  /** EXIF/XMP facts, when the caller already extracted them. */
  metadata?: MetadataFacts;
}

/**
 * The id, from whichever field the caller populated.
 *
 * Falls back to a marker string rather than `undefined`: an id that reads as a
 * missing id in a crop URL is debuggable, and `'undefined'` is not.
 */
export function resolveUploadId(input: LocateInput): string {
  return input.uploadId ?? input.upload?.id ?? input.image?.imageId ?? 'unknown-upload';
}

/** A region the model named that could not be placed on the globe. */
export interface UnresolvedRegion {
  label: string;
  admin1?: string;
  country?: string;
  /** The model's own confidence in the region, uncalibrated. */
  rawConfidence: number;
  /** Why it could not be resolved. */
  reason: string;
}

export interface LocateResult {
  geo: GeoCandidate[];
  /** Evidence not tied to one candidate: EXIF, and the full clue ledger. */
  evidence: Evidence[];
  stages: StageTrace[];
  gaps: CapabilityGap[];
  models: Record<string, string>;
  costUsd: number;
  /** Included because the caller must render a refusal, and this is where it is decided. */
  quality: QualityGate;
  unresolvedRegions: UnresolvedRegion[];
}

export interface LocateDeps {
  /** `undefined` selects from env; `null` forces the no-vision path. */
  provider?: LiveVisionProvider | null;
  geocoder?: Geocoder | null;
  /** Returns the technique checklist, or null when there is none. */
  readTechniqueDoc?: () => Promise<string | null>;
  env?: EnvLike;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function locate(input: LocateInput, deps: LocateDeps = {}): Promise<LocateResult> {
  const env = deps.env ?? process.env;
  const budget = new Budget(input.budgetMs ?? LOCATE_BUDGET_MS);
  const stages: StageTrace[] = [];
  const evidence: Evidence[] = [];
  const gaps: CapabilityGap[] = [];
  const models: Record<string, string> = {};
  const unresolvedRegions: UnresolvedRegion[] = [];

  const uploadId = resolveUploadId(input);
  // The caller already ran and reported both local steps; re-running them would
  // duplicate the work and, more visibly, duplicate the rows a reader sees in the
  // stage list.
  const callerAlreadyMeasured = input.quality !== undefined;

  // --- 1. preprocess: header + metadata, both local ------------------------
  const preprocessStart = Date.now();
  const header = input.header ?? readImageHeader(input.bytes);
  const metadata = input.metadata ?? (await extractMetadata(input.bytes));
  evidence.push(...metadataEvidence(metadata, header, uploadId));
  models.exif = 'exifr@7';
  if (!callerAlreadyMeasured) {
    stages.push({ stage: 'preprocess', ranMs: Date.now() - preprocessStart, costUsd: 0 });
  }

  // --- 2. quality gate ----------------------------------------------------
  const gateStart = Date.now();
  const image: ImageRef = {
    imageId: uploadId,
    bytes: input.bytes,
    ...(input.mime ? { mimeType: input.mime } : {}),
  };
  const quality =
    input.quality ?? evaluateQualityGate({ image, header, metadata, bytes: input.bytes });
  if (!callerAlreadyMeasured) {
    stages.push({
      stage: 'quality-gate',
      ranMs: Date.now() - gateStart,
      costUsd: 0,
      ...(quality.passed ? {} : { skipped: { reason: quality.refusalReason ?? 'refused' } }),
    });
  }

  if (!quality.passed) {
    // A failed gate returns no ranking. The metadata evidence still ships — it is
    // a record of the file, not a finding about the place.
    return { geo: [], evidence, stages, gaps, models, costUsd: 0, quality, unresolvedRegions };
  }

  // --- 3. clue extraction -------------------------------------------------
  const provider = deps.provider === undefined ? selectProvider(env) : deps.provider;
  if (!provider) {
    gaps.push(VISION_GAP);
    stages.push({
      stage: 'vlm-clues',
      ranMs: 0,
      skipped: {
        reason:
          'No vision model is configured, so nothing in the frame was read. LOCATE has no other signal: EXIF is a claim, not a location.',
      },
    });
    return {
      geo: [],
      evidence,
      stages,
      gaps,
      models,
      costUsd: sumCostUsd(stages.map((s) => s.costUsd)),
      quality,
      unresolvedRegions,
    };
  }

  const geocoder = deps.geocoder === undefined ? defaultGeocoder(env) : deps.geocoder;
  const technique = await (deps.readTechniqueDoc ?? (() => readTechniqueDoc(env)))();
  if (!technique) gaps.push(TECHNIQUE_GAP);

  // With no gazetteer, the only non-fabricating route to a coordinate is to ask
  // the model to place its own named regions and label the result as its estimate.
  const askForCoordinates = geocoder === null && provider.vendor !== 'gemini';

  const promptSuffix = buildPromptSuffix(technique, input.hints?.note);
  const visionStart = Date.now();
  const extraction = await provider.extractClues({
    image,
    timeoutMs: budget.timeoutFor(LOCATE_TIMEOUTS_MS.vision),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(promptSuffix ? { promptSuffix } : {}),
    ...(askForCoordinates ? { requestRegionCoordinates: true } : {}),
  });
  const visionMs = Date.now() - visionStart;

  if (!extraction.ok) {
    models.vision = provider.name;
    stages.push({ stage: 'vlm-clues', ranMs: visionMs, skipped: { reason: extraction.error.reason } });
    if (extraction.error.kind === 'not-configured') gaps.push(VISION_GAP);
    return {
      geo: [],
      evidence,
      stages,
      gaps,
      models,
      costUsd: sumCostUsd(stages.map((s) => s.costUsd)),
      quality,
      unresolvedRegions,
    };
  }

  const { clues, usage, notes } = extraction.value;
  models.vision = `${provider.vendor}:${extraction.value.modelVersion}`;
  models.visionImage = `${extraction.value.image.method}@scale=${extraction.value.image.scale.toFixed(3)}`;

  const visionTrace: StageTrace = {
    stage: 'vlm-clues',
    ranMs: visionMs,
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  };
  const visionNotes = [...notes, usage.costBasis];
  if (clues.insufficientSignal) {
    visionTrace.skipped = {
      reason: `The vision model reported insufficient signal in the frame to constrain a region. Its individual observations are still in the ledger. ${visionNotes.join(' ')}`,
    };
  }
  stages.push(visionTrace);

  // The whole clue list goes in the ledger, cited crop by crop, whether or not it
  // ends up supporting a candidate.
  evidence.push(...clueEvidence(clues, stageContext(image, budget, input.signal)));

  // --- 4. resolve region labels to coordinates ----------------------------
  const resolveStart = Date.now();
  const synthesis = await synthesise({
    clues,
    modelCoordinates: extraction.value.regionCoordinates,
    geocoder,
    budget,
    uploadId,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.hints?.bbox ? { bbox: input.hints.bbox } : {}),
  });
  unresolvedRegions.push(...synthesis.unresolved);

  stages.push({
    stage: 'verify-ocr',
    ranMs: Date.now() - resolveStart,
    costUsd: synthesis.geocodeCalls * COSTS.geocodeUsdPerCall,
    ...(synthesis.working.length === 0
      ? {
          skipped: {
            reason:
              synthesis.unresolved.length > 0
                ? `No region could be turned into a mappable candidate. ${synthesis.unresolved[0].reason}`
                : 'The vision model named no region it could support with the observations it listed, so nothing was ranked.',
          },
        }
      : {}),
  });

  if (geocoder) models.geocoder = geocoder.name;
  if (synthesis.unresolved.length > 0 && !geocoder) gaps.push(GEOCODER_GAP);
  if (synthesis.working.length > 0) gaps.push(RANKING_GAP);

  // --- 5. assembly under the contract invariants --------------------------
  const geo = finaliseCandidates(synthesis.working, quality);
  // Belt and braces. LOCATE produces no vpr-match and no signage-ocr, so a
  // street claim here would mean a future edit broke the rule.
  for (const candidate of geo) assertStreetPrecisionIsEarned(candidate);

  return {
    geo,
    evidence,
    stages,
    gaps,
    models,
    costUsd: sumCostUsd(stages.map((s) => s.costUsd)),
    quality,
    unresolvedRegions,
  };
}

/**
 * A well-formed refusal. Used when the caller already knows the input is
 * unusable — wrong module, missing upload, two images for a one-image module.
 */
export function locateRefusal(reason: string, quality?: QualityGate): LocateResult {
  return {
    geo: [],
    evidence: [],
    stages: [],
    gaps: [],
    models: {},
    costUsd: 0,
    quality:
      quality ??
      {
        passed: false,
        // Zero is not a measurement here and must not read as one: the refusal
        // reason states that nothing was measured.
        components: { resolutionPx: { w: 0, h: 0 } },
        degraded: false,
        refusalReason: reason,
      },
    unresolvedRegions: [],
  };
}

// ---------------------------------------------------------------------------
// Candidate synthesis
// ---------------------------------------------------------------------------

interface SynthesisResult {
  working: WorkingCandidate[];
  unresolved: UnresolvedRegion[];
  geocodeCalls: number;
}

async function synthesise(args: {
  clues: VlmClues;
  modelCoordinates?: ReadonlyArray<{ label: string; lat: number; lon: number; radiusKm?: number }>;
  geocoder: Geocoder | null;
  budget: Budget;
  uploadId: string;
  signal?: AbortSignal;
  bbox?: Bbox;
}): Promise<SynthesisResult> {
  const { clues, geocoder, budget, uploadId } = args;
  const working: WorkingCandidate[] = [];
  const unresolved: UnresolvedRegion[] = [];
  let geocodeCalls = 0;

  if (clues.insufficientSignal) {
    // The model said it cannot tell. Ranking its region list anyway would be
    // overriding the one honest thing it did.
    return { working, unresolved, geocodeCalls };
  }

  const priors = [...clues.regionPrior].sort((a, b) => b.rawConfidence - a.rawConfidence);

  for (const [index, prior] of priors.entries()) {
    const support = matchSupportingClues(clues, prior.supportedBy, uploadId);
    if (support.evidence.length === 0) {
      unresolved.push({
        label: prior.label,
        ...(prior.admin1 ? { admin1: prior.admin1 } : {}),
        ...(prior.country ? { country: prior.country } : {}),
        rawConfidence: prior.rawConfidence,
        reason:
          'Discarded: the region cited support that does not appear anywhere in the observation list, which is the signature of a fabricated justification. Nothing was ranked from it.',
      });
      continue;
    }

    const placed = await place({
      prior,
      geocoder,
      budget,
      modelCoordinates: args.modelCoordinates,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    geocodeCalls += placed.geocodeCalls;

    if (!placed.location) {
      unresolved.push({
        label: prior.label,
        ...(prior.admin1 ? { admin1: prior.admin1 } : {}),
        ...(prior.country ? { country: prior.country } : {}),
        rawConfidence: prior.rawConfidence,
        reason: placed.reason,
      });
      continue;
    }

    if (args.bbox && !bboxContains(args.bbox, placed.location.center)) {
      unresolved.push({
        label: prior.label,
        ...(prior.admin1 ? { admin1: prior.admin1 } : {}),
        ...(prior.country ? { country: prior.country } : {}),
        rawConfidence: prior.rawConfidence,
        reason:
          'Dropped: it falls outside the bounding box the operator constrained the search to. Narrowing is applied after resolution so the exclusion is visible rather than silent.',
      });
      continue;
    }

    const radiusM = Math.max(placed.location.radiusM, RADIUS_FLOOR_M[placed.location.route]);
    working.push({
      id: `${uploadId}-region-${index + 1}`,
      center: placed.location.center,
      radiusM,
      // Never finer than what a radius can support, and `precisionForRadius`
      // cannot return 'street' by construction.
      precision: precisionForRadius(radiusM),
      place: {
        label: prior.label,
        ...(prior.admin1 ? { admin1: prior.admin1 } : {}),
        ...(prior.country ? { country: prior.country } : {}),
      },
      // The model's own number. Recalibrated in `finaliseCandidates` against the
      // `vlmClues` set, whose curve caps hard at region level.
      rawScore: prior.rawConfidence,
      evidence: [...support.evidence, placed.location.evidence],
      calibrationSet: 'vlmClues',
      facts: {
        kind: 'vlm-clues',
        // Counts of the clues that support THIS region, not of the whole list.
        clueCount: support.evidence.length,
        categories: support.categories,
        label: prior.label,
      },
    });
  }

  return { working, unresolved, geocodeCalls };
}

interface PlacedLocation {
  center: { lat: number; lon: number };
  radiusM: number;
  route: 'geocoded' | 'modelEstimated';
  evidence: Evidence;
}

async function place(args: {
  prior: VlmClues['regionPrior'][number];
  geocoder: Geocoder | null;
  budget: Budget;
  modelCoordinates?: ReadonlyArray<{ label: string; lat: number; lon: number; radiusKm?: number }>;
  signal?: AbortSignal;
}): Promise<{ location: PlacedLocation | null; reason: string; geocodeCalls: number }> {
  const { prior, geocoder, budget } = args;
  const query = [prior.label, prior.admin1, prior.country].filter(Boolean).join(', ');

  if (geocoder) {
    if (!budget.canAfford(LOCATE_TIMEOUTS_MS.geocode)) {
      return {
        location: null,
        reason: 'The time budget ran out before this region could be geocoded.',
        geocodeCalls: 0,
      };
    }
    const res = await geocoder.geocode(query, {
      limit: 1,
      timeoutMs: budget.timeoutFor(LOCATE_TIMEOUTS_MS.geocode),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (res.ok && res.value.length > 0) {
      const hit = res.value[0];
      const center = { lat: hit.lat, lon: hit.lon };
      const radiusM = hit.bbox ? bboxRadiusM(hit.bbox) : RADIUS_FLOOR_M.geocoded;
      return {
        location: {
          center,
          radiusM,
          route: 'geocoded',
          evidence: {
            kind: 'vlm-clue',
            claim: `The region the model named — "${query}" — resolves to ${hit.label} in the gazetteer. The coordinate is the gazetteer's, not the model's.`,
            verifiable: `Search "${query}" in any mapping tool and confirm it lands where this candidate is drawn. Then check the observations above: the coordinate being right does not make the region right.`,
            reference: {
              label: hit.label,
              url: `https://www.openstreetmap.org/?mlat=${hit.lat}&mlon=${hit.lon}#map=9/${hit.lat}/${hit.lon}`,
            },
            // Resolving a name is not corroboration of the place — 'vlm-clue' is
            // in the non-corroborating set, so this cannot lift a band.
            weight: 0.2,
          },
        },
        reason: '',
        geocodeCalls: 1,
      };
    }
    return {
      location: null,
      reason: res.ok
        ? `The gazetteer returned no match for "${query}", so no coordinate was assigned.`
        : `The gazetteer could not be reached: ${res.error.reason}`,
      geocodeCalls: 1,
    };
  }

  const estimate = args.modelCoordinates?.find((c) => labelsMatch(c.label, prior.label));
  if (estimate) {
    const radiusM = Math.max(
      RADIUS_FLOOR_M.modelEstimated,
      (estimate.radiusKm ?? 0) * 1000,
    );
    return {
      location: {
        center: { lat: estimate.lat, lon: estimate.lon },
        radiusM,
        route: 'modelEstimated',
        evidence: {
          kind: 'vlm-clue',
          claim: `MODEL-ESTIMATED COORDINATE, not a gazetteer lookup: the model placed "${prior.label}" at ${estimate.lat.toFixed(3)}, ${estimate.lon.toFixed(3)} from its own recollection${estimate.radiusKm ? `, with a stated uncertainty of ~${Math.round(estimate.radiusKm)} km` : ''}. No gazetteer is configured to check it.`,
          verifiable: `Look up "${prior.label}" yourself and compare it to where this candidate is drawn. If the pin is in the wrong place, the region name may still be right — treat the two claims separately. Set NOMINATIM_URL to replace this estimate with a gazetteer resolution.`,
          weight: 0.1,
        },
      },
      reason: '',
      geocodeCalls: 0,
    };
  }

  return {
    location: null,
    reason: GEOCODER_GAP.impact,
    geocodeCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// Support matching — the anti-fabrication check
// ---------------------------------------------------------------------------

export interface SupportMatch {
  evidence: Evidence[];
  /** How many of the four clue categories contributed. */
  categories: number;
}

/**
 * Finds the observations a region prior actually cited.
 *
 * The prompt requires `supportedBy` to quote observations already listed. A
 * prior citing a string that appears nowhere above is the documented failure —
 * the model recognises a place and then writes plausible support for it. So the
 * match is deliberately generous about wording (a model paraphrases its own
 * observation) and strict about existence: no match, no candidate.
 */
export function matchSupportingClues(
  clues: VlmClues,
  supportedBy: readonly string[],
  imageId: string,
): SupportMatch {
  const buckets = [
    { name: 'text', items: clues.text },
    { name: 'infrastructure', items: clues.infrastructure },
    { name: 'environment', items: clues.environment },
    { name: 'architecture', items: clues.architecture },
  ] as const;

  const evidence: Evidence[] = [];
  const categories = new Set<string>();
  const seen = new Set<string>();

  for (const cited of supportedBy) {
    for (const bucket of buckets) {
      for (const clue of bucket.items) {
        if (!similar(cited, clue.observed)) continue;
        const key = `${bucket.name}:${clue.observed}`;
        if (seen.has(key)) continue;
        seen.add(key);
        categories.add(bucket.name);
        evidence.push({
          kind: 'vlm-clue',
          claim: `${bucket.name} observation cited in support of this region: "${clue.observed}" (seen ${clue.legibility}).`,
          verifiable: clue.bbox
            ? 'Open the linked crop and decide for yourself whether the frame shows this. A clue you cannot see is a clue to discard, and discarding it weakens this candidate directly.'
            : 'Look at the frame and decide whether it shows this. The model localised nothing for this observation, which is itself a reason to weight it lightly.',
          ...(clue.bbox ? { cropUrl: cropUrl(imageId, clue.bbox) } : {}),
          ...(clue.bbox
            ? { reference: { label: `crop [${clue.bbox.map((n) => n.toFixed(2)).join(', ')}]` } }
            : {}),
          weight: clue.legibility === 'clear' ? 0.45 : clue.legibility === 'partial' ? 0.25 : 0.08,
        });
      }
    }
  }

  return { evidence, categories: categories.size };
}

/** Normalised containment or high token overlap. */
function similar(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xs = new Set(x.split(' ').filter((t) => t.length > 2));
  const ys = new Set(y.split(' ').filter((t) => t.length > 2));
  if (xs.size === 0 || ys.size === 0) return false;
  let shared = 0;
  for (const token of xs) if (ys.has(token)) shared += 1;
  return shared / Math.min(xs.size, ys.size) >= 0.6;
}

function labelsMatch(a: string, b: string): boolean {
  return normalise(a) === normalise(b) || similar(a, b);
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Metadata evidence
// ---------------------------------------------------------------------------

/**
 * EXIF as a claim to test.
 *
 * Everything here is weight 0. That is not a formality: `independentSignalCount`
 * excludes `exif` from corroboration precisely so a forged tag cannot promote a
 * confidence band, and weight 0 keeps it out of the ranking arithmetic too.
 */
export function metadataEvidence(
  metadata: MetadataFacts,
  header: HeaderInfo,
  uploadId: string,
): Evidence[] {
  const out: Evidence[] = [];

  if (metadata.gps) {
    const { lat, lon } = metadata.gps;
    out.push({
      kind: 'exif',
      claim: `The file's metadata CLAIMS ${lat.toFixed(5)}, ${lon.toFixed(5)}. Recorded as a claim to check, never used as the answer and never used to seed the search.`,
      verifiable: `Run \`exiftool ${uploadId}\` on the original file to confirm the tag exists, then check whether the visual evidence below actually agrees with that coordinate. EXIF GPS is trivially editable; a coordinate that the frame contradicts is the most useful thing in the file.`,
      reference: {
        label: 'EXIF GPS claim',
        url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
      },
      weight: 0,
    });
  }

  const provenanceBits = [
    metadata.cameraMake && metadata.cameraModel
      ? `${metadata.cameraMake} ${metadata.cameraModel}`
      : metadata.cameraMake,
    metadata.lensModel ? `lens "${metadata.lensModel}"` : undefined,
    metadata.software ? `software "${metadata.software}"` : undefined,
    metadata.capturedAt ? `capture time ${metadata.capturedAt}` : undefined,
    metadata.digitalSourceType ? `digital source type "${metadata.digitalSourceType}"` : undefined,
    metadata.orientation !== undefined ? `orientation ${metadata.orientation}` : undefined,
  ].filter(Boolean);

  if (provenanceBits.length > 0) {
    out.push({
      kind: 'exif',
      claim: `Metadata present: ${provenanceBits.join(', ')}. ${metadata.tagCount} tags in total.`,
      verifiable:
        'Run `exiftool` on the original file and compare. This is chain-of-custody detail; none of it places the image, and a capture time is a claim like any other.',
      weight: 0,
    });
  }

  if (metadata.stripped) {
    out.push({
      kind: 'exif',
      claim: `No metadata at all (${header.format.toUpperCase()} container${header.width && header.height ? `, ${header.width}x${header.height}` : ''}). Normal for anything that has been through a platform, and not a finding.`,
      verifiable:
        'Run `exiftool` on the original file: platforms strip metadata on upload, so absence tells you about the delivery path, not about the image.',
      weight: 0,
    });
  } else if (provenanceBits.length === 0) {
    // Neither "GPS present" nor "camera present" nor "stripped" — the file has
    // tags, just none of the ones that bear on provenance. Saying so is the point:
    // the ledger must always state what the metadata situation actually was, or a
    // reader cannot tell "we looked and found nothing" from "we did not look".
    out.push({
      kind: 'exif',
      claim: `${metadata.tagCount} metadata tag(s) present in the ${header.format.toUpperCase()} container, but none of the camera, software, timestamp or GPS fields this module reads.`,
      verifiable:
        'Run `exiftool` on the original file to see the full tag list. Anything it shows that is not summarised here was read and found irrelevant to placing the image, not hidden.',
      weight: 0,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Prompt suffix + technique doc
// ---------------------------------------------------------------------------

/**
 * The operator's free-text hint, framed as a claim to test.
 *
 * Narrowing a search is legitimate; seeding the answer is not. A raw "believed to
 * be Western PA" in the prompt buys agreement, so it goes in wrapped in an
 * instruction to contradict it when the frame does.
 */
export function buildPromptSuffix(technique: string | null, note?: string): string {
  const parts: string[] = [];
  if (technique) {
    parts.push(
      `TECHNIQUE CHECKLIST — work through this before writing "regionPrior". It expands what counts as an observation; it does not license a guess.\n\n${technique}`,
    );
  }
  if (note?.trim()) {
    parts.push(
      `The investigator has supplied context: "${note.trim()}"\nTreat this as an UNVERIFIED CLAIM TO TEST, not a conclusion to support. If the frame contradicts it, say so and rank what you actually see. Do not add a region prior you cannot support with observations in your own list, and do not describe an observation you cannot see just because it would fit this context.`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Reads `docs/GEOGUESSR.md` and condenses it to the prompt-ready section.
 *
 * The doc carries its own "Prompt-ready extraction checklist" heading for exactly
 * this purpose, so that section is preferred; failing that, the headings and
 * bullets are taken in order. Either way it is capped — a 40KB reference in the
 * prompt costs tokens on every call and buries the schema instructions.
 */
export async function readTechniqueDoc(env: EnvLike = process.env): Promise<string | null> {
  const target = env.LANTAGE_TECHNIQUE_DOC ?? path.join(process.cwd(), 'docs', 'GEOGUESSR.md');
  try {
    const text = await readFile(target, 'utf8');
    return condenseTechnique(text);
  } catch {
    return null;
  }
}

export function condenseTechnique(markdown: string): string | null {
  const promptReady = /^#{2,3}\s.*prompt-ready[^\n]*$/im.exec(markdown);
  if (promptReady?.index !== undefined) {
    const start = promptReady.index;
    const rest = markdown.slice(start + promptReady[0].length);
    const nextHeading = /^#{2}\s/m.exec(rest);
    const section = rest.slice(0, nextHeading?.index ?? rest.length).trim();
    if (section.length > 0) return truncate(section, TECHNIQUE_CHARS);
  }

  const lines = markdown
    .split('\n')
    .filter((line) => /^(#{2,4}\s|\s*[-*]\s|\s*\d+\.\s)/.test(line))
    .map((line) => line.trim());
  if (lines.length === 0) return null;
  return truncate(lines.join('\n'), TECHNIQUE_CHARS);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}\n…(checklist truncated)`;
}

// ---------------------------------------------------------------------------
// Wiring helpers
// ---------------------------------------------------------------------------

function defaultGeocoder(env: EnvLike): Geocoder | null {
  // The class itself refuses the public Nominatim instance; this only decides
  // whether there is anything to call at all.
  return env.NOMINATIM_URL ? new NominatimGeocoder(env.NOMINATIM_URL) : null;
}

/** `clueEvidence` wants a full StageContext; only two fields are ever read. */
function stageContext(image: ImageRef, budget: Budget, signal?: AbortSignal): StageContext {
  return {
    searchId: image.imageId,
    image,
    budget,
    signal: signal ?? new AbortController().signal,
    emit: () => {},
  };
}
