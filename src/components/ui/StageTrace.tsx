import type { StageTrace as StageTraceEntry } from '@/lib/contracts/types';
import { Eyebrow } from './Eyebrow';
import { cx } from './cx';

export interface StageTraceProps {
  stages: readonly StageTraceEntry[];
  className?: string;
}

/**
 * Compact pipeline readout: which cascade stages actually ran, and what each
 * cost in wall-clock time.
 *
 * Skipped stages are shown, greyed, with their reason. Hiding them would be the
 * wrong call — "we did not run the solar verifier because you gave us no
 * timestamp" is information the analyst needs in order to read the confidence
 * band correctly.
 */
export function StageTrace({ stages, className }: StageTraceProps) {
  const ranMs = stages.reduce((total, stage) => total + (stage.skipped ? 0 : stage.ranMs), 0);
  const ranCount = stages.reduce((total, stage) => total + (stage.skipped ? 0 : 1), 0);

  return (
    <div className={cx('flex flex-col', className)}>
      <ol className="flex flex-col gap-[5px]">
        {stages.map((stage) => {
          const skipped = stage.skipped;
          return (
            <li key={stage.stage}>
              <div className="flex items-baseline gap-2">
                <Eyebrow
                  mono
                  className={cx('shrink-0 whitespace-nowrap', skipped ? 'text-n-400' : 'text-fg-secondary')}
                >
                  {stage.stage.replace(/-/g, ' ')}
                </Eyebrow>
                <span aria-hidden className="min-w-2 flex-1 translate-y-[-3px] border-b border-dashed border-border" />
                <Eyebrow mono className={cx('tnum shrink-0', skipped ? 'text-n-400' : 'text-fg-secondary')}>
                  {skipped ? 'skipped' : `${stage.ranMs}ms`}
                </Eyebrow>
              </div>
              {skipped ? (
                <p className="mt-0.5 text-[11px] leading-snug text-n-400">{skipped.reason}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="mt-2.5 flex items-baseline gap-2 border-t border-border pt-2.5">
        <Eyebrow mono className="shrink-0 text-fg-tertiary">
          {ranCount} of {stages.length} stages
        </Eyebrow>
        <span aria-hidden className="flex-1" />
        <Eyebrow mono className="tnum shrink-0 text-fg">
          {ranMs}ms
        </Eyebrow>
      </div>
    </div>
  );
}
