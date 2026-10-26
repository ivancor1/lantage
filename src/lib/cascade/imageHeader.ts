/**
 * Container-header reader: pixel dimensions and format, without decoding.
 *
 * The quality gate needs true pixel dimensions before anything else runs, and it
 * must not get them from EXIF — `ExifImageWidth` is metadata, and metadata is
 * exactly the thing this product does not trust (o3 correctly rejected falsified
 * EXIF GPS; the same scepticism applies to every other tag). Reading the SOF /
 * IHDR / VP8X / ispe box is a fact about the file.
 */

import { readJpeg } from '@/lib/verify/jpeg';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'heif' | 'avif' | 'unknown';

export interface HeaderInfo {
  format: ImageFormat;
  width?: number;
  height?: number;
  byteLength: number;
  /** Bits per pixel of the encoded file. A crude but real detail-density proxy. */
  bitsPerPixel?: number;
}

export function readImageHeader(bytes: Uint8Array): HeaderInfo {
  const byteLength = bytes.byteLength;
  const base = { byteLength };

  if (byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const jpeg = readJpeg(bytes);
    return withBpp({ ...base, format: 'jpeg', width: jpeg.width, height: jpeg.height });
  }

  if (
    byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    // IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR".
    return withBpp({
      ...base,
      format: 'png',
      width: readU32(bytes, 16),
      height: readU32(bytes, 20),
    });
  }

  if (byteLength >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') {
      return withBpp({
        ...base,
        format: 'webp',
        width: readU24LE(bytes, 24) + 1,
        height: readU24LE(bytes, 27) + 1,
      });
    }
    if (chunk === 'VP8 ') {
      return withBpp({
        ...base,
        format: 'webp',
        width: readU16LE(bytes, 26) & 0x3fff,
        height: readU16LE(bytes, 28) & 0x3fff,
      });
    }
    if (chunk === 'VP8L') {
      const b = readU32LE(bytes, 21);
      return withBpp({
        ...base,
        format: 'webp',
        width: (b & 0x3fff) + 1,
        height: ((b >> 14) & 0x3fff) + 1,
      });
    }
    return { ...base, format: 'webp' };
  }

  if (byteLength >= 10 && ascii(bytes, 0, 3) === 'GIF') {
    return withBpp({
      ...base,
      format: 'gif',
      width: readU16LE(bytes, 6),
      height: readU16LE(bytes, 8),
    });
  }

  if (byteLength >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    const format: ImageFormat = brand.startsWith('avi') ? 'avif' : 'heif';
    const extents = readIsoBmffPrimaryExtents(bytes);
    if (extents) {
      return withBpp({ ...base, format, width: extents.width, height: extents.height });
    }
    return { ...base, format };
  }

  return { ...base, format: 'unknown' };
}

// ---------------------------------------------------------------------------
// ISOBMFF (HEIC / HEIF / AVIF)
// ---------------------------------------------------------------------------

/**
 * The dimensions of the **primary** item, with the container's own rotation
 * applied.
 *
 * This used to be a scan for the first `ispe` box in the first 4 KB, which is
 * wrong on the most common input this product will ever see. An iPhone HEIC
 * carries four `ispe` boxes — measured on IMG_7211.HEIC: 512x512, 4032x3024,
 * 320x240, 2016x1512 — because the file holds a thumbnail, the capture, an
 * auxiliary (depth/gain) map and its thumbnail as separate items. The first one
 * in the box order is the *thumbnail*, so the scan reported a 12 MP photo as
 * 512x512 and the quality gate then refused it in those words. A dimension
 * attributed to the wrong item is a fabricated dimension.
 *
 * So the association is read the way the spec defines it: `pitm` names the
 * primary item, `ipma` maps that item to 1-based indices into `ipco`, and the
 * `ispe` among those properties is the only one that describes the photograph.
 * `irot` is a container transform (not EXIF, not metadata) and is part of the
 * item's definition, so a quarter turn swaps the axes — which is what every
 * decoder reports and therefore what the rest of the pipeline must agree with.
 *
 * Returns undefined rather than a guess whenever the structure cannot be walked.
 * The quality gate's "could not read pixel dimensions" refusal is the honest
 * outcome there; a number taken from whichever box happened to come first is not.
 */
interface IsoBmffExtents {
  width: number;
  height: number;
}

interface IsoBox {
  type: string;
  /** First byte of the box payload, after size+type (and after a 64-bit size). */
  contentStart: number;
  /** One past the last byte of the box. */
  end: number;
}

/** Guards against a malformed file turning a header read into a long loop. */
const MAX_BOXES_PER_LEVEL = 512;

function readIsoBmffPrimaryExtents(bytes: Uint8Array): IsoBmffExtents | undefined {
  const meta = findBox(bytes, 0, bytes.byteLength, 'meta');
  // `meta` is a FullBox: 4 bytes of version+flags precede its children.
  if (!meta || meta.contentStart + 4 > meta.end) return undefined;
  const metaStart = meta.contentStart + 4;

  const iprp = findBox(bytes, metaStart, meta.end, 'iprp');
  if (!iprp) return undefined;
  const ipco = findBox(bytes, iprp.contentStart, iprp.end, 'ipco');
  if (!ipco) return undefined;

  // `ipco` children are addressed by 1-based position, so order is the identity.
  const properties = listBoxes(bytes, ipco.contentStart, ipco.end);

  const pitm = findBox(bytes, metaStart, meta.end, 'pitm');
  const ipma = findBox(bytes, iprp.contentStart, iprp.end, 'ipma');
  const primaryId = pitm ? readPrimaryItemId(bytes, pitm) : undefined;
  const associated =
    primaryId !== undefined && ipma
      ? readPropertyIndices(bytes, ipma, primaryId)
          ?.map((index) => properties[index - 1])
          .filter((box): box is IsoBox => box !== undefined)
      : undefined;

  const scope =
    associated ??
    // No `pitm`/`ipma` to read: usable only when there is nothing to choose
    // between. One `ispe` in the file is that item's `ispe` by construction;
    // several without an association table is ambiguous, and ambiguous is
    // reported as unmeasured.
    (properties.filter((b) => b.type === 'ispe').length === 1 ? properties : undefined);
  if (!scope) return undefined;

  const ispe = scope.find((b) => b.type === 'ispe');
  // `ispe` is a FullBox: version+flags, then two 32-bit extents.
  if (!ispe || ispe.contentStart + 12 > ispe.end) return undefined;
  const width = readU32(bytes, ispe.contentStart + 4);
  const height = readU32(bytes, ispe.contentStart + 8);
  if (width <= 0 || height <= 0) return undefined;

  const irot = scope.find((b) => b.type === 'irot');
  const quarterTurns = irot && irot.contentStart < irot.end ? bytes[irot.contentStart] & 0x03 : 0;
  return quarterTurns % 2 === 1 ? { width: height, height: width } : { width, height };
}

/** The boxes directly inside [start, end), in file order. */
function listBoxes(bytes: Uint8Array, start: number, end: number): IsoBox[] {
  const out: IsoBox[] = [];
  let offset = start;
  while (offset + 8 <= end && out.length < MAX_BOXES_PER_LEVEL) {
    let size = readU32(bytes, offset);
    let headerBytes = 8;
    if (size === 1) {
      // 64-bit size. Anything past 2^53 is not a real image and is treated as
      // malformed rather than silently truncated by the float conversion.
      if (offset + 16 > end) return out;
      const high = readU32(bytes, offset + 8);
      const low = readU32(bytes, offset + 12);
      size = high * 0x1_0000_0000 + low;
      headerBytes = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerBytes || offset + size > end) return out;
    out.push({
      type: ascii(bytes, offset + 4, 4),
      contentStart: offset + headerBytes,
      end: offset + size,
    });
    offset += size;
  }
  return out;
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string): IsoBox | undefined {
  return listBoxes(bytes, start, end).find((b) => b.type === type);
}

/** `pitm`: version 0 carries a 16-bit item id, version 1 and later a 32-bit one. */
function readPrimaryItemId(bytes: Uint8Array, pitm: IsoBox): number | undefined {
  if (pitm.contentStart + 4 > pitm.end) return undefined;
  const version = bytes[pitm.contentStart];
  if (version === 0) {
    return pitm.contentStart + 6 <= pitm.end ? readU16(bytes, pitm.contentStart + 4) : undefined;
  }
  return pitm.contentStart + 8 <= pitm.end ? readU32(bytes, pitm.contentStart + 4) : undefined;
}

/**
 * `ipma`: for each item, the 1-based `ipco` indices of its properties.
 *
 * Item ids are 16-bit below version 1 and 32-bit at or above it; each index is
 * 15-bit when `flags & 1` is set and 7-bit otherwise, with the top bit marking
 * the property "essential" — a flag about decodability, not about size, so it is
 * masked off rather than read.
 */
function readPropertyIndices(
  bytes: Uint8Array,
  ipma: IsoBox,
  itemId: number,
): number[] | undefined {
  let offset = ipma.contentStart;
  if (offset + 8 > ipma.end) return undefined;
  const version = bytes[offset];
  const flags = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
  offset += 4;
  const entryCount = readU32(bytes, offset);
  offset += 4;

  const idBytes = version < 1 ? 2 : 4;
  const indexBytes = (flags & 1) === 1 ? 2 : 1;

  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + idBytes + 1 > ipma.end) return undefined;
    const id = idBytes === 2 ? readU16(bytes, offset) : readU32(bytes, offset);
    offset += idBytes;
    const associationCount = bytes[offset];
    offset += 1;
    if (offset + associationCount * indexBytes > ipma.end) return undefined;
    if (id === itemId) {
      const indices: number[] = [];
      for (let i = 0; i < associationCount; i += 1) {
        const at = offset + i * indexBytes;
        indices.push(indexBytes === 2 ? readU16(bytes, at) & 0x7fff : bytes[at] & 0x7f);
      }
      return indices;
    }
    offset += associationCount * indexBytes;
  }
  return undefined;
}

function withBpp(info: HeaderInfo): HeaderInfo {
  if (!info.width || !info.height || info.width <= 0 || info.height <= 0) return info;
  return { ...info, bitsPerPixel: (info.byteLength * 8) / (info.width * info.height) };
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function readU32LE(b: Uint8Array, o: number): number {
  return ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;
}
function readU24LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}
function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function readU16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function ascii(b: Uint8Array, start: number, len: number): string {
  let out = '';
  for (let i = start; i < Math.min(b.length, start + len); i += 1) out += String.fromCharCode(b[i]);
  return out;
}
