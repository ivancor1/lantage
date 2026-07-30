'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  addProtocol,
  type AddProtocolAction,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoCandidate } from '@/lib/contracts/types';
import { ResultRings } from './ResultRings';
import { addBuildingExtrusion } from './buildings';
import {
  OPENFREEMAP_ATTRIBUTION,
  OPENFREEMAP_DARK_STYLE,
  PROTOMAPS_ATTRIBUTION,
  resolveBasemapStyle,
  usingPmtiles,
} from './style';
import { useMapAnimating } from './useMapAnimating';

/**
 * `addProtocol` is global to MapLibre, and the Protomaps docs are explicit that
 * it should only run once per application lifecycle. A module-level latch is the
 * simplest thing that survives StrictMode's double-mount and Fast Refresh; we
 * deliberately do NOT `removeProtocol` on unmount, because a second MapCanvas
 * elsewhere on the page would lose its tiles.
 */
let pmtilesProtocolRegistered = false;

function ensurePmtilesProtocol(): void {
  if (pmtilesProtocolRegistered) return;
  const protocol = new Protocol();
  addProtocol('pmtiles', protocol.tile as AddProtocolAction);
  pmtilesProtocolRegistered = true;
}

export interface MapCanvasProps {
  /** [lon, lat] — MapLibre order, not the [lat, lon] used by our contracts. */
  center?: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  /** Drawn as expanding confidence regions with numbered pins. */
  candidates?: readonly GeoCandidate[];
  className?: string;
}

export function MapCanvas({
  /* Butler St, Lawrenceville — the rank-1 candidate. z14.4 is the widest camera
     that still shows building massing while keeping the ~850m rank-3 region on
     screen; going tighter hides the ranking, going wider flattens the city. */
  center = [-79.9614, 40.4718],
  zoom = 14.4,
  pitch = 52,
  bearing = -18,
  candidates,
  className,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);

  /* Camera props seed the map once. Re-creating a WebGL context because a prop
     changed would be catastrophic for both perf and analyst context, so the
     effect is intentionally mount-only and reads the initial values off a ref. */
  const cameraRef = useRef({ center, zoom, pitch, bearing });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensurePmtilesProtocol();

    const camera = cameraRef.current;
    const instance = new MapLibreMap({
      container,
      style: resolveBasemapStyle(),
      center: camera.center,
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: camera.bearing,
      maxPitch: 72,
      /* OSM/ODbL attribution is a licence obligation, not a nicety. Declared here
         as well as on the source so it survives a runtime style swap. */
      attributionControl: {
        compact: true,
        customAttribution: usingPmtiles ? PROTOMAPS_ATTRIBUTION : OPENFREEMAP_ATTRIBUTION,
      },
      canvasContextAttributes: { antialias: true },
    });

    instance.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
    /* An investigative map needs a legible scale bar — every radius on screen is
       a distance claim the analyst should be able to eyeball. */
    instance.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-left');

    /* Re-run after any style change, not just the first load: the fallback swap
       below replaces the whole stylesheet and drops the extrusion with it. */
    const syncExtrusion = () => {
      if (instance.isStyleLoaded()) addBuildingExtrusion(instance);
    };
    instance.on('load', syncExtrusion);
    instance.on('styledata', syncExtrusion);

    /* TODO(basemap): remove once a real PMTiles archive is provisioned. Until
       then, if the configured archive is missing or unreadable we degrade to the
       keyless OpenFreeMap dark style rather than showing an empty black plane. */
    let fellBackToRaster = false;
    /* maplibre-gl does not export its ErrorEvent class as a named type, so this is
       declared structurally against the only field the handler reads. */
    const onError = (event: { error?: { message?: string } }) => {
      const message = event.error?.message ?? '';
      /* Surface every map error. A basemap that fails silently is the worst
         failure mode this component has — see the container-height bug. */
      console.error('[MapCanvas] map error:', message, event.error);
      if (!usingPmtiles || fellBackToRaster || !message.toLowerCase().includes('pmtiles')) return;
      fellBackToRaster = true;
      console.warn('[MapCanvas] PMTiles basemap unavailable; falling back to OpenFreeMap dark.', event.error);
      instance.setStyle(OPENFREEMAP_DARK_STYLE);
    };
    instance.on('error', onError);

    /* Dev-only handle so the map can be inspected from the console. A black map
       with no error is otherwise almost impossible to diagnose. */
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __lantageMap?: MapLibreMap }).__lantageMap = instance;
    }

    setMap(instance);

    return () => {
      instance.off('load', syncExtrusion);
      instance.off('styledata', syncExtrusion);
      instance.off('error', onError);
      instance.remove();
      setMap(null);
    };
    /* Empty deps is deliberate — see cameraRef above. Do not add camera props here. */
  }, []);

  useMapAnimating(map);

  return (
    /* Two divs, deliberately.
     *
     * maplibre-gl.css sets `.maplibregl-map { position: relative }` on whatever
     * element MapLibre is mounted into. Tailwind v4 emits its utilities inside a
     * cascade layer, and unlayered CSS beats layered CSS regardless of source
     * order — so MapLibre's `relative` always wins over an `absolute` utility on
     * the same node. The container then has no positioned box and no content, and
     * collapses to height 0: MapLibre initialises, reports a 0-size viewport,
     * renders nothing and never requests a tile. Silently — no error anywhere.
     *
     * So the caller's positioning classes go on an outer div MapLibre never
     * touches, and the mount node gets explicit 100% sizing, which MapLibre's
     * stylesheet does not set and therefore cannot override.
     *
     * --map-shell is true #000, reserved for exactly this surface. Everything else
     * in the app uses the blue-tinted off-blacks. */
    <div className={className} style={{ background: 'var(--map-shell)' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      {map && candidates?.length ? <ResultRings map={map} candidates={candidates} /> : null}
    </div>
  );
}
