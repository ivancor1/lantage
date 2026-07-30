/**
 * Display formatting for values that came off the wire.
 *
 * Everything here is a *presentation* of a number the API (or the operator's own
 * file) actually supplied. Nothing in this file invents, estimates or fills in a
 * value: a missing input returns an em dash, never a plausible-looking figure.
 */

import type {
  AuthenticityVerdict,
  ConfidenceBand,
  Evidence,
  SuppressionReason,
} from '@/lib/contracts/types';

export const ABSENT = '—';

export const EVIDENCE_LABEL: Record<Evidence['kind'], string> = {
  exif: 'EXIF',
  'signage-ocr': 'SIGNAGE OCR',
  'vpr-match': 'VPR MATCH',
  'embedding-prior': 'EMBEDDING PRIOR',
  'vlm-clue': 'VLM CLUE',
  solar: 'SOLAR',
  ecoregion: 'ECOREGION',
  c2pa: 'C2PA',
  quantization: 'QUANTIZATION',
  detector: 'DETECTOR',
  localization: 'LOCALIZATION',
  'corpus-match': 'CORPUS MATCH',
};

/** The only three hues in the app. Colour carries state, never decoration. */
export const BAND_COLOUR: Record<ConfidenceBand, string> = {
  high: 'var(--color-signal)',
  moderate: 'var(--color-signal)',
  weak: 'var(--color-caution)',
  refused: 'var(--color-alert)',
};

/**
 * Verdict labels for AUTHENTIC.
 *
 * The word "authentic" appears in none of them, and `no-indicators-found` is
 * deliberately NOT green: green would read as "verified real", which is a claim
 * this product does not make (contracts/types.ts, AuthenticityVerdict).
 */
export const VERDICT_LABEL: Record<AuthenticityVerdict, string> = {
  'strong-indicators': 'STRONG INDICATORS OF GENERATION OR EDITING',
  'moderate-indicators': 'MODERATE INDICATORS',
  'weak-indicators': 'WEAK INDICATORS',
  'no-indicators-found': 'NO INDICATORS FOUND',
  inconclusive: 'INCONCLUSIVE · VERDICT SUPPRESSED',
};

export const VERDICT_COLOUR: Record<AuthenticityVerdict, string> = {
  'strong-indicators': 'var(--color-alert)',
  'moderate-indicators': 'var(--color-caution)',
  'weak-indicators': 'var(--color-caution)',
  'no-indicators-found': 'var(--color-fg-secondary)',
  inconclusive: 'var(--color-fg-secondary)',
};

export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  'computational-photography': 'Computational photography (HDR / night mode / AI denoise)',
  'ai-upscaled': 'AI upscaled',
  'heavy-retouching': 'Heavy retouching',
  screenshot: 'Screenshot',
  recompressed: 'Recompressed',
  'resolution-too-low': 'Resolution below the detector floor',
};

/** Binary units, because that is what a file browser reports for the same file. */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ABSENT;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

/** Five decimals ≈ 1m. More would imply precision the radius explicitly denies. */
export function formatCoord(value: number): string {
  return value.toFixed(5);
}

export function formatRadius(metres: number): string {
  if (!Number.isFinite(metres)) return ABSENT;
  if (metres >= 1000) return `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 2)} km`;
  return `${Math.round(metres)} m`;
}

export function formatMs(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ABSENT;
  return `${Math.round(ms)}ms`;
}

/** 0..1 → integer percent. Only ever used next to a band or an explicit label. */
export function formatFraction(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ABSENT;
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

export function formatIsoTime(iso: string | undefined): string {
  if (!iso) return ABSENT;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function shortHash(sha256: string | undefined): string {
  if (!sha256) return ABSENT;
  return sha256.length > 16 ? `${sha256.slice(0, 16)}…` : sha256;
}

export function stageLabel(stage: string): string {
  return stage.replace(/-/g, ' ');
}

// ---------------------------------------------------------------------------
// Crop geometry
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Reads a crop box off an `Evidence` if the response carried one.
 *
 * Two sources, in order:
 *   1. a box field the analyser attached (`Evidence` has `cropUrl` but no box, so
 *      this is an optional extra rather than part of the contract);
 *   2. the `bbox` query parameter of `cropUrl` itself. `cropUrl()` in
 *      src/lib/verify/ocrGeocode.ts states outright that the crop endpoint may
 *      never be built and that the bbox travels with the evidence so the UI can
 *      crop client-side — this is that fallback.
 *
 * If neither is present nothing is drawn. A box is never derived from the image
 * dimensions or from the claim text.
 */
export function readEvidenceBox(evidence: Evidence): Box | null {
  const raw = evidence as unknown as Record<string, unknown>;
  const direct = coerceBox(raw.bbox ?? raw.box ?? raw.crop ?? raw.cropBox);
  if (direct) return direct;
  return boxFromCropUrl(evidence.cropUrl);
}

function boxFromCropUrl(cropUrl: string | undefined): Box | null {
  if (!cropUrl) return null;
  const match = /[?&]bbox=([^&]+)/.exec(cropUrl);
  if (!match) return null;
  const parts = decodeURIComponent(match[1]).split(',').map(Number);
  return coerceBox(parts);
}

function coerceBox(value: unknown): Box | null {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number')) {
    /* House convention, and it is corners rather than extents: the VLM clue
       prompt in src/lib/live/interior.ts specifies "[x0, y0, x1, y1] normalised
       0..1 with the origin at the TOP-LEFT", and cropUrl() serialises the same
       four numbers. Reading them as x/y/width/height would misplace every box. */
    const [x0, y0, x1, y1] = value as [number, number, number, number];
    return finite({
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    });
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const x = pick(o, 'x', 'left', 'x0');
  const y = pick(o, 'y', 'top', 'y0');
  const w = pick(o, 'w', 'width');
  const h = pick(o, 'h', 'height');
  if (x === null || y === null) return null;
  if (w !== null && h !== null) return finite({ x, y, w, h });
  const x1 = pick(o, 'x1', 'right');
  const y1 = pick(o, 'y1', 'bottom');
  if (x1 === null || y1 === null) return null;
  return finite({ x, y, w: x1 - x, h: y1 - y });
}

function pick(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function finite(box: Box): Box | null {
  const ok = [box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n));
  return ok && box.w > 0 && box.h > 0 ? box : null;
}

/**
 * Whether a box is expressed as 0..1 fractions rather than pixels.
 *
 * Pixel boxes are the documented form (`FaceProbe.selected` says "in pixels"),
 * so this only matters for the undeclared evidence box above. A box whose right
 * and bottom edges both land inside the unit square cannot be pixels on any
 * image bigger than 1px.
 */
export function boxIsNormalised(box: Box): boolean {
  return box.x + box.w <= 1.0001 && box.y + box.h <= 1.0001;
}
