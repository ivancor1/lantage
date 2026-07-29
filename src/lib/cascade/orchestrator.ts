/**
 * The cascade orchestrator.
 *
 * Runs the stages, accumulates the trace, and assembles a `SearchResult` that
 * satisfies every contract invariant before it leaves the function:
 *
 *   - `assertRefusalIsHonoured()` — a failed quality gate returns no ranking;
 *   - `assertStreetPrecisionIsEarned()` — on every candidate, every time;
 *   - `bandCeiling()` — degraded input cannot produce a high band;
 *   - `ResultProvenance` — model and index versions on every result, because a
 *     result nobody can reproduce is a result nobody can defend in court.
 *
 * Nothing in here throws on a dependency failure. Each stage returns a trace with
 * `skipped.reason`, the cascade continues with less information, and the result
 * says so. The one exception is a module this file does not implement, which is a
 * programming error rather than a degradation.
 */

import {
  type Confidence,
  type Evidence,
  type GeoCandidate,
  type ModuleId,
  type QualityGate,
  type ResultProvenance,
  type SearchRequest,
  type SearchResult,
  type StageTrace,
  assertRefusalIsHonoured,
  assertStreetPrecisionIsEarned,
} from '@/lib/contracts/types';
import { BENCHMARK_REF, CASCADE_BUDGET_MS, INDEX_BUILD, MODEL_VERSIONS } from './config';
import type { VlmClues } from '@/lib/contracts/schemas';
import { type WorkingCandidate, finaliseCandidates } from './candidate';
import { refusedConfidence } from './confidence';
import type { CascadeRuntime } from './deps';
import { precisionForRadius } from './geo';
import { createEmbeddingPriorStage } from './embeddingPrior';
import { createPreprocessStage } from './preprocess';
import { createQualityGateStage } from './qualityGate';
import { createRerankStage } from './rerank';
import {
  clueCategoryCount,
  clueCount,
  createVlmCluesStage,
  refinePriorFromClues,
  solarObservationFrom,
} from './vlmClues';
import { createVprRetrievalStage } from './vprRetrieval';
import { runOcrGeocodeVerifier } from '@/lib/verify/ocrGeocode';
import { runSolarVerifier } from '@/lib/verify/solar';
import { runEcoregionVerifier } from '@/lib/verify/ecoregion';
import { runAuthenticity } from '@/lib/verify/authenticity';
import {
  Budget,
  type ImageRef,
  type ProgressEvent,
  type RegionPrior,
  type StageContext,
} from './types';

export class ModuleNotImplementedError extends Error {
  readonly module: ModuleId;

  constructor(module: ModuleId) {
    super(`Module ${module} is not implemented by the cascade orchestrator.`);
    this.name = 'ModuleNotImplementedError';
    this.module = module;
  }
}

export interface CascadeInput {
  searchId: string;
  request: SearchRequest;
  image: ImageRef;
  /** Wall-clock ceiling. Defaults to the configured budget. */
  budgetMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * How many individual clue lines ride along on each candidate's evidence chain.
 *
 * All of them would be honest but unreadable — a 60-row ledger entry is a ledger
 * nobody audits. The highest-weight lines are kept, which is also the ordering an
 * analyst would check them in.
 */
const MAX_CLUE_EVIDENCE_PER_CANDIDATE = 8;

export async function runCascade(
  input: CascadeInput,
  runtime: CascadeRuntime,
): Promise<SearchResult> {
  switch (input.request.module) {
    case 'GEO':
    case 'STREET':
      return runGeoCascade(input, runtime);
    case 'VERIFY':
      return runVerifyCascade(input, runtime);
    // VEHICLE, CLAIM and MATCH are owned by their own modules. Returning an empty
    // result here would look like "nothing found" instead of "not built".
    default:
      throw new ModuleNotImplementedError(input.request.module);
  }
}

// ---------------------------------------------------------------------------
// GEO / STREET
// ---------------------------------------------------------------------------

async function runGeoCascade(input: CascadeInput, runtime: CascadeRuntime): Promise<SearchResult> {
  const traces: StageTrace[] = [];
  const models: Record<string, string> = {};
  const ctx = makeContext(input);

  // --- 0. preprocess ------------------------------------------------------
  const pre = await runStage(createPreprocessStage(), input.image, ctx, traces);
  if (!pre.output) {
    return refusedResult(input, traces, {
      passed: false,
      components: { resolutionPx: { w: 0, h: 0 } },
      degraded: false,
      refusalReason:
        pre.trace.skipped?.reason ??
        'The image could not be read, so nothing was analysed and nothing is claimed.',
    });
  }
  const regionEvidence: Evidence[] = [...pre.evidence];

  // --- 1. quality gate ----------------------------------------------------
  const gateStage = await runStage(createQualityGateStage(), pre.output, ctx, traces);
  const gate: QualityGate = gateStage.output ?? {
    passed: false,
    components: { resolutionPx: { w: 0, h: 0 } },
    degraded: false,
    refusalReason: 'The quality gate could not be evaluated, so no ranking is returned.',
  };
  if (!gate.passed) {
    // Short-circuit: no embedding spend, no VLM spend, no ranking.
    return refusedResult(input, traces, gate);
  }

  // --- 2. embedding prior -------------------------------------------------
  const priorStage = await runStage(
    createEmbeddingPriorStage(runtime.embed),
    pre.output,
    ctx,
    traces,
  );
  regionEvidence.push(...priorStage.evidence);
  let prior: RegionPrior | null = priorStage.output?.prior ?? null;
  if (priorStage.output) models.embedding = priorStage.output.modelVersion;

  // --- 3. gated clue extraction ------------------------------------------
  const cluesStage = await runStage(
    createVlmCluesStage(runtime.vlm),
    {
      preprocessed: pre.output,
      priorScore: priorStage.output ? priorStage.output.prior.score : null,
      spreadKm: priorStage.output ? priorStage.output.spreadKm : null,
    },
    ctx,
    traces,
  );
  const clues = cluesStage.output?.clues ?? null;
  if (cluesStage.output) models.vlm = cluesStage.output.modelVersion;

  // Highest-weight clue lines only — see MAX_CLUE_EVIDENCE_PER_CANDIDATE.
  regionEvidence.push(
    ...[...cluesStage.evidence]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_CLUE_EVIDENCE_PER_CANDIDATE),
  );

  if (clues) {
    const refined = await refinePriorFromClues({
      clues,
      existing: prior,
      geocoder: runtime.geocoder,
      ctx,
    });
    prior = refined.prior;
    regionEvidence.push(...refined.evidence);
    if (refined.evidence.length > 0 && runtime.geocoder) models.geocoder = runtime.geocoder.name;
  }

  // --- 4. region-pruned retrieval ----------------------------------------
  const retrieval = await runStage(
    createVprRetrievalStage(runtime.embed, runtime.vectorSearch),
    { preprocessed: pre.output, prior, hintBbox: input.request.hints?.bbox },
    ctx,
    traces,
  );
  let candidates: WorkingCandidate[] = retrieval.output?.candidates ?? [];
  if (retrieval.output) {
    models.vpr = retrieval.output.modelVersion;
  }

  // --- 5. optional re-rank ------------------------------------------------
  if (retrieval.output && candidates.length > 1) {
    const reranked = await runStage(
      createRerankStage(runtime.embed, runtime.rerankStore),
      { preprocessed: pre.output, candidates, hits: retrieval.output.hits },
      ctx,
      traces,
    );
    if (reranked.output) models.rerank = reranked.output.modelVersion;
  } else {
    traces.push({
      stage: 'rerank',
      ranMs: 0,
      skipped: { reason: 'Nothing to re-rank: fewer than two retrieval candidates.' },
    });
  }

  // --- 6. verifiers -------------------------------------------------------
  const ocr = await runOcrGeocodeVerifier({
    candidates,
    clues,
    geocoder: runtime.geocoder,
    priorBbox: prior?.bbox,
    ctx,
  });
  traces.push(ocr.trace);
  if (ocr.output && ocr.output.geocodeCalls > 0 && runtime.geocoder) {
    models.geocoder = runtime.geocoder.name;
  }

  const solar = await runSolarVerifier({
    candidates,
    observation: solarObservationFrom(clues, input.request.hints?.capturedAt ?? pre.output.metadata.capturedAt),
    ctx,
  });
  traces.push(solar.trace);

  const eco = await runEcoregionVerifier({
    candidates,
    clues,
    mask: runtime.ecoregion,
    ctx,
  });
  traces.push(eco.trace);

  // --- 7. assemble --------------------------------------------------------
  // With no retrieval match there is still an honest answer: the coarse region,
  // labelled as such, with the prior's own evidence attached. What there is not,
  // ever, is a street-level claim.
  if (candidates.length === 0 && prior) {
    candidates = [coarseCandidateFromPrior(input.searchId, prior, clues)];
  }

  const geo: GeoCandidate[] = finaliseCandidates(candidates, gate, regionEvidence);
  for (const candidate of geo) assertStreetPrecisionIsEarned(candidate);

  const result: SearchResult = {
    id: input.searchId,
    module: input.request.module,
    imageId: input.request.imageId,
    quality: gate,
    geo,
    stages: traces,
    provenance: buildProvenance(models, traces, retrieval.output?.indexBuild),
    createdAt: new Date().toISOString(),
  };
  assertRefusalIsHonoured(result);
  return result;
}

function coarseCandidateFromPrior(
  searchId: string,
  prior: RegionPrior,
  clues: VlmClues | null,
): WorkingCandidate {
  const label = prior.labels[0] ?? `${prior.center.lat.toFixed(3)}, ${prior.center.lon.toFixed(3)}`;
  return {
    id: `${searchId}-geo-region`,
    center: prior.center,
    radiusM: prior.radiusM,
    // Never 'street': no retrieval match and no OCR geocode means unearned.
    precision: precisionForRadius(prior.radiusM),
    place: { label },
    rawScore: prior.score,
    evidence: [],
    calibrationSet: prior.source === 'vlm' ? 'vlmClues' : 'embeddingPrior',
    facts:
      clues && prior.source !== 'embedding'
        ? {
            kind: 'vlm-clues',
            clueCount: clueCount(clues),
            categories: clueCategoryCount(clues),
            label,
          }
        : { kind: 'embedding-prior', topScorePct: Math.round(prior.score * 100), spreadKm: 0, label },
  };
}

// ---------------------------------------------------------------------------
// VERIFY
// ---------------------------------------------------------------------------

async function runVerifyCascade(input: CascadeInput, runtime: CascadeRuntime): Promise<SearchResult> {
  const traces: StageTrace[] = [];
  const ctx = makeContext(input);

  const pre = await runStage(createPreprocessStage(), input.image, ctx, traces);
  if (!pre.output || !pre.output.bytes) {
    return refusedResult(input, traces, {
      passed: false,
      components: { resolutionPx: { w: 0, h: 0 } },
      degraded: false,
      refusalReason:
        pre.trace.skipped?.reason ?? 'The image could not be read, so no checks were performed.',
    });
  }

  const gateStage = await runStage(createQualityGateStage(), pre.output, ctx, traces);
  const gate: QualityGate = gateStage.output ?? {
    passed: true,
    components: { resolutionPx: { w: pre.output.header.width ?? 0, h: pre.output.header.height ?? 0 } },
    degraded: true,
  };

  // Deliberately NOT short-circuited on a failed gate. VERIFY's honest answer for
  // an unusable image is 'inconclusive' with `resolution-too-low` in
  // `suppressedBy` — which the authenticity module produces — and that is more
  // useful to an SIU investigator than a bare refusal. No ranked candidates are
  // returned either way, so the refusal invariant still holds.
  const { result: authenticity, traces: verifyTraces } = await runAuthenticity(
    { bytes: pre.output.bytes, header: pre.output.header, metadata: pre.output.metadata },
    { c2pa: runtime.c2pa, detector: runtime.detector },
    ctx,
  );
  traces.push(...verifyTraces);

  const models: Record<string, string> = {};
  if (runtime.c2pa) models.provenance = runtime.c2pa.name;
  if (runtime.detector) models.detector = runtime.detector.name;

  const result: SearchResult = {
    id: input.searchId,
    module: 'VERIFY',
    imageId: input.request.imageId,
    quality: gate,
    authenticity,
    stages: traces,
    provenance: buildProvenance(models, traces),
    createdAt: new Date().toISOString(),
  };
  assertRefusalIsHonoured(result);
  return result;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function makeContext(input: CascadeInput): StageContext {
  const controller = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return {
    searchId: input.searchId,
    image: input.image,
    budget: new Budget(input.budgetMs ?? CASCADE_BUDGET_MS),
    signal: controller.signal,
    emit: (event) => input.onProgress?.(event),
  };
}

async function runStage<TIn, TOut>(
  stage: { stage: StageTrace['stage']; run(input: TIn, ctx: StageContext): Promise<{ evidence: Evidence[]; trace: StageTrace; output: TOut | null }> },
  stageInput: TIn,
  ctx: StageContext,
  traces: StageTrace[],
): Promise<{ evidence: Evidence[]; trace: StageTrace; output: TOut | null }> {
  ctx.emit({ type: 'stage-start', stage: stage.stage, at: Date.now() });
  let outcome: { evidence: Evidence[]; trace: StageTrace; output: TOut | null };
  try {
    outcome = await stage.run(stageInput, ctx);
  } catch (e) {
    // A stage that throws is a bug, not a vendor failure — but it still must not
    // take the search down. Record it as a skip and keep going.
    outcome = {
      evidence: [],
      trace: {
        stage: stage.stage,
        ranMs: 0,
        skipped: { reason: `Stage failed unexpectedly: ${e instanceof Error ? e.message : String(e)}` },
      },
      output: null,
    };
  }
  traces.push(outcome.trace);
  ctx.emit({ type: 'stage-end', stage: stage.stage, trace: outcome.trace });
  return outcome;
}

function buildProvenance(
  models: Record<string, string>,
  traces: StageTrace[],
  indexBuild?: string,
): ResultProvenance {
  const totalCostUsd = traces.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  return {
    models: {
      // Fallbacks are explicit so a provenance record is never silently empty.
      embedding: models.embedding ?? MODEL_VERSIONS.embedding,
      ...models,
    },
    indexBuild: indexBuild ?? INDEX_BUILD,
    benchmarkRef: BENCHMARK_REF,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
  };
}

function refusedResult(
  input: CascadeInput,
  traces: StageTrace[],
  gate: QualityGate,
): SearchResult {
  const result: SearchResult = {
    id: input.searchId,
    module: input.request.module,
    imageId: input.request.imageId,
    quality: gate,
    // No geo, no vehicles, no corpus matches. The refusal IS the result.
    stages: traces,
    provenance: buildProvenance({}, traces),
    createdAt: new Date().toISOString(),
  };
  assertRefusalIsHonoured(result);
  return result;
}

/**
 * Confidence for a refusal, for surfaces that need one to render. Exported
 * because the UI must show a band even when the band is 'refused'.
 */
export function refusalConfidence(gate: QualityGate): Confidence {
  return refusedConfidence(
    gate.refusalReason ?? 'The input failed the quality gate, so no ranking was produced.',
  );
}
