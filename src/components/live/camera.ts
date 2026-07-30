/**
 * Camera framing for the map shell.
 *
 * `MapCanvas` seeds its camera once at mount and exposes no map handle, so the
 * only way to move it from here — without editing a component this agent does
 * not own — is to remount it under a new key. `cameraKey()` changes exactly when
 * the top candidate's coordinate does, which is once per run, so the WebGL
 * context is not recreated for anything else. A true `flyTo` (DESIGN_SYSTEM.md
 * §5) needs one `onMap` callback on MapCanvas; that is a change for its owner.
 */

import type { GeoCandidate } from '@/lib/contracts/types';

export interface Camera {
  /** [lon, lat] — MapLibre order, not the [lat, lon] our contracts use. */
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

/**
 * The empty state. A world view asserts nothing about where anything is, which
 * is the correct claim before a run has happened.
 */
export const NEUTRAL_CAMERA: Camera = { center: [-24, 26], zoom: 1.25, pitch: 0, bearing: 0 };

const EQUATOR_M = 40_075_016.686;
const TILE_PX = 256;
/** Effective shell width the region is framed against, in CSS px. */
const FRAME_PX = 1100;
/** Fraction of that width the claimed diameter should occupy. */
const FRAME_FILL = 0.55;

/**
 * Frames the candidate's *radius*, not its centre point. The uncertainty is the
 * claim, so the camera has to show all of it; zooming to the centroid would make
 * a 1.6km region read as a pin.
 */
export function cameraForCandidate(candidate: GeoCandidate): Camera {
  const { lat, lon } = candidate.center;
  const metresPerPixel = (2 * Math.max(1, candidate.radiusM)) / (FRAME_PX * FRAME_FILL);
  const groundSpan = EQUATOR_M * Math.cos((lat * Math.PI) / 180);
  const zoom = Math.log2(groundSpan / (TILE_PX * metresPerPixel));
  const tight = candidate.precision === 'street' || candidate.precision === 'city';
  return {
    center: [lon, lat],
    zoom: Math.min(17, Math.max(2, Number.isFinite(zoom) ? zoom : 2)),
    // Pitch shows building massing, which only helps at the two tight precisions.
    pitch: tight ? 48 : 0,
    bearing: 0,
  };
}

export function cameraKey(top: GeoCandidate | undefined): string {
  if (!top) return 'no-region';
  return `${top.id}:${top.center.lat.toFixed(5)},${top.center.lon.toFixed(5)}:${top.radiusM}`;
}

/** Lowest rank wins; falls back to array order when ranks are absent. */
export function topCandidate(candidates: readonly GeoCandidate[] | undefined): GeoCandidate | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0];
}
