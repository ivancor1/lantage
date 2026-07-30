'use client';

import { useEffect, useRef, useState } from 'react';
import { Car, Globe, House, RotateCcw, ScanFace, ShieldCheck } from 'lucide-react';
import type { ReviewState, StageTrace as StageTraceEntry } from '@/lib/contracts/types';
import {
  MODULE_CATALOGUE,
  type CapabilityGap,
  type LiveModule,
  type UploadRecord,
} from '@/lib/live/contract';
import { MapCanvas } from '@/components/map/MapCanvas';
import { Button } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { GlassHeader } from '@/components/ui/GlassHeader';
import { LeadDisclaimer } from '@/components/ui/LeadDisclaimer';
import { cx } from '@/components/ui/cx';
import { ApiError, analyze, uploadImage, type Analysis } from './api';
import { CapabilityGaps } from './CapabilityGaps';
import { Composer, type Phase, type RunError } from './Composer';
import { NEUTRAL_CAMERA, cameraForCandidate, cameraKey, topCandidate } from './camera';
import { ACCEPTED_LABEL, isAcceptedImage, type StagedFile } from './Dropzone';
import { ResultsPanel } from './ResultsPanel';
import { formatBytes } from './format';

/**
 * The whole workbench.
 *
 * This component holds every piece of state on screen, and all of it is either
 * (a) something the operator chose, (b) something the browser measured from their
 * own file, or (c) something an API response contained. There is no fixture, no
 * seed value and no demo path: before a run, the result surfaces do not exist.
 *
 * Fetching happens in the run handler only — never in an effect on mount, so
 * opening the app costs nothing and claims nothing.
 */

const MODULE_ICON: Record<LiveModule, typeof Globe> = {
  LOCATE: Globe,
  INTERIOR: House,
  FACE: ScanFace,
  VEHICLE: Car,
  AUTHENTIC: ShieldCheck,
};

/** Two slots is the maximum any module takes (FACE). */
const SLOT_COUNT = 2;

export function Workbench() {
  const [mode, setMode] = useState<LiveModule | null>(null);
  const [slots, setSlots] = useState<Array<StagedFile | null>>([null, null]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [uploading, setUploading] = useState<StagedFile | null>(null);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [stages, setStages] = useState<StageTraceEntry[]>([]);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<boolean | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState<RunError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({});
  /**
   * Capability gaps outlive their run on purpose: an unset key is a property of
   * the environment, so the operator should still see why a section was empty
   * after they clear the result.
   */
  const [gaps, setGaps] = useState<CapabilityGap[]>([]);

  const controllerRef = useRef<AbortController | null>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      controllerRef.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const descriptor = MODULE_CATALOGUE.find((entry) => entry.id === mode) ?? null;
  const capacity = descriptor?.images ?? 1;

  function createPreview(file: File): string {
    const url = URL.createObjectURL(file);
    objectUrlsRef.current.add(url);
    return url;
  }

  function revokePreview(url: string | undefined): void {
    if (!url) return;
    if (objectUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
  }

  /* Object URLs are created here rather than inside a setState updater: React
     may invoke an updater twice, which would leak one URL per extra call. */
  function stageFiles(index: number, incoming: File[]): void {
    const accepted = incoming.filter(isAcceptedImage);
    const rejected = incoming.length - accepted.length;
    const messages: string[] = [];
    if (rejected > 0) {
      messages.push(
        `${rejected} file${rejected === 1 ? '' : 's'} ignored — this build accepts ${ACCEPTED_LABEL}.`,
      );
    }
    if (accepted.length === 0) {
      setNotice(messages.join(' ') || `Not an accepted image. This build accepts ${ACCEPTED_LABEL}.`);
      return;
    }

    const next = [...slots];
    let cursor = index;
    let placed = 0;
    for (const file of accepted) {
      if (cursor >= capacity) break;
      revokePreview(next[cursor]?.previewUrl);
      next[cursor] = { file, previewUrl: createPreview(file) };
      cursor += 1;
      placed += 1;
    }
    if (placed < accepted.length) {
      messages.push(
        capacity === 1
          ? 'Face compare is the only module that takes two images, so the extra file was not staged.'
          : 'Only two images can be staged.',
      );
    }
    setSlots(next);
    setNotice(messages.join(' ') || null);
  }

  function clearSlot(index: number): void {
    const next = [...slots];
    revokePreview(next[index]?.previewUrl);
    next[index] = null;
    setSlots(next);
    setNotice(null);
  }

  function chooseMode(next: LiveModule): void {
    const chosen = MODULE_CATALOGUE.find((entry) => entry.id === next);
    setMode(next);
    if (!chosen) return;
    // A single-image module cannot carry a staged second probe.
    if (chosen.images < SLOT_COUNT && slots[1]) {
      const trimmed = [...slots];
      revokePreview(trimmed[1]?.previewUrl);
      trimmed[1] = null;
      setSlots(trimmed);
      setNotice(`${chosen.label} takes one image, so the second image was removed.`);
      return;
    }
    setNotice(null);
  }

  function reset(): void {
    controllerRef.current?.abort();
    controllerRef.current = null;
    for (const slot of slots) revokePreview(slot?.previewUrl);
    setSlots([null, null]);
    setResult(null);
    setUploads([]);
    setStages([]);
    setCurrentStage(null);
    setNote(null);
    setStreaming(null);
    setUploading(null);
    setError(null);
    setNotice(null);
    setReviews({});
    setPhase('idle');
  }

  async function run(): Promise<void> {
    if (!mode || !descriptor) return;
    const staged = slots.slice(0, descriptor.images);
    if (staged.some((entry) => entry === null)) return;
    const files = staged.filter((entry): entry is StagedFile => entry !== null);

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setError(null);
    setResult(null);
    setStages([]);
    setCurrentStage(null);
    setNote(null);
    setStreaming(null);
    setNotice(null);
    setReviews({});
    setPhase('uploading');

    try {
      const records: UploadRecord[] = [];
      for (const entry of files) {
        setUploading(entry);
        records.push(await uploadImage(entry.file, entry.previewUrl, controller.signal));
      }
      setUploading(null);
      setUploads(records);
      setPhase('analyzing');

      const analysis = await analyze(
        { module: mode, uploadIds: records.map((record) => record.id) },
        {
          onStage: (trace) =>
            setStages((previous) => {
              const at = previous.findIndex((entry) => entry.stage === trace.stage);
              if (at === -1) return [...previous, trace];
              const merged = [...previous];
              merged[at] = trace;
              return merged;
            }),
          onStageStart: (stage) => setCurrentStage(stage),
          onNote: (message) => setNote(message),
          onStream: (isStreaming) => setStreaming(isStreaming),
        },
        controller.signal,
      );

      setStages(analysis.stages);
      setCurrentStage(null);
      setResult(analysis);
      setGaps(analysis.unavailable);
      setPhase('done');
    } catch (caught) {
      setUploading(null);
      if (controller.signal.aborted) {
        setPhase('idle');
        return;
      }
      setError(toRunError(caught));
      setPhase('error');
    }
  }

  const geo = result?.geo ?? [];
  const top = topCandidate(geo);
  const camera = top ? cameraForCandidate(top) : NEUTRAL_CAMERA;
  const showResults = result !== null;
  const primaryUpload = (result?.uploads.length ? result.uploads : uploads)[0];

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[var(--map-shell)]">
      {/* Remounting on a new key is the only way to move a camera MapCanvas seeds
          once at mount — see camera.ts. The key is stable within a run. */}
      <MapCanvas
        key={cameraKey(top)}
        className="absolute inset-0"
        center={camera.center}
        zoom={camera.zoom}
        pitch={camera.pitch}
        bearing={camera.bearing}
        candidates={geo}
      />

      <GlassHeader
        forceScrim
        left={
          <>
            <span className="text-sm font-medium tracking-[-0.02em] text-fg">Lantage</span>
            <span aria-hidden className="h-4 w-px bg-border" />
            <Eyebrow mono className="whitespace-nowrap">
              {descriptor ? `§ 01 ${mode} · ${descriptor.label}` : '§ 01 no module selected'}
            </Eyebrow>
          </>
        }
        center={
          showResults && primaryUpload ? (
            <div className="glass-pill flex items-center gap-3 py-1 pl-4 pr-1 max-[820px]:hidden">
              <div className="min-w-0">
                <Eyebrow mono className="block leading-none">
                  analysed
                </Eyebrow>
                <span className="mt-1 block max-w-[220px] truncate text-[13px] leading-none text-fg">
                  {primaryUpload.filename}
                </span>
              </div>
              <span className="tnum font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
                {formatBytes(primaryUpload.bytes)}
              </span>
              <Button variant="secondary" onClick={reset}>
                <RotateCcw aria-hidden className="size-3.5" />
                New analysis
              </Button>
            </div>
          ) : null
        }
        right={
          <div className="flex items-center gap-2">
            {phase === 'analyzing' || phase === 'uploading' ? (
              <Eyebrow mono className="shimmer max-[820px]:hidden">
                {phase === 'uploading' ? 'uploading' : 'analysing'}
              </Eyebrow>
            ) : null}
            {showResults ? (
              <Button variant="icon" aria-label="Start a new analysis" onClick={reset} className="min-[821px]:hidden">
                <RotateCcw aria-hidden className="size-4" />
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Module rail. Mirrors the dropdown; both write the same state. */}
      <nav
        aria-label="Analysis modules"
        className="glass-pill fixed left-[max(16px,env(safe-area-inset-left))] top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1 p-1 max-[820px]:hidden"
      >
        {MODULE_CATALOGUE.map((entry) => {
          const Icon = MODULE_ICON[entry.id];
          const requires =
            entry.requires.length === 0 ? 'no key required' : `requires ${entry.requires.join(', ')}`;
          const title = `${entry.label} — ${entry.images === 2 ? '2 images' : '1 image'}, ${requires}`;
          return (
            <Button
              key={entry.id}
              variant="ghost"
              selected={entry.id === mode}
              aria-label={title}
              title={title}
              disabled={phase === 'uploading' || phase === 'analyzing'}
              onClick={() => chooseMode(entry.id)}
              className="size-9 p-0"
            >
              <Icon aria-hidden className="size-4" />
            </Button>
          );
        })}
      </nav>

      {/* Input surface. Replaced by the result surface once a run returns. */}
      {!showResults ? (
        <div
          data-lenis-prevent
          className={cx(
            'fixed left-1/2 top-1/2 z-40 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2',
            'max-h-[calc(100dvh-140px)] overflow-y-auto overscroll-contain [scrollbar-width:thin]',
          )}
        >
          <Composer
            mode={mode}
            onMode={chooseMode}
            slots={slots}
            onSlotFiles={stageFiles}
            onClearSlot={clearSlot}
            phase={phase}
            notice={notice}
            error={error}
            stages={stages}
            currentStage={currentStage}
            note={note}
            streaming={streaming}
            uploading={uploading}
            onRun={run}
          />

          {/* Gaps from a previous run stay visible: the environment has not changed. */}
          <CapabilityGaps
            gaps={gaps}
            provenanceNote="Reported by the last run"
            className="blur-in mt-3 bg-[var(--glass-1)]"
          />

          {/* Permanent furniture, present even before the first run — everything
              this tool produces is a lead, including the empty state's promise. */}
          <div className="mt-3 flex justify-center">
            <LeadDisclaimer />
          </div>
        </div>
      ) : null}

      {showResults ? (
        <aside
          aria-label={`${result.module} result`}
          className={cx(
            'fixed bottom-4 top-[92px] z-40 w-[390px] max-[1024px]:w-[340px]',
            'right-[max(16px,env(safe-area-inset-right))]',
            'max-[820px]:left-[max(12px,env(safe-area-inset-left))] max-[820px]:w-auto',
          )}
        >
          <ResultsPanel
            analysis={result}
            fallbackUploads={uploads}
            reviews={reviews}
            onReview={(key, next) => setReviews((previous) => ({ ...previous, [key]: next }))}
            streamed={streaming === true}
            className="blur-in"
          />
        </aside>
      ) : null}

    </main>
  );
}

function toRunError(caught: unknown): RunError {
  if (caught instanceof ApiError) {
    return { message: caught.message, status: caught.status, detail: caught.detail };
  }
  if (caught instanceof TypeError) {
    // fetch() rejects with a TypeError when the request never reached the server.
    return { message: caught.message, detail: 'The request did not reach the server.' };
  }
  if (caught instanceof Error) return { message: caught.message };
  return { message: String(caught) };
}
