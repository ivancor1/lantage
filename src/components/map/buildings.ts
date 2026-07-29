import type { AddLayerObject, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Overture/OSM-derived 3D building extrusion.
 *
 * Modelled on MapLibre's own "Display buildings in 3D" example
 * (https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/),
 * with two changes:
 *
 *  1. The schema is discovered rather than hardcoded, so this works over both
 *     the Protomaps v4 basemap and the OpenMapTiles fallback, and no-ops
 *     silently over anything else.
 *  2. `fill-extrusion-base` reads the min-height property directly. The upstream
 *     example writes `['get', 'zoom']` inside a `case`, which reads a *feature*
 *     property named "zoom" that does not exist — always falsy, so the base is
 *     always 0. Building parts on plinths need the real value.
 */

export const BUILDING_EXTRUSION_ID = 'lantage-3d-buildings';

/**
 * Verified against the published schemas on 2026-07-29:
 *  - Protomaps basemap v4 `buildings`: kind / height / min_height
 *    (https://docs.protomaps.com/basemaps/layers)
 *  - OpenMapTiles `building` as served by OpenFreeMap: render_height /
 *    render_min_height / hide_3d (from https://tiles.openfreemap.org/planet)
 */
const SCHEMAS = [
  { sourceLayer: 'buildings', height: 'height', minHeight: 'min_height' },
  { sourceLayer: 'building', height: 'render_height', minHeight: 'render_min_height' },
] as const;

interface BuildingBinding {
  source: string;
  sourceLayer: string;
  height: string;
  minHeight: string;
}

function findBuildingBinding(map: MapLibreMap): BuildingBinding | null {
  const layers = map.getStyle()?.layers;
  if (!layers) return null;

  for (const schema of SCHEMAS) {
    for (const layer of layers) {
      if (layer.id === BUILDING_EXTRUSION_ID) continue;
      if (!('source-layer' in layer) || layer['source-layer'] !== schema.sourceLayer) continue;
      if (!('source' in layer) || typeof layer.source !== 'string') continue;
      return {
        source: layer.source,
        sourceLayer: schema.sourceLayer,
        height: schema.height,
        minHeight: schema.minHeight,
      };
    }
  }
  return null;
}

/** Insert beneath the first label layer so extrusions never occlude place names. */
function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
}

/**
 * Adds the extrusion layer if the active basemap exposes building heights.
 *
 * Idempotent, and a no-op returning `false` when the style has no building
 * layer — a basemap without footprints is a legitimate configuration, not an
 * error worth throwing over.
 */
export function addBuildingExtrusion(map: MapLibreMap): boolean {
  if (map.getLayer(BUILDING_EXTRUSION_ID)) return true;

  const binding = findBuildingBinding(map);
  if (!binding) return false;

  /* `coalesce` to 8m (roughly two storeys) below: a footprint with no height tag
     should still have mass rather than collapse into the ground plane. */
  const layer: AddLayerObject = {
    id: BUILDING_EXTRUSION_ID,
    type: 'fill-extrusion',
    source: binding.source,
    'source-layer': binding.sourceLayer,
    minzoom: 13.5,
    filter: ['!=', ['get', 'hide_3d'], true],
    paint: {
      /* Monochrome ramp — taller massing reads lighter. No hue: colour in this
         app is reserved for confidence and state. */
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', binding.height], 0],
        0,
        '#14161d',
        40,
        '#1e212a',
        120,
        '#2a2e39',
        260,
        '#373c49',
      ],
      /* Grows in over 0.8 of a zoom level so massing is already at full height
         at the default camera (z14.4) rather than reading as a flat plane. */
      'fill-extrusion-height': [
        'interpolate',
        ['linear'],
        ['zoom'],
        13.5,
        0,
        14.3,
        ['coalesce', ['get', binding.height], 8],
      ],
      'fill-extrusion-base': ['coalesce', ['get', binding.minHeight], 0],
      'fill-extrusion-opacity': 0.92,
    },
  };

  map.addLayer(layer, firstSymbolLayerId(map));
  return true;
}
