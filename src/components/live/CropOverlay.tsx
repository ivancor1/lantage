'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';
import { boxIsNormalised, type Box } from './format';

/**
 * A thumbnail with response-supplied boxes drawn over it.
 *
 * The scale factor comes from the image's own `naturalWidth`/`naturalHeight` once
 * it has decoded — never from an assumed resolution. If the box is in pixels and
 * the image has not decoded yet (or failed to), no box is drawn: a rectangle in
 * the wrong place is a false claim about where a signal came from.
 */

export interface OverlayBox {
  box: Box;
  label?: string;
  /** `alert` is used for a probe that failed the gate — state, not decoration. */
  tone?: 'neutral' | 'alert';
}

export interface CropOverlayProps {
  src: string;
  alt: string;
  boxes?: readonly OverlayBox[];
  className?: string;
  /** Rendered under the frame, e.g. the filename. */
  caption?: string;
}

interface Natural {
  w: number;
  h: number;
}

export function CropOverlay({ src, alt, boxes = [], className, caption }: CropOverlayProps) {
  const [natural, setNatural] = useState<Natural | null>(null);
  const [failed, setFailed] = useState(false);

  const drawable = boxes.flatMap((entry) => {
    const scale: Natural | null = boxIsNormalised(entry.box) ? { w: 1, h: 1 } : natural;
    if (!scale) return [];
    const scaleX = scale.w;
    const scaleY = scale.h;
    return [
      {
        ...entry,
        style: {
          left: `${(entry.box.x / scaleX) * 100}%`,
          top: `${(entry.box.y / scaleY) * 100}%`,
          width: `${(entry.box.w / scaleX) * 100}%`,
          height: `${(entry.box.h / scaleY) * 100}%`,
        },
      },
    ];
  });

  return (
    <figure className={cx('m-0', className)}>
      <div className="relative overflow-hidden rounded-md border border-border bg-n-0">
        {failed ? (
          <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2">
            <ImageOff aria-hidden className="size-4 text-n-400" />
            <Eyebrow mono className="text-n-400">
              preview unavailable
            </Eyebrow>
          </div>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- the source is a
                blob: object URL or a server preview path, neither of which
                next/image accepts, and these are never optimised assets. */}
            <img
              src={src}
              alt={alt}
              className="block h-auto w-full"
              onLoad={(event) =>
                setNatural({
                  w: event.currentTarget.naturalWidth,
                  h: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
            />
            {drawable.map((entry, index) => (
              <span
                key={`${entry.label ?? 'box'}-${index}`}
                aria-hidden
                className="absolute"
                style={{
                  ...entry.style,
                  border: `1px solid ${entry.tone === 'alert' ? 'var(--color-alert)' : 'var(--color-fg)'}`,
                  boxShadow: '0 0 0 1px rgba(0,0,0,.55)',
                  borderRadius: '2px',
                }}
              >
                {entry.label ? (
                  <span
                    className="eyebrow-mono absolute left-0 top-full mt-1 whitespace-nowrap px-1 py-px"
                    style={{
                      background: 'var(--color-n-0)',
                      color: entry.tone === 'alert' ? 'var(--color-alert)' : 'var(--color-fg)',
                    }}
                  >
                    {entry.label}
                  </span>
                ) : null}
              </span>
            ))}
          </>
        )}
      </div>
      {caption ? (
        <figcaption className="tnum mt-1.5 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
          {caption}
          {natural ? ` · ${natural.w}×${natural.h}` : ''}
        </figcaption>
      ) : null}
    </figure>
  );
}
