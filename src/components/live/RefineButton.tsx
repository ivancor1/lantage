'use client';

import { useState } from 'react';
import { Ban, Crosshair } from 'lucide-react';
import type { GeoCandidate } from '@/lib/contracts/types';
import type {
  LiveRefineRequest,
  RefineResult,
  RefineSignageClue,
  RegionRefinement,
} from '@/lib/live/contract';
import { Button } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';

/**
 * "Refine in {region}" — the operator-triggered step from a region hypothesis to
 * a street one.
 *
 * The honesty rule this component exists to enforce: street precision is
 * *earned*, never offered. Stage 2 is the only path that can return
 * `precision: 'street'`, and it can only do so where a harvested street index
 * actually covers the region — because the refinement is a retrieval against
 * panoramas we hold, not a second, more confident pass of the same inference
 * (contracts/types.ts `assertStreetPrecisionIsEarned`; AGENTS.md). So where the
 * index does not reach, this control is visibly disabled and repeats the
 * server's own reason, rather than being hidden or — far worse — enabled and
 * then failing.
 *
 * Two things are deliberately NOT computed here:
 *
 *   - **The bbox.** `RegionRefinement.bbox` comes from the stage-1 coverage
 *     probe and is the scope the refine must be made with. Deriving one in the
 *     browser from `center` + `radiusM` would reimplement `bboxForCandidate` and
 *     `REFINE.maxScopeKm`, an invariant AGENTS.md says to import rather than
 *     restate — and getting it wrong turns a scoped search into a planet-wide
 *     ANN query wearing a bbox costume. No coverage report, no request.
 *   - **Availability.** It is `RegionRefinement.refinable`, which is true only
 *     when rows were actually counted. Guessing optimistically would put the
 *     operator one click from a street-level claim nothing supports.
 */

export const REFINE_ENDPOINT = '/api/refine';

export type RefineOutcome =
  | { ok: true; result: RefineResult }
  | { ok: false; status: number; statusLine: string; message: string; wasHtml: boolean };

/**
 * POST /api/refine.
 *
 * Nothing here interprets a failure. `message` is the server's own sentence,
 * trimmed only for length: the route returns the house `{ error, message }`
 * shape and that message is usually the operator's only instruction.
 */
export async function requestRefine(body: LiveRefineRequest): Promise<RefineOutcome> {
  let response: Response;
  try {
    response = await fetch(REFINE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusLine: `POST ${REFINE_ENDPOINT} — request failed`,
      message: error instanceof Error ? error.message : String(error),
      wasHtml: false,
    };
  }

  const wasHtml = (response.headers.get('content-type') ?? '').includes('html');
  const text = await response.text();
  const statusLine = `POST ${REFINE_ENDPOINT} → ${response.status}${
    response.statusText ? ` ${response.statusText}` : ''
  }`;

  if (response.ok) {
    try {
      return { ok: true, result: JSON.parse(text) as RefineResult };
    } catch {
      return {
        ok: false,
        status: response.status,
        statusLine,
        message: 'The route answered 200 with a body that is not JSON.',
        wasHtml,
      };
    }
  }

  /* An HTML body is not the house error shape; it is a framework error page, and
     printing a page of markup verbatim helps nobody, so the status line stands
     in for it. */
  let message = wasHtml ? '' : text.trim();
  if (!wasHtml) {
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
      const stated = parsed.message ?? parsed.error;
      if (typeof stated === 'string' && stated.length > 0) message = stated;
    } catch {
      /* Not JSON. The raw body is already in `message`. */
    }
  }

  return {
    ok: false,
    status: response.status,
    statusLine,
    message: message.length > 600 ? `${message.slice(0, 600)}…` : message,
    wasHtml,
  };
}

export interface RefineButtonProps {
  candidate: GeoCandidate;
  /**
   * Stage-1 coverage annotation for this candidate (`LiveAnalyzeResponse.refinable`).
   * Absent means the run did not report coverage — which is not the same as
   * "not refinable", and is rendered as its own state.
   */
  refinement?: RegionRefinement;
  /** The upload stage 1 analysed. Stage 2 has to run on the same frame. */
  uploadId?: string;
  /** Signage stage 1 read, forwarded so stage 2 can geocode it. It boosts; it never seeds. */
  signage?: readonly RefineSignageClue[];
  onRefined?: (result: RefineResult) => void;
  className?: string;
}

export function RefineButton({
  candidate,
  refinement,
  uploadId,
  signage,
  onRefined,
  className,
}: RefineButtonProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Extract<RefineOutcome, { ok: false }> | null>(null);
  const [result, setResult] = useState<RefineResult | null>(null);

  const region = candidate.place.label;
  const blocker = describeBlocker(refinement, uploadId);

  async function refine() {
    if (!refinement || !uploadId) return;
    setPending(true);
    setFailure(null);
    setResult(null);
    const outcome = await requestRefine({
      uploadId,
      region: {
        candidateId: candidate.id,
        label: candidate.place.label,
        ...(candidate.place.admin1 ? { admin1: candidate.place.admin1 } : {}),
        ...(candidate.place.country ? { country: candidate.place.country } : {}),
      },
      bbox: refinement.bbox,
      ...(signage && signage.length > 0 ? { signage: [...signage] } : {}),
    });
    setPending(false);
    if (outcome.ok) {
      setResult(outcome.result);
      onRefined?.(outcome.result);
    } else {
      setFailure(outcome);
    }
  }

  if (blocker) {
    return (
      <div className={cx('flex flex-col gap-2', className)}>
        <Button
          variant="secondary"
          disabled
          aria-describedby={`refine-gap-${candidate.id}`}
          className="self-start"
        >
          <Ban aria-hidden className="size-3.5" />
          Refine in {region}
        </Button>
        <div
          id={`refine-gap-${candidate.id}`}
          className="rounded-md border border-border bg-n-0 px-2.5 py-2"
        >
          <Eyebrow mono className="block">
            street precision unavailable here
          </Eyebrow>
          {/* The coverage probe's own words when there was one. */}
          <p className="mt-1 text-[12px] leading-snug text-fg-secondary">{blocker.reason}</p>
          <p className="mt-1.5">
            <span className="eyebrow-mono mr-1.5 text-n-400">missing</span>
            <span className="text-[12px] text-fg-secondary">{blocker.missing}</span>
          </p>
          {refinement ? <CoverageLine refinement={refinement} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <Button variant="secondary" onClick={refine} disabled={pending} className="self-start">
        <Crosshair aria-hidden className="size-3.5" />
        {pending ? `Refining in ${region}…` : `Refine in ${region}`}
      </Button>
      {refinement ? <CoverageLine refinement={refinement} /> : null}

      {failure ? (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)] px-2.5 py-2">
          <Eyebrow mono className="block" style={{ color: 'var(--color-alert)' }}>
            refine failed
          </Eyebrow>
          <p className="tnum mt-1 break-words font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
            {failure.statusLine}
          </p>
          {failure.message ? (
            /* Verbatim. Never rewritten into something friendlier. */
            <p className="mt-1.5 break-words whitespace-pre-wrap text-[12px] leading-snug text-fg-secondary">
              {failure.message}
            </p>
          ) : null}
          {failure.wasHtml ? (
            <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
              The response was an HTML error page rather than the JSON error shape.
            </p>
          ) : null}
        </div>
      ) : null}

      {result ? <RefineOutcomeBlock result={result} /> : null}
    </div>
  );
}

/** Why the control is off, and what would turn it on. Null means it is on. */
function describeBlocker(
  refinement: RegionRefinement | undefined,
  uploadId: string | undefined,
): { reason: string; missing: string } | null {
  if (!refinement) {
    return {
      reason:
        'This run did not report street-index coverage for the region, so there is no scope to search in. A refine is a scoped search and is never issued unbounded.',
      missing: 'The stage-1 coverage probe (`refinable` on the analyse response)',
    };
  }
  if (!refinement.refinable) {
    return {
      reason: refinement.reason,
      missing: 'A harvested street index covering this bbox',
    };
  }
  if (!uploadId) {
    return {
      reason:
        'The index covers this region, but the upload this run analysed was not passed to this panel. Stage 2 has to run on the same frame stage 1 did.',
      missing: 'The upload id from this run',
    };
  }
  return null;
}

/** What the coverage probe actually counted. Absent numbers stay absent. */
function CoverageLine({ refinement }: { refinement: RegionRefinement }) {
  const parts = [
    refinement.coverage,
    typeof refinement.indexedImages === 'number'
      ? `${refinement.indexedImages.toLocaleString('en-US')} indexed`
      : null,
    refinement.metros.length > 0 ? refinement.metros.join(', ') : null,
  ].filter(Boolean);

  return (
    <p className="tnum font-mono text-[10.5px] tracking-[0.04em] text-n-400">{parts.join(' · ')}</p>
  );
}

/**
 * The result of a refinement that ran.
 *
 * Zero candidates is a first-class outcome, not an error and not an empty list
 * to be filled with something region-shaped. It is rendered with the coverage
 * reason that explains it.
 */
function RefineOutcomeBlock({ result }: { result: RefineResult }) {
  if (result.refusal) {
    return (
      <div className="rounded-md border border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)] px-2.5 py-2">
        <Eyebrow mono className="block" style={{ color: 'var(--color-alert)' }}>
          refused · {result.refusal.kind}
        </Eyebrow>
        <p className="mt-1 text-[12px] leading-snug text-fg-secondary">{result.refusal.reason}</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-n-0 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow mono>Street candidates</Eyebrow>
        <Eyebrow mono className="tnum text-fg-secondary">
          {result.candidates.length}
        </Eyebrow>
      </div>
      {result.candidates.length === 0 ? (
        <p className="mt-1 text-[12px] leading-snug text-fg-secondary">{result.coverage.reason}</p>
      ) : null}
      {result.unavailable.map((gap, index) => (
        <p key={`${gap.capability}-${index}`} className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
          <span className="eyebrow-mono mr-1.5 text-n-400">unavailable</span>
          {gap.capability}
          {gap.envVar ? ` · set ${gap.envVar}` : ''}
        </p>
      ))}
    </div>
  );
}
