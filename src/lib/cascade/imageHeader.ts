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
    // ISOBMFF: the ImageSpatialExtents box carries the real dimensions. Scanning
    // for it beats walking the whole box tree for a header read, and iPhone HEIC
    // is common enough in claims imagery that "unknown" is not good enough.
    const ispe = indexOfAscii(bytes, 'ispe');
    if (ispe > 0 && ispe + 16 <= byteLength) {
      return withBpp({
        ...base,
        format,
        width: readU32(bytes, ispe + 8),
        height: readU32(bytes, ispe + 12),
      });
    }
    return { ...base, format };
  }

  return { ...base, format: 'unknown' };
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
function ascii(b: Uint8Array, start: number, len: number): string {
  let out = '';
  for (let i = start; i < Math.min(b.length, start + len); i += 1) out += String.fromCharCode(b[i]);
  return out;
}
function indexOfAscii(b: Uint8Array, needle: string, limit = 4096): number {
  const end = Math.min(b.length - needle.length, limit);
  for (let i = 0; i <= end; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (b[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}
