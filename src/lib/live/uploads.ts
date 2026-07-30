/**
 * Local upload store for the LIVE path.
 *
 * Object storage, signed URLs and org scoping belong to the production
 * `/api/search` path. This is the single-operator local path: bytes land in
 * `.lantage-uploads/` at the repo root and are addressed by their own sha256.
 *
 * Three rules the rest of the module exists to enforce:
 *
 *  1. **Nothing the client says is trusted.** The filename is recorded for the
 *     operator's benefit and never used to build a path — a path derived from a
 *     client string is a traversal bug waiting to be written. The declared MIME
 *     type is ignored in favour of the magic bytes, because a `.jpg` extension on
 *     a PDF is the oldest upload trick there is.
 *  2. **Every field is measured.** `bytes` is the real byte length, `sha256` is
 *     computed over exactly the stored bytes, and `width`/`height` come from a
 *     decoder or from the container header — never from EXIF, which is metadata
 *     and metadata is the thing this product does not trust. A dimension we
 *     cannot measure is absent, not guessed.
 *  3. **Content addressing makes dedup free.** Re-uploading the same bytes
 *     returns the existing record rather than a second copy, so an operator who
 *     drags the same frame into two modules gets one id and one audit trail.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readImageHeader } from '@/lib/cascade/imageHeader';
import type { UploadRecord } from './contract';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Where the bytes live. Deliberately inside the repo and gitignored: the
 * operator can see, inspect and delete their own case imagery with `ls` and `rm`,
 * which is a property a hidden OS temp directory does not have.
 */
export function uploadRoot(): string {
  // The root is resolved at runtime, so `next build` reports that it traced the
  // whole project into the file list of every route that touches this module.
  // `turbopackIgnore` marks the cwd read as deliberate; the warning persists
  // regardless, and it is a deploy-size concern that does not apply here —
  // every route that reads this directory is local-only and must not be deployed.
  return (
    process.env.LANTAGE_UPLOAD_DIR ??
    path.join(/*turbopackIgnore: true*/ process.cwd(), '.lantage-uploads')
  );
}

/**
 * 25 MB. Comfortably above a 48MP phone HEIC and a full-frame camera JPEG, and
 * below the point where holding the buffer in memory to hash it is antisocial.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Under this it is a thumbnail or a truncated transfer, not a frame. */
export const MIN_UPLOAD_BYTES = 64;

/**
 * The one sentence for an oversize file, shared with the route so the operator
 * reads the same words whether the file was refused before or after buffering.
 * Exact byte counts are included because at one byte over the cap both figures
 * round to the same number of megabytes, which reads like a bug.
 */
export function oversizeReason(byteLength: number): string {
  return (
    `The file is ${byteLength.toLocaleString('en-US')} bytes (${formatMb(byteLength)} MB). ` +
    `The cap is ${MAX_UPLOAD_BYTES.toLocaleString('en-US')} bytes (${formatMb(MAX_UPLOAD_BYTES)} MB) per file — ` +
    `resize or re-export it and upload again.`
  );
}

/** Long edge of the generated preview. Enough for the operator to confirm the frame. */
const PREVIEW_LONG_EDGE_PX = 1600;

interface AcceptedFormat {
  mime: string;
  /** Extension used on disk. Cosmetic — the id is the sha256. */
  ext: string;
  label: string;
  /** Whether a browser can be expected to render these bytes directly. */
  browserRenderable: boolean;
}

/**
 * The accepted set. HEIC and TIFF are here because real claim imagery arrives as
 * iPhone HEIC and scanner TIFF; neither renders in most browsers, which is why
 * `browserRenderable` exists and why a downscaled preview is generated.
 */
const ACCEPTED: readonly AcceptedFormat[] = [
  { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG', browserRenderable: true },
  { mime: 'image/png', ext: 'png', label: 'PNG', browserRenderable: true },
  { mime: 'image/webp', ext: 'webp', label: 'WebP', browserRenderable: true },
  { mime: 'image/heic', ext: 'heic', label: 'HEIC', browserRenderable: false },
  { mime: 'image/heif', ext: 'heif', label: 'HEIF', browserRenderable: false },
  { mime: 'image/tiff', ext: 'tiff', label: 'TIFF', browserRenderable: false },
] as const;

export const ACCEPTED_UPLOAD_MIMES: readonly string[] = ACCEPTED.map((f) => f.mime);

const ACCEPTED_LABEL = ACCEPTED.map((f) => f.label).join(', ');

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface UploadStored {
  ok: true;
  record: UploadRecord;
  /** True when these exact bytes were already on disk. Not an error. */
  deduplicated: boolean;
}

export interface UploadRejected {
  ok: false;
  /** The name the client sent, echoed so the operator knows which file failed. */
  filename: string;
  /** Analyst-readable, and specific enough to act on. */
  reason: string;
}

export type UploadOutcome = UploadStored | UploadRejected;

// ---------------------------------------------------------------------------
// MIME sniffing — magic bytes only
// ---------------------------------------------------------------------------

/**
 * Returns the accepted format these bytes actually are, or null.
 *
 * The declared `Content-Type` of a multipart part is attacker-controlled and is
 * not consulted anywhere in this file.
 */
export function sniffAcceptedFormat(bytes: Uint8Array): AcceptedFormat | null {
  const mime = sniffMime(bytes);
  if (!mime) return null;
  return ACCEPTED.find((f) => f.mime === mime) ?? null;
}

/** The container these bytes are, whether or not we accept it. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF') {
    if (ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
    return 'application/octet-stream';
  }
  // TIFF, both byte orders. BigTIFF (version 43) is reported as TIFF too: the
  // decoder either handles it or the dimension read degrades to absent.
  if (bytes.length >= 4) {
    const le = bytes[0] === 0x49 && bytes[1] === 0x49;
    const be = bytes[0] === 0x4d && bytes[1] === 0x4d;
    const version = le ? bytes[2] | (bytes[3] << 8) : (bytes[2] << 8) | bytes[3];
    if ((le || be) && (version === 42 || version === 43)) return 'image/tiff';
  }
  if (bytes.length >= 16 && ascii(bytes, 4, 4) === 'ftyp') {
    // ISOBMFF: the major brand is at offset 8, and compatible brands follow the
    // 4-byte minor version. A HEIC file commonly declares major `mif1` with
    // `heic` only in the compatible list, so both are read.
    const brands = new Set<string>();
    brands.add(ascii(bytes, 8, 4).trim().toLowerCase());
    for (let o = 16; o + 4 <= Math.min(bytes.length, 64); o += 4) {
      brands.add(ascii(bytes, o, 4).trim().toLowerCase());
    }
    if (brands.has('avif') || brands.has('avis')) return 'image/avif';
    for (const b of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']) {
      if (brands.has(b)) return 'image/heic';
    }
    if (brands.has('mif1') || brands.has('msf1') || brands.has('miaf')) return 'image/heif';
    return 'video/quicktime';
  }
  if (bytes.length >= 6 && ascii(bytes, 0, 3) === 'GIF') return 'image/gif';
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === '%PDF') return 'application/pdf';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'application/zip';
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  return null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = ascii(bytes, 0, Math.min(bytes.length, 256)).toLowerCase();
  return head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'));
}

/** The rejection sentence for a container we recognise but do not accept. */
function rejectionForMime(mime: string | null): string {
  const named: Record<string, string> = {
    'image/gif': 'GIF',
    'image/avif': 'AVIF',
    'image/bmp': 'BMP',
    'image/svg+xml': 'SVG',
    'application/pdf': 'PDF',
    'application/zip': 'a ZIP or Office document',
    'video/quicktime': 'a video container (MP4/MOV)',
    'application/octet-stream': 'a RIFF container that is not WebP',
  };
  const what = mime ? (named[mime] ?? mime) : 'not a format this build recognises';
  return `The file's magic bytes say it is ${what}. Accepted: ${ACCEPTED_LABEL}. The declared content type is ignored here — only the bytes are read — so re-labelling the file will not help; convert it instead.`;
}

// ---------------------------------------------------------------------------
// sharp — loaded lazily, and optional
// ---------------------------------------------------------------------------

/**
 * sharp ships with Next as an optional native dependency. It is the only way to
 * get true pixel dimensions for TIFF and to produce a preview, so it is used —
 * but a missing or broken native binary must degrade to "no preview, dimensions
 * from the container header" rather than fail the upload. Hence the local
 * structural type and the runtime load: nothing in this file's build depends on
 * sharp's types resolving.
 */
interface SharpMetadata {
  width?: number;
  height?: number;
  orientation?: number;
}

interface SharpInstance {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpInstance;
  resize(opts: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): SharpInstance;
  jpeg(opts: { quality: number; mozjpeg?: boolean }): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

type SharpFactory = (input: Uint8Array, opts?: { failOn?: string; pages?: number }) => SharpInstance;

let sharpFactory: SharpFactory | null | undefined;

async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpFactory !== undefined) return sharpFactory;
  try {
    const mod: unknown = await import('sharp');
    const candidate =
      typeof mod === 'function'
        ? mod
        : mod && typeof mod === 'object' && 'default' in mod
          ? (mod as { default: unknown }).default
          : null;
    sharpFactory = typeof candidate === 'function' ? (candidate as SharpFactory) : null;
  } catch {
    sharpFactory = null;
  }
  return sharpFactory;
}

interface MeasuredPixels {
  width?: number;
  height?: number;
  /** How the dimensions were obtained. Recorded so a reader knows what to trust. */
  via: 'decoder' | 'container-header' | 'unmeasured';
}

/**
 * True pixel dimensions.
 *
 * The decoder is asked first because it is authoritative for TIFF and for
 * orientation; the container header is the fallback and is authoritative for
 * HEIC, which the bundled libvips cannot decode (its HEIF input is AVIF-only).
 * Both are facts about the bytes. EXIF `ExifImageWidth` is not consulted.
 */
export async function measurePixels(bytes: Uint8Array): Promise<MeasuredPixels> {
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const meta = await sharp(bytes, { failOn: 'none' }).metadata();
      if (meta.width && meta.height) {
        // EXIF orientation 5-8 transposes the frame. sharp reports the stored
        // dimensions, so they are swapped here to describe what is displayed.
        const swap = typeof meta.orientation === 'number' && meta.orientation >= 5;
        return {
          width: swap ? meta.height : meta.width,
          height: swap ? meta.width : meta.height,
          via: 'decoder',
        };
      }
    } catch {
      // Fall through: an undecodable container is not a reason to refuse storage.
    }
  }
  const header = readImageHeader(bytes);
  if (header.width && header.height) {
    return { width: header.width, height: header.height, via: 'container-header' };
  }
  return { via: 'unmeasured' };
}

// ---------------------------------------------------------------------------
// On-disk record
// ---------------------------------------------------------------------------

/**
 * The sidecar. Basenames rather than absolute paths, so the directory can be
 * moved or inspected on another machine without rewriting every record.
 */
interface UploadSidecar {
  v: 1;
  id: string;
  filename: string;
  bytes: number;
  mime: string;
  width?: number;
  height?: number;
  dimensionSource: MeasuredPixels['via'];
  sha256: string;
  /** Basename of the stored original. */
  file: string;
  /** Basename of the generated preview, when one could be produced. */
  preview?: string;
  createdAt: string;
}

export interface StoredUpload {
  record: UploadRecord;
  /** Absolute path to the original bytes. Server-side only. */
  path: string;
  /** Absolute path to the downscaled preview, when one exists. */
  previewPath?: string;
  mime: string;
  browserRenderable: boolean;
}

const ID_PATTERN = /^[0-9a-f]{64}$/;

/** An id is a sha256 hex digest and nothing else. This is the traversal guard. */
export function isUploadId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function sidecarPath(id: string): string {
  return path.join(uploadRoot(), `${id}.json`);
}

function toRecord(side: UploadSidecar): UploadRecord {
  const record: UploadRecord = {
    id: side.id,
    filename: side.filename,
    bytes: side.bytes,
    mime: side.mime,
    sha256: side.sha256,
    path: path.join(uploadRoot(), side.file),
    previewUrl: `/api/uploads/${side.id}`,
    createdAt: side.createdAt,
  };
  if (side.width !== undefined) record.width = side.width;
  if (side.height !== undefined) record.height = side.height;
  return record;
}

/**
 * Strips the disk path. Call this on everything that crosses the HTTP boundary:
 * the absolute path of a case image is server-side detail, and the contract marks
 * it "never serialised to the client".
 */
export function toClientRecord(record: UploadRecord): UploadRecord {
  const clone: UploadRecord = { ...record };
  delete clone.path;
  return clone;
}

export function toClientRecords(records: readonly UploadRecord[]): UploadRecord[] {
  return records.map(toClientRecord);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Records a client filename without letting it become a path.
 * Only the basename survives, control characters are dropped, and the result is
 * length-capped. It is display text from here on.
 */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'unnamed';
  return cleaned.slice(0, 180);
}

export async function storeUpload(input: {
  filename: string;
  bytes: Uint8Array;
}): Promise<UploadOutcome> {
  const filename = safeFilename(input.filename);
  const bytes = input.bytes;

  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, filename, reason: oversizeReason(bytes.byteLength) };
  }
  if (bytes.byteLength < MIN_UPLOAD_BYTES) {
    return {
      ok: false,
      filename,
      reason: `The file is only ${bytes.byteLength} bytes, which is a truncated transfer rather than an image.`,
    };
  }

  const format = sniffAcceptedFormat(bytes);
  if (!format) {
    return { ok: false, filename, reason: rejectionForMime(sniffMime(bytes)) };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const root = uploadRoot();
  await mkdir(root, { recursive: true });

  // Dedup by content. Same bytes, same id, same record — a second copy on disk
  // would only create a second thing to keep in sync.
  const existing = await readSidecar(sha256);
  if (existing) {
    return { ok: true, record: toRecord(existing), deduplicated: true };
  }

  const pixels = await measurePixels(bytes);
  const file = `${sha256}.${format.ext}`;
  await writeAtomic(path.join(root, file), bytes);

  let preview: string | undefined;
  const previewBytes = await renderPreview(bytes);
  if (previewBytes) {
    preview = `${sha256}.preview.jpg`;
    await writeAtomic(path.join(root, preview), previewBytes);
  }

  const sidecar: UploadSidecar = {
    v: 1,
    id: sha256,
    filename,
    bytes: bytes.byteLength,
    mime: format.mime,
    dimensionSource: pixels.via,
    sha256,
    file,
    createdAt: new Date().toISOString(),
    ...(pixels.width !== undefined ? { width: pixels.width } : {}),
    ...(pixels.height !== undefined ? { height: pixels.height } : {}),
    ...(preview ? { preview } : {}),
  };
  await writeAtomic(sidecarPath(sha256), Buffer.from(JSON.stringify(sidecar, null, 2), 'utf8'));

  return { ok: true, record: toRecord(sidecar), deduplicated: false };
}

/**
 * A downscaled JPEG for display. Returns null when the decoder is unavailable or
 * cannot read the container (HEIC, most notably) — in which case the original
 * bytes are served instead and the operator's browser decides.
 */
async function renderPreview(bytes: Uint8Array): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    return await sharp(bytes, { failOn: 'none', pages: 1 })
      .rotate()
      .resize({
        width: PREVIEW_LONG_EDGE_PX,
        height: PREVIEW_LONG_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Write-then-rename, so a crash mid-write cannot leave a half file under a real id. */
async function writeAtomic(target: string, data: Uint8Array): Promise<void> {
  const tmp = `${target}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function readSidecar(id: string): Promise<UploadSidecar | null> {
  if (!isUploadId(id)) return null;
  try {
    const raw = await readFile(sidecarPath(id), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const s = parsed as Partial<UploadSidecar>;
    if (typeof s.id !== 'string' || typeof s.file !== 'string' || typeof s.mime !== 'string') {
      return null;
    }
    if (typeof s.sha256 !== 'string' || typeof s.bytes !== 'number') return null;
    return {
      v: 1,
      id: s.id,
      filename: typeof s.filename === 'string' ? s.filename : 'unnamed',
      bytes: s.bytes,
      mime: s.mime,
      dimensionSource: s.dimensionSource ?? 'unmeasured',
      sha256: s.sha256,
      file: s.file,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date(0).toISOString(),
      ...(typeof s.width === 'number' ? { width: s.width } : {}),
      ...(typeof s.height === 'number' ? { height: s.height } : {}),
      ...(typeof s.preview === 'string' ? { preview: s.preview } : {}),
    };
  } catch {
    return null;
  }
}

/** The record, with its server-side `path` populated. Null when unknown. */
export async function getUpload(id: string): Promise<UploadRecord | null> {
  const side = await readSidecar(id);
  return side ? toRecord(side) : null;
}

/** Record plus disk locations. Null when unknown. */
export async function getStoredUpload(id: string): Promise<StoredUpload | null> {
  const side = await readSidecar(id);
  if (!side) return null;
  const format = ACCEPTED.find((f) => f.mime === side.mime);
  return {
    record: toRecord(side),
    path: path.join(uploadRoot(), side.file),
    mime: side.mime,
    browserRenderable: format?.browserRenderable ?? false,
    ...(side.preview ? { previewPath: path.join(uploadRoot(), side.preview) } : {}),
  };
}

/** Record plus the original bytes. Null when unknown or unreadable. */
export async function readUpload(
  id: string,
): Promise<{ record: UploadRecord; bytes: Uint8Array; mime: string } | null> {
  const stored = await getStoredUpload(id);
  if (!stored) return null;
  try {
    const bytes = await readFile(stored.path);
    return { record: stored.record, bytes, mime: stored.mime };
  } catch {
    return null;
  }
}

/**
 * What `GET /api/uploads/[id]` should hand back.
 *
 * The original bytes when a browser can render them; the generated preview when
 * it cannot (HEIC, TIFF). `variant` is reported in a response header so nobody
 * mistakes a preview for the file that was hashed.
 */
export async function readUploadForServing(
  id: string,
  opts: { forceOriginal?: boolean; forcePreview?: boolean } = {},
): Promise<{ bytes: Uint8Array; mime: string; variant: 'original' | 'preview' } | null> {
  const stored = await getStoredUpload(id);
  if (!stored) return null;

  const wantPreview = opts.forcePreview === true || (!opts.forceOriginal && !stored.browserRenderable);
  if (wantPreview && stored.previewPath) {
    try {
      const bytes = await readFile(stored.previewPath);
      return { bytes, mime: 'image/jpeg', variant: 'preview' };
    } catch {
      // Fall through to the original: a missing derivative is not a missing upload.
    }
  }
  if (opts.forcePreview === true && !stored.previewPath) return null;

  try {
    const bytes = await readFile(stored.path);
    return { bytes, mime: stored.mime, variant: 'original' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ascii(b: Uint8Array, start: number, len: number): string {
  let out = '';
  for (let i = start; i < Math.min(b.length, start + len); i += 1) out += String.fromCharCode(b[i]);
  return out;
}

function formatMb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1);
}
