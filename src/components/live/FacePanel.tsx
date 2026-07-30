'use client';

import { Ban } from 'lucide-react';
import type { FaceComparison, FaceProbe } from '@/lib/live/contract';
import { ConfidenceRing } from '@/components/ui/ConfidenceRing';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { CropOverlay } from './CropOverlay';
import { ABSENT } from './format';

/**
 * FACE results: a closed 1:1 comparison, and nothing more.
 *
 * When the verdict is `refused` no similarity is rendered at all — not greyed
 * out, not "below threshold", absent. Below roughly 24-32px inter-eye distance a
 * ranking is not defensible, and printing the number anyway invites the operator
 * to read it as a weak match rather than as no measurement.
 */

const VERDICT_LABEL: Record<FaceComparison['verdict'], string> = {
  'same-person': 'SAME PERSON',
  'different-person': 'DIFFERENT PERSON',
  inconclusive: 'INCONCLUSIVE',
  refused: 'COMPARISON REFUSED',
};

const VERDICT_COLOUR: Record<FaceComparison['verdict'], string> = {
  'same-person': 'var(--color-signal)',
  'different-person': 'var(--color-fg-secondary)',
  inconclusive: 'var(--color-caution)',
  refused: 'var(--color-alert)',
};

export interface FaceProbeSource {
  url?: string;
  filename?: string;
}

export interface FacePanelProps {
  comparison: FaceComparison;
  /** Resolves a probe's `uploadId` to something renderable. */
  sourceFor: (uploadId: string, index: number) => FaceProbeSource;
}

export function FacePanel({ comparison, sourceFor }: FacePanelProps) {
  const refused = comparison.verdict === 'refused';
  const colour = VERDICT_COLOUR[comparison.verdict];

  return (
    <section>
      <Eyebrow mono className="block">
        Probes
      </Eyebrow>
      <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
        Closed comparison between the two supplied images. There is no gallery and no internet face index.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        {comparison.probes.map((probe, index) => (
          <ProbeCard
            key={`${probe.uploadId}-${index}`}
            probe={probe}
            index={index}
            source={sourceFor(probe.uploadId, index)}
          />
        ))}
      </div>

      <div
        className="rounded-nested mt-4 border p-4"
        style={{
          borderColor: `color-mix(in srgb, ${colour} 30%, transparent)`,
          background: `color-mix(in srgb, ${colour} 8%, transparent)`,
        }}
      >
        <div className="flex items-center gap-2">
          {refused ? <Ban aria-hidden className="size-3.5 shrink-0 text-alert" /> : null}
          <Eyebrow mono style={{ color: colour }}>
            {VERDICT_LABEL[comparison.verdict] ?? comparison.verdict}
          </Eyebrow>
        </div>

        {refused ? (
          <p className="mt-2 text-[13px] leading-snug text-fg-secondary">
            {comparison.refusalReason ??
              'The comparison was refused and the server did not state a reason. No similarity was computed.'}
          </p>
        ) : (
          <>
            {typeof comparison.similarity === 'number' ? (
              <p className="tnum mt-2 font-mono text-[10.5px] tracking-[0.04em] text-fg-secondary">
                cosine similarity {comparison.similarity.toFixed(4)}
                {comparison.threshold ? ` · threshold ${comparison.threshold.value.toFixed(4)}` : ''}
              </p>
            ) : (
              <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
                No similarity was returned for this comparison.
              </p>
            )}
            {/* A threshold without its basis is an arbitrary line. */}
            {comparison.threshold ? (
              <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
                <span className="eyebrow-mono mr-1.5 text-n-400">threshold basis</span>
                {comparison.threshold.basis}
              </p>
            ) : null}
          </>
        )}
      </div>

      <ConfidenceRing confidence={comparison.confidence} size={48} showCalibration className="mt-4" />
    </section>
  );
}

function ProbeCard({
  probe,
  index,
  source,
}: {
  probe: FaceProbe;
  index: number;
  source: FaceProbeSource;
}) {
  const label = index === 0 ? 'PROBE A' : `PROBE ${String.fromCharCode(65 + index)}`;
  const tone = probe.passedGate ? 'neutral' : 'alert';

  return (
    <article className="rounded-nested border border-border bg-[var(--glass-3)] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow mono>{label}</Eyebrow>
        <Eyebrow mono style={{ color: probe.passedGate ? 'var(--color-signal)' : 'var(--color-alert)' }}>
          {probe.passedGate ? 'gate passed' : 'gate failed'}
        </Eyebrow>
      </div>

      {source.url ? (
        <CropOverlay
          src={source.url}
          alt={`${label}: ${source.filename ?? probe.uploadId}`}
          className="mt-2"
          boxes={
            probe.selected
              ? [{ box: probe.selected, label: 'selected face', tone }]
              : []
          }
          caption={source.filename}
        />
      ) : (
        <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
          No preview was returned for upload {probe.uploadId}.
        </p>
      )}

      <dl className="mt-2.5 flex flex-col gap-1">
        <Row term="faces found" value={String(probe.facesDetected)} />
        <Row
          term="inter-eye"
          value={
            typeof probe.interEyeDistancePx === 'number'
              ? `${probe.interEyeDistancePx.toFixed(1)} px`
              : ABSENT
          }
        />
        {typeof probe.detectionScore === 'number' ? (
          <Row term="detector" value={probe.detectionScore.toFixed(3)} />
        ) : null}
      </dl>

      {probe.note ? <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">{probe.note}</p> : null}
    </article>
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
