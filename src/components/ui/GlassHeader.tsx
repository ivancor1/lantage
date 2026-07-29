'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cx } from './cx';

export interface GlassHeaderProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  /** Scroll distance in px before the scrim fades in. */
  threshold?: number;
  /**
   * Pin the scrim on. Necessary on surfaces that never scroll — the full-bleed
   * map shell, for instance — where the header still needs separation from the
   * canvas behind it.
   */
  forceScrim?: boolean;
  className?: string;
}

/**
 * Fixed application header.
 *
 * The important detail (MEASURED from flysoar.ai, DESIGN_SYSTEM.md §3a): the
 * glass is NOT on the header. A separate fixed, pointer-transparent span sits
 * underneath and masks its own blur out towards the bottom. That mask is why
 * this header has no hard blur edge, which is the giveaway on every other glass
 * nav. Putting `backdrop-filter` on the header itself would undo the whole trick.
 */
export function GlassHeader({
  left,
  center,
  right,
  threshold = 8,
  forceScrim = false,
  className,
}: GlassHeaderProps) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (forceScrim) return;
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [forceScrim, threshold]);

  const scrimVisible = forceScrim || scrolled;

  return (
    <>
      <span aria-hidden className={cx('glass-scrim z-40', scrimVisible ? 'opacity-100' : 'opacity-0')} />
      <header
        className={cx(
          'fixed inset-x-0 top-0 z-50 grid grid-cols-[1fr_auto_1fr] items-center gap-4',
          'px-7 pb-[18px] pt-[max(18px,env(safe-area-inset-top))]',
          'max-[820px]:gap-2 max-[820px]:px-4 max-[820px]:pb-[14px] max-[820px]:pt-[max(14px,env(safe-area-inset-top))]',
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-3 justify-self-start">{left}</div>
        <div className="flex min-w-0 items-center gap-2 justify-self-center">{center}</div>
        <div className="flex min-w-0 items-center gap-2 justify-self-end">{right}</div>
      </header>
    </>
  );
}
