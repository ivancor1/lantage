'use client';

import type { CapabilityGap } from '@/lib/live/contract';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';

/**
 * The mechanism that replaces sample data.
 *
 * When a capability is missing the response says so and returns nothing for that
 * section, so this panel is the only place the operator learns *why* a section is
 * empty. It is written as configuration instructions, not as an apology: the
 * capability, what it costs them, and the exact variable to set.
 *
 * Not dismissible, and it stays on screen after a reset — a missing key is a
 * property of the environment, not of one run.
 */

export interface CapabilityGapsProps {
  gaps: readonly CapabilityGap[];
  /** e.g. "reported by the last run". */
  provenanceNote?: string;
  className?: string;
}

export function CapabilityGaps({ gaps, provenanceNote, className }: CapabilityGapsProps) {
  if (gaps.length === 0) return null;

  return (
    <section
      className={cx(
        'rounded-nested border border-border bg-[var(--glass-3)] px-4 py-3',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow mono>Capabilities unavailable</Eyebrow>
        <Eyebrow mono className="tnum text-fg-secondary">
          {gaps.length}
        </Eyebrow>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
        {provenanceNote ? `${provenanceNote}. ` : ''}Each one returned nothing rather than a substitute.
      </p>

      <ul className="mt-3 flex flex-col gap-3">
        {gaps.map((gap, index) => (
          <li key={`${gap.capability}-${index}`} className="flex gap-2.5">
            <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-caution" />
            <div className="min-w-0">
              <Eyebrow mono className="block text-fg-secondary">
                {gap.capability}
              </Eyebrow>
              <p className="mt-1 text-[12px] leading-snug text-fg-secondary">{gap.impact}</p>
              {gap.envVar ? (
                <p className="mt-1.5">
                  <span className="eyebrow-mono mr-1.5 text-n-400">set</span>
                  <code className="rounded-sm border border-border bg-n-0 px-1.5 py-px font-mono text-[11px] text-fg">
                    {gap.envVar}
                  </code>
                </p>
              ) : null}
              {gap.howTo ? (
                <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
                  {/^https?:\/\//.test(gap.howTo) ? (
                    <a
                      href={gap.howTo}
                      target="_blank"
                      rel="noreferrer"
                      className="break-words text-fg-secondary underline decoration-border underline-offset-2 hover:text-fg"
                    >
                      {gap.howTo}
                    </a>
                  ) : (
                    gap.howTo
                  )}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
