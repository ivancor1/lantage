'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';
import { formatBytes } from './format';

/**
 * The dropzone: drag-and-drop plus a file picker, per DESIGN_SYSTEM.md — dashed
 * hairline, image glyph, "OR" divider, white pill button.
 *
 * Drag feedback is monochrome on purpose. Colour in this app means confidence or
 * state, and "you are hovering a file over a box" is neither.
 */

/**
 * HEIC and TIFF are frequently handed to the browser with an empty `type`, so the
 * extension list is not belt-and-braces — it is the only signal for those two.
 */
export const ACCEPTED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
] as const;

const ACCEPTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff'] as const;

export const ACCEPT_ATTRIBUTE = [...ACCEPTED_MIME, ...ACCEPTED_EXTENSIONS.map((e) => `.${e}`)].join(',');

export const ACCEPTED_LABEL = 'JPEG · PNG · WEBP · HEIC · TIFF';

export function isAcceptedImage(file: File): boolean {
  const mime = file.type.toLowerCase();
  if ((ACCEPTED_MIME as readonly string[]).includes(mime)) return true;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extension);
}

export interface StagedFile {
  file: File;
  /** Object URL for the operator's own bytes. Revoked by the owner on clear. */
  previewUrl: string;
}

export interface DropzoneProps {
  /** Slot label, e.g. `PROBE A`. Omitted for the single-image modes. */
  label?: string;
  staged: StagedFile | null;
  onFiles: (files: File[]) => void;
  onClear: () => void;
  disabled?: boolean;
  /** Side-by-side slots need the shorter body. */
  compact?: boolean;
  /** Shown under the glyph when the slot is empty. */
  hint?: string;
  className?: string;
}

export function Dropzone({
  label,
  staged,
  onFiles,
  onClear,
  disabled = false,
  compact = false,
  hint,
  className,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const inputId = useId();

  function accept(list: FileList | null): void {
    if (!list || list.length === 0) return;
    setPreviewFailed(false);
    onFiles(Array.from(list));
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    accept(event.dataTransfer?.files ?? null);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (!disabled) setDragging(true);
  }

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={() => setDragging(false)}
      className={cx(
        'rounded-nested relative flex flex-col items-center justify-center border border-dashed',
        'transition-[background-color,border-color] duration-[140ms] ease-[var(--ease-smooth)]',
        compact ? 'px-4 py-5' : 'px-5 py-7',
        dragging ? 'border-fg-secondary bg-n-150' : 'border-border-strong bg-[var(--glass-3)]',
        disabled && 'opacity-45',
        className,
      )}
    >
      {label ? (
        <Eyebrow mono className="absolute left-4 top-3">
          {label}
        </Eyebrow>
      ) : null}

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        hidden
        accept={ACCEPT_ATTRIBUTE}
        multiple={false}
        disabled={disabled}
        onChange={(event) => {
          accept(event.target.files);
          // Re-selecting the same path must still fire a change event.
          event.target.value = '';
        }}
      />

      {staged ? (
        <div className={cx('flex w-full items-center gap-3', label && 'mt-3')}>
          <div className="size-14 shrink-0 overflow-hidden rounded-md border border-border bg-n-0">
            {previewFailed ? (
              <span className="flex size-full items-center justify-center">
                <ImagePlus aria-hidden className="size-4 text-n-400" />
              </span>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element -- a blob: object
                 URL for the operator's own file is not a next/image source. */
              <img
                src={staged.previewUrl}
                alt={`Selected image ${staged.file.name}`}
                className="size-full object-cover"
                onError={() => setPreviewFailed(true)}
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-fg" title={staged.file.name}>
              {staged.file.name}
            </p>
            <p className="tnum mt-1 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
              {formatBytes(staged.file.size)} · {staged.file.type || 'type not reported by the browser'}
            </p>
            {previewFailed ? (
              <Eyebrow mono className="mt-1 block text-n-400">
                this browser cannot preview this format — the bytes are still uploaded
              </Eyebrow>
            ) : null}
          </div>
          <Button
            variant="icon"
            aria-label={`Remove ${staged.file.name}`}
            onClick={onClear}
            disabled={disabled}
            className="shrink-0"
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      ) : (
        <div className={cx('flex flex-col items-center text-center', label && 'mt-3')}>
          <ImagePlus aria-hidden className="size-5 text-n-400" />
          <p className="mt-2.5 text-[13px] text-fg-secondary">Drop an image here</p>
          <Eyebrow mono className="mt-1 block">
            {hint ?? ACCEPTED_LABEL}
          </Eyebrow>

          {/* "OR" divider — MEASURED pattern from the design system. */}
          <div className="mt-4 flex w-full max-w-[240px] items-center gap-3">
            <span aria-hidden className="h-px flex-1 bg-border" />
            <Eyebrow mono>or</Eyebrow>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>

          <Button
            variant="primary"
            className="mt-4"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </Button>
        </div>
      )}
    </div>
  );
}

