import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  /**
   * Ghost-only. Selection reads as an inset hairline ring rather than a fill —
   * a fill would introduce decorative colour, which the design system forbids.
   */
  selected?: boolean;
}

/* Everything is a pill. The focus ring is the universal `:focus-visible` rule in
   globals.css, so no variant declares its own. */
const BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-full select-none ' +
  'transition-[background-color,border-color,color,box-shadow,transform] ' +
  'duration-[140ms] ease-[var(--ease-smooth)] ' +
  'disabled:pointer-events-none disabled:opacity-45';

const VARIANT: Record<ButtonVariant, string> = {
  /* DERIVED: flysoar.ai's blue glossy gradient collapses to a flat white fill.
     White-on-black is the Raven "Search →" / "Select This Result" button. */
  primary: 'h-11 px-[18px] text-base font-semibold bg-fg text-n-0 hover:bg-fg-secondary active:scale-[.99]',
  secondary:
    'min-h-[38px] px-[15px] text-sm font-medium bg-n-0 text-fg border border-border-strong ' +
    'hover:bg-n-100 hover:border-n-400 active:scale-[.99]',
  ghost: 'px-[10px] py-[6px] text-sm text-fg-secondary hover:bg-n-100 hover:text-fg active:scale-[.99]',
  icon: 'size-[38px] p-0 border border-border text-fg-secondary hover:bg-n-100 hover:text-fg active:scale-[.96]',
};

export function Button({ variant = 'secondary', selected = false, className, type, ...rest }: ButtonProps) {
  return (
    <button
      /* Buttons default to submit inside a form, which is almost never what an
         investigative control wants. */
      type={type ?? 'button'}
      aria-pressed={variant === 'ghost' && selected ? true : undefined}
      className={cx(
        BASE,
        VARIANT[variant],
        variant === 'ghost' && selected && 'text-fg shadow-[inset_0_0_0_1.5px_var(--color-border-strong)]',
        className,
      )}
      {...rest}
    />
  );
}
