'use client';

import { useEffect } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

/** globals.css keys `backdrop-filter: none` off this class on <html>. */
export const MAP_ANIMATING_CLASS = 'map-animating';

/**
 * Marks the document as "camera moving" for the duration of any map movement.
 *
 * This is the single most valuable perf lever in the app: compositing a
 * `backdrop-filter` over a canvas that repaints every frame forces the browser to
 * re-sample and re-blur the whole scrim on each of those frames. Dropping the
 * blur while the camera moves costs nothing visually — nobody reads the header
 * mid-flight — and buys back most of the frame budget on a pitched 3D view.
 *
 * `movestart`/`moveend` cover pan, zoom, rotate, pitch and `flyTo`. A depth
 * counter guards against overlapping gestures (wheel-zoom during a drag) leaving
 * the class stuck on or being cleared too early.
 */
export function useMapAnimating(map: MapLibreMap | null): void {
  useEffect(() => {
    if (!map) return;

    const root = document.documentElement;
    let depth = 0;

    const start = () => {
      depth += 1;
      root.classList.add(MAP_ANIMATING_CLASS);
    };
    const end = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) root.classList.remove(MAP_ANIMATING_CLASS);
    };

    map.on('movestart', start);
    map.on('moveend', end);

    return () => {
      map.off('movestart', start);
      map.off('moveend', end);
      root.classList.remove(MAP_ANIMATING_CLASS);
    };
  }, [map]);
}
