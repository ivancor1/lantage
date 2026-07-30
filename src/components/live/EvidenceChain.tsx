'use client';

import type { Evidence } from '@/lib/contracts/types';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';
import { CropOverlay } from './CropOverlay';
import { EVIDENCE_LABEL, readEvidenceBox } from './format';

/**
 * The evidence chain, rendered whole.
 *
 * Both halves of each signal are mandatory: the `claim` (what it asserts) and the
 * `verifiable` line (how a human checks it without trusting us). The contract
 * says a signal that cannot be independently checked is telemetry, not evidence,
 * so `verifiable` is never collapsed, truncated or hidden behind a disclosure.
 */

export interface EvidenceChainProps {
  evidence: readonly Evidence[];
  /** Frame the crop box is drawn over. The operator's own upload. */
  sourceUrl?: string;
  sourceAlt?: string;
  className?: string;
}

export function EvidenceChain({ evidence, sourceUrl, sourceAlt, className }: EvidenceChainProps) {
  if (evidence.length === 0) return null;

  return (
    <ul className={cx('flex flex-col gap-3', className)}>
      {evidence.map((entry, index) => {
        const box = readEvidenceBox(entry);
        return (
          <li key={`${entry.kind}-${index}`} className="flex gap-2.5">
            <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-n-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <Eyebrow mono className="text-fg-secondary">
                  {EVIDENCE_LABEL[entry.kind] ?? entry.kind}
                </Eyebrow>
                {typeof entry.weight === 'number' ? (
                  <span className="tnum font-mono text-[10px] text-n-400">w {entry.weight.toFixed(2)}</span>
                ) : null}
              </div>
              <p className="mt-1 text-[13px] leading-snug text-fg-secondary">{entry.claim}</p>
              <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
                <span className="eyebrow-mono mr-1.5 text-n-400">verify</span>
                {entry.verifiable}
              </p>

              {/* The cited region, drawn over the operator's own frame. Preferred
                  over fetching `cropUrl`: it keeps the surrounding context, and it
                  does not depend on a crop endpoint that may not exist. */}
              {box && sourceUrl ? (
                <CropOverlay
                  src={sourceUrl}
                  alt={sourceAlt ?? 'Uploaded frame with the cited region outlined'}
                  boxes={[{ box, label: EVIDENCE_LABEL[entry.kind] ?? entry.kind }]}
                  className="mt-2 max-w-[220px]"
                  caption="cited region"
                />
              ) : entry.cropUrl ? (
                <CropOverlay
                  src={entry.cropUrl}
                  alt={`Crop supporting: ${entry.claim}`}
                  className="mt-2 max-w-[220px]"
                  caption="returned crop"
                />
              ) : null}

              {entry.reference ? (
                <Eyebrow mono className="mt-1.5 block text-n-400">
                  ref ·{' '}
                  {entry.reference.url ? (
                    <a
                      href={entry.reference.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-fg-secondary underline decoration-border underline-offset-2 hover:text-fg"
                    >
                      {entry.reference.label}
                    </a>
                  ) : (
                    entry.reference.label
                  )}
                  {entry.reference.panoId ? ` · pano ${entry.reference.panoId}` : ''}
                  {entry.reference.mapillaryId ? ` · mapillary ${entry.reference.mapillaryId}` : ''}
                </Eyebrow>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
