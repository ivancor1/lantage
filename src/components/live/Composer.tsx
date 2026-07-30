'use client';

import { TriangleAlert } from 'lucide-react';
import type { StageTrace as StageTraceEntry } from '@/lib/contracts/types';
import { MODULE_CATALOGUE, type LiveModule } from '@/lib/live/contract';
import { Button } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { GlassCard } from '@/components/ui/GlassCard';
import { StageTrace } from '@/components/ui/StageTrace';
import { cx } from '@/components/ui/cx';
import { ACCEPTED_LABEL, Dropzone, type StagedFile } from './Dropzone';
import { ModeSelect, requirementLabel } from './ModeSelect';
import { formatBytes, stageLabel } from './format';

/**
 * The input surface: mode, images, run.
 *
 * The empty state is genuinely empty. It shows what the operator has to supply
 * and what each module requires — nothing about a location, a vehicle or a
 * person, because nothing has been analysed. Progress is the real filename and
 * the real byte count, and the stage list is whatever the server has actually
 * reported so far; there is no simulated percentage anywhere in this component.
 */

export type Phase = 'idle' | 'uploading' | 'analyzing' | 'done' | 'error';

export interface RunError {
  message: string;
  status?: number;
  detail?: string;
}

export interface ComposerProps {
  mode: LiveModule | null;
  onMode: (next: LiveModule) => void;
  slots: readonly (StagedFile | null)[];
  onSlotFiles: (index: number, files: File[]) => void;
  onClearSlot: (index: number) => void;
  phase: Phase;
  /** Operator-facing consequence of an action we took, e.g. dropping a 2nd file. */
  notice: string | null;
  error: RunError | null;
  stages: readonly StageTraceEntry[];
  /** Stage the server said it started but has not finished. */
  currentStage: string | null;
  /** Free-text note emitted by the run, verbatim. */
  note: string | null;
  /** null until the response type is known. */
  streaming: boolean | null;
  /** File currently being sent, for the upload readout. */
  uploading: StagedFile | null;
  onRun: () => void;
  className?: string;
}

export function Composer({
  mode,
  onMode,
  slots,
  onSlotFiles,
  onClearSlot,
  phase,
  notice,
  error,
  stages,
  currentStage,
  note,
  streaming,
  uploading,
  onRun,
  className,
}: ComposerProps) {
  const descriptor = MODULE_CATALOGUE.find((entry) => entry.id === mode) ?? null;
  const capacity = descriptor?.images ?? 1;
  const staged = slots.slice(0, capacity);
  const missing = staged.filter((entry) => entry === null).length;
  const busy = phase === 'uploading' || phase === 'analyzing';
  const ready = descriptor !== null && missing === 0 && !busy;

  const blocker = !descriptor
    ? 'Choose a module first — it decides how many images are needed.'
    : missing > 0
      ? descriptor.images === 2
        ? `Face compare needs two images. ${missing === 2 ? 'Both probes are empty.' : 'Probe B is empty.'}`
        : `${descriptor.label} needs one image.`
      : null;

  return (
    <GlassCard className={cx('blur-in flex flex-col gap-4 p-5', className)}>
      <header>
        <Eyebrow mono className="block">
          § 01 input
        </Eyebrow>
        <h1 className="mt-2 text-[22px] text-fg">
          {phase === 'idle' ? 'Nothing analysed yet' : busy ? 'Running' : 'Run another image'}
        </h1>
        <p className="mt-1.5 text-[13px] leading-snug text-fg-secondary">
          Pick a module, add the images it takes, then run it. Everything on screen afterwards comes from that run —
          this build carries no sample data.
        </p>
      </header>

      <ModeSelect value={mode} onChange={onMode} disabled={busy} />

      {/* What the chosen module needs, before it is run. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Eyebrow mono className="text-fg-secondary">
          {descriptor ? requirementLabel(descriptor) : `accepts ${ACCEPTED_LABEL}`}
        </Eyebrow>
        {descriptor ? (
          <Eyebrow mono className="text-n-400">
            {descriptor.images === 2 ? 'two images' : 'one image'} · {ACCEPTED_LABEL}
          </Eyebrow>
        ) : null}
      </div>

      {descriptor?.images === 2 ? (
        // The two-image requirement is a layout, not a footnote: two labelled
        // slots make it impossible to think one file is enough.
        <div className="grid grid-cols-2 gap-3">
          <Dropzone
            label="Probe A"
            staged={slots[0] ?? null}
            onFiles={(files) => onSlotFiles(0, files)}
            onClear={() => onClearSlot(0)}
            disabled={busy}
            compact
            hint="first image"
          />
          <Dropzone
            label="Probe B"
            staged={slots[1] ?? null}
            onFiles={(files) => onSlotFiles(1, files)}
            onClear={() => onClearSlot(1)}
            disabled={busy}
            compact
            hint="second image"
          />
        </div>
      ) : (
        <Dropzone
          staged={slots[0] ?? null}
          onFiles={(files) => onSlotFiles(0, files)}
          onClear={() => onClearSlot(0)}
          disabled={busy}
        />
      )}

      {notice ? (
        <Eyebrow mono className="block text-caution">
          {notice}
        </Eyebrow>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button variant="primary" disabled={!ready} onClick={onRun} className="w-full">
          {busy ? 'Running…' : 'Run analysis'}
          {!busy ? <span aria-hidden>→</span> : null}
        </Button>
        {blocker && !busy ? (
          <Eyebrow mono className="block text-center">
            {blocker}
          </Eyebrow>
        ) : null}
      </div>

      {busy ? (
        <section className="border-t border-border pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <Eyebrow mono className="shimmer">
              {phase === 'uploading' ? 'uploading' : currentStage ? stageLabel(currentStage) : 'analysing'}
            </Eyebrow>
            {phase === 'analyzing' ? (
              <Eyebrow mono className="text-n-400">
                {streaming === null
                  ? 'awaiting response'
                  : streaming
                    ? 'stage stream open'
                    : 'no stage stream — trace arrives with the result'}
              </Eyebrow>
            ) : null}
          </div>

          {/* Real filename, real byte count. No synthetic percentage: fetch does
              not report upload progress, and inventing one would be a fake number. */}
          {uploading ? (
            <p className="tnum mt-2 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
              {uploading.file.name} · {formatBytes(uploading.file.size)}
            </p>
          ) : null}

          {note ? <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">{note}</p> : null}

          {stages.length > 0 ? (
            <>
              <Eyebrow mono className="mt-3 block text-n-400">
                stages reported so far
              </Eyebrow>
              <StageTrace stages={stages} className="mt-2" />
            </>
          ) : phase === 'analyzing' ? (
            <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
              No stage has reported yet. The trace appears here as it arrives — nothing is shown in the meantime.
            </p>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <section className="rounded-nested border border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)] p-4">
          <div className="flex items-center gap-2">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-alert" />
            <Eyebrow mono style={{ color: 'var(--color-alert)' }}>
              run failed{typeof error.status === 'number' ? ` · http ${error.status}` : ''}
            </Eyebrow>
          </div>
          {/* The server's own words. Never replaced with a friendlier string. */}
          <p className="mt-2 text-[13px] leading-snug text-fg-secondary">{error.message}</p>
          {error.detail ? (
            <p className="mt-1.5 break-words text-[12px] leading-snug text-fg-tertiary">{error.detail}</p>
          ) : null}
        </section>
      ) : null}
    </GlassCard>
  );
}
