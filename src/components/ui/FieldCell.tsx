import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx';

export interface FieldCellProps extends Omit<ComponentPropsWithRef<'input'>, 'className'> {
  /** Uppercase micro-label sitting above the input. */
  label: string;
  /**
   * Draws the 1px × 20px hairline that separates adjacent cells inside a pill
   * group (MEASURED). Set it on every cell except the first.
   */
  divider?: boolean;
  /** Applied to the pill well, not the input. */
  className?: string;
}

/**
 * A 48px pill well containing a micro-label and a transparent input.
 *
 * The input is wrapped by its `<label>` rather than wired with an id, which
 * keeps this component server-safe (no `useId`) while staying accessible.
 */
export function FieldCell({ label, divider = false, className, ...inputProps }: FieldCellProps) {
  return (
    <label
      className={cx(
        'relative flex h-12 min-w-0 cursor-text flex-col justify-center gap-[3px] rounded-full px-4',
        'transition-colors duration-[140ms] ease-[var(--ease-smooth)] hover:bg-n-100 focus-within:bg-n-100',
        divider &&
          'before:absolute before:left-0 before:top-1/2 before:h-5 before:w-px before:-translate-y-1/2 before:bg-border',
        className,
      )}
    >
      <span className="eyebrow-mono leading-none">{label}</span>
      <input
        {...inputProps}
        /* 15px desktop, 16px below 820px: anything under 16px makes iOS Safari
           zoom the viewport on focus, which would fight the full-bleed map. */
        className={cx(
          'w-full min-w-0 bg-transparent text-[15px] font-medium leading-none text-fg',
          'placeholder:font-normal placeholder:text-fg-tertiary max-[820px]:text-[16px]',
        )}
      />
    </label>
  );
}
