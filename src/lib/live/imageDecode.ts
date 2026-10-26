/**
 * Making an uploaded container decodable, so the rest of the pipeline is not
 * forked per format.
 *
 * WHY THIS EXISTS. sharp 0.34.5 in this project links libvips 8.17.3 with
 * libheif 1.20.2 and **aom only** — `sharp.format.heif.input.file` is `true` and
 * `sharp(bytes).metadata()` happily returns `heif 3024x4032`, so every capability
 * probe in the codebase said HEIC was supported. It is not: the moment pixels are
 * requested libheif reports `Error while loading plugin: Support for this
 * compression format has not been built in`, because an ordinary iPhone capture
 * is HEVC-coded and no HEVC decoder is compiled in. Measured against the real
 * file `IMG_7211.HEIC` (1,624,322 bytes, ftyp `heic` / `mif1MiHEMiPrmiaf`).
 *
 * That mattered more than a missing format usually would, because **HEIC is the
 * iPhone default**: every photograph the operator takes with the device in their
 * pocket landed on this path, the vision call was skipped with a decoder error
 * buried in the stage trace, and the run came back in 70 ms looking like a
 * completed analysis with nothing in it.
 *
 * WHAT THIS DOES. One decode, at one place, producing bytes the existing pipeline
 * already knows how to handle — a full-resolution JPEG. Downstream resize,
 * re-encode, orientation and payload-cap logic in `./vision/image.ts` is left
 * exactly as it is and sees an ordinary JPEG. The re-encode is full resolution on
 * purpose: `SentImageFacts.scale` is computed against the dimensions of the bytes
 * handed to the vendor stage, so handing it a pre-shrunk frame would make that
 * ratio describe a frame the operator never uploaded.
 *
 * ORDER OF ATTEMPTS. sharp first — it is already loaded, it is fast, it handles
 * AVIF today, and if a future libvips gains HEVC this file quietly stops doing
 * any work. `libheif-js` (Emscripten/wasm) second: it is the cross-platform
 * guarantee and it carries its own HEVC decoder. There is deliberately **no**
 * `sips` shell-out. A macOS-only decode path would work perfectly on the
 * operator's laptop and fail on every Linux host, which is the failure mode that
 * is hardest to notice and worst to discover late.
 *
 * LICENCE NOTE. `heic-decode` is ISC; the wasm it wraps, `libheif-js`, is
 * LGPL-3.0 and is consumed unmodified as a separate npm package through a
 * dynamic import, which is the arrangement LGPL §4 is written for.
 */

import { type HeaderInfo, type ImageFormat, readImageHeader } from '@/lib/cascade/imageHeader';
import type { ImageRef } from '@/lib/cascade/types';
import type { CapabilityGap } from './contract';

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

export interface DecodedImage {
  /** JPEG bytes at the source's true pixel dimensions. */
  bytes: Uint8Array;
  mimeType: 'image/jpeg';
  /** Measured from the decode itself, never from a header or from EXIF. */
  width: number;
  height: number;
  /** Which decoder produced the pixels. Belongs in `ResultProvenance.sources`. */
  decoder: string;
  ranMs: number;
}

export interface DecodeFailure {
  /** The container we could not turn into pixels, as the header reported it. */
  format: ImageFormat;
  /** Verbatim from the decoder. Never rewritten into something friendlier. */
  reason: string;
  ranMs: number;
}

/**
 * An image reference a pixel consumer can use, plus what happened on the way.
 *
 * Exactly one of `decoded` / `failure` is set when a transcode was attempted, and
 * neither is set when the bytes were already usable. `image` is only re-pointed
 * on success: on failure it still refers to the original bytes, because EXIF,
 * hashing and the authenticity path all read the file the operator uploaded.
 */
export interface AnalysableImage {
  image: ImageRef;
  decoded?: DecodedImage;
  failure?: DecodeFailure;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Containers that must be turned into something else before any pixel consumer
 * touches them.
 *
 * ISOBMFF-family stills only. JPEG/PNG/WebP/GIF are accepted by both the vision
 * vendors and libvips, so re-encoding them would cost a generation of quality to
 * buy nothing.
 */
const TRANSCODE_FORMATS: readonly ImageFormat[] = ['heif', 'avif'];

export function needsLocalDecode(format: ImageFormat): boolean {
  return TRANSCODE_FORMATS.includes(format);
}

/**
 * Quality of the intermediate JPEG.
 *
 * High, because this is not the frame anybody looks at — it is re-encoded again
 * at the vendor cap immediately afterwards, and a forensic tool should not spend
 * detail twice. mozjpeg is off: it roughly triples encode time for a buffer that
 * exists for a few hundred milliseconds.
 */
const INTERMEDIATE_JPEG_QUALITY = 92;

/** Human-readable format name for operator-facing sentences. */
export function formatLabel(format: ImageFormat): string {
  switch (format) {
    case 'heif':
      return 'HEIC/HEIF';
    case 'avif':
      return 'AVIF';
    case 'unknown':
      return 'an unrecognised container';
    default:
      return format.toUpperCase();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Returns an `ImageRef` whose bytes can actually be decoded, or a stated failure.
 *
 * Never throws: a stage boundary is not a place to raise. `header` may be passed
 * when the caller has already read it, which every caller in this repo has.
 */
export async function ensureAnalysable(
  image: ImageRef,
  header?: HeaderInfo,
): Promise<AnalysableImage> {
  const bytes = image.bytes;
  if (!bytes || bytes.byteLength === 0) return { image };

  const info = header ?? readImageHeader(bytes);
  if (!needsLocalDecode(info.format)) return { image };

  const outcome = await decodeToJpeg(bytes, info.format);
  if (!outcome.ok) return { image, failure: outcome.failure };

  return {
    image: { ...image, bytes: outcome.value.bytes, mimeType: outcome.value.mimeType },
    decoded: outcome.value,
  };
}

export type DecodeOutcome =
  | { ok: true; value: DecodedImage }
  | { ok: false; failure: DecodeFailure };

/**
 * Decode to a full-resolution JPEG. sharp first, wasm libheif second.
 *
 * Both failures are reported together when both are tried, because "sharp said
 * the codec is missing AND libheif said the file is truncated" is a different
 * diagnosis from either sentence alone.
 */
export async function decodeToJpeg(
  bytes: Uint8Array,
  format: ImageFormat = readImageHeader(bytes).format,
): Promise<DecodeOutcome> {
  const started = Date.now();
  const attempts: string[] = [];

  const sharp = await loadSharp();
  if (sharp) {
    try {
      const out = await sharp(bytes)
        // No argument: apply the container's own orientation rather than a fixed
        // angle, matching what `readImageHeader` reports for an `irot` box.
        .rotate()
        .jpeg({ quality: INTERMEDIATE_JPEG_QUALITY })
        .toBuffer();
      const decoded = readImageHeader(out);
      if (decoded.width && decoded.height) {
        return {
          ok: true,
          value: {
            bytes: out,
            mimeType: 'image/jpeg',
            width: decoded.width,
            height: decoded.height,
            decoder: `libvips (sharp) -> JPEG q${INTERMEDIATE_JPEG_QUALITY}`,
            ranMs: Date.now() - started,
          },
        };
      }
      attempts.push('sharp: re-encoded to a JPEG whose dimensions could not be read back');
    } catch (e) {
      attempts.push(`sharp: ${messageOf(e)}`);
    }
  } else {
    attempts.push('sharp: the native binary did not load');
  }

  const viaHeif = await decodeHeifViaWasm(bytes, sharp);
  if (viaHeif.ok) {
    return { ok: true, value: { ...viaHeif.value, ranMs: Date.now() - started } };
  }
  attempts.push(viaHeif.failure.reason);

  return {
    ok: false,
    failure: { format, reason: attempts.join(' | '), ranMs: Date.now() - started },
  };
}

// ---------------------------------------------------------------------------
// libheif (wasm)
// ---------------------------------------------------------------------------

export const HEIF_WASM_DECODER = 'libheif-js (wasm, via heic-decode)';

/**
 * `heic-decode`'s `one()`: RGBA, with `irot` and the container's own transforms
 * already applied, so `width`/`height` here are display dimensions and agree with
 * `readImageHeader`.
 *
 * Memory: a 48 MP frame is ~192 MB of RGBA in the wasm heap plus a copy on the
 * Node side. That is inside the 25 MB upload cap's worst case and inside a
 * default heap, but it is the reason this decodes once per run rather than per
 * consumer.
 */
async function decodeHeifViaWasm(
  bytes: Uint8Array,
  sharp: SharpFactory | null,
): Promise<{ ok: true; value: Omit<DecodedImage, 'ranMs'> } | { ok: false; failure: { reason: string } }> {
  let decode: HeicDecodeFn;
  try {
    decode = await loadHeicDecode();
  } catch (e) {
    return {
      ok: false,
      failure: {
        reason: `libheif (wasm): the decoder could not be loaded (${messageOf(e)}). Run \`npm install\` — \`heic-decode\` is a declared dependency of this project.`,
      },
    };
  }

  let raw: { width: number; height: number; data: Uint8ClampedArray };
  try {
    raw = await decode({ buffer: bytes });
  } catch (e) {
    return { ok: false, failure: { reason: `libheif (wasm): ${messageOf(e)}` } };
  }
  if (!raw.width || !raw.height || raw.data.byteLength < raw.width * raw.height * 4) {
    return {
      ok: false,
      failure: {
        reason: `libheif (wasm): returned ${raw.data.byteLength} bytes for a ${raw.width}x${raw.height} frame, which is short of the RGBA it claimed.`,
      },
    };
  }

  if (!sharp) {
    return {
      ok: false,
      failure: {
        reason: `libheif (wasm) decoded the frame at ${raw.width}x${raw.height}, but sharp did not load so there is no encoder to turn those pixels back into a JPEG.`,
      },
    };
  }

  try {
    const out = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    })
      .jpeg({ quality: INTERMEDIATE_JPEG_QUALITY })
      .toBuffer();
    return {
      ok: true,
      value: {
        bytes: out,
        mimeType: 'image/jpeg',
        width: raw.width,
        height: raw.height,
        decoder: `${HEIF_WASM_DECODER} -> JPEG q${INTERMEDIATE_JPEG_QUALITY}`,
      },
    };
  } catch (e) {
    return {
      ok: false,
      failure: {
        reason: `libheif (wasm) decoded the frame at ${raw.width}x${raw.height}, but re-encoding it to JPEG failed: ${messageOf(e)}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Operator-facing sentences
// ---------------------------------------------------------------------------

/**
 * The gap that puts a failed decode in the panel above the fold.
 *
 * A stage-trace line is not enough. In the run this was written for, the trace
 * said `vlm-clues SKIPPED("Local image preparation failed: source: bad seek to
 * 1624354")` and the "Capabilities unavailable" panel listed only TinEye and
 * Google Vision — so the operator read a normal-looking result and had no way to
 * know the core analysis never ran.
 */
export function undecodableGap(failure: DecodeFailure): CapabilityGap {
  return {
    capability: `${formatLabel(failure.format)} decoding`,
    impact: `The image could not be decoded, so NO analysis ran on its pixels — no vision call, no observations, no candidates. This is not a weak result, it is an absent one. The decoders reported: ${failure.reason}`,
    howTo: `Re-export the frame as JPEG or PNG and upload that. On an iPhone, Settings > Camera > Formats > Most Compatible saves new photos as JPEG, and sharing a photo through Mail or Files converts an existing HEIC on the way out.`,
  };
}

/**
 * The quality-gate sentence for the same failure.
 *
 * An undecodable image is precisely the case the gate exists for — "we cannot
 * analyse this" — so it fails the gate rather than merely annotating it. That
 * buys the contract invariant for free: `assertRefusalIsHonoured` guarantees a
 * failed gate carries no ranking, so there is no path on which a decode failure
 * ends in a candidate list.
 */
export function undecodableRefusal(failure: DecodeFailure): string {
  return `The ${formatLabel(failure.format)} file could not be decoded to pixels, so nothing could be measured or analysed and no ranking is returned. Decoder output: ${failure.reason}`;
}

// ---------------------------------------------------------------------------
// Dependencies, probed rather than imported
// ---------------------------------------------------------------------------

interface SharpPipeline {
  rotate(): SharpPipeline;
  jpeg(opts: { quality?: number; mozjpeg?: boolean }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}

type SharpFactory = (
  input: Uint8Array,
  opts?: { raw?: { width: number; height: number; channels: number } },
) => SharpPipeline;

/**
 * Annotated `string`s, not literals: the specifiers stay opaque to the type
 * checker, so neither module has to have type declarations for this file to
 * build, and an absent one degrades at runtime with a stated reason.
 */
const SHARP_SPECIFIER: string = 'sharp';
const HEIC_DECODE_SPECIFIER: string = 'heic-decode';

let sharpProbe: Promise<SharpFactory | null> | null = null;

function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpProbe) {
    sharpProbe = (async (): Promise<SharpFactory | null> => {
      try {
        const mod: unknown = await import(SHARP_SPECIFIER);
        const candidate = defaultExport(mod);
        return typeof candidate === 'function' ? (candidate as SharpFactory) : null;
      } catch {
        return null;
      }
    })();
  }
  return sharpProbe;
}

type HeicDecodeFn = (input: {
  buffer: Uint8Array;
}) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;

let heicProbe: Promise<HeicDecodeFn> | null = null;

/**
 * `heic-decode` is CommonJS and assigns its function to `module.exports`, which
 * Node's interop can surface at either `default` or `default.default` depending
 * on how the importer was loaded. Both are unwrapped rather than assumed.
 */
function loadHeicDecode(): Promise<HeicDecodeFn> {
  if (!heicProbe) {
    heicProbe = (async (): Promise<HeicDecodeFn> => {
      const mod: unknown = await import(HEIC_DECODE_SPECIFIER);
      const first = defaultExport(mod);
      const candidate = typeof first === 'function' ? first : defaultExport(first);
      if (typeof candidate !== 'function') {
        throw new Error('heic-decode resolved to a module with no callable export');
      }
      return candidate as HeicDecodeFn;
    })().catch((e: unknown) => {
      // A failed probe must not be cached as a permanently rejected promise:
      // the next request would see an unrelated "already rejected" error.
      heicProbe = null;
      throw e;
    });
  }
  return heicProbe;
}

function defaultExport(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && 'default' in mod) return (mod as { default: unknown }).default;
  return mod;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
