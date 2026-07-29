/**
 * JPEG structure reader: quantization tables, dimensions, encoder markers.
 *
 * Deterministic, dependency-free, and cheap — which is why it runs before any
 * statistical detector (docs/MASTER_PLAN.md §5: provenance first, statistics
 * second). Quantization-table fingerprinting is genuinely informative about
 * *processing history* — "re-saved by Photoshop", "passed through platform X" —
 * and that is all we claim from it. It says nothing about whether pixels are
 * true, and this module must never be read as if it did.
 *
 * Also used by the quality gate: a frame recompressed down to Q30 has lost the
 * high-frequency facade detail that retrieval keys on, and the analyst deserves
 * to be told that before we rank anything.
 */

/** Annex K baseline luminance table — the reference for quality estimation. */
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
] as const;

export interface JpegQuantTable {
  /** Table slot 0..3. Slot 0 is luminance in every encoder we've seen. */
  id: number;
  precision: 8 | 16;
  values: number[];
}

export interface JpegInfo {
  isJpeg: boolean;
  width?: number;
  height?: number;
  /** SOF marker kind. Progressive is a platform-recompression tell, not a forgery tell. */
  mode?: 'baseline' | 'extended-sequential' | 'progressive' | 'lossless' | 'arithmetic';
  quantTables: JpegQuantTable[];
  /**
   * Estimated libjpeg-equivalent quality factor, 0..100, from the luma table.
   * Undefined when there is no usable table.
   */
  estimatedQuality?: number;
  /**
   * Stable fingerprint of the quantization tables. Identical encoder + quality
   * gives an identical fingerprint, which is what makes "these two files came
   * out of the same pipeline" a checkable statement.
   */
  quantFingerprint?: string;
  /** Chroma subsampling as an "hxv" string for the first component, e.g. "2x2". */
  chromaSubsampling?: string;
  markers: {
    hasExifApp1: boolean;
    hasXmpApp1: boolean;
    hasAdobeApp14: boolean;
    hasIccProfile: boolean;
    hasJfif: boolean;
    comments: string[];
    /** Count of scan segments. >1 means progressive scans, not "edited twice". */
    scanCount: number;
  };
}

export function readJpeg(bytes: Uint8Array): JpegInfo {
  const empty: JpegInfo = {
    isJpeg: false,
    quantTables: [],
    markers: {
      hasExifApp1: false,
      hasXmpApp1: false,
      hasAdobeApp14: false,
      hasIccProfile: false,
      hasJfif: false,
      comments: [],
      scanCount: 0,
    },
  };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return empty;

  const info: JpegInfo = { ...empty, isJpeg: true, markers: { ...empty.markers, comments: [] } };
  let i = 2;

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    i += 2;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue;
    }
    if (i + 1 >= bytes.length) break;
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) break;
    const segStart = i + 2;
    const segEnd = i + length;

    switch (marker) {
      case 0xdb: {
        // DQT — one or more tables in a single segment.
        let p = segStart;
        while (p < segEnd) {
          const pq = bytes[p] >> 4;
          const tq = bytes[p] & 0x0f;
          p += 1;
          const precision: 8 | 16 = pq === 0 ? 8 : 16;
          const values: number[] = [];
          for (let k = 0; k < 64 && p < segEnd; k += 1) {
            if (precision === 8) {
              values.push(bytes[p]);
              p += 1;
            } else {
              values.push((bytes[p] << 8) | bytes[p + 1]);
              p += 2;
            }
          }
          info.quantTables.push({ id: tq, precision, values });
        }
        break;
      }
      case 0xc0:
      case 0xc1:
      case 0xc2:
      case 0xc3:
      case 0xc9:
      case 0xca: {
        info.mode =
          marker === 0xc0
            ? 'baseline'
            : marker === 0xc1
              ? 'extended-sequential'
              : marker === 0xc2
                ? 'progressive'
                : marker === 0xc3
                  ? 'lossless'
                  : 'arithmetic';
        info.height = (bytes[segStart + 1] << 8) | bytes[segStart + 2];
        info.width = (bytes[segStart + 3] << 8) | bytes[segStart + 4];
        const components = bytes[segStart + 5];
        if (components >= 1 && segStart + 8 <= segEnd) {
          const sampling = bytes[segStart + 7];
          info.chromaSubsampling = `${sampling >> 4}x${sampling & 0x0f}`;
        }
        break;
      }
      case 0xda: {
        info.markers.scanCount += 1;
        break;
      }
      case 0xe0: {
        if (ascii(bytes, segStart, 4) === 'JFIF') info.markers.hasJfif = true;
        break;
      }
      case 0xe1: {
        const tag = ascii(bytes, segStart, 4);
        if (tag === 'Exif') info.markers.hasExifApp1 = true;
        if (ascii(bytes, segStart, 28).startsWith('http://ns.adobe.com/xap')) {
          info.markers.hasXmpApp1 = true;
        }
        break;
      }
      case 0xe2: {
        if (ascii(bytes, segStart, 11) === 'ICC_PROFILE') info.markers.hasIccProfile = true;
        break;
      }
      case 0xee: {
        if (ascii(bytes, segStart, 5) === 'Adobe') info.markers.hasAdobeApp14 = true;
        break;
      }
      case 0xfe: {
        const text = ascii(bytes, segStart, Math.min(120, segEnd - segStart)).replace(/\0+$/, '');
        if (text.trim().length > 0) info.markers.comments.push(text.trim());
        break;
      }
      default:
        break;
    }

    i = segEnd;
    // After the first scan header the rest is entropy-coded data; the tables and
    // markers we care about are already behind us.
    if (marker === 0xda) break;
  }

  const luma = info.quantTables.find((t) => t.id === 0) ?? info.quantTables[0];
  if (luma && luma.values.length === 64) {
    info.estimatedQuality = estimateQuality(luma.values);
  }
  if (info.quantTables.length > 0) {
    info.quantFingerprint = fingerprint(info.quantTables);
  }
  return info;
}

/**
 * Inverse of libjpeg's quality -> table scaling, taken per coefficient and
 * reduced with a median so one clamped entry cannot swing the estimate.
 *
 * libjpeg: table[i] = clamp((STD[i] * scale + 50) / 100), where
 * scale = 5000/q for q < 50 and 200 - 2q for q >= 50.
 */
export function estimateQuality(lumaTable: readonly number[]): number | undefined {
  const estimates: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    const t = lumaTable[i];
    // 255 is saturated and 1 is the lossless floor: neither constrains quality.
    if (!Number.isFinite(t) || t <= 1 || t >= 255) continue;
    const scale = (t * 100) / STD_LUMA[i];
    const q = scale > 100 ? 5000 / scale : (200 - scale) / 2;
    if (Number.isFinite(q)) estimates.push(Math.max(1, Math.min(100, q)));
  }
  if (estimates.length === 0) return undefined;
  estimates.sort((a, b) => a - b);
  const mid = Math.floor(estimates.length / 2);
  const median =
    estimates.length % 2 === 0 ? (estimates[mid - 1] + estimates[mid]) / 2 : estimates[mid];
  return Math.round(median);
}

/** FNV-1a over the table bytes. Not a security hash — a stable identity. */
function fingerprint(tables: JpegQuantTable[]): string {
  let h = 0x811c9dc5;
  for (const t of tables) {
    h = mix(h, t.id);
    for (const v of t.values) {
      h = mix(h, v & 0xff);
      h = mix(h, (v >> 8) & 0xff);
    }
  }
  return `dqt-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function mix(h: number, byte: number): number {
  let x = (h ^ byte) >>> 0;
  x = Math.imul(x, 0x01000193) >>> 0;
  return x;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < Math.min(bytes.length, start + length); i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}
