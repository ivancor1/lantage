'use client';

import type { AuthenticityResult } from '@/lib/contracts/types';
import { ConfidenceRing } from '@/components/ui/ConfidenceRing';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { EvidenceChain } from './EvidenceChain';
import { SUPPRESSION_LABEL, VERDICT_COLOUR, VERDICT_LABEL, formatFraction } from './format';

/**
 * AUTHENTIC results.
 *
 * Two rules are enforced by construction here:
 *
 *   - the word "authentic" is never rendered as a verdict — `no-indicators-found`
 *     is the strongest statement available, and it is styled neutral rather than
 *     green so it cannot read as "verified real";
 *   - the PPV math is shown, not buried. At a 5-15% false-positive rate and low
 *     prevalence most positive flags are false positives, and an operator who is
 *     not shown that arithmetic will over-read the verdict.
 */

export interface AuthenticityPanelProps {
  result: AuthenticityResult;
  sourceUrl?: string;
  sourceAlt?: string;
}

export function AuthenticityPanel({ result, sourceUrl, sourceAlt }: AuthenticityPanelProps) {
  const colour = VERDICT_COLOUR[result.verdict];
  const ppvPercent = formatFraction(result.ppv?.value);
  const basePercent = formatFraction(result.ppv?.assumedBaseRate);
  const inHundred =
    typeof result.ppv?.value === 'number' && Number.isFinite(result.ppv.value)
      ? Math.round(result.ppv.value * 100)
      : null;

  return (
    <section>
      <Eyebrow mono className="block">
        Verdict
      </Eyebrow>

      {/* The verdict band. Colour is the only signal it carries, and it never
          goes green — see the module comment. */}
      <div
        className="rounded-nested mt-2 border p-4"
        style={{
          borderColor: `color-mix(in srgb, ${colour} 30%, transparent)`,
          background: `color-mix(in srgb, ${colour} 8%, transparent)`,
        }}
      >
        <Eyebrow mono className="block" style={{ color: colour }}>
          {VERDICT_LABEL[result.verdict] ?? result.verdict}
        </Eyebrow>
        <p className="mt-2 text-[13px] leading-snug text-fg-secondary">{result.confidence.reason}</p>
        {result.verdict === 'no-indicators-found' ? (
          <p className="mt-2 border-t border-border pt-2 text-[12px] leading-snug text-fg-tertiary">
            No indicators found is not a finding of authenticity. Platforms strip Content Credentials on upload
            almost every time, and no detector clears an image.
          </p>
        ) : null}
      </div>

      <ConfidenceRing confidence={result.confidence} size={48} showCalibration className="mt-4" />

      {/* PPV, spelled out. */}
      <section className="rounded-nested mt-4 border border-border bg-[var(--glass-3)] px-4 py-3">
        <Eyebrow mono className="block">
          Positive predictive value
        </Eyebrow>
        <p className="tnum mt-2 font-mono text-[10.5px] tracking-[0.04em] text-fg-secondary">
          PPV {ppvPercent} at an assumed base rate of {basePercent}
        </p>
        {inHundred !== null ? (
          <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
            Of 100 images this threshold flags at that base rate, about {inHundred} are true positives. The rest are
            not.
          </p>
        ) : null}
      </section>

      {result.suppressedBy && result.suppressedBy.length > 0 ? (
        <section className="mt-4 border-t border-border pt-3">
          <Eyebrow mono className="block">
            Verdict suppressed by
          </Eyebrow>
          <ul className="mt-2 flex flex-col gap-1.5">
            {result.suppressedBy.map((reason) => (
              <li key={reason} className="flex gap-2 text-[12px] leading-snug text-fg-secondary">
                <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-caution" />
                {SUPPRESSION_LABEL[reason] ?? reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
            These are documented false-positive classes. The detector score is withheld rather than reported as a
            finding.
          </p>
        </section>
      ) : null}

      {/* C2PA first, because it is deterministic. */}
      <section className="mt-4 border-t border-border pt-3">
        <Eyebrow mono className="block">
          Content credentials
        </Eyebrow>
        <dl className="mt-2 flex flex-col gap-1.5">
          <Row
            term="manifest"
            value={result.provenance.hasManifest ? 'present' : 'none in this file'}
          />
          {result.provenance.issuer ? <Row term="issuer" value={result.provenance.issuer} /> : null}
          {typeof result.provenance.valid === 'boolean' ? (
            <Row term="signature" value={result.provenance.valid ? 'valid' : 'invalid'} />
          ) : null}
          {result.provenance.generator ? <Row term="generator" value={result.provenance.generator} /> : null}
        </dl>
      </section>

      <section className="mt-4 border-t border-border pt-3">
        <Eyebrow mono className="block">
          Evidence · {result.evidence.length} signal{result.evidence.length === 1 ? '' : 's'}
        </Eyebrow>
        <EvidenceChain
          evidence={result.evidence}
          sourceUrl={sourceUrl}
          sourceAlt={sourceAlt}
          className="mt-2.5"
        />
      </section>
    </section>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="eyebrow-mono shrink-0 text-n-400">{term}</dt>
      <span aria-hidden className="min-w-2 flex-1 translate-y-[-3px] border-b border-dashed border-border" />
      <dd className="tnum shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-fg-secondary">{value}</dd>
    </div>
  );
}
