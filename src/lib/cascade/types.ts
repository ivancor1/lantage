/**
 * Cascade-internal types.
 *
 * Domain types live in `@/lib/contracts/types` and are never redefined here.
 * This file only describes how the cascade *runs*: the uniform stage shape, the
 * typed failures every external call degrades into, and the time budget.
 *
 * Rule that shapes all of it (docs/MASTER_PLAN.md §3): a dead dependency must
 * skip a stage, never fail the search. The published cascade is 6 stages deep;
 * if any one of them can throw, the whole product is only as available as its
 * flakiest vendor.
 */

import type { Evidence, StageTrace } from '@/lib/contracts/types';

// ---------------------------------------------------------------------------
// Result / failure
// ---------------------------------------------------------------------------

export type Result<T, E = StageFailure> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Why a stage produced nothing. Every one of these is a *degradation*, not an
 * error: the orchestrator records it in `StageTrace.skipped.reason` and keeps
 * going. Nothing in the cascade throws across a network boundary.
 */
export type StageFailureKind =
  | 'timeout'
  | 'unavailable' // transport / 5xx / DNS
  | 'invalid-response' // schema mismatch after retry — the model went off-contract
  | 'not-configured' // no API key / no self-hosted endpoint wired yet
  | 'no-input' // an upstream stage produced nothing to work on
  | 'budget-exhausted'
  | 'gated-off' // confidence gate or feature flag said don't run
  | 'policy'; // we refuse to run it this way (e.g. unpruned full-index scan)

export interface StageFailure {
  kind: StageFailureKind;
  /** Analyst-readable. Lands verbatim in `StageTrace.skipped.reason`. */
  reason: string;
}

export function failure(kind: StageFailureKind, reason: string): StageFailure {
  return { kind, reason };
}

// ---------------------------------------------------------------------------
// Geo primitives
// ---------------------------------------------------------------------------

/**
 * Canonical bbox order for the whole codebase: **[west, south, east, north]**
 * = [minLon, minLat, maxLon, maxLat], the GeoJSON / OSM / Mapillary order.
 *
 * `SearchRequest.hints.bbox` is a bare 4-tuple in the contract, so this is the
 * only place the order is written down. Read it before touching bbox code.
 */
export type Bbox = [west: number, south: number, east: number, north: number];

/**
 * A coarse search-space prune. This is the object the whole architecture turns
 * on: the vision model and the embedding prior exist to produce one of these,
 * and retrieval is only allowed to run *inside* it.
 */
export interface RegionPrior {
  bbox: Bbox;
  center: { lat: number; lon: number };
  /** Radius of the prior in metres. Never zero. */
  radiusM: number;
  precision: 'continent' | 'country' | 'region' | 'city' | 'street';
  /** Human labels the prior is consistent with, best first. */
  labels: string[];
  /** 0..1 calibrated. Drives the VLM escalation gate. */
  score: number;
  source: 'analyst-hint' | 'embedding' | 'vlm' | 'merged';
}

// ---------------------------------------------------------------------------
// Image handle
// ---------------------------------------------------------------------------

/**
 * What the cascade is given. A signed URL is preferred — Modal and the VLM both
 * take URLs, which keeps request payloads out of our logs.
 */
export interface ImageRef {
  imageId: string;
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** Progress event, emitted for the live pipeline readout in the UI. */
export type ProgressEvent =
  | { type: 'stage-start'; stage: StageTrace['stage']; at: number }
  | { type: 'stage-end'; stage: StageTrace['stage']; trace: StageTrace }
  | { type: 'note'; message: string };

export interface StageContext {
  readonly searchId: string;
  readonly image: ImageRef;
  /** Wall-clock budget shared by every stage. */
  readonly budget: Budget;
  readonly signal: AbortSignal;
  readonly emit: (event: ProgressEvent) => void;
}

/**
 * Uniform stage return. `output === null` means the stage degraded; `trace`
 * always carries the reason. Evidence is additive and never removed downstream:
 * the ledger is append-only by construction.
 */
export interface StageOutput<T> {
  evidence: Evidence[];
  trace: StageTrace;
  output: T | null;
}

export interface Stage<TIn, TOut> {
  readonly stage: StageTrace['stage'];
  run(input: TIn, ctx: StageContext): Promise<StageOutput<TOut>>;
}

/** Convenience: a skipped stage with zero cost and a real elapsed time. */
export function skipped<T>(
  stage: StageTrace['stage'],
  ranMs: number,
  fail: StageFailure,
): StageOutput<T> {
  return { evidence: [], trace: { stage, ranMs, skipped: { reason: fail.reason } }, output: null };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Hard wall-clock budget. The plan's SLA is 3–8s with a 10s ceiling, and the
 * reason a reasoning-heavy model is banned from the hot path is that it alone
 * eats 15–60s. Stages ask the budget whether they can afford to run; if not
 * they skip with `budget-exhausted` and the result still ships.
 */
export class Budget {
  readonly totalMs: number;
  private readonly clock: () => number;
  private readonly startedAt: number;

  // Fields are declared and assigned rather than written as constructor parameter
  // properties: the unit tests run on Node's strip-only TypeScript support, which
  // supports erasable syntax only. Keeping the whole codebase erasable means the
  // tests need no build step.
  constructor(totalMs: number, clock: () => number = () => Date.now()) {
    this.totalMs = totalMs;
    this.clock = clock;
    this.startedAt = clock();
  }

  elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  remainingMs(): number {
    return Math.max(0, this.totalMs - this.elapsedMs());
  }

  /** Can we afford a call that needs `needMs`, keeping a reserve for assembly? */
  canAfford(needMs: number, reserveMs = 250): boolean {
    return this.remainingMs() >= needMs + reserveMs;
  }

  /** The timeout to hand a fetch: never longer than what's left. */
  timeoutFor(preferredMs: number, reserveMs = 250): number {
    return Math.max(0, Math.min(preferredMs, this.remainingMs() - reserveMs));
  }
}
