'use client';

import { useState, type ChangeEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ReviewState } from '@/lib/contracts/types';
import { cx } from './cx';

const OPTIONS: ReadonlyArray<{ value: ReviewState; label: string }> = [
  { value: 'unreviewed', label: 'Unreviewed' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'nearby', label: 'Nearby' },
  { value: 'incorrect', label: 'Incorrect' },
];

/* Analyst disposition is state, and state is one of the few things allowed to
   carry colour. Unreviewed stays grey precisely so it does not look decided. */
const STATE_COLOUR: Record<ReviewState, string> = {
  unreviewed: 'var(--color-fg-tertiary)',
  confirmed: 'var(--color-signal)',
  nearby: 'var(--color-caution)',
  incorrect: 'var(--color-alert)',
};

export interface ReviewSelectProps {
  value: ReviewState;
  /**
   * Omit to let the control manage its own disposition (useful for read-only or
   * fixture surfaces). Supply it and the control becomes fully parent-driven.
   */
  onChange?: (next: ReviewState) => void;
  className?: string;
  'aria-label'?: string;
}

export function ReviewSelect({
  value,
  onChange,
  className,
  'aria-label': ariaLabel = 'Analyst disposition',
}: ReviewSelectProps) {
  const [internal, setInternal] = useState<ReviewState>(value);
  const current = onChange ? value : internal;
  const colour = STATE_COLOUR[current];

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as ReviewState;
    setInternal(next);
    onChange?.(next);
  }

  return (
    <div
      className={cx(
        'relative inline-flex h-8 items-center rounded-full border border-border bg-n-0',
        'transition-colors duration-[140ms] ease-[var(--ease-smooth)] hover:border-n-400',
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-3 size-1.5 rounded-full"
        style={{ background: colour }}
      />
      <select
        aria-label={ariaLabel}
        value={current}
        onChange={handleChange}
        className={cx(
          'h-full w-full cursor-pointer appearance-none rounded-full bg-transparent pl-7 pr-7',
          'font-mono text-[10.5px] uppercase tracking-[0.08em] outline-none',
        )}
        style={{ color: colour }}
      >
        {OPTIONS.map((option) => (
          /* The native list renders in OS chrome, so options need an explicit
             dark background — the theme cannot reach inside it. */
          <option key={option.value} value={option.value} className="bg-n-0 text-fg">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 size-3 text-fg-tertiary" />
    </div>
  );
}
