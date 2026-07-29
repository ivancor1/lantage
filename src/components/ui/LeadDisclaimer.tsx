import { LEAD_DISCLAIMER } from '@/lib/contracts/types';
import { cx } from './cx';

export interface LeadDisclaimerProps {
  className?: string;
}

/**
 * Permanent UI furniture on every result surface.
 *
 * There is no `onDismiss`, no close button and no state in this component, and
 * adding any of them would violate the product contract (AGENTS.md, and §8 of
 * the design system). A dismissible warning is a warning nobody reads. The text
 * itself comes from the contracts module so it can never drift.
 */
export function LeadDisclaimer({ className }: LeadDisclaimerProps) {
  return (
    <p className={cx('eyebrow-mono flex items-center gap-2 text-fg-tertiary', className)}>
      <span aria-hidden className="inline-block size-1 shrink-0 rounded-full bg-caution" />
      {LEAD_DISCLAIMER}
    </p>
  );
}
