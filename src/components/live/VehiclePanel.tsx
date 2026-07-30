'use client';

import type { ReviewState, VehicleCandidate } from '@/lib/contracts/types';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { ReviewSelect } from '@/components/ui/ReviewSelect';
import { ABSENT } from './format';

/**
 * VEHICLE results: always a ranked set, never a single answer.
 *
 * Fine-grained make/model/year has high intra-class and low inter-class variance,
 * so top-1 is unreliable and the contract requires the UI to render the ranking
 * (`VehicleCandidate` docs). The `similarity` figure is printed as what it is — a
 * model score — and deliberately not styled as a confidence band, because the
 * analyser did not return one for it.
 */

export interface VehiclePanelProps {
  candidates: readonly VehicleCandidate[];
  reviews: Record<string, ReviewState>;
  onReview: (key: string, next: ReviewState) => void;
}

export function VehiclePanel({ candidates, reviews, onReview }: VehiclePanelProps) {
  const shown = [...candidates].sort((a, b) => a.rank - b.rank);

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow mono>Ranked candidates</Eyebrow>
        <Eyebrow mono className="tnum text-fg-secondary">
          {shown.length} returned
        </Eyebrow>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
        Read the whole list. Fine-grained model identification has low inter-class variance, so the top entry alone
        is not a finding.
      </p>

      {shown.length === 0 ? (
        <p className="mt-2 text-[13px] leading-snug text-fg-secondary">
          The run returned no vehicle candidates.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2.5">
          {shown.map((candidate) => {
            const key = `${candidate.rank}-${candidate.make}-${candidate.model}`;
            const verified = Boolean(candidate.vpic?.makeId ?? candidate.vpic?.modelId);
            return (
              <li key={key}>
                <article className="rounded-nested blur-in border border-border bg-[var(--glass-3)] p-4">
                  <header className="flex items-start gap-3">
                    <span className="tnum mt-px font-mono text-[11px] text-fg-tertiary">
                      {String(candidate.rank).padStart(2, '0')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm text-fg">
                        {candidate.make} {candidate.model}
                      </h3>
                      <p className="mt-0.5 text-[12px] text-fg-secondary">
                        {candidate.generation || ABSENT}
                        {candidate.color ? ` · ${candidate.color}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <Eyebrow mono className="block">
                        similarity
                      </Eyebrow>
                      <span className="tnum font-mono text-[12px] text-fg">
                        {candidate.similarity.toFixed(3)}
                      </span>
                    </div>
                  </header>

                  {/* vPIC is the audit trail for the taxonomy: with ids, the make and
                      model exist in NHTSA's database; without, they are the model's
                      own words and nothing has checked them. */}
                  <p className="tnum mt-3 border-t border-border pt-2.5 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
                    {verified
                      ? `vPIC verified · make id ${candidate.vpic?.makeId ?? ABSENT} · model id ${candidate.vpic?.modelId ?? ABSENT}`
                      : 'not verified against the NHTSA vPIC database'}
                  </p>

                  <footer className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                    <Eyebrow mono>Disposition</Eyebrow>
                    <ReviewSelect
                      value={reviews[key] ?? candidate.review}
                      onChange={(next) => onReview(key, next)}
                      aria-label={`Disposition for ${candidate.make} ${candidate.model}`}
                    />
                  </footer>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
