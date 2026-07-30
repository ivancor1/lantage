/**
 * What actually gets sent to the vendor.
 *
 * Three jobs, each of which has a wrong answer that looks fine:
 *
 * 1. **Downscale.** Verified 2026-07-30 against Anthropic's vision doc: images
 *    are re-scaled server-side to a long-edge cap — 1568px on standard-tier
 *    models, 2576px on the high-resolution tier (Claude 4.7+). Sending more
 *    pixels than the cap buys nothing and costs latency, so we cap locally.
 *    We never *up*scale: upscaling does not add information, it only makes the
 *    absence of information harder to see.
 *
 * 2. **Record the scale factor.** `bbox` in the clue contract is normalised to
 *    0..1, which makes it scale-invariant — so a downscale needs no coordinate
 *    correction, and that is exactly why the factor has to be recorded rather
 *    than assumed: a reader has to be able to confirm no correction was owed,
 *    and to know how many real pixels the model was actually looking at when it
 *    claimed a sign was legible.
 *
 * 3. **Orientation.** Browsers apply EXIF orientation when rendering; a raw
 *    decode does not. If the model saw the unrotated buffer while the operator
 *    sees the rotated render, every bbox citation is wrong by a quarter turn. So
 *    when a re-encode happens at all, EXIF rotation is baked in; when it cannot
 *    happen, that is recorded as a note rather than silently ignored.
 *
 * The resizer is `sharp`, loaded through an opaque specifier. It ships as one of
 * Next's optional dependencies, so it is present in this project but is not a
 * declared dependency of it — hence a runtime probe with a real degradation path
 * instead of a static import that could fail a build elsewhere.
 */

import { readImageHeader } from '@/lib/cascade/imageHeader';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';
import type { SentImageFacts } from './types';

/** Anthropic standard tier. Above this the vendor downscales anyway. */
export const STANDARD_TIER_LONG_EDGE_PX = 1568;
/** Anthropic high-resolution tier (Claude 4.7 and later). */
export const HIGH_RES_TIER_LONG_EDGE_PX = 2576;

/**
 * Base64 payload ceiling. Anthropic documents 10MB per image base64-encoded;
 * OpenAI's per-request limit is far larger, so the tighter number governs both.
 */
const MAX_BASE64_BYTES = 10 * 1024 * 1024;

/** Formats both vendors accept. HEIC/AVIF must be converted or refused. */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heif: 'image/heic',
  avif: 'image/avif',
};

export interface PreparedImage {
  base64: string;
  mediaType: string;
  facts: SentImageFacts;
  notes: string[];
}

export interface PrepareOptions {
  maxLongEdgePx?: number;
  /** JPEG quality used only when a re-encode is unavoidable. */
  quality?: number;
  /**
   * EXIF orientation, if the caller already read it. Not available from the
   * container header — it is metadata — so it is passed in rather than guessed,
   * and its only use is to warn when a rotated frame went out unmodified.
   */
  orientation?: number;
}

export async function prepareImage(
  bytes: Uint8Array,
  opts: PrepareOptions = {},
): Promise<Result<PreparedImage, StageFailure>> {
  if (bytes.byteLength === 0) {
    return err(failure('no-input', 'The image buffer was empty, so there was nothing to send.'));
  }

  const maxLongEdge = opts.maxLongEdgePx ?? STANDARD_TIER_LONG_EDGE_PX;
  const header = readImageHeader(bytes);
  const declaredMime = MIME_BY_FORMAT[header.format] ?? 'application/octet-stream';
  const longEdge = Math.max(header.width ?? 0, header.height ?? 0);
  const notes: string[] = [];

  const needsConversion = !ACCEPTED.has(declaredMime);
  const needsDownscale = longEdge > maxLongEdge;
  const oversizePayload = base64Length(bytes.byteLength) > MAX_BASE64_BYTES;

  if (!needsConversion && !needsDownscale && !oversizePayload) {
    if ((opts.orientation ?? 1) !== 1) {
      notes.push(
        'EXIF orientation is not 1 and the bytes were sent unmodified, so the model saw the frame in its stored rotation. Check the orientation before trusting a bbox citation against a browser-rendered copy.',
      );
    }
    return ok({
      base64: toBase64(bytes),
      mediaType: declaredMime,
      facts: {
        scale: 1,
        ...(header.width && header.height ? { px: { w: header.width, h: header.height } } : {}),
        mediaType: declaredMime,
        bytes: bytes.byteLength,
        method: 'passthrough',
      },
      notes,
    });
  }

  const sharp = await loadSharp();
  if (!sharp) {
    // No resizer. Say which of the three reasons we needed one, and refuse
    // rather than send something the vendor will reject or silently mangle.
    if (needsConversion) {
      return err(
        failure(
          'policy',
          `The upload is ${header.format.toUpperCase()}, which the vision vendors do not accept, and no local image converter is available (sharp did not load). Re-export the frame as JPEG or PNG.`,
        ),
      );
    }
    if (oversizePayload) {
      return err(
        failure(
          'policy',
          `The upload is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, over the vendor's 10 MB base64 limit, and no local resizer is available (sharp did not load). Downscale the frame before uploading.`,
        ),
      );
    }
    notes.push(
      `No local resizer is available (sharp did not load), so the full ${header.width}x${header.height} frame was sent and the vendor downscaled it server-side to its own ${maxLongEdge}px cap. bbox values are normalised, so citations are unaffected.`,
    );
    return ok({
      base64: toBase64(bytes),
      mediaType: declaredMime,
      facts: {
        scale: 1,
        ...(header.width && header.height ? { px: { w: header.width, h: header.height } } : {}),
        mediaType: declaredMime,
        bytes: bytes.byteLength,
        method: 'passthrough-oversized',
      },
      notes,
    });
  }

  try {
    const quality = opts.quality ?? 88;
    const pipeline = sharp(bytes)
      // No argument: apply the EXIF orientation rather than a fixed angle.
      .rotate()
      .resize({ width: maxLongEdge, height: maxLongEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true });
    const out = new Uint8Array(await pipeline.toBuffer());
    const outHeader = readImageHeader(out);
    const outLongEdge = Math.max(outHeader.width ?? 0, outHeader.height ?? 0);
    const scale = longEdge > 0 && outLongEdge > 0 ? outLongEdge / longEdge : 1;

    if (base64Length(out.byteLength) > MAX_BASE64_BYTES) {
      return err(
        failure(
          'policy',
          `Even after downscaling to ${outHeader.width}x${outHeader.height} the payload is over the vendor's 10 MB base64 limit.`,
        ),
      );
    }

    notes.push(
      `Re-encoded to JPEG q${quality} at ${outHeader.width}x${outHeader.height} (${(scale * 100).toFixed(0)}% of the original long edge) before sending. Recompression can cost small-text legibility, so weigh a "clear" text observation against that. bbox values are normalised and need no correction.`,
    );

    return ok({
      base64: toBase64(out),
      mediaType: 'image/jpeg',
      facts: {
        scale,
        ...(outHeader.width && outHeader.height
          ? { px: { w: outHeader.width, h: outHeader.height } }
          : {}),
        mediaType: 'image/jpeg',
        bytes: out.byteLength,
        method: needsConversion ? 'sharp-convert-downscale' : 'sharp-downscale',
      },
      notes,
    });
  } catch (e) {
    return err(
      failure(
        'unavailable',
        `Local image preparation failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// sharp, probed rather than imported
// ---------------------------------------------------------------------------

interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(opts: {
    width?: number;
    height?: number;
    fit?: string;
    withoutEnlargement?: boolean;
  }): SharpPipeline;
  jpeg(opts: { quality?: number; mozjpeg?: boolean }): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
}

type SharpFactory = (input: Uint8Array) => SharpPipeline;

/**
 * Annotated `string`, not a literal: that keeps the specifier opaque to both the
 * type checker and the bundler, so an absent `sharp` is a runtime degradation
 * rather than a build failure.
 */
const SHARP_SPECIFIER: string = 'sharp';

let sharpProbe: Promise<SharpFactory | null> | null = null;

export function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpProbe) {
    sharpProbe = (async (): Promise<SharpFactory | null> => {
      try {
        const mod: unknown = await import(SHARP_SPECIFIER);
        const candidate =
          typeof mod === 'object' && mod !== null && 'default' in mod
            ? (mod as { default: unknown }).default
            : mod;
        return typeof candidate === 'function' ? (candidate as SharpFactory) : null;
      } catch {
        return null;
      }
    })();
  }
  return sharpProbe;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
