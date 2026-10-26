'use client';

/**
 * The plain-language answer to "what happened?", pinned above everything else.
 *
 * Why this exists: a run that produces nothing is a legitimate and frequent
 * outcome — the model declining to name a region is the honest response to a
 * photo with no geographic content, and it is the behaviour the whole product
 * is built around. But the reason lived only in the stage trace, four sections
 * down, past the capability gaps and the EXIF block. An operator looking at the
 * top of the panel saw a heading, an input summary, a green QUALITY GATE PASSED,
 * and then nothing — which reads as "the app is broken", not as "the analysis
 * ran and honestly found nothing".
 *
 * Being honest in a field nobody scrolls to is not being honest. So: when a run
 * produces no findings, the terminal reason comes to the top, in the module's
 * own words, before anything else.
 */

import { CircleSlash, Info } from 'lucide-react';
import type { StageTrace } from '@/lib/contracts/types';
import type { Analysis } from './api';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';

/** Did this run actually surface something for the operator to look at? */
function hasFindings(a: Analysis): boolean {
  return Boolean(
    a.geo?.length ||
      a.vehicles?.length ||
      a.provenanceHits?.length ||
      a.authenticity ||
      a.face,
  );
}

/**
 * The reason the run ended where it did.
 *
 * The last skipped stage is the terminal one: stages run in order, so whatever
 * skipped most recently is what stopped the chain. A refused quality gate wins
 * outright, since nothing downstream was even attempted.
 */
function terminalReason(a: Analysis): { reason: string; stage?: StageTrace['stage'] } | null {
  if (a.quality && a.quality.passed === false) {
    return {
      reason:
        a.quality.refusalReason ??
        'The image did not pass the quality gate, so nothing was ranked.',
      stage: 'quality-gate',
    };
  }

  const skipped = (a.stages ?? []).filter((s) => s.skipped?.reason);
  const last = skipped[skipped.length - 1];
  if (last?.skipped?.reason) return { reason: last.skipped.reason, stage: last.stage };
  return null;
}

export interface OutcomeProps {
  analysis: Analysis;
  className?: string;
}

export function Outcome({ analysis, className }: OutcomeProps) {
  // Results present: they are the answer. Saying anything here would be noise.
  if (hasFindings(analysis)) return null;

  const terminal = terminalReason(analysis);
  const refused = analysis.quality?.passed === false;

  return (
    <section
      className={cx(
        'rounded-nested border px-4 py-3.5',
        refused
          ? 'border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)]'
          : 'border-[color-mix(in_srgb,var(--color-caution)_28%,transparent)] bg-[var(--caution-dim)]',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {refused ? (
          <CircleSlash aria-hidden className="size-3.5 shrink-0 text-alert" />
        ) : (
          <Info aria-hidden className="size-3.5 shrink-0 text-caution" />
        )}
        <Eyebrow mono style={{ color: refused ? 'var(--color-alert)' : 'var(--color-caution)' }}>
          {refused ? 'refused — nothing was ranked' : 'no findings'}
        </Eyebrow>
      </div>

      <p className="mt-2 text-[13px] leading-snug text-fg">
        {terminal?.reason ??
          'This run produced no findings, and it did not record a reason. That gap is itself a defect — a run should always be able to say why it ended where it did.'}
      </p>

      {terminal?.stage ? (
        <Eyebrow mono className="mt-2 block text-fg-tertiary">
          stopped at · {terminal.stage}
        </Eyebrow>
      ) : null}

      {/* The distinction that keeps a null result from reading as a broken one. */}
      <p className="mt-2.5 text-[12px] leading-snug text-fg-secondary">
        Nothing was substituted in place of a result. An empty answer here means the evidence was
        not there — not that the analysis failed to run.
      </p>
    </section>
  );
}
