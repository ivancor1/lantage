/**
 * VEHICLE — make / model / year-range / colour / body style, validated against
 * NHTSA vPIC.
 *
 * THE POINT OF THIS MODULE IS THE VALIDATION, NOT THE GUESS. A vision model will
 * happily name a plausible-sounding make and model for any car-shaped thing in a
 * frame, and fine-grained VMMR has high intra-class and low inter-class variance
 * — top-1 on exact make/model/year is unreliable and the literature is
 * consistent on this (docs/MASTER_PLAN.md §4). So every candidate the model
 * proposes is checked against NHTSA's vPIC taxonomy (free, no key, every US
 * vehicle since 1981). A make vPIC has never heard of is dropped outright and
 * recorded in the audit. A make vPIC knows but whose model string does not
 * resolve keeps only its `vpic.makeId` — the absent `modelId` IS the
 * "unverified" signal, structurally, in the contract's own type.
 *
 * We always return a ranked set, never a single confident answer.
 *
 * NO PLATE CHARACTERS, EVER. We ship no ALPR. Private plate reading is flatly
 * illegal in New Hampshire and Maine, restricted in Vermont / Arkansas / Utah /
 * Minnesota, and California's operator statute is generating active class
 * actions; independently, Mapillary's terms bar re-identifying or unblurring
 * plates and require *technical* safeguards, not just instructions. The prompt
 * forbids transcription and `redactPlateCharacters` enforces it on the way back,
 * before anything can be logged, persisted or ranked.
 *
 * NO FABRICATED VALUES. `VehicleCandidate.similarity` is required by the
 * contract and there is no reference-image gallery wired, so it carries the
 * vision model's own self-reported confidence — and that is stated in the
 * evidence ledger in those words. It is not presented as a measured similarity.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Evidence, EvidenceKind, StageTrace, VehicleCandidate } from '@/lib/contracts/types';
import type { CapabilityGap } from '@/lib/live/contract';
import { callJson } from '@/lib/cascade/net';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface VehicleImage {
  uploadId: string;
  bytes?: Uint8Array;
  /** Absolute path on local disk. Read when `bytes` is absent. */
  path?: string;
  /** Declared MIME type. Sniffed from the magic bytes when absent or wrong. */
  mime?: string;
}

export interface VehicleIdentifyOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Vision provider. Inject L1's `selectProvider()` adapter here to use the
   * shared multi-vendor client; when omitted this module falls back to its own
   * Anthropic call. See ANTHROPIC_ONLY_GAP for why the fallback is Anthropic-only.
   */
  vision?: VehicleVisionProvider;
  /** Injectable vPIC client, so the anti-hallucination check is testable offline. */
  vpic?: VpicClient;
}

/**
 * What a vPIC lookup concluded about one proposed candidate. Surfaced separately
 * from `vehicles` so the UI can say "2 of 5 candidates were dropped: NHTSA vPIC
 * does not list them" — the negative result is the product.
 */
export interface VpicAuditEntry {
  proposed: { make: string; model: string; years: string };
  status: 'verified' | 'make-only' | 'rejected' | 'unchecked';
  reason: string;
  /** The exact URL a human can open to repeat the check. */
  endpoint?: string;
  makeId?: number;
  modelId?: number;
}

export interface VehicleIdentifyResult {
  /** Ranked. Never a single answer when the model offered more. */
  vehicles: VehicleCandidate[];
  evidence: Evidence[];
  stages: StageTrace[];
  gaps: CapabilityGap[];
  models: Record<string, string>;
  sources: Record<string, string>;
  /** Real, from provider-reported token usage. 0 only when genuinely 0. */
  costUsd: number;
  vpicAudit: VpicAuditEntry[];
}

// ---------------------------------------------------------------------------
// Structured vision output — zod is the contract, the JSON Schema is derived
// ---------------------------------------------------------------------------

const Legibility = z.enum(['clear', 'partial', 'guessed']);

const BODY_STYLES = [
  'sedan',
  'coupe',
  'hatchback',
  'wagon',
  'suv',
  'crossover',
  'minivan',
  'van',
  'pickup-truck',
  'convertible',
  'bus',
  'box-truck',
  'semi-tractor',
  'motorcycle',
  'other',
  'unknown',
] as const;

const FEATURE_KINDS = [
  'grille',
  'headlight',
  'taillight',
  'badge-shape',
  'wheel',
  'roofline',
  'body-line',
  'window-line',
  'bumper',
  'mirror',
  'trim',
  'exhaust',
  'other',
] as const;

const VehicleFeatureSchema = z.strictObject({
  observed: z.string().min(1).max(400),
  kind: z.enum(FEATURE_KINDS),
  legibility: Legibility,
  /** [x0, y0, x1, y1] normalised 0..1, origin top-left. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});

/**
 * `yearFrom`/`yearTo` are a generation span, not a model year. 1981 is the
 * floor because that is where vPIC's coverage starts, so a candidate older than
 * that is unverifiable by construction.
 */
const ProposedCandidateSchema = z.strictObject({
  make: z.string().min(1).max(60),
  model: z.string().min(1).max(60),
  yearFrom: z.number().int().min(1981).max(2031),
  yearTo: z.number().int().min(1981).max(2031),
  bodyStyle: z.enum(BODY_STYLES),
  /** The model's own confidence. Labelled as a self-report everywhere it surfaces. */
  selfReportedConfidence: z.number().min(0).max(1),
  supportedBy: z.array(z.string().min(1).max(300)).min(1).max(8),
});

export const VehicleReadingSchema = z.strictObject({
  vehiclePresent: z.boolean(),
  color: z.strictObject({ name: z.string().min(1).max(40), legibility: Legibility }).nullable(),
  candidates: z.array(ProposedCandidateSchema).max(6),
  features: z.array(VehicleFeatureSchema).max(20),
  /** Plate *style* only — proportions, colour bands, slogan placement, mounting. */
  jurisdictionStyle: z
    .array(
      z.strictObject({
        observed: z.string().min(1).max(300),
        impliesRegions: z.array(z.string().min(1).max(80)).max(8),
      }),
    )
    .max(4),
  insufficientSignal: z.boolean(),
});

export type VehicleReading = z.infer<typeof VehicleReadingSchema>;

export const VEHICLE_PROMPT = `You are a forensic image analyst producing a vehicle identification for a human investigator who will independently verify every line you write.

Return a RANKED SET of candidates, not one answer. Fine-grained make/model/year identification has high intra-class and low inter-class variance: top-1 is unreliable. Give 3 to 5 candidates whenever the frame supports it, ordered most likely first. If two makes are genuinely indistinguishable from this angle, list both.

Rules:
1. "features" contains only what is literally visible — the shape of a grille, the outline of a tail light, the spoke count of a wheel, a body crease. No inference and no model names in this list. This is the evidence an investigator will check against a reference photo, so describe shape and position, not identity.
2. "legibility" describes how clearly you SEE the thing, not how confident you are in what it means: "clear" = unambiguous, "partial" = occluded/blurred but readable, "guessed" = you are reconstructing it.
3. "bbox" is [x0, y0, x1, y1] normalised to 0..1 with the origin at the TOP-LEFT. Give it whenever you can localise the feature so the investigator can look at the same pixels. Use null when you cannot.
4. NEVER transcribe or guess licence-plate characters, in any field, under any circumstance. This is a hard prohibition, not a preference. For plates describe ONLY the jurisdiction style in "jurisdictionStyle": plate proportions, colour bands, slogan placement, mounting, sticker position. Characters are prohibited output and will be redacted before anyone reads your answer.
5. "yearFrom"/"yearTo" must span the whole GENERATION you believe this is, not a single model year. A single-year claim is not supportable from a photograph. Both must be 1981 or later.
6. "selfReportedConfidence" is your own estimate, 0..1. It will be labelled as your self-report, never presented as a measured similarity, so be honest rather than generous.
7. "supportedBy" must quote features you actually listed in "features". Do not include a candidate you cannot support from the visible evidence.
8. If there is no vehicle in the frame, set "vehiclePresent": false and return no candidates. If a vehicle is present but the frame does not constrain make and model, set "insufficientSignal": true and return few or no candidates. "I cannot tell" is a useful and correct answer here.
9. Use the manufacturer's own naming as NHTSA would list it (for example "Chevrolet", not "Chevy"; "F-150", not "F150"). Your candidates are validated against the NHTSA vPIC database and an invented name will be dropped.`;

// ---------------------------------------------------------------------------
// Vision provider boundary
// ---------------------------------------------------------------------------

export interface VehicleVisionRequest {
  image: { base64: string; mediaType: string };
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface VehicleVisionResult {
  /** Unvalidated JSON from the provider. Validated against the zod schema by us. */
  json: unknown;
  modelVersion: string;
  /** Computed from provider-reported token usage. Absent when not derivable. */
  costUsd?: number;
  attempts: number;
}

export interface VehicleVisionProvider {
  readonly name: string;
  extract(req: VehicleVisionRequest): Promise<Result<VehicleVisionResult, StageFailure>>;
}

// ---------------------------------------------------------------------------
// Constants — every tunable number with the reason it has the value it has
// ---------------------------------------------------------------------------

const TIMEOUTS_MS = {
  /** Vision extraction. Vehicle ID is a genuinely hard visual reasoning task. */
  vision: 90_000,
  /** One vPIC request. Public endpoint on a government host; be patient but bounded. */
  vpic: 8_000,
  /** Whole identification. */
  total: 150_000,
} as const;

/**
 * vPIC has no published numeric rate limit, only "an automated traffic rate
 * control mechanism". The community-observed soft limit is ~5 req/s, so requests
 * are serialised with at least this gap: ~4.5 req/s, comfortably under it. Being
 * throttled off a free public dataset would take the anti-hallucination check
 * offline, which is the one thing this module cannot lose.
 */
const VPIC_MIN_GAP_MS = 220;

/** vPIC's taxonomy changes on the order of months, not minutes. */
const VPIC_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const VPIC_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';

/** Longest edge we send to the vision model, in pixels. */
const MAX_IMAGE_EDGE_PX = 2576;

/** Above this we re-encode: providers reject oversized base64 payloads. */
const MAX_IMAGE_BYTES = 4_500_000;

/**
 * Published per-million-token prices for the models this module knows how to
 * bill. A model absent from this table gets costUsd omitted and a gap, rather
 * than a made-up number.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const DEFAULT_MODEL = process.env.LANTAGE_VEHICLE_MODEL ?? 'claude-opus-5';

export const VEHICLE_VISION_GAP: CapabilityGap = {
  capability: 'Vision model for vehicle identification',
  impact:
    'Vehicle returns no candidates. There is no offline substitute: make and model come from the image, and inventing one would be the exact failure this module exists to catch.',
  envVar: 'ANTHROPIC_API_KEY',
  howTo: 'Add it to .env.local in the project root, then restart the dev server.',
};

export const ANTHROPIC_ONLY_GAP: CapabilityGap = {
  capability: 'Non-Anthropic vision vendors for VEHICLE',
  impact:
    "This module's built-in client speaks Anthropic only, because it computes costUsd from provider-reported token usage against published prices and we will not guess another vendor's model id or rates. OPENAI_API_KEY / GEMINI_API_KEY are ignored here.",
  envVar: 'ANTHROPIC_API_KEY',
  howTo:
    'Either set ANTHROPIC_API_KEY, or pass the shared multi-vendor provider from @/lib/live/vision into identifyVehicle({ vision }).',
};

export const GALLERY_GAP: CapabilityGap = {
  capability: 'Reference-image gallery (measured visual similarity)',
  impact:
    "VehicleCandidate.similarity carries the vision model's self-reported confidence, not a measured descriptor distance, and referenceImageUrl is absent. Ranking is therefore a model self-report — the evidence ledger says so explicitly.",
  howTo:
    'Wire the DINOv2/CLIP embedding + vPIC-keyed reference gallery from docs/MASTER_PLAN.md §4 (Auto.dev at $0.001/image) and populate similarity from nearest-neighbour distance.',
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Never throws. A failure is an empty candidate list plus a stated gap. */
export async function identifyVehicle(
  image: VehicleImage,
  options: VehicleIdentifyOptions = {},
): Promise<VehicleIdentifyResult> {
  const stages: StageTrace[] = [];
  const gaps: CapabilityGap[] = [GALLERY_GAP];
  const evidence: Evidence[] = [];
  const models: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUTS_MS.total);

  try {
    // --- preprocess -------------------------------------------------------
    const prepStart = Date.now();
    const prepared = await prepareImage(image);
    if (!prepared.ok) {
      stages.push({
        stage: 'preprocess',
        ranMs: Date.now() - prepStart,
        skipped: { reason: prepared.error.reason },
        costUsd: 0,
      });
      return { vehicles: [], evidence, stages, gaps, models, sources, costUsd: 0, vpicAudit: [] };
    }
    stages.push({ stage: 'preprocess', ranMs: Date.now() - prepStart, costUsd: 0 });
    if (prepared.value.resized) {
      evidence.push({
        kind: 'vlm-clue',
        claim: `The frame was re-encoded to ${prepared.value.width}x${prepared.value.height} before analysis (from ${prepared.value.originalWidth}x${prepared.value.originalHeight}).`,
        verifiable:
          'Downscaling is lossy and can erase the badge and trim detail this identification keys on. Open the original upload at full size and confirm the cited features are visible there too.',
        weight: 0.1,
      });
    }

    // --- vision -----------------------------------------------------------
    const provider = options.vision ?? defaultProvider();
    if (!provider) {
      stages.push({
        stage: 'vlm-clues',
        ranMs: 0,
        skipped: { reason: VEHICLE_VISION_GAP.impact },
        costUsd: 0,
      });
      gaps.push(VEHICLE_VISION_GAP);
      if (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        gaps.push(ANTHROPIC_ONLY_GAP);
      }
      return { vehicles: [], evidence, stages, gaps, models, sources, costUsd: 0, vpicAudit: [] };
    }

    const visionStart = Date.now();
    const visionBudget = Math.min(TIMEOUTS_MS.vision, Math.max(0, deadline - Date.now()));
    const raw = await provider.extract({
      image: { base64: prepared.value.base64, mediaType: prepared.value.mediaType },
      timeoutMs: visionBudget,
      signal: options.signal,
    });
    if (!raw.ok) {
      stages.push({
        stage: 'vlm-clues',
        ranMs: Date.now() - visionStart,
        skipped: { reason: raw.error.reason },
        costUsd: 0,
      });
      gaps.push({
        capability: 'Vision model for vehicle identification',
        impact: `The vision model produced nothing: ${raw.error.reason}`,
        envVar: 'ANTHROPIC_API_KEY',
      });
      return { vehicles: [], evidence, stages, gaps, models, sources, costUsd: 0, vpicAudit: [] };
    }

    const costUsd = raw.value.costUsd ?? 0;
    models['vehicle-vision'] = raw.value.modelVersion;
    stages.push({
      stage: 'vlm-clues',
      ranMs: Date.now() - visionStart,
      costUsd: raw.value.costUsd,
    });
    if (raw.value.costUsd === undefined) {
      gaps.push({
        capability: 'Per-call cost accounting for the vision model',
        impact: `costUsd is reported as 0 because no published price is on file for "${raw.value.modelVersion}". The call was not free; the number is unknown and is not being guessed.`,
        envVar: 'LANTAGE_VEHICLE_MODEL',
        howTo: `Use one of: ${Object.keys(PRICE_PER_MTOK).join(', ')}.`,
      });
    }

    const parsed = VehicleReadingSchema.safeParse(raw.value.json);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      gaps.push({
        capability: 'Structured vehicle reading',
        impact: `The vision model went off-contract, so nothing was returned rather than a partially-parsed guess: ${detail}`,
      });
      return { vehicles: [], evidence, stages, gaps, models, sources, costUsd, vpicAudit: [] };
    }

    // Technical safeguard, applied before anything can be logged, persisted, or
    // ranked — not merely an instruction in the prompt.
    const reading = redactPlateCharacters(parsed.data);

    if (!reading.vehiclePresent || reading.candidates.length === 0) {
      evidence.push(...visualEvidence(reading));
      stages.push({
        stage: 'rerank',
        ranMs: 0,
        skipped: {
          reason: reading.vehiclePresent
            ? 'The vision model found a vehicle but could not constrain make and model, so there was nothing to validate.'
            : 'No vehicle in the frame.',
        },
        costUsd: 0,
      });
      return { vehicles: [], evidence, stages, gaps, models, sources, costUsd, vpicAudit: [] };
    }

    // --- vPIC validation + ranking ----------------------------------------
    const vpicStart = Date.now();
    const vpic = options.vpic ?? new NhtsaVpicClient();
    const validated = await validateAgainstVpic(reading, vpic, deadline, options.signal);
    stages.push({
      stage: 'rerank',
      ranMs: Date.now() - vpicStart,
      costUsd: 0,
      ...(validated.vehicles.length === 0
        ? { skipped: { reason: 'Every proposed candidate was rejected by NHTSA vPIC.' } }
        : {}),
    });
    sources['nhtsa-vpic'] = `${VPIC_BASE} (GetAllMakes + GetModelsForMakeIdYear/GetModelsForMake), queried ${new Date().toISOString()}`;
    // Visual features first — they are what a human checks — then the vPIC
    // verdicts that dropped or demoted candidates, then the ranking disclosure.
    evidence.push(...visualEvidence(reading, validated.vehicles[0]));
    evidence.push(...validated.evidence);
    if (validated.gap) gaps.push(validated.gap);

    evidence.push(selfReportDisclosure(validated.vehicles));

    return {
      vehicles: validated.vehicles,
      evidence,
      stages,
      gaps,
      models,
      sources,
      costUsd,
      vpicAudit: validated.audit,
    };
  } catch (e) {
    return {
      vehicles: [],
      evidence,
      stages,
      gaps: [
        ...gaps,
        {
          capability: 'Vehicle identification',
          impact: `The module failed unexpectedly and returned nothing rather than a partial result: ${describe(e)}`,
        },
      ],
      models,
      sources,
      costUsd: 0,
      vpicAudit: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Plate safeguard
// ---------------------------------------------------------------------------

const PLATE_CONTEXT = /\b(plate|plates|tag|tags|registration|licence|license|number\s*plate)\b/i;

/**
 * Belt-and-braces enforcement of the no-plate-characters rule.
 *
 * The prompt forbids transcribing plates, but Mapillary ToS §12 requires
 * technical safeguards, not just instructions — and these strings are about to
 * be written into an evidence ledger we can never edit. Any string that mentions
 * a plate has its alphanumeric runs redacted; style words survive, characters do
 * not. Model names and year ranges are untouched because they never appear in a
 * plate-context string.
 */
export function redactPlateCharacters(reading: VehicleReading): VehicleReading {
  return {
    ...reading,
    features: reading.features.map((f) => ({ ...f, observed: scrubIfPlate(f.observed) })),
    jurisdictionStyle: reading.jurisdictionStyle.map((j) => ({
      ...j,
      // Unconditional here: this field exists only to describe plate style, so
      // there is no legitimate alphanumeric plate-shaped token in it.
      observed: scrubPlateTokens(j.observed),
    })),
    candidates: reading.candidates.map((c) => ({
      ...c,
      supportedBy: c.supportedBy.map(scrubIfPlate),
    })),
  };
}

function scrubIfPlate(text: string): string {
  return PLATE_CONTEXT.test(text) ? scrubPlateTokens(text) : text;
}

function scrubPlateTokens(text: string): string {
  return text
    // Mixed letter+digit runs of 3+, in either order, with optional separators.
    .replace(/\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]{2,}(?:[-\s][A-Za-z0-9]{1,})*\b/g,
      '[plate characters redacted]')
    // Bare digit runs of 3+ (a plate can be all digits; "1500" in a trim name
    // never appears inside a plate-context string).
    .replace(/\b\d{3,}\b/g, '[redacted]')
    // All-caps runs of 3+ that are not obviously words we allow through.
    .replace(/\b[A-Z]{3,}\b/g, (m) => (PLATE_SAFE_WORDS.has(m) ? m : '[plate characters redacted]'));
}

const PLATE_SAFE_WORDS = new Set([
  'USA',
  'NEW',
  'THE',
  'AND',
  'LED',
  'SUV',
  'VIN',
  'DOT',
  'EU',
  'UK',
]);

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const WEIGHT_BY_LEGIBILITY: Record<'clear' | 'partial' | 'guessed', number> = {
  clear: 0.7,
  partial: 0.45,
  guessed: 0.2,
};

/**
 * `top` is the candidate that survived vPIC validation in first place, not the
 * vision model's own favourite — the whole point is that an investigator checks
 * the features against the reference we are actually putting in front of them.
 */
function visualEvidence(reading: VehicleReading, top?: VehicleCandidate): Evidence[] {
  const out: Evidence[] = [];
  const reference = top
    ? `a ${top.generation} ${top.make} ${top.model} reference photo`
    : 'a reference photo of each candidate';

  for (const f of reading.features) {
    out.push({
      kind: 'vlm-clue',
      claim: `${f.kind}: ${f.observed} (seen ${f.legibility})`,
      verifiable:
        `Crop the ${f.kind} from the frame` +
        (f.bbox
          ? ` at normalised bbox [${f.bbox.map((n) => n.toFixed(3)).join(', ')}]`
          : '') +
        ` and compare its shape against ${reference}. If the ${f.kind} does not match, the candidate is wrong regardless of the overall score.`,
      weight: WEIGHT_BY_LEGIBILITY[f.legibility],
    });
  }

  if (reading.color) {
    out.push({
      kind: 'vlm-clue',
      claim: `Body colour reads as ${reading.color.name} (seen ${reading.color.legibility}).`,
      verifiable:
        'Colour under mixed or low light is unreliable. Check the colour against a panel in direct light in the same frame, and treat it as a filter rather than an identifier.',
      weight: WEIGHT_BY_LEGIBILITY[reading.color.legibility] * 0.6,
    });
  }

  for (const j of reading.jurisdictionStyle) {
    out.push({
      kind: 'vlm-clue',
      claim: `Plate style: ${j.observed}${j.impliesRegions.length > 0 ? ` (consistent with ${j.impliesRegions.join(', ')})` : ''}`,
      verifiable:
        'Compare the plate proportions, colour bands and slogan placement against the current and recent plate designs for each named jurisdiction. Plate CHARACTERS are never read, transcribed or stored by this system, so this is a design comparison only.',
      weight: 0.35,
    });
  }

  if (reading.insufficientSignal) {
    out.push({
      kind: 'vlm-clue',
      claim:
        'The vision model flagged the frame as insufficient to constrain make and model with confidence.',
      verifiable:
        'Look at the frame and judge whether the grille, badge and lamp shapes are actually resolvable. If they are not, no candidate below is actionable on its own.',
      weight: 0.1,
    });
  }

  return out;
}

function selfReportDisclosure(vehicles: VehicleCandidate[]): Evidence {
  const scores = vehicles.map((v) => v.similarity.toFixed(2)).join(', ');
  return {
    kind: 'vlm-clue',
    claim:
      `Ranking uses the vision model's SELF-REPORTED confidence (${scores || 'none'}), not a measured ` +
      'visual similarity. No reference-image gallery is wired, so no descriptor distance was computed ' +
      "and `similarity` on every candidate below is the model's own number.",
    verifiable:
      'Re-run the same image and compare the reported figures: they are the model\'s self-assessment and reproducible as such, but they are not calibrated against any labelled set and must not be read as a probability of a correct match.',
    weight: 0.15,
  };
}

/**
 * `EvidenceKind` has no member for "hit in an authoritative reference
 * database", and `contracts/types.ts` is not this module's file to extend, so
 * vPIC results are filed under the nearest existing member. This is a known
 * contract gap: the union wants a `taxonomy-match` (or `reference-db`) kind.
 */
const VPIC_EVIDENCE_KIND: EvidenceKind = 'corpus-match';

// ---------------------------------------------------------------------------
// vPIC
// ---------------------------------------------------------------------------

export interface VpicMake {
  makeId: number;
  makeName: string;
}

export interface VpicModel {
  makeId: number;
  makeName: string;
  modelId: number;
  modelName: string;
}

export interface VpicClient {
  allMakes(signal?: AbortSignal): Promise<Result<VpicMake[], StageFailure>>;
  modelsForMake(
    make: { makeId: number; makeName: string },
    modelYear: number | undefined,
    signal?: AbortSignal,
  ): Promise<Result<{ models: VpicModel[]; endpoint: string }, StageFailure>>;
}

const VpicMakesSchema = z.object({
  Count: z.number(),
  Results: z.array(z.object({ Make_ID: z.number(), Make_Name: z.string() })),
});

const VpicModelsSchema = z.object({
  Count: z.number(),
  Results: z.array(
    z.object({
      Make_ID: z.number(),
      Make_Name: z.string(),
      Model_ID: z.number(),
      Model_Name: z.string(),
    }),
  ),
});

interface CacheEntry<T> {
  at: number;
  value: T;
}

const makesCache: { current: CacheEntry<VpicMake[]> | null } = { current: null };
const modelsCache = new Map<string, CacheEntry<{ models: VpicModel[]; endpoint: string }>>();
let vpicNextSlot = 0;

/** Serialise vPIC calls so we stay under the documented soft traffic limit. */
async function vpicGate(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, vpicNextSlot);
  vpicNextSlot = slot + VPIC_MIN_GAP_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * The real NHTSA vPIC client. Free, no key, and the endpoints below were
 * verified live against https://vpic.nhtsa.dot.gov/api/ (GetAllMakes returned
 * 12,308 makes; GetModelsForMakeIdYear/makeId/474/modelyear/2015 returned 62
 * Honda models; an invented make returns HTTP 200 with Count 0 rather than a
 * 404, which is why the code checks Count and not the status).
 */
export class NhtsaVpicClient implements VpicClient {
  readonly timeoutMs: number;

  constructor(timeoutMs: number = TIMEOUTS_MS.vpic) {
    this.timeoutMs = timeoutMs;
  }

  async allMakes(signal?: AbortSignal): Promise<Result<VpicMake[], StageFailure>> {
    const cached = makesCache.current;
    if (cached && Date.now() - cached.at < VPIC_CACHE_TTL_MS) return ok(cached.value);

    await vpicGate();
    const res = await callJson({
      url: `${VPIC_BASE}/getallmakes?format=json`,
      method: 'GET',
      timeoutMs: this.timeoutMs,
      schema: VpicMakesSchema,
      signal,
      label: 'NHTSA vPIC GetAllMakes',
    });
    if (!res.ok) return res;
    const makes = res.value.Results.map((r) => ({ makeId: r.Make_ID, makeName: r.Make_Name }));
    makesCache.current = { at: Date.now(), value: makes };
    return ok(makes);
  }

  async modelsForMake(
    make: { makeId: number; makeName: string },
    modelYear: number | undefined,
    signal?: AbortSignal,
  ): Promise<Result<{ models: VpicModel[]; endpoint: string }, StageFailure>> {
    const endpoint =
      modelYear === undefined
        ? `${VPIC_BASE}/getmodelsformake/${encodeURIComponent(make.makeName)}?format=json`
        : `${VPIC_BASE}/GetModelsForMakeIdYear/makeId/${make.makeId}/modelyear/${modelYear}?format=json`;

    const cached = modelsCache.get(endpoint);
    if (cached && Date.now() - cached.at < VPIC_CACHE_TTL_MS) return ok(cached.value);

    await vpicGate();
    const res = await callJson({
      url: endpoint,
      method: 'GET',
      timeoutMs: this.timeoutMs,
      schema: VpicModelsSchema,
      signal,
      label: 'NHTSA vPIC models',
    });
    if (!res.ok) return res;

    // vPIC returns each model once per body class, so the same Model_ID appears
    // several times. Dedupe on Model_ID.
    const seen = new Set<number>();
    const models: VpicModel[] = [];
    for (const r of res.value.Results) {
      if (seen.has(r.Model_ID)) continue;
      seen.add(r.Model_ID);
      models.push({
        makeId: r.Make_ID,
        makeName: r.Make_Name,
        modelId: r.Model_ID,
        modelName: r.Model_Name,
      });
    }
    const value = { models, endpoint };
    modelsCache.set(endpoint, { at: Date.now(), value });
    return ok(value);
  }
}

/** Test hook. */
export function resetVpicCache(): void {
  makesCache.current = null;
  modelsCache.clear();
  vpicNextSlot = 0;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface ModelMatch {
  model: VpicModel;
  kind: 'exact' | 'family';
}

/**
 * vPIC's model names are coarser than colloquial trim names — it lists
 * "Silverado", "Silverado HD" and "Silverado LD" but not "Silverado 1500", and
 * "F-150" normalises to the same token as "F150". So an exact match wins, and
 * failing that the longest vPIC name that is a prefix of the proposal is
 * accepted as the model FAMILY, which is reported as such.
 */
export function matchModel(proposed: string, models: readonly VpicModel[]): ModelMatch | null {
  const want = normalise(proposed);
  if (want.length === 0) return null;

  for (const m of models) {
    if (normalise(m.modelName) === want) return { model: m, kind: 'exact' };
  }

  let best: VpicModel | null = null;
  for (const m of models) {
    const have = normalise(m.modelName);
    if (have.length < 3) continue;
    if (!want.startsWith(have)) continue;
    if (!best || have.length > normalise(best.modelName).length) best = m;
  }
  return best ? { model: best, kind: 'family' } : null;
}

export function matchMake(proposed: string, makes: readonly VpicMake[]): VpicMake | null {
  const want = normalise(proposed);
  if (want.length === 0) return null;
  for (const m of makes) {
    if (normalise(m.makeName) === want) return m;
  }
  return null;
}

interface ValidationOutcome {
  vehicles: VehicleCandidate[];
  evidence: Evidence[];
  audit: VpicAuditEntry[];
  gap?: CapabilityGap;
}

async function validateAgainstVpic(
  reading: VehicleReading,
  vpic: VpicClient,
  deadline: number,
  signal?: AbortSignal,
): Promise<ValidationOutcome> {
  const evidence: Evidence[] = [];
  const audit: VpicAuditEntry[] = [];

  const makes = await vpic.allMakes(signal);
  if (!makes.ok) {
    /*
     * vPIC unreachable. The choice here is deliberate: we return NOTHING rather
     * than an unvalidated ranking. An unvalidated candidate list is exactly the
     * hallucinated output this module exists to intercept, and shipping it
     * because a government endpoint was slow would defeat the purpose.
     */
    for (const c of reading.candidates) {
      audit.push({
        proposed: { make: c.make, model: c.model, years: `${c.yearFrom}-${c.yearTo}` },
        status: 'unchecked',
        reason: makes.error.reason,
      });
    }
    return {
      vehicles: [],
      evidence,
      audit,
      gap: {
        capability: 'NHTSA vPIC validation',
        impact: `vPIC could not be reached (${makes.error.reason}), so no candidate could be checked. Candidates are withheld rather than returned unvalidated — an unchecked make/model list is the hallucination this module exists to catch.`,
        howTo: `Confirm ${VPIC_BASE}/getallmakes?format=json is reachable from this host, then re-run.`,
      },
    };
  }

  const verified: { candidate: VehicleCandidate; exactModel: boolean }[] = [];
  const makeOnly: VehicleCandidate[] = [];

  for (const c of reading.candidates) {
    const years = `${c.yearFrom}-${c.yearTo}`;
    const make = matchMake(c.make, makes.value);

    if (!make) {
      // vPIC positively does not list this manufacturer. Dropped, not ranked.
      audit.push({
        proposed: { make: c.make, model: c.model, years },
        status: 'rejected',
        reason: `NHTSA vPIC lists no make named "${c.make}" among its ${makes.value.length} registered makes. The candidate was dropped.`,
        endpoint: `${VPIC_BASE}/getallmakes?format=json`,
      });
      evidence.push({
        kind: VPIC_EVIDENCE_KIND,
        claim: `DROPPED — the vision model proposed "${c.make} ${c.model}" (${years}); NHTSA vPIC does not recognise the make "${c.make}".`,
        verifiable: `Open ${VPIC_BASE}/getallmakes?format=json and search for "${c.make}". It is not there, which is why this candidate is not in the results.`,
        reference: { label: 'NHTSA vPIC GetAllMakes', url: `${VPIC_BASE}/getallmakes?format=json` },
        weight: 0.8,
      });
      continue;
    }

    if (Date.now() > deadline) {
      audit.push({
        proposed: { make: c.make, model: c.model, years },
        status: 'unchecked',
        reason: 'The identification budget ran out before this candidate could be validated.',
      });
      continue;
    }

    // Try the generation's first year, then its last. Two requests at worst per
    // candidate, and the results are cached per (makeId, year) so candidates
    // sharing a make and year cost one lookup between them.
    const attempts = c.yearFrom === c.yearTo ? [c.yearFrom] : [c.yearFrom, c.yearTo];
    let match: ModelMatch | null = null;
    let endpoint: string | undefined;
    let listSize = 0;
    for (const year of attempts) {
      const res = await vpic.modelsForMake(
        { makeId: make.makeId, makeName: make.makeName },
        year,
        signal,
      );
      if (!res.ok) continue;
      endpoint = res.value.endpoint;
      listSize = res.value.models.length;
      match = matchModel(c.model, res.value.models);
      if (match) break;
    }

    if (!match) {
      // The make is real; the model string did not resolve. Keep it, but with no
      // `vpic.modelId` — the absent id is the unverified signal in the contract.
      audit.push({
        proposed: { make: c.make, model: c.model, years },
        status: 'make-only',
        reason: `NHTSA vPIC recognises the make "${make.makeName}" (id ${make.makeId}) but lists no model matching "${c.model}" for ${attempts.join(' or ')} among ${listSize} models. The model name is UNVERIFIED.`,
        endpoint,
        makeId: make.makeId,
      });
      evidence.push({
        kind: VPIC_EVIDENCE_KIND,
        claim: `UNVERIFIED MODEL — vPIC confirms the make "${make.makeName}" but not the model "${c.model}" for ${attempts.join(' or ')}. The candidate is ranked below every fully-verified one and carries no vPIC model id.`,
        verifiable: endpoint
          ? `Open ${endpoint} and look for "${c.model}". vPIC model names are coarser than trim names, so this may be a naming-granularity mismatch rather than an invented model — decide which by eye.`
          : `Query ${VPIC_BASE}/getmodelsformake/${encodeURIComponent(make.makeName)}?format=json and look for "${c.model}".`,
        reference: endpoint ? { label: 'NHTSA vPIC models', url: endpoint } : undefined,
        weight: 0.5,
      });
      makeOnly.push({
        rank: 0,
        make: make.makeName,
        model: c.model,
        generation: years,
        color: reading.color?.name,
        vpic: { makeId: make.makeId },
        similarity: c.selfReportedConfidence,
        review: 'unreviewed',
      });
      continue;
    }

    audit.push({
      proposed: { make: c.make, model: c.model, years },
      status: 'verified',
      reason:
        match.kind === 'exact'
          ? `NHTSA vPIC confirms make "${make.makeName}" (id ${make.makeId}) and model "${match.model.modelName}" (id ${match.model.modelId}).`
          : `NHTSA vPIC confirms make "${make.makeName}" (id ${make.makeId}) and the model family "${match.model.modelName}" (id ${match.model.modelId}); the trim "${c.model}" is not a separate vPIC model.`,
      endpoint,
      makeId: make.makeId,
      modelId: match.model.modelId,
    });
    evidence.push({
      kind: VPIC_EVIDENCE_KIND,
      claim:
        match.kind === 'exact'
          ? `vPIC confirms "${make.makeName} ${match.model.modelName}" exists (make id ${make.makeId}, model id ${match.model.modelId}) for ${attempts.join(' or ')}.`
          : `vPIC confirms the family "${make.makeName} ${match.model.modelName}" (make id ${make.makeId}, model id ${match.model.modelId}); "${c.model}" is a trim vPIC does not list separately.`,
      verifiable: endpoint
        ? `Open ${endpoint} and find model id ${match.model.modelId}. This confirms the make/model exists in the NHTSA taxonomy — it does NOT confirm the vehicle in the photo is one.`
        : `Query ${VPIC_BASE}/getmodelsformake/${encodeURIComponent(make.makeName)}?format=json.`,
      reference: endpoint ? { label: 'NHTSA vPIC models', url: endpoint } : undefined,
      weight: 0.8,
    });
    verified.push({
      exactModel: match.kind === 'exact',
      candidate: {
        rank: 0,
        make: make.makeName,
        // vPIC's own spelling for whatever it verified, plus the model's trim
        // when vPIC only matched the family — so the string stays useful without
        // implying vPIC blessed the trim.
        model:
          match.kind === 'exact'
            ? match.model.modelName
            : `${match.model.modelName} (${c.model})`,
        generation: years,
        color: reading.color?.name,
        vpic: { makeId: make.makeId, modelId: match.model.modelId },
        similarity: c.selfReportedConfidence,
        review: 'unreviewed',
      },
    });
  }

  // Fully verified first, then make-only; self-reported confidence within each
  // tier. A vPIC-confirmed model outranks an unverified one even when the model
  // liked the unverified one more, because the taxonomy check is the harder fact.
  const ranked = [
    ...verified
      .sort(
        (a, b) =>
          Number(b.exactModel) - Number(a.exactModel) ||
          b.candidate.similarity - a.candidate.similarity,
      )
      .map((v) => v.candidate),
    ...makeOnly.sort((a, b) => b.similarity - a.similarity),
  ].map((c, i) => ({ ...c, rank: i + 1 }));

  const gap =
    ranked.length > 0 && ranked.length < 3 && reading.candidates.length >= 3
      ? {
          capability: 'Top-3 vehicle candidates',
          impact: `The vision model offered ${reading.candidates.length} candidates but only ${ranked.length} survived vPIC validation. The rest are in vpicAudit with the reason each was dropped.`,
        }
      : undefined;

  return { vehicles: ranked, evidence, audit, gap };
}

// ---------------------------------------------------------------------------
// Image preparation
// ---------------------------------------------------------------------------

interface PreparedImage {
  base64: string;
  mediaType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  resized: boolean;
}

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

async function prepareImage(image: VehicleImage): Promise<Result<PreparedImage, StageFailure>> {
  let bytes: Uint8Array;
  if (image.bytes) {
    bytes = image.bytes;
  } else if (image.path) {
    try {
      bytes = new Uint8Array(await readFile(image.path));
    } catch (e) {
      return err(failure('no-input', `upload ${image.uploadId} could not be read: ${describe(e)}`));
    }
  } else {
    return err(failure('no-input', `upload ${image.uploadId} carried neither bytes nor a path`));
  }

  const sniffed = sniffMime(bytes);
  if (!sniffed) {
    return err(
      failure(
        'no-input',
        `upload ${image.uploadId} is not a JPEG, PNG, GIF or WebP, which are the formats a vision model accepts.`,
      ),
    );
  }

  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(Buffer.from(bytes), { failOn: 'none' }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const longEdge = Math.max(width, height);
    const needsResize = longEdge > MAX_IMAGE_EDGE_PX || bytes.byteLength > MAX_IMAGE_BYTES;

    if (!needsResize) {
      return ok({
        base64: Buffer.from(bytes).toString('base64'),
        mediaType: sniffed,
        width,
        height,
        originalWidth: width,
        originalHeight: height,
        resized: false,
      });
    }

    const out = await sharp(Buffer.from(bytes), { failOn: 'none' })
      .rotate()
      .resize({
        width: longEdge > MAX_IMAGE_EDGE_PX ? MAX_IMAGE_EDGE_PX : undefined,
        height: undefined,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3',
      })
      // Quality 90 rather than a smaller number on purpose: the badge, grille
      // and lamp edges this identification keys on are exactly what aggressive
      // JPEG quantisation destroys.
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return ok({
      base64: out.data.toString('base64'),
      mediaType: 'image/jpeg',
      width: out.info.width,
      height: out.info.height,
      originalWidth: width,
      originalHeight: height,
      resized: true,
    });
  } catch (e) {
    return err(failure('no-input', `upload ${image.uploadId} could not be decoded: ${describe(e)}`));
  }
}

// ---------------------------------------------------------------------------
// Built-in Anthropic provider
// ---------------------------------------------------------------------------

const AnthropicEnvelopeSchema = z.object({
  model: z.string().optional(),
  stop_reason: z.string().nullish(),
  stop_details: z
    .object({ type: z.string().optional(), category: z.string().nullish(), explanation: z.string().nullish() })
    .nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    })
    .optional(),
});

/**
 * Strip the JSON Schema keywords Anthropic's structured outputs do not accept.
 *
 * The official SDKs do exactly this — remove unsupported constraints from the
 * schema sent to the API and validate them client-side instead — and we validate
 * client-side with the same zod schema the JSON Schema was generated from, so
 * nothing is actually relaxed.
 */
const UNSUPPORTED_SCHEMA_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minContains',
  'maxContains',
  '$schema',
] as const;

export function sanitiseJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitiseJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((UNSUPPORTED_SCHEMA_KEYS as readonly string[]).includes(key)) continue;
    out[key] = sanitiseJsonSchema(value);
  }
  return out;
}

let cachedSchema: unknown = null;
function readingJsonSchema(): unknown {
  if (!cachedSchema) {
    cachedSchema = sanitiseJsonSchema(
      z.toJSONSchema(VehicleReadingSchema, { target: 'draft-2020-12' }),
    );
  }
  return cachedSchema;
}

export class AnthropicVehicleVision implements VehicleVisionProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model: string = DEFAULT_MODEL, baseUrl = 'https://api.anthropic.com') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.name = `anthropic:${model}`;
  }

  async extract(req: VehicleVisionRequest): Promise<Result<VehicleVisionResult, StageFailure>> {
    const res = await callJson({
      url: `${this.baseUrl.replace(/\/$/, '')}/v1/messages`,
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        // Server-side refusal fallback: the safety classifiers on this model
        // class can decline a request and return HTTP 200 with
        // stop_reason 'refusal'. "default" lets Anthropic route by refusal
        // category rather than us pinning a model that will later be deprecated.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: {
        model: this.model,
        max_tokens: 16_000,
        fallbacks: 'default',
        // Structured output is forced at the API level and re-validated against
        // the zod schema on the way back. Belt and braces: a model that goes
        // off-contract must not reach the ledger.
        output_config: { format: { type: 'json_schema', schema: readingJsonSchema() } },
        system: VEHICLE_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: req.image.mediaType,
                  data: req.image.base64,
                },
              },
              {
                type: 'text',
                text: 'Identify the vehicle in this image. Return the JSON object described in your instructions. Remember: ranked candidates, never a single answer, and no plate characters in any field.',
              },
            ],
          },
        ],
      },
      timeoutMs: req.timeoutMs,
      schema: AnthropicEnvelopeSchema,
      signal: req.signal,
      label: 'vision model',
    });
    if (!res.ok) return res;

    // Check stop_reason before reading content: on a refusal `content` is empty
    // (pre-output) or partial (mid-stream), and indexing it would throw.
    if (res.value.stop_reason === 'refusal') {
      const category = res.value.stop_details?.category ?? 'unspecified';
      return err(
        failure(
          'policy',
          `the vision model's safety classifiers declined this image (category: ${category}). No candidates were produced.`,
        ),
      );
    }

    const text = (res.value.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (!text) {
      return err(
        failure(
          'invalid-response',
          `the vision model returned no text content (stop_reason ${res.value.stop_reason ?? 'unknown'}).`,
        ),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(stripFences(text));
    } catch {
      return err(failure('invalid-response', 'the vision model did not return parseable JSON.'));
    }

    return ok({
      json,
      modelVersion: res.value.model ?? this.model,
      costUsd: anthropicCostUsd(res.value.model ?? this.model, res.value.usage),
      attempts: 1,
    });
  }
}

/**
 * Cost from provider-reported token counts against published per-MTok prices.
 * Returns undefined — not 0 — for a model we have no price for, so the caller
 * can say "unknown" instead of "free".
 */
export function anthropicCostUsd(
  model: string,
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | undefined,
): number | undefined {
  const price = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK[stripSnapshot(model)];
  if (!price || !usage) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input * price.input +
      output * price.output +
      // Published multipliers: 5-minute cache writes bill at 1.25x input,
      // cache reads at 0.1x.
      cacheWrite * price.input * 1.25 +
      cacheRead * price.input * 0.1) /
    1_000_000
  );
}

function stripSnapshot(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

function defaultProvider(): VehicleVisionProvider | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new AnthropicVehicleVision(key);
}

function stripFences(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
