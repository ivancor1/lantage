'use client';

import { TriangleAlert } from 'lucide-react';
import type { ReviewState } from '@/lib/contracts/types';
import { MODULE_CATALOGUE, type UploadRecord } from '@/lib/live/contract';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { GlassCard } from '@/components/ui/GlassCard';
import { LeadDisclaimer } from '@/components/ui/LeadDisclaimer';
import { StageTrace } from '@/components/ui/StageTrace';
import { cx } from '@/components/ui/cx';
import type { Analysis } from './api';
import { AuthenticityPanel } from './AuthenticityPanel';
import { CapabilityGaps } from './CapabilityGaps';
import { EvidenceChain } from './EvidenceChain';
import { FacePanel, type FaceProbeSource } from './FacePanel';
import { GeoPanel } from './GeoPanel';
import { VehiclePanel } from './VehiclePanel';
import { ABSENT, formatBytes, formatIsoTime, shortHash } from './format';
import { refusalViolation } from './integrity';

/**
 * The result surface.
 *
 * Every section is conditional on its data existing in the response. There is no
 * "no data" filler, no zeroed metric and no placeholder row: if the analyser did
 * not return a section, the section is not on screen. `LeadDisclaimer` is pinned
 * in the footer and has no dismiss affordance, by contract.
 */

export interface ResultsPanelProps {
  analysis: Analysis;
  /** Records from the upload step, used when the response omits `uploads`. */
  fallbackUploads: readonly UploadRecord[];
  reviews: Record<string, ReviewState>;
  onReview: (key: string, next: ReviewState) => void;
  /** True when the stage trace arrived as a stream rather than in one payload. */
  streamed: boolean;
  className?: string;
}

export function ResultsPanel({
  analysis,
  fallbackUploads,
  reviews,
  onReview,
  streamed,
  className,
}: ResultsPanelProps) {
  const descriptor = MODULE_CATALOGUE.find((entry) => entry.id === analysis.module);
  /* Prefer the response's own records, but keep the local object URL when the
     server did not hand back a preview path — otherwise the operator loses the
     ability to see the frame the evidence is drawn on. */
  const uploads = (analysis.uploads.length > 0 ? analysis.uploads : [...fallbackUploads]).map((upload) => {
    if (upload.previewUrl) return upload;
    const local = fallbackUploads.find((record) => record.id === upload.id);
    return local ? { ...upload, previewUrl: local.previewUrl } : upload;
  });
  const primary = uploads[0];
  const violation = refusalViolation(analysis);
  const quality = analysis.quality;
  const refused = quality ? !quality.passed : false;

  const sourceFor = (uploadId: string, index: number): FaceProbeSource => {
    const match = uploads.find((upload) => upload.id === uploadId) ?? uploads[index];
    return { url: match?.previewUrl, filename: match?.filename };
  };

  return (
    <GlassCard className={cx('flex h-full flex-col overflow-hidden', className)}>
      <header className="shrink-0 border-b border-border px-5 pb-4 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <Eyebrow mono>Result · {analysis.module}</Eyebrow>
          <Eyebrow mono className="tnum truncate text-fg-tertiary" title={analysis.id}>
            {analysis.id ?? ABSENT}
          </Eyebrow>
        </div>
        <h2 className="mt-2 text-[17px] text-fg">{descriptor?.label ?? analysis.module}</h2>
        {descriptor ? (
          <p className="mt-1.5 text-[13px] leading-snug text-fg-secondary">{descriptor.blurb}</p>
        ) : null}
        <Eyebrow mono className="tnum mt-2 block text-n-400">
          {formatIsoTime(analysis.createdAt)}
        </Eyebrow>
      </header>

      <div
        data-lenis-prevent
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-width:thin]"
      >
        {violation ? (
          <section className="rounded-nested mb-4 border border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)] p-4">
            <div className="flex items-center gap-2">
              <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-alert" />
              <Eyebrow mono style={{ color: 'var(--color-alert)' }}>
                contract violation in this response
              </Eyebrow>
            </div>
            <p className="mt-2 text-[12px] leading-snug text-fg-secondary">{violation}</p>
          </section>
        ) : null}

        <CapabilityGaps gaps={analysis.unavailable} provenanceNote="Reported by this run" className="mb-4" />

        {/* Input, as measured. */}
        {uploads.length > 0 ? (
          <section className="rounded-nested border border-border bg-[var(--glass-3)] px-4 py-3">
            <Eyebrow mono className="block">
              Input
            </Eyebrow>
            <ul className="mt-2 flex flex-col gap-2">
              {uploads.map((upload) => (
                <li key={upload.id}>
                  <p className="truncate text-[13px] text-fg" title={upload.filename}>
                    {upload.filename}
                  </p>
                  <p className="tnum mt-0.5 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
                    {formatBytes(upload.bytes)}
                    {upload.mime ? ` · ${upload.mime}` : ''}
                    {upload.width && upload.height ? ` · ${upload.width}×${upload.height}` : ''}
                  </p>
                  {upload.sha256 ? (
                    <Eyebrow mono className="tnum mt-0.5 block text-n-400">
                      sha256 {shortHash(upload.sha256)}
                    </Eyebrow>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Quality gate. The band ceiling depends on it, so it comes first. */}
        {quality ? (
          <section
            className={cx(
              'rounded-nested mt-4 border px-4 py-3',
              refused
                ? 'border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)]'
                : 'border-border bg-[var(--glass-3)]',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <Eyebrow mono>Quality gate</Eyebrow>
              <Eyebrow
                mono
                style={{
                  color: refused
                    ? 'var(--color-alert)'
                    : quality.degraded
                      ? 'var(--color-caution)'
                      : 'var(--color-signal)',
                }}
              >
                {refused ? 'refused' : quality.degraded ? 'degraded' : 'passed'}
              </Eyebrow>
            </div>
            <p className="tnum mt-2 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
              {[
                typeof quality.unifiedScore === 'number' ? `OFIQ ${quality.unifiedScore}` : null,
                quality.components?.resolutionPx
                  ? `${quality.components.resolutionPx.w}×${quality.components.resolutionPx.h}`
                  : null,
                typeof quality.components?.blur === 'number' ? `blur ${quality.components.blur.toFixed(2)}` : null,
                typeof quality.components?.exposure === 'number'
                  ? `exposure ${quality.components.exposure.toFixed(2)}`
                  : null,
                typeof quality.components?.occlusion === 'number'
                  ? `occlusion ${quality.components.occlusion.toFixed(2)}`
                  : null,
                typeof quality.components?.interEyeDistancePx === 'number'
                  ? `inter-eye ${quality.components.interEyeDistancePx.toFixed(1)}px`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'no components reported'}
            </p>
            {/* A refusal is the finding. It is not softened into a low score. */}
            {refused && quality.refusalReason ? (
              <p className="mt-2.5 border-t border-border pt-2.5 text-[13px] leading-snug text-fg-secondary">
                {quality.refusalReason}
              </p>
            ) : null}
            {refused ? (
              <Eyebrow mono className="mt-2 block" style={{ color: 'var(--color-alert)' }}>
                no ranking returned
              </Eyebrow>
            ) : null}
          </section>
        ) : null}

        {/* Module payloads. Each renders only if the response carried it. */}
        <div className="mt-5 flex flex-col gap-5">
          {analysis.geo ? (
            <GeoPanel
              candidates={analysis.geo}
              sourceUrl={primary?.previewUrl}
              sourceAlt={primary ? `Uploaded frame ${primary.filename}` : undefined}
              reviews={reviews}
              onReview={onReview}
              provenanceHits={analysis.provenanceHits}
            />
          ) : null}

          {analysis.vehicles ? (
            <VehiclePanel candidates={analysis.vehicles} reviews={reviews} onReview={onReview} />
          ) : null}

          {analysis.authenticity ? (
            <AuthenticityPanel
              result={analysis.authenticity}
              sourceUrl={primary?.previewUrl}
              sourceAlt={primary ? `Uploaded frame ${primary.filename}` : undefined}
            />
          ) : null}

          {analysis.face ? <FacePanel comparison={analysis.face} sourceFor={sourceFor} /> : null}

          {/* provenanceHits without a geo section still have to be attributed. */}
          {!analysis.geo && analysis.provenanceHits && analysis.provenanceHits.length > 0 ? (
            <section>
              <Eyebrow mono className="block">
                Published copies · third-party finding
              </Eyebrow>
              <ul className="mt-2 flex flex-col gap-2">
                {analysis.provenanceHits.map((hit, index) => (
                  <li key={`${hit.source}-${index}`}>
                    <Eyebrow mono className="block text-fg-secondary">
                      {hit.source}
                    </Eyebrow>
                    <a
                      href={hit.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block break-words text-[13px] leading-snug text-fg underline decoration-border underline-offset-2 hover:decoration-fg-secondary"
                    >
                      {hit.title ?? hit.url}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {analysis.evidence.length > 0 ? (
            <section>
              <Eyebrow mono className="block">
                File-level evidence · not tied to one candidate
              </Eyebrow>
              <EvidenceChain
                evidence={analysis.evidence}
                sourceUrl={primary?.previewUrl}
                sourceAlt={primary ? `Uploaded frame ${primary.filename}` : undefined}
                className="mt-2.5"
              />
            </section>
          ) : null}
        </div>

        <section className="mt-5 border-t border-border pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <Eyebrow mono>Stage trace</Eyebrow>
            <Eyebrow mono className="text-n-400">{streamed ? 'streamed' : 'returned with the result'}</Eyebrow>
          </div>
          <StageTrace stages={analysis.stages} className="mt-3" />
        </section>

        {analysis.provenance ? (
          <section className="mt-5 border-t border-border pt-4">
            <Eyebrow mono className="block">
              Provenance
            </Eyebrow>
            <dl className="mt-2.5 flex flex-col gap-1.5">
              {Object.entries(analysis.provenance.models ?? {}).map(([role, version]) => (
                <Row key={`model-${role}`} term={role} value={String(version)} />
              ))}
              {Object.entries(analysis.provenance.sources ?? {}).map(([role, version]) => (
                <Row key={`source-${role}`} term={role} value={String(version)} />
              ))}
              {typeof analysis.provenance.totalCostUsd === 'number' ? (
                <Row term="cost" value={`$${analysis.provenance.totalCostUsd.toFixed(4)}`} />
              ) : null}
            </dl>
          </section>
        ) : null}

        <Eyebrow mono className="mt-5 block border-t border-border pt-4 text-n-400">
          dispositions are held in this tab only · persistence needs the authenticated path
        </Eyebrow>
      </div>

      <footer className="shrink-0 border-t border-border px-5 py-3.5">
        <LeadDisclaimer />
      </footer>
    </GlassCard>
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
