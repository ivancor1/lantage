'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ScanSearch, TriangleAlert } from 'lucide-react';
import type { GeoCandidate, ReviewState } from '@/lib/contracts/types';
import type {
  ProvenanceHit,
  RefineResult,
  RefineSignageClue,
  RegionRefinement,
} from '@/lib/live/contract';
import { Button } from '@/components/ui/Button';
import { ConfidenceRing } from '@/components/ui/ConfidenceRing';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { ReviewSelect } from '@/components/ui/ReviewSelect';
import { cx } from '@/components/ui/cx';
import { EvidenceChain } from './EvidenceChain';
import { RefineButton } from './RefineButton';
import { StreetCompare, type PromotedLocation } from './StreetCompare';
import { formatCoord, formatRadius } from './format';
import { precisionViolation } from './integrity';

/**
 * LOCATE / INTERIOR results: ranked *regions*, each carrying its own chain.
 *
 * There is no summary line that collapses the ranking into one answer, because
 * the ranking is the answer. Radius is rendered next to every coordinate for the
 * same reason — a coordinate without its radius reads as a pin, which is the one
 * claim `GeoCandidate` is designed not to make.
 */

export interface GeoPanelProps {
  candidates: readonly GeoCandidate[];
  /** Preview of the analysed upload, for evidence crop boxes. */
  sourceUrl?: string;
  sourceAlt?: string;
  reviews: Record<string, ReviewState>;
  onReview: (candidateId: string, next: ReviewState) => void;
  provenanceHits?: readonly ProvenanceHit[];
  /**
   * Stage-1 street-index coverage, one entry per candidate
   * (`LiveAnalyzeResponse.refinable`). Omitted means the run did not probe
   * coverage — which is not the same as "nothing is refinable", and every
   * `RefineButton` says so rather than assuming either way.
   */
  refinements?: readonly RegionRefinement[];
  /** The upload stage 1 ran on. Stage 2 has to run on the same frame. */
  uploadId?: string;
  /** Signage stage 1 read, forwarded to stage 2. It corroborates; it never seeds. */
  signage?: readonly RefineSignageClue[];
  /** Fires when the operator promotes a viewed location over the proposal. */
  onUpdateResult?: (candidateId: string, next: PromotedLocation) => void;
}

/** Which ranked set the compare surface is walking, and where in it. */
interface CompareTarget {
  candidates: readonly GeoCandidate[];
  index: number;
}

export function GeoPanel({
  candidates,
  sourceUrl,
  sourceAlt,
  reviews,
  onReview,
  provenanceHits,
  refinements,
  uploadId,
  signage,
  onUpdateResult,
}: GeoPanelProps) {
  /* The compare surface needs both panes side by side, so it opens over the
     whole viewport rather than inside this column. It is portalled because
     `.blur-in` leaves a `filter` on the ancestor card, and a filtered ancestor
     becomes the containing block for `position: fixed`. */
  const [compare, setCompare] = useState<CompareTarget | null>(null);
  /* Street candidates returned by stage 2, keyed by the region they refined.
     Held here rather than in the button so they can be rendered in the card
     vocabulary and handed to the compare surface. */
  const [refined, setRefined] = useState<Record<string, GeoCandidate[]>>({});
  /* No hydration hazard: `compare` is null through the first client render, so
     the portal cannot exist before the operator clicks. */
  const canPortal = typeof document !== 'undefined';

  const dialogRef = useRef<HTMLDivElement | null>(null);

  const closeCompare = useCallback(() => {
    setCompare(null);
  }, []);

  useEffect(() => {
    if (!compare) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCompare();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [compare, closeCompare]);

  const active = compare ? compare.candidates[compare.index] : undefined;

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow mono>Ranked regions</Eyebrow>
        <Eyebrow mono className="tnum text-fg-secondary">
          {candidates.length} returned
        </Eyebrow>
      </div>

      {candidates.length === 0 ? (
        <p className="mt-2 text-[13px] leading-snug text-fg-secondary">
          The run returned no regions. Nothing is shown in their place.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3">
          {candidates.map((candidate, index) => (
            <li key={candidate.id}>
              <CandidateCard
                candidate={candidate}
                sourceUrl={sourceUrl}
                sourceAlt={sourceAlt}
                review={reviews[candidate.id] ?? candidate.review}
                onReview={(next) => onReview(candidate.id, next)}
                refinement={refinements?.find((entry) => entry.candidateId === candidate.id)}
                uploadId={uploadId}
                signage={signage}
                refined={refined[candidate.id]}
                onRefined={(result: RefineResult) => {
                  setRefined((prev) => ({ ...prev, [candidate.id]: result.candidates }));
                }}
                onOpenCompare={(list, at) => setCompare({ candidates: list, index: at })}
                ownIndex={index}
                allCandidates={candidates}
              />
            </li>
          ))}
        </ol>
      )}

      {provenanceHits && provenanceHits.length > 0 ? <ProvenanceHits hits={provenanceHits} /> : null}

      {canPortal && compare && active
        ? createPortal(
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              tabIndex={-1}
              aria-label={`Side-by-side verification · ${active.place.label}`}
              className="fixed inset-0 z-50 flex items-center justify-center p-3 outline-none sm:p-6"
            >
              {/* MEASURED modal backdrop: blur(10px) over #0006. A real button so
                  click-to-dismiss is not a keyboard trap, out of the tab order
                  because the header's close control is the one to tab to. */}
              <button
                type="button"
                tabIndex={-1}
                aria-label="Close verification"
                onClick={closeCompare}
                className="absolute inset-0 cursor-default bg-[#0006] backdrop-blur-[10px]"
              />
              <div className="relative z-10 h-full max-h-[860px] w-full max-w-[1140px]">
                <StreetCompare
                  candidates={compare.candidates}
                  index={compare.index}
                  onIndexChange={(next) => setCompare({ candidates: compare.candidates, index: next })}
                  queryImageUrl={sourceUrl}
                  queryImageAlt={sourceAlt}
                  review={reviews[active.id] ?? active.review}
                  onReview={(next) => onReview(active.id, next)}
                  onUpdateResult={onUpdateResult}
                  onClose={closeCompare}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

function CandidateCard({
  candidate,
  sourceUrl,
  sourceAlt,
  review,
  onReview,
  refinement,
  uploadId,
  signage,
  refined,
  onRefined,
  onOpenCompare,
  ownIndex,
  allCandidates,
}: {
  candidate: GeoCandidate;
  sourceUrl?: string;
  sourceAlt?: string;
  review: ReviewState;
  onReview: (next: ReviewState) => void;
  refinement?: RegionRefinement;
  uploadId?: string;
  signage?: readonly RefineSignageClue[];
  /** Street candidates stage 2 returned for this region, if it has been run. */
  refined?: readonly GeoCandidate[];
  onRefined: (result: RefineResult) => void;
  onOpenCompare: (list: readonly GeoCandidate[], index: number) => void;
  ownIndex: number;
  allCandidates: readonly GeoCandidate[];
}) {
  const violation = precisionViolation(candidate);
  /* A street-precision candidate has already earned its precision from a
     retrieval match or an OCR geocode, so the next step is checking it. Anything
     coarser is a region, and the next step is asking whether it can be refined
     at all. Two different questions, two different controls. */
  const isStreet = candidate.precision === 'street';

  return (
    <article className="rounded-nested blur-in border border-border bg-[var(--glass-3)] p-4">
      <header className="flex items-start gap-3">
        <span className="tnum mt-px font-mono text-[11px] text-fg-tertiary">
          {String(candidate.rank).padStart(2, '0')}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm text-fg">{candidate.place.label}</h3>
          {candidate.place.admin1 || candidate.place.country ? (
            <p className="mt-0.5 truncate text-[12px] text-fg-tertiary">
              {[candidate.place.admin1, candidate.place.country].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          <p className="tnum mt-1 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
            {formatCoord(candidate.center.lat)}, {formatCoord(candidate.center.lon)} · ±
            {formatRadius(candidate.radiusM)}
          </p>
        </div>
        <Eyebrow mono className="mt-px shrink-0 rounded-full border border-border px-2 py-[3px]">
          {candidate.precision}
        </Eyebrow>
      </header>

      {violation ? <IntegrityFlag message={violation} /> : null}

      <ConfidenceRing confidence={candidate.confidence} size={48} showCalibration className="mt-4" />

      <section className="mt-4 border-t border-border pt-3">
        <Eyebrow mono className="block">
          Evidence · {candidate.evidence.length} signal{candidate.evidence.length === 1 ? '' : 's'}
        </Eyebrow>
        <EvidenceChain
          evidence={candidate.evidence}
          sourceUrl={sourceUrl}
          sourceAlt={sourceAlt}
          className="mt-2.5"
        />
      </section>

      <section className="mt-4 border-t border-border pt-3">
        {isStreet ? (
          <Button variant="secondary" onClick={() => onOpenCompare(allCandidates, ownIndex)}>
            <ScanSearch aria-hidden className="size-3.5" />
            Verify side by side
          </Button>
        ) : (
          <RefineButton
            candidate={candidate}
            refinement={refinement}
            uploadId={uploadId}
            signage={signage}
            onRefined={onRefined}
          />
        )}

        {/* Stage-2 output. Each one has earned street precision, so each one is
            checkable side by side — that is the whole point of refining. */}
        {refined && refined.length > 0 ? (
          <ol className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
            {refined.map((street, index) => (
              <li
                key={street.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-n-0 px-2.5 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-fg">{street.place.label}</p>
                  <p className="tnum mt-0.5 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
                    {formatCoord(street.center.lat)}, {formatCoord(street.center.lon)} · ±
                    {formatRadius(street.radiusM)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="h-9 shrink-0"
                  onClick={() => onOpenCompare(refined, index)}
                >
                  <ScanSearch aria-hidden className="size-3.5" />
                  Verify
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
        <Eyebrow mono>Disposition</Eyebrow>
        <ReviewSelect
          value={review}
          onChange={onReview}
          aria-label={`Disposition for ${candidate.place.label}`}
        />
      </footer>
    </article>
  );
}

/** A contract violation in the response. Rendered instead of being swallowed. */
function IntegrityFlag({ message }: { message: string }) {
  return (
    <div
      className={cx(
        'mt-3 flex gap-2 rounded-md border p-2.5',
        'border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)]',
      )}
    >
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-alert" />
      <div className="min-w-0">
        <Eyebrow mono className="block" style={{ color: 'var(--color-alert)' }}>
          contract violation in this response
        </Eyebrow>
        <p className="mt-1 text-[12px] leading-snug text-fg-secondary">{message}</p>
      </div>
    </div>
  );
}

/**
 * Reverse-image-search results.
 *
 * Attributed to the service that returned them, every time. These are somebody
 * else's finding about a page on the open web; presenting them as ours would be
 * the difference between "a service says this image appears here" and "we located
 * this image", which are not the same claim.
 */
function ProvenanceHits({ hits }: { hits: readonly ProvenanceHit[] }) {
  return (
    <section className="mt-5 border-t border-border pt-4">
      <Eyebrow mono className="block">
        Published copies · third-party finding
      </Eyebrow>
      <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
        Returned by the services named below, not by us. We store the URL only — no third-party pixels.
      </p>
      <ul className="mt-2.5 flex flex-col gap-2.5">
        {hits.map((hit, index) => (
          <li key={`${hit.source}-${index}`} className="border-l border-border pl-2.5">
            <div className="flex items-baseline gap-2">
              <Eyebrow mono className="shrink-0 text-fg-secondary">
                {hit.source}
              </Eyebrow>
              {/* Printed as the service reported it. We do not know its scale, so
                  we do not convert it into a percentage. */}
              {typeof hit.score === 'number' ? (
                <span className="tnum font-mono text-[10px] text-n-400">
                  service score {hit.score.toFixed(hit.score <= 1 ? 3 : 1)}
                </span>
              ) : null}
            </div>
            <a
              href={hit.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-words text-[13px] leading-snug text-fg underline decoration-border underline-offset-2 hover:decoration-fg-secondary"
            >
              {hit.title ?? hit.url}
            </a>
            {hit.place ? (
              <p className="mt-1 text-[12px] leading-snug text-fg-tertiary">
                <span className="eyebrow-mono mr-1.5 text-n-400">page text</span>
                {hit.place}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
