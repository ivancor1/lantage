'use client';

import { useEffect } from 'react';
import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { ConfidenceBand, GeoCandidate, LatLon } from '@/lib/contracts/types';

/**
 * Candidate regions drawn as expanding confidence circles with numbered pins.
 *
 * These are DOM markers rather than GeoJSON circle layers on purpose. A
 * `circle-radius` paint property is in *pixels*, so a GeoJSON circle would lie
 * about scale as soon as the analyst zooms — and the whole point of
 * `GeoCandidate.radiusM` is that the uncertainty is a real ground distance, not a
 * decoration. A DOM ring whose diameter is recomputed from the projection on
 * every `move` stays geographically honest, and gets CSS transitions for free.
 */

/* Colour carries meaning. A green circle is a claim about confidence. */
const BAND_COLOUR: Record<ConfidenceBand, string> = {
  high: 'var(--color-signal)',
  moderate: 'var(--color-signal)',
  weak: 'var(--color-caution)',
  refused: 'var(--color-alert)',
};

const RING_MS = 900;
const PIN_MS = 340;
/** Per-rank entrance offset. Slow enough that the analyst can follow the ranking. */
const STAGGER_MS = 40;
const MIN_RING_PX = 30;

export interface ResultRingsProps {
  map: MapLibreMap;
  candidates: readonly GeoCandidate[];
}

/** Ground metres → screen px at the current camera, via the actual projection. */
function metresToPixels(map: MapLibreMap, center: LatLon, metres: number): number {
  const latitudeDegrees = metres / 111_320;
  const a = map.project([center.lon, center.lat]);
  const b = map.project([center.lon, center.lat + latitudeDegrees]);
  return Math.abs(a.y - b.y);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ResultRings({ map, candidates }: ResultRingsProps) {
  useEffect(() => {
    /* A refused band means no ranking was returned, so there is no region to
       draw. Plotting one would contradict the refusal. */
    const drawable = candidates.filter((candidate) => candidate.confidence.band !== 'refused');
    if (drawable.length === 0) return;

    const reduced = prefersReducedMotion();
    const markers: Marker[] = [];
    const rings: Array<{ element: HTMLElement; candidate: GeoCandidate }> = [];

    for (const candidate of drawable) {
      const colour = BAND_COLOUR[candidate.confidence.band];
      const delay = (candidate.rank - 1) * STAGGER_MS;

      /* Zero-size wrapper: MapLibre anchors it dead-centre on the coordinate and
         the children position themselves off that origin. */
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;width:0;height:0;pointer-events:none;';

      const ring = document.createElement('span');
      ring.setAttribute('aria-hidden', 'true');
      ring.style.cssText = [
        'position:absolute',
        'left:0',
        'top:0',
        'border-radius:9999px',
        `border:1px solid ${colour}`,
        `background:color-mix(in srgb, ${colour} 8%, transparent)`,
        `box-shadow:0 0 0 1px color-mix(in srgb, ${colour} 18%, transparent) inset`,
        reduced
          ? 'transition:none'
          : `transition:transform ${RING_MS}ms var(--ease-spring) ${delay}ms, opacity ${RING_MS}ms var(--ease-spring) ${delay}ms`,
        reduced ? 'opacity:1' : 'opacity:0',
        reduced ? 'transform:translate(-50%,-50%) scale(1)' : 'transform:translate(-50%,-50%) scale(.2)',
      ].join(';');
      wrapper.append(ring);

      const pin = document.createElement('span');
      pin.textContent = String(candidate.rank);
      pin.title = `${candidate.place.label} · ±${candidate.radiusM}m`;
      pin.style.cssText = [
        'position:absolute',
        'left:0',
        'top:0',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'width:22px',
        'height:22px',
        'border-radius:9999px',
        'background:var(--color-n-0)',
        `border:1px solid ${colour}`,
        `color:${colour}`,
        'font-family:var(--font-mono)',
        'font-size:11px',
        'font-variant-numeric:tabular-nums',
        'line-height:1',
        'pointer-events:auto',
        'cursor:default',
        'box-shadow:var(--shadow-lg)',
        reduced ? 'transition:none' : `transition:transform ${PIN_MS}ms var(--ease-spring) ${delay}ms, opacity ${PIN_MS}ms var(--ease-spring) ${delay}ms`,
        reduced ? 'opacity:1' : 'opacity:0',
        reduced ? 'transform:translate(-50%,-50%) scale(1)' : 'transform:translate(-50%,-50%) scale(.6)',
      ].join(';');
      wrapper.append(pin);

      const marker = new Marker({ element: wrapper, anchor: 'center' })
        .setLngLat([candidate.center.lon, candidate.center.lat])
        .addTo(map);

      markers.push(marker);
      rings.push({ element: ring, candidate });

      if (!reduced) {
        /* Two frames: one to let the browser commit the initial style, one to
           change it. A single rAF is coalesced and the transition never runs. */
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            ring.style.opacity = '1';
            ring.style.transform = 'translate(-50%,-50%) scale(1)';
            pin.style.opacity = '1';
            pin.style.transform = 'translate(-50%,-50%) scale(1)';
          });
        });
      }
    }

    /* Ring diameter is a ground measurement, so it has to be re-derived from the
       projection whenever the camera changes. */
    const sizeRings = () => {
      for (const { element, candidate } of rings) {
        const diameter = Math.max(MIN_RING_PX, metresToPixels(map, candidate.center, candidate.radiusM) * 2);
        element.style.width = `${diameter}px`;
        element.style.height = `${diameter}px`;
      }
    };

    sizeRings();
    map.on('move', sizeRings);

    return () => {
      map.off('move', sizeRings);
      for (const marker of markers) marker.remove();
    };
  }, [map, candidates]);

  return null;
}
