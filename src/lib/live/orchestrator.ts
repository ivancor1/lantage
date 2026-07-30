/**
 * The LIVE orchestrator: request in, one `LiveAnalyzeResponse` out.
 *
 * Four jobs, in this order, and the order is the point:
 *
 *   1. Validate the request against the contract (zod). A FACE request with one
 *      image is a 400, not a half-run.
 *   2. Measure the input — header, metadata, quality gate — before spending a
 *      cent. A refused gate returns no ranking, and it returns it for free.
 *   3. Run the module, tolerating everything: a module that is not in this build,
 *      a module that throws, a module that returns something off-contract.
 *   4. Enforce the invariants on the way out. `assertStreetPrecisionIsEarned` and
 *      `assertRefusalIsHonoured` are called here, and an overclaim is downgraded
 *      or dropped rather than shipped.
 *
 * The hard rule, restated because this file is where it would be easiest to
 * break: **no value in the response is invented.** Sections that could not be
 * computed are absent, and the reason lands in `unavailable` with the env var
 * that would fix it. There is no demo mode and no sample data.
 */

import { z } from 'zod';
import { RETRIEVAL } from '@/lib/cascade/config';
import { readImageHeader } from '@/lib/cascade/imageHeader';
import { type MetadataFacts, extractMetadata } from '@/lib/cascade/preprocess';
import { evaluateQualityGate } from '@/lib/cascade/qualityGate';
import type { HeaderInfo } from '@/lib/cascade/imageHeader';
import type { ImageRef } from '@/lib/cascade/types';
import {
  type AuthenticityResult,
  type Evidence,
  type GeoCandidate,
  type ModuleId,
  type QualityGate,
  type SearchResult,
  type StageTrace,
  type VehicleCandidate,
  assertRefusalIsHonoured,
  assertStreetPrecisionIsEarned,
} from '@/lib/contracts/types';
import {
  LIVE_MODULES,
  MODULE_CATALOGUE,
  type CapabilityGap,
  type FaceComparison,
  type LiveAnalyzeRequest,
  type LiveAnalyzeResponse,
  type LiveModule,
  type ModuleDescriptor,
  type ProvenanceHit,
  type UploadRecord,
} from './contract';
import { analyzeAuthenticity } from './authentic';
import { readUpload, toClientRecord } from './uploads';

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export function moduleDescriptor(id: LiveModule): ModuleDescriptor {
  const found = MODULE_CATALOGUE.find((m) => m.id === id);
  if (!found) throw new Error(`No module descriptor for ${id}. MODULE_CATALOGUE is the source of truth.`);
  return found;
}

const UploadIdSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'An upload id is the sha256 of the stored bytes: 64 lowercase hex characters.');

export const LiveAnalyzeRequestSchema = z
  .object({
    module: z.enum(LIVE_MODULES),
    uploadIds: z.array(UploadIdSchema).min(1).max(2),
    hints: z
      .object({
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        capturedAt: z.string().min(4).optional(),
        note: z.string().max(2_000).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const want = moduleDescriptor(value.module).images;
    if (value.uploadIds.length !== want) {
      ctx.addIssue({
        code: 'custom',
        path: ['uploadIds'],
        message: `${value.module} takes exactly ${want} image${want === 1 ? '' : 's'}; ${value.uploadIds.length} supplied.`,
      });
    }
    if (want === 2 && value.uploadIds.length === 2 && value.uploadIds[0] === value.uploadIds[1]) {
      // Same sha256 means the same bytes. A self-comparison returns a similarity
      // of 1.0 and answers nothing, so it is refused rather than reported.
      ctx.addIssue({
        code: 'custom',
        path: ['uploadIds'],
        message:
          'Both ids are the same file (identical sha256). Comparing an image with itself returns a similarity of 1.0 and tells you nothing — upload the second image.',
      });
    }
  });

export interface RequestIssue {
  path: string;
  message: string;
}

/** A client error the route turns into a 400/404. Never a 500. */
export class LiveRequestError extends Error {
  readonly issues: RequestIssue[];
  readonly status: number;

  // Fields are declared and assigned rather than written as constructor
  // parameter properties: this tree must stay erasable so the node test runner
  // needs no build step (see src/lib/cascade/testing/aliasHooks.ts).
  constructor(message: string, issues: RequestIssue[] = [], status = 400) {
    super(message);
    this.name = 'LiveRequestError';
    this.issues = issues;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export type LiveProgressEvent =
  | { type: 'stage-start'; stage: StageTrace['stage'] }
  | { type: 'stage-end'; stage: StageTrace['stage']; trace: StageTrace }
  | { type: 'note'; message: string };

export interface AnalyzeOptions {
  signal?: AbortSignal;
  onProgress?: (event: LiveProgressEvent) => void;
  /**
   * Overrides the module implementations. Tests inject; production never does.
   * An explicit `null` means "treat this module as absent from the build", which
   * is the only way to exercise the capability-gap path once every module file
   * exists on disk.
   */
  modules?: Partial<Record<LiveModule, ModuleRunner | null>>;
}

/** What a module implementation looks like once adapted to a uniform call. */
export type ModuleRunner = (input: ModuleInput) => Promise<unknown>;

export interface ModuleInput {
  /** Resolved uploads in request order. One image for every module but FACE. */
  images: ResolvedImage[];
  quality: QualityGate;
  hints?: LiveAnalyzeRequest['hints'];
  signal?: AbortSignal;
}

export interface ResolvedImage {
  record: UploadRecord;
  bytes: Uint8Array;
  mime: string;
  header: HeaderInfo;
  metadata: MetadataFacts;
  /** Absolute path on local disk. Server-side only; never serialised. */
  path: string;
}

// ---------------------------------------------------------------------------
// Module output — validated at the boundary, because it crosses one
// ---------------------------------------------------------------------------

const ConfidenceSchema = z.looseObject({
  band: z.enum(['high', 'moderate', 'weak', 'refused']),
  score: z.number(),
  reason: z.string().min(1),
  calibration: z.string().min(1),
});

const EvidenceSchema = z.looseObject({
  kind: z.enum([
    'exif',
    'signage-ocr',
    'vpr-match',
    'embedding-prior',
    'vlm-clue',
    'solar',
    'ecoregion',
    'c2pa',
    'quantization',
    'detector',
    'localization',
    'corpus-match',
  ]),
  claim: z.string().min(1),
  // Required by the contract: a signal nobody can independently check is
  // telemetry, not evidence. A module that omits it gets its evidence dropped.
  verifiable: z.string().min(1),
  cropUrl: z.string().optional(),
  reference: z
    .looseObject({
      label: z.string(),
      url: z.string().optional(),
      panoId: z.string().optional(),
      mapillaryId: z.string().optional(),
    })
    .optional(),
  weight: z.number(),
});

const StageTraceSchema = z.looseObject({
  stage: z.enum([
    'preprocess',
    'quality-gate',
    'embedding-prior',
    'vlm-clues',
    'vpr-retrieval',
    'rerank',
    'verify-ocr',
    'verify-solar',
    'verify-ecoregion',
    'provenance',
    'detector',
    'corpus-match',
  ]),
  ranMs: z.number(),
  skipped: z.looseObject({ reason: z.string() }).optional(),
  costUsd: z.number().optional(),
});

const GeoCandidateSchema = z.looseObject({
  id: z.string().min(1),
  rank: z.number(),
  center: z.looseObject({ lat: z.number(), lon: z.number() }),
  // Never zero: a point estimate is a claim this product does not make.
  radiusM: z.number().positive(),
  precision: z.enum(['continent', 'country', 'region', 'city', 'street']),
  place: z.looseObject({
    label: z.string().min(1),
    admin1: z.string().optional(),
    country: z.string().optional(),
  }),
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceSchema).min(1),
  review: z.enum(['unreviewed', 'confirmed', 'nearby', 'incorrect']),
});

const VehicleCandidateSchema = z.looseObject({
  rank: z.number(),
  make: z.string().min(1),
  model: z.string().min(1),
  generation: z.string(),
  color: z.string().optional(),
  vpic: z.looseObject({ makeId: z.number().optional(), modelId: z.number().optional() }).optional(),
  similarity: z.number(),
  referenceImageUrl: z.string().optional(),
  review: z.enum(['unreviewed', 'confirmed', 'nearby', 'incorrect']),
});

const FaceComparisonSchema = z.looseObject({
  verdict: z.enum(['same-person', 'different-person', 'inconclusive', 'refused']),
  similarity: z.number().optional(),
  threshold: z.looseObject({ value: z.number(), basis: z.string() }).optional(),
  confidence: ConfidenceSchema,
  probes: z.array(
    z.looseObject({
      uploadId: z.string(),
      facesDetected: z.number(),
      selected: z
        .looseObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional(),
      interEyeDistancePx: z.number().optional(),
      detectionScore: z.number().optional(),
      passedGate: z.boolean(),
      note: z.string().optional(),
    }),
  ),
  refusalReason: z.string().optional(),
});

const QualityGateSchema = z.looseObject({
  passed: z.boolean(),
  unifiedScore: z.number().optional(),
  components: z.looseObject({
    resolutionPx: z.looseObject({ w: z.number(), h: z.number() }),
    blur: z.number().optional(),
    exposure: z.number().optional(),
    occlusion: z.number().optional(),
    interEyeDistancePx: z.number().optional(),
  }),
  refusalReason: z.string().optional(),
  degraded: z.boolean(),
});

const AuthenticityResultSchema = z.looseObject({
  // No 'authentic' member, here or anywhere. Absence of indicators is the ceiling.
  verdict: z.enum([
    'strong-indicators',
    'moderate-indicators',
    'weak-indicators',
    'no-indicators-found',
    'inconclusive',
  ]),
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceSchema).min(1),
  suppressedBy: z
    .array(
      z.enum([
        'computational-photography',
        'ai-upscaled',
        'heavy-retouching',
        'screenshot',
        'recompressed',
        'resolution-too-low',
      ]),
    )
    .optional(),
  // Surfaced because at a low base rate most positive flags are false positives,
  // and the operator has to see that arithmetic.
  ppv: z.looseObject({ value: z.number(), assumedBaseRate: z.number() }),
  provenance: z.looseObject({
    hasManifest: z.boolean(),
    issuer: z.string().optional(),
    valid: z.boolean().optional(),
    generator: z.string().optional(),
  }),
});

const CapabilityGapSchema = z.looseObject({
  capability: z.string().min(1),
  impact: z.string().min(1),
  envVar: z.string().optional(),
  howTo: z.string().optional(),
});

const ProvenanceHitSchema = z.looseObject({
  url: z.string().min(1),
  title: z.string().optional(),
  source: z.string().min(1),
  score: z.number().optional(),
  place: z.string().optional(),
});

/**
 * The uniform module envelope.
 *
 * Every field is optional and every list is validated element-by-element, so a
 * module that returns a malformed candidate loses that candidate rather than the
 * whole run. `gaps` and `unavailable` are both accepted because the sibling
 * modules landed with different names for the same field, and renaming theirs
 * would be a worse fix than accepting both.
 */
const ModuleOutputSchema = z.looseObject({
  geo: z.array(z.unknown()).optional(),
  vehicles: z.array(z.unknown()).optional(),
  face: z.unknown().optional(),
  authenticity: z.unknown().optional(),
  provenanceHits: z.array(z.unknown()).optional(),
  quality: z.unknown().optional(),
  evidence: z.array(z.unknown()).optional(),
  stages: z.array(z.unknown()).optional(),
  gaps: z.array(z.unknown()).optional(),
  unavailable: z.array(z.unknown()).optional(),
  models: z.record(z.string(), z.string()).optional(),
  sources: z.record(z.string(), z.string()).optional(),
  costUsd: z.number().optional(),
});

interface NormalisedOutput {
  geo: GeoCandidate[];
  vehicles: VehicleCandidate[];
  face?: FaceComparison;
  authenticity?: AuthenticityResult;
  provenanceHits: ProvenanceHit[];
  quality?: QualityGate;
  evidence: Evidence[];
  stages: StageTrace[];
  gaps: CapabilityGap[];
  models: Record<string, string>;
  sources: Record<string, string>;
  costUsd: number;
  /** How many returned items failed contract validation and were dropped. */
  dropped: number;
}

function normaliseOutput(raw: unknown): NormalisedOutput | null {
  const parsed = ModuleOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  let dropped = 0;

  const collect = <T>(items: readonly unknown[] | undefined, schema: z.ZodType): T[] => {
    const out: T[] = [];
    for (const item of items ?? []) {
      const ok = schema.safeParse(item);
      if (ok.success) out.push(ok.data as T);
      else dropped += 1;
    }
    return out;
  };

  const faceParsed = v.face === undefined ? null : FaceComparisonSchema.safeParse(v.face);
  const qualityParsed = v.quality === undefined ? null : QualityGateSchema.safeParse(v.quality);
  const authParsed =
    v.authenticity === undefined ? null : AuthenticityResultSchema.safeParse(v.authenticity);
  if (faceParsed && !faceParsed.success) dropped += 1;
  if (authParsed && !authParsed.success) dropped += 1;

  return {
    geo: collect<GeoCandidate>(v.geo, GeoCandidateSchema),
    vehicles: collect<VehicleCandidate>(v.vehicles, VehicleCandidateSchema),
    ...(faceParsed?.success ? { face: faceParsed.data as unknown as FaceComparison } : {}),
    ...(authParsed?.success
      ? { authenticity: authParsed.data as unknown as AuthenticityResult }
      : {}),
    provenanceHits: collect<ProvenanceHit>(v.provenanceHits, ProvenanceHitSchema),
    ...(qualityParsed?.success ? { quality: qualityParsed.data as unknown as QualityGate } : {}),
    evidence: collect<Evidence>(v.evidence, EvidenceSchema),
    stages: collect<StageTrace>(v.stages, StageTraceSchema),
    gaps: [
      ...collect<CapabilityGap>(v.gaps, CapabilityGapSchema),
      ...collect<CapabilityGap>(v.unavailable, CapabilityGapSchema),
    ],
    models: v.models ?? {},
    sources: v.sources ?? {},
    costUsd: v.costUsd ?? 0,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Module loading — absence is a capability gap, not a build error
// ---------------------------------------------------------------------------

/**
 * Why these are loaded dynamically rather than imported at the top of the file.
 *
 * The five modules are built by separate agents on separate timelines. A static
 * `import { locate } from './locate'` makes this orchestrator — and therefore
 * `/api/analyze` and `/api/upload`'s sibling routes — unbuildable until every
 * one of those files exists. A dynamic specifier with a variable in it is not
 * resolved at build time, so a module that is not in the build reports itself as
 * a `CapabilityGap` and the other four keep working.
 *
 * The `webpackInclude` hint keeps the generated context to the four module files
 * rather than every file in this directory. Turbopack ignores unknown magic
 * comments; the hint is there for the webpack path and is harmless either way.
 */
const MODULE_FILES: Readonly<Record<Exclude<LiveModule, 'AUTHENTIC'>, string>> = {
  LOCATE: 'locate',
  INTERIOR: 'interior',
  FACE: 'face',
  VEHICLE: 'vehicle',
};

async function loadModuleNamespace(file: string): Promise<Record<string, unknown> | null> {
  try {
    const mod: unknown = await import(
      /* webpackInclude: /\/(locate|interior|face|vehicle)\.ts$/ */
      `./${file}`
    );
    return mod && typeof mod === 'object' ? (mod as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type UnknownFn = (...args: unknown[]) => unknown;

/** First named export that is actually a function. */
function pickExport(ns: Record<string, unknown> | null, names: readonly string[]): UnknownFn | null {
  if (!ns) return null;
  for (const name of names) {
    const value = ns[name];
    if (typeof value === 'function') return value as UnknownFn;
  }
  return null;
}

function notInBuildGap(module: LiveModule, entry: string): CapabilityGap {
  return {
    capability: `${moduleDescriptor(module).label} module`,
    impact: `The ${module} module is not part of this build, so nothing was computed for it. No placeholder result is returned in its place.`,
    howTo: `Implement \`export async function ${entry}()\` in src/lib/live/${MODULE_FILES[module as Exclude<LiveModule, 'AUTHENTIC'>]}.ts and restart the dev server.`,
  };
}

function threwGap(module: LiveModule, error: unknown): CapabilityGap {
  return {
    capability: `${moduleDescriptor(module).label} module`,
    impact: `The ${module} module failed while running: ${error instanceof Error ? error.message : String(error)}. Nothing is reported for it — a partial finding from a failed run is not shown.`,
    howTo: 'Check the dev-server console for the stack trace.',
  };
}

function offContractGap(module: LiveModule): CapabilityGap {
  return {
    capability: `${moduleDescriptor(module).label} module`,
    impact: `The ${module} module returned a value that does not match the result contract, so it was discarded rather than displayed.`,
    howTo: 'The module must resolve to { evidence, stages, gaps, models, costUsd } plus its own section.',
  };
}

// ---------------------------------------------------------------------------
// Adapters — the real signatures of the sibling modules
// ---------------------------------------------------------------------------

/**
 * Each adapter calls its module the way that module was actually written, and
 * passes a superset of the fields the others take. Extra properties are inert at
 * runtime, which is what makes a signature that is still being written safe to
 * call: the module reads what it knows about and ignores the rest.
 */
const ADAPTERS: Readonly<
  Record<Exclude<LiveModule, 'AUTHENTIC'>, { entry: readonly string[]; call: (fn: UnknownFn, input: ModuleInput) => Promise<unknown> }>
> = {
  LOCATE: {
    entry: ['locate', 'analyzeLocation', 'runLocate', 'default'],
    call: async (fn, input) => {
      const image = input.images[0];
      return (await fn({
        image: imageRefFor(image),
        upload: image.record,
        bytes: image.bytes,
        path: image.path,
        mime: image.mime,
        quality: input.quality,
        hints: input.hints,
        signal: input.signal,
        env: process.env,
      })) as unknown;
    },
  },
  INTERIOR: {
    entry: ['analyzeInterior', 'interior', 'default'],
    call: async (fn, input) => {
      const image = input.images[0];
      return (await fn({
        image: imageRefFor(image),
        quality: input.quality,
        hints: input.hints,
        signal: input.signal,
        env: process.env,
      })) as unknown;
    },
  },
  FACE: {
    // `runFaceCompare` first: it returns the quality gate, stage traces and gaps
    // as well as the comparison. `compareFaces` is the narrow contract and is the
    // fallback, at the cost of the trace.
    entry: ['runFaceCompare', 'compareFaces', 'default'],
    call: async (fn, input) => {
      const [a, b] = input.images;
      const probe = (image: ResolvedImage): Record<string, unknown> => ({
        uploadId: image.record.id,
        bytes: image.bytes,
        path: image.path,
      });
      const returned = (await fn(probe(a), probe(b), { signal: input.signal })) as unknown;
      // `compareFaces` resolves to a bare FaceComparison; wrap it so both entry
      // points normalise through the same envelope.
      if (returned && typeof returned === 'object' && 'verdict' in returned) {
        return { face: returned, evidence: [], stages: [], gaps: [], models: {}, costUsd: 0 };
      }
      return returned;
    },
  },
  VEHICLE: {
    entry: ['identifyVehicle', 'vehicle', 'default'],
    call: async (fn, input) => {
      const image = input.images[0];
      // No vision provider is injected. The module has its own vendor client and
      // reports the resulting single-vendor limitation as its own capability gap;
      // adapting the shared provider to its interface is a wiring decision that
      // belongs with whoever owns both sides of it, not a guess made here.
      return (await fn(
        {
          uploadId: image.record.id,
          bytes: image.bytes,
          path: image.path,
          mime: image.mime,
        },
        { signal: input.signal },
      )) as unknown;
    },
  },
};

function imageRefFor(image: ResolvedImage): ImageRef {
  return { imageId: image.record.id, bytes: image.bytes, mimeType: image.mime };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const MODULE_ID: Readonly<Record<LiveModule, ModuleId>> = {
  // The LIVE modules map onto the audited cascade's module ids so the shared
  // invariants can be applied unchanged. LOCATE and INTERIOR are both geo
  // products; FACE is the cascade's MATCH; AUTHENTIC is VERIFY.
  LOCATE: 'GEO',
  INTERIOR: 'GEO',
  FACE: 'MATCH',
  VEHICLE: 'VEHICLE',
  AUTHENTIC: 'VERIFY',
};

export async function analyze(
  request: LiveAnalyzeRequest,
  options: AnalyzeOptions = {},
): Promise<LiveAnalyzeResponse> {
  const parsed = LiveAnalyzeRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new LiveRequestError(
      'The analyse request did not match the contract.',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      400,
    );
  }
  const req: LiveAnalyzeRequest = parsed.data;
  const emit = (event: LiveProgressEvent): void => options.onProgress?.(event);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const stages: StageTrace[] = [];
  const unavailable: CapabilityGap[] = [];

  // --- 1. resolve + measure ------------------------------------------------
  emit({ type: 'stage-start', stage: 'preprocess' });
  const preprocessStarted = Date.now();
  const images: ResolvedImage[] = [];
  const missing: string[] = [];

  for (const uploadId of req.uploadIds) {
    const found = await readUpload(uploadId);
    if (!found) {
      missing.push(uploadId);
      continue;
    }
    images.push({
      record: found.record,
      bytes: found.bytes,
      mime: found.mime,
      header: readImageHeader(found.bytes),
      metadata: await extractMetadata(found.bytes),
      path: found.record.path ?? '',
    });
  }

  if (missing.length > 0) {
    throw new LiveRequestError(
      `No stored upload for ${missing.join(', ')}. Upload the image again — .lantage-uploads may have been cleared.`,
      missing.map((m) => ({ path: 'uploadIds', message: `Unknown upload ${m}.` })),
      404,
    );
  }

  const preprocessTrace: StageTrace = {
    stage: 'preprocess',
    ranMs: Date.now() - preprocessStarted,
    costUsd: 0,
  };
  stages.push(preprocessTrace);
  emit({ type: 'stage-end', stage: 'preprocess', trace: preprocessTrace });

  // --- 2. quality gate -----------------------------------------------------
  emit({ type: 'stage-start', stage: 'quality-gate' });
  const gateStarted = Date.now();
  const quality = combineGates(images);
  const gateTrace: StageTrace = {
    stage: 'quality-gate',
    ranMs: Date.now() - gateStarted,
    costUsd: 0,
    ...(quality.passed ? {} : { skipped: { reason: quality.refusalReason ?? 'Refused.' } }),
  };
  stages.push(gateTrace);
  emit({ type: 'stage-end', stage: 'quality-gate', trace: gateTrace });

  // --- 3. run the module ---------------------------------------------------
  /**
   * AUTHENTIC and FACE run even on a refused gate. Both are local and free, and
   * both express refusal inside their own result — AUTHENTIC's 'resolution-too-low'
   * suppression and FACE's 'refused' verdict are more informative than silence.
   * The three vision modules do not: spending on a frame the gate already refused
   * would buy a ranking we are forbidden to show.
   */
  const runsOnRefusal = req.module === 'AUTHENTIC' || req.module === 'FACE';
  let output: NormalisedOutput | null = null;

  if (!quality.passed && !runsOnRefusal) {
    unavailable.push({
      capability: `${moduleDescriptor(req.module).label} ranking`,
      impact: `The quality gate refused this input, so no ranking was produced and no vision spend was incurred. ${quality.refusalReason ?? ''}`.trim(),
      howTo: 'Upload the original file rather than a resized copy or a screenshot of it.',
    });
    emit({ type: 'note', message: 'Quality gate refused. No ranking, and nothing was spent.' });
  } else if (req.module === 'AUTHENTIC') {
    emit({ type: 'note', message: 'Running AUTHENTIC: Content Credentials, metadata, JPEG forensics.' });
    try {
      output = normaliseOutput(await analyzeAuthenticity({ image: images[0], signal: options.signal }));
      if (!output) unavailable.push(offContractGap(req.module));
    } catch (e) {
      unavailable.push(threwGap(req.module, e));
    }
  } else {
    const injected = options.modules?.[req.module];
    const file = MODULE_FILES[req.module];
    const adapter = ADAPTERS[req.module];
    const fn =
      injected === null
        ? null
        : (injected ?? pickExport(await loadModuleNamespace(file), adapter.entry));

    if (!fn) {
      unavailable.push(notInBuildGap(req.module, adapter.entry[0]));
    } else {
      emit({ type: 'note', message: `Running ${req.module}.` });
      try {
        const raw = injected
          ? await injected({ images, quality, hints: req.hints, signal: options.signal })
          : await adapter.call(fn as UnknownFn, { images, quality, hints: req.hints, signal: options.signal });
        output = normaliseOutput(raw);
        if (!output) unavailable.push(offContractGap(req.module));
      } catch (e) {
        // A module that throws becomes a stated failure, never a 500.
        unavailable.push(threwGap(req.module, e));
      }
    }
  }

  // --- 4. assemble + enforce ----------------------------------------------
  const evidence: Evidence[] = [...(output?.evidence ?? [])];
  const models: Record<string, string> = { ...(output?.models ?? {}) };
  const sources: Record<string, string> = { ...(output?.sources ?? {}) };
  for (const trace of output?.stages ?? []) {
    stages.push(trace);
    emit({ type: 'stage-end', stage: trace.stage, trace });
  }
  unavailable.push(...(output?.gaps ?? []));

  if (output && output.dropped > 0) {
    unavailable.push({
      capability: `${moduleDescriptor(req.module).label} result validation`,
      impact: `${output.dropped} item${output.dropped === 1 ? '' : 's'} returned by the module did not match the result contract and ${output.dropped === 1 ? 'was' : 'were'} dropped rather than shown.`,
      howTo: 'Every candidate needs a confidence band with a reason and at least one piece of evidence carrying a `verifiable` string.',
    });
  }

  // The module's own gate wins when it measured something we cannot: FACE
  // measures inter-eye distance, which is the only gate that matters for it.
  const effectiveQuality = output?.quality ?? quality;

  let geo = enforceStreetPrecision(output?.geo ?? [], unavailable);
  let vehicles = output?.vehicles ?? [];
  const provenanceHits = output?.provenanceHits ?? [];

  for (const hit of provenanceHits) {
    if (!(hit.source in sources)) sources[hit.source] = 'reverse-image-search';
  }

  const totalCostUsd = Math.max(
    output?.costUsd ?? 0,
    stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
  );

  // A refused gate must not carry a ranking. Dropped before the assertion so the
  // assertion is a proof rather than a crash, then called anyway so the invariant
  // is genuinely exercised on every response.
  if (!effectiveQuality.passed && (geo.length > 0 || vehicles.length > 0)) {
    unavailable.push({
      capability: `${moduleDescriptor(req.module).label} ranking`,
      impact: `The module returned ${geo.length + vehicles.length} ranked candidate(s) for input that failed the quality gate. They are withheld: a failed gate returns the refusal, not a ranking.`,
      howTo: 'Upload a higher-resolution original.',
    });
    geo = [];
    vehicles = [];
  }

  const response: LiveAnalyzeResponse = {
    id,
    module: req.module,
    uploads: images.map((i) => toClientRecord(i.record)),
    quality: effectiveQuality,
    ...(geo.length > 0 ? { geo } : {}),
    ...(vehicles.length > 0 ? { vehicles } : {}),
    ...(output?.face ? { face: output.face } : {}),
    ...(provenanceHits.length > 0 ? { provenanceHits } : {}),
    ...(output?.authenticity ? { authenticity: output.authenticity } : {}),
    evidence,
    stages,
    provenance: { models, sources, totalCostUsd },
    unavailable,
    createdAt,
  };

  assertRefusalIsHonouredOn(response, unavailable);
  return response;
}

/**
 * Calls the shared invariant and turns a violation into a stated gap rather than
 * an exception. Reaching the catch means a bug upstream of it, so the message
 * says so instead of pretending the result is fine.
 */
function assertRefusalIsHonouredOn(
  response: LiveAnalyzeResponse,
  unavailable: CapabilityGap[],
): void {
  const asSearchResult: SearchResult = {
    id: response.id,
    module: MODULE_ID[response.module],
    imageId: response.uploads[0]?.id ?? '',
    quality: response.quality,
    ...(response.geo ? { geo: response.geo } : {}),
    ...(response.vehicles ? { vehicles: response.vehicles } : {}),
    stages: response.stages,
    provenance: {
      models: response.provenance.models,
      totalCostUsd: response.provenance.totalCostUsd,
    },
    createdAt: response.createdAt,
  };
  try {
    assertRefusalIsHonoured(asSearchResult);
  } catch (e) {
    delete response.geo;
    delete response.vehicles;
    unavailable.push({
      capability: 'Ranked candidates',
      impact: `Withheld: ${e instanceof Error ? e.message : String(e)}`,
      howTo: 'This is an integrity guard firing, not an input problem. Report it.',
    });
  }
}

/**
 * Street precision is earned by a retrieval match or a geocoded sign, never by
 * inference. An unearned claim is widened to a city-level region rather than
 * dropped — the region is still a real finding; the precision was the overclaim.
 */
function enforceStreetPrecision(
  candidates: readonly GeoCandidate[],
  unavailable: CapabilityGap[],
): GeoCandidate[] {
  const out: GeoCandidate[] = [];
  for (const candidate of candidates) {
    try {
      assertStreetPrecisionIsEarned(candidate);
      out.push(candidate);
      continue;
    } catch {
      // Fall through to the downgrade.
    }
    const widened: GeoCandidate = {
      ...candidate,
      precision: 'city',
      radiusM: Math.max(candidate.radiusM, RETRIEVAL.cityRadiusM),
    };
    try {
      assertStreetPrecisionIsEarned(widened);
      out.push(widened);
      unavailable.push({
        capability: 'Street-level precision',
        impact: `Candidate "${candidate.place.label}" was returned at street precision without a retrieval match or a geocoded sign in its evidence chain, so it is reported as a ${Math.round(widened.radiusM / 1000)} km region instead. Street precision comes from retrieval or OCR, not from inference.`,
        howTo:
          'Build the Mapillary retrieval index for the area of interest, or supply a frame with legible signage.',
      });
    } catch {
      unavailable.push({
        capability: 'Street-level precision',
        impact: `Candidate "${candidate.place.label}" claimed street precision it had not earned and could not be widened, so it was dropped.`,
      });
    }
  }
  return out;
}

/**
 * One gate for the whole request. The weakest image decides: a refusal on either
 * frame refuses the pair, and a degradation on either degrades it. Both
 * resolutions are named in the reason so the operator knows which file to replace.
 */
function combineGates(images: readonly ResolvedImage[]): QualityGate {
  const gates = images.map((image) =>
    evaluateQualityGate({
      image: imageRefFor(image),
      header: image.header,
      metadata: image.metadata,
      bytes: image.bytes,
    }),
  );
  if (gates.length === 0) {
    return {
      passed: false,
      components: { resolutionPx: { w: 0, h: 0 } },
      degraded: false,
      refusalReason: 'No image was resolved, so nothing was measured.',
    };
  }
  if (gates.length === 1) return gates[0];

  const refused = gates.filter((g) => !g.passed);
  const worst = refused[0] ?? gates.find((g) => g.degraded) ?? gates[0];
  const reasons = gates
    .map((g, i) => (g.refusalReason ? `Image ${i + 1} (${g.components.resolutionPx.w}x${g.components.resolutionPx.h}): ${g.refusalReason}` : null))
    .filter((r): r is string => r !== null);

  return {
    ...worst,
    passed: refused.length === 0,
    degraded: refused.length === 0 && gates.some((g) => g.degraded),
    ...(reasons.length > 0 ? { refusalReason: reasons.join(' ') } : {}),
  };
}
