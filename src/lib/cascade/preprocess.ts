/**
 * Stage 0 — decode-lite, header read, EXIF/XMP extraction.
 *
 * The rule that governs this whole file: **record metadata, never trust it.**
 *
 * EXIF GPS is the most tempting field in the file and the most abused. In the
 * published evaluations, o3 was observed correctly *rejecting* falsified EXIF
 * GPS rather than parroting it, and we hold ourselves to the same standard. So
 * EXIF GPS becomes an `Evidence` of `kind: 'exif'` with a `verifiable` note
 * telling the analyst how to check it against the visual evidence — it never
 * becomes a candidate, never seeds retrieval, and never sets a confidence band.
 *
 * A claimed capture time is treated the same way, with one exception that is
 * safe by construction: it may *feed the solar verifier*, which can only ever
 * down-weight or corroborate candidates that retrieval already produced.
 */

// exifr pulls in Node built-ins (fs, zlib) for its file-reading path, which we
// never use — we hand it buffers. That is the source of the benign
// "Couldn't load fs / zlib" notices during page-data collection.
//
// Do NOT add `import 'server-only'` here: it is a bundler-only alias and is
// unresolvable by the plain Node test runner, which breaks orchestrator.test.ts.
// The server boundary is already correct — nothing in a client bundle reaches
// this module (verified: the build succeeds with the marker present).
import exifr from 'exifr';
import type { Evidence, StageTrace } from '@/lib/contracts/types';
import { QUALITY, TIMEOUTS_MS } from './config';
import { type HeaderInfo, readImageHeader } from './imageHeader';
import { fetchBytes } from './net';
import { type ImageRef, type Stage, type StageContext, type StageOutput, failure, skipped } from './types';

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface MetadataFacts {
  /** Present in the file. Recorded, never trusted. */
  gps?: { lat: number; lon: number; altitudeM?: number };
  /** ISO 8601 if parseable. Feeds the solar verifier only. */
  capturedAt?: string;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  software?: string;
  orientation?: number;
  /** IPTC DigitalSourceType / XMP — the C2PA-adjacent generative-media marker. */
  digitalSourceType?: string;
  /** Raw key count, so the ledger can say "metadata was stripped" honestly. */
  tagCount: number;
  /** True when the container has no metadata at all. Not evidence of anything. */
  stripped: boolean;
}

export interface PreprocessOutput {
  image: ImageRef;
  header: HeaderInfo;
  metadata: MetadataFacts;
  /** Bytes, present whenever we managed to read them. */
  bytes?: Uint8Array;
}

// ---------------------------------------------------------------------------
// Resize — deliberately delegated
// ---------------------------------------------------------------------------

/**
 * Resize/normalise hook.
 *
 * TODO(B1): the Modal inference service already decodes and resizes every image
 * it embeds (EigenPlaces ingests 512px, GeoCLIP 224px), so doing it a second
 * time in Node would cost a native image dependency and a decode for no
 * accuracy. Until a `/preprocess` endpoint exists, this is a pass-through that
 * records what a resize *would* target, and the cascade sends the original URL.
 * If a local resize is ever needed (offline BENCH runs), implement this
 * interface — do not sprinkle sharp/wasm calls through the stages.
 */
export interface ImageNormaliser {
  normalise(input: ImageRef, targetLongEdgePx: number): Promise<ImageRef>;
}

export const passthroughNormaliser: ImageNormaliser = {
  async normalise(input) {
    return input;
  },
};

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export function createPreprocessStage(
  normaliser: ImageNormaliser = passthroughNormaliser,
): Stage<ImageRef, PreprocessOutput> {
  return {
    stage: 'preprocess',
    async run(input: ImageRef, ctx: StageContext): Promise<StageOutput<PreprocessOutput>> {
      const started = Date.now();
      let bytes = input.bytes;

      if (!bytes && input.url) {
        const fetched = await fetchBytes(
          input.url,
          ctx.budget.timeoutFor(TIMEOUTS_MS.imageFetch),
          ctx.signal,
        );
        if (fetched.ok) {
          bytes = fetched.value.bytes;
        }
      }

      if (!bytes) {
        return skipped(
          'preprocess',
          Date.now() - started,
          failure(
            'no-input',
            'Could not read the image bytes. Nothing downstream can run without them.',
          ),
        );
      }

      const header = readImageHeader(bytes);
      const metadata = await extractMetadata(bytes);
      const normalised = await normaliser.normalise({ ...input, bytes }, QUALITY.degradedLongEdgePx);

      const evidence = metadataEvidence(metadata, header);
      const trace: StageTrace = { stage: 'preprocess', ranMs: Date.now() - started, costUsd: 0 };

      return {
        evidence,
        trace,
        output: { image: { ...normalised, mimeType: normalised.mimeType ?? mimeFor(header) }, header, metadata, bytes },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** exifr returns an untyped bag; this is the only place it is read. */
type ExifBag = Record<string, unknown>;

export async function extractMetadata(bytes: Uint8Array): Promise<MetadataFacts> {
  let bag: ExifBag = {};
  try {
    const parsed: unknown = await exifr.parse(bytes, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      iptc: true,
      icc: false,
      jfif: true,
      userComment: true,
      mergeOutput: true,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
    });
    if (parsed && typeof parsed === 'object') bag = parsed as ExifBag;
  } catch {
    // A malformed or absent EXIF block is not an error condition: most real case
    // imagery has been through a platform that stripped it.
    bag = {};
  }

  const lat = num(bag.latitude);
  const lon = num(bag.longitude);
  const facts: MetadataFacts = {
    tagCount: Object.keys(bag).length,
    stripped: Object.keys(bag).length === 0,
  };

  if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    facts.gps = { lat, lon, altitudeM: num(bag.GPSAltitude) };
  }
  const captured = firstDate([bag.DateTimeOriginal, bag.CreateDate, bag.ModifyDate, bag.GPSDateStamp]);
  if (captured) facts.capturedAt = captured;
  facts.cameraMake = str(bag.Make);
  facts.cameraModel = str(bag.Model);
  facts.lensModel = str(bag.LensModel);
  facts.software = str(bag.Software) ?? str(bag.CreatorTool);
  facts.orientation = num(bag.Orientation);
  facts.digitalSourceType = str(bag.DigitalSourceType) ?? str(bag.digitalSourceType);
  return facts;
}

function metadataEvidence(m: MetadataFacts, header: HeaderInfo): Evidence[] {
  const evidence: Evidence[] = [];

  if (m.gps) {
    evidence.push({
      kind: 'exif',
      claim: `The file's EXIF block claims ${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}. Recorded, not relied on.`,
      verifiable:
        'Run `exiftool` on the original file to confirm the tag exists, then check whether the visual evidence below actually agrees with that coordinate. EXIF GPS is trivially editable and is treated here as a claim to test, not a location.',
      reference: {
        label: 'EXIF GPS claim',
        url: `https://www.openstreetmap.org/?mlat=${m.gps.lat}&mlon=${m.gps.lon}#map=17/${m.gps.lat}/${m.gps.lon}`,
      },
      // Zero weight is deliberate: this signal never moves a ranking.
      weight: 0,
    });
  }

  if (m.capturedAt || m.cameraMake || m.software) {
    const parts = [
      m.cameraMake && m.cameraModel ? `${m.cameraMake} ${m.cameraModel}` : m.cameraMake,
      m.software ? `software "${m.software}"` : undefined,
      m.capturedAt ? `capture time ${m.capturedAt}` : undefined,
    ].filter(Boolean);
    evidence.push({
      kind: 'exif',
      claim: `Metadata present: ${parts.join(', ')}.`,
      verifiable:
        'Run `exiftool` on the original file and compare. Metadata is recorded for the chain of custody; it is never used to place the image.',
      weight: 0,
    });
  }

  if (m.stripped) {
    evidence.push({
      kind: 'exif',
      claim: `No metadata present (${header.format.toUpperCase()} container). This is normal for platform-uploaded imagery and is not a finding.`,
      verifiable:
        'Run `exiftool` on the original file: platforms strip metadata on upload, so absence tells you about the delivery path, not about the image.',
      weight: 0,
    });
  }

  return evidence;
}

function mimeFor(header: HeaderInfo): string | undefined {
  switch (header.format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'heif':
      return 'image/heic';
    case 'avif':
      return 'image/avif';
    default:
      return undefined;
  }
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return undefined;
}

function firstDate(values: unknown[]): string | undefined {
  for (const v of values) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return undefined;
}
