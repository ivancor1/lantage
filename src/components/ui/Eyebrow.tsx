import type { ComponentPropsWithoutRef } from 'react';
import { cx } from './cx';

export interface EyebrowProps extends ComponentPropsWithoutRef<'span'> {
  /**
   * `true` renders the JetBrains Mono variant — the signature investigative
   * microlabel (DESIGN_SYSTEM.md §2). Prefer it for panel titles, pipeline
   * stages and status annotations. `false` renders the sans variant, which is
   * only for eyebrows sitting directly above prose.
   */
  mono?: boolean;
}

/** Uppercase microlabel. Both variants are defined in globals.css. */
export function Eyebrow({ mono = false, className, ...rest }: EyebrowProps) {
  return <span className={cx(mono ? 'eyebrow-mono' : 'eyebrow', className)} {...rest} />;
}
