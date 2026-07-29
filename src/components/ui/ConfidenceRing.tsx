import type { Confidence, ConfidenceBand } from '@/lib/contracts/types';
import { Eyebrow } from './Eyebrow';
import { cx } from './cx';

/**
 * The confidence display. DESIGN_SYSTEM.md §8 treats this as a product-integrity
 * component rather than a styling one, so the rules are enforced here in code:
 *
 *   - never a bare percentage — the band label and `reason` always ship with it;
 *   - `refused` renders the refusal and NO percentage, because a number on input
 *     the quality gate rejected is a claim we cannot support;
 *   - green means genuinely high or moderate. If everything looks confirmed the
 *     colour system is worthless.
 */

const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: 'HIGH CONFIDENCE',
  moderate: 'MODERATE',
  weak: 'WEAK SIGNAL',
  refused: 'NOT MATCHABLE',
};

/* Colour carries meaning only. These are the only three hues in the app. */
const BAND_COLOUR: Record<ConfidenceBand, string> = {
  high: 'var(--color-signal)',
  moderate: 'var(--color-signal)',
  weak: 'var(--color-caution)',
  refused: 'var(--color-alert)',
};

export interface ConfidenceRingProps {
  confidence: Confidence;
  /** Outer diameter of the ring in px. */
  size?: number;
  /**
   * Show the calibration set + model version under the reason. Off by default;
   * turn it on wherever a finding has to be reproducible on the record.
   */
  showCalibration?: boolean;
  className?: string;
}

export function ConfidenceRing({
  confidence,
  size = 56,
  showCalibration = false,
  className,
}: ConfidenceRingProps) {
  const { band, score, reason, calibration } = confidence;
  const refused = band === 'refused';
  const colour = BAND_COLOUR[band];
  const label = BAND_LABEL[band];

  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(1, Math.max(0, score));
  const percent = Math.round(fraction * 100);

  return (
    <div className={cx('flex items-start gap-3', className)}>
      <div
        role="img"
        aria-label={refused ? `${label}. ${reason}` : `${label}, ${percent} percent. ${reason}`}
        className="relative shrink-0"
        style={{ width: size, height: size }}
      >
        {/* -rotate-90 so the arc starts at 12 o'clock. */}
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={colour}
            strokeWidth={stroke}
            strokeLinecap="round"
            /* Refused: a dashed full ring. It reads as "no measurement taken"
               rather than as a low score, which is a different claim. */
            strokeDasharray={refused ? '2 5' : circumference}
            strokeDashoffset={refused ? 0 : circumference * (1 - fraction)}
            opacity={refused ? 0.75 : 1}
          />
        </svg>
        <span
          className="tnum absolute inset-0 flex items-center justify-center text-[13px] font-medium leading-none"
          style={{ color: colour }}
          aria-hidden
        >
          {refused ? '—' : `${percent}%`}
        </span>
      </div>

      <div className="min-w-0 pt-1">
        <Eyebrow mono className="block" style={{ color: colour }}>
          {label}
        </Eyebrow>
        {/* The plain-English reason is what makes a probabilistic result read as
            credible. It is required by the contract, so it is never optional here. */}
        <p className="mt-1.5 text-[13px] leading-snug text-fg-secondary">{reason}</p>
        {showCalibration ? (
          <Eyebrow mono className="mt-2 block text-n-400">
            CAL · {calibration}
          </Eyebrow>
        ) : null}
      </div>
    </div>
  );
}
