import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx';

export type GlassCardProps = ComponentPropsWithRef<'div'>;

/**
 * Card surface. Uses `.glass-card`, which is **not** blurred.
 *
 * That is deliberate and MEASURED — see DESIGN_SYSTEM.md §3c. Blur is reserved
 * for floating chrome (`.glass-pill`). Blurring a card that sits over a live map
 * destroys text legibility and is the most expensive thing you can composite
 * over a moving canvas.
 */
export function GlassCard({ className, ...rest }: GlassCardProps) {
  return <div className={cx('glass-card', className)} {...rest} />;
}
