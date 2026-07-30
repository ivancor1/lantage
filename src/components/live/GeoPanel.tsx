'use client';

import { TriangleAlert } from 'lucide-react';
import type { GeoCandidate, ReviewState } from '@/lib/contracts/types';
import type { ProvenanceHit } from '@/lib/live/contract';
import { ConfidenceRing } from '@/components/ui/ConfidenceRing';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { ReviewSelect } from '@/components/ui/ReviewSelect';
import { cx } from '@/components/ui/cx';
import { EvidenceChain } from './EvidenceChain';
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
}

export function GeoPanel({
  candidates,
  sourceUrl,
  sourceAlt,
  reviews,
  onReview,
  provenanceHits,
}: GeoPanelProps) {
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
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <CandidateCard
                candidate={candidate}
                sourceUrl={sourceUrl}
                sourceAlt={sourceAlt}
                review={reviews[candidate.id] ?? candidate.review}
                onReview={(next) => onReview(candidate.id, next)}
              />
            </li>
          ))}
        </ol>
      )}

      {provenanceHits && provenanceHits.length > 0 ? <ProvenanceHits hits={provenanceHits} /> : null}
    </section>
  );
}

function CandidateCard({
  candidate,
  sourceUrl,
  sourceAlt,
  review,
  onReview,
}: {
  candidate: GeoCandidate;
  sourceUrl?: string;
  sourceAlt?: string;
  review: ReviewState;
  onReview: (next: ReviewState) => void;
}) {
  const violation = precisionViolation(candidate);

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
