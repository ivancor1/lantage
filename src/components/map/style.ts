import type { MapOptions } from 'maplibre-gl';

/**
 * Basemap styles.
 *
 * Everything in this file was read from the Protomaps docs on 2026-07-29, not
 * recalled:
 *   - layer + property names: https://docs.protomaps.com/basemaps/layers (v4)
 *   - source/glyph/attribution shape: https://docs.protomaps.com/basemaps/maplibre
 *   - `pmtiles://` protocol: https://docs.protomaps.com/pmtiles/maplibre
 */

/* MapLibre 6 does not re-export the style-spec types by name; MapOptions is the
   supported surface, so we narrow through it rather than reaching into the
   undeclared @maplibre/maplibre-gl-style-spec transitive dependency. */
export type MapStyle = NonNullable<MapOptions['style']>;
type StyleSpec = Extract<MapStyle, { version: number }>;

/** ODbL/attribution obligation for the Protomaps basemap. Never render without it. */
export const PROTOMAPS_ATTRIBUTION =
  '<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a> © ' +
  '<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

export const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> © ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> · data © ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

/** Pre-compiled fontstacks published by Protomaps. "Noto Sans Regular" exists here. */
const PROTOMAPS_GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

/**
 * TODO(basemap): no PMTiles archive is provisioned yet. Set
 * NEXT_PUBLIC_PMTILES_URL to an https URL of a Protomaps v4 basemap build
 * (`protomaps extract` output for the Allegheny County AOI is the plan) and the
 * map switches to it automatically — no code change. Until then MapCanvas serves
 * the OpenFreeMap dark vector style below, which needs no API key and is the
 * source MapLibre's own 3D-buildings example uses.
 */
export const PMTILES_URL: string = process.env.NEXT_PUBLIC_PMTILES_URL ?? '';

/** Free, keyless, near-black OpenMapTiles-schema dark style. Fallback basemap. */
export const OPENFREEMAP_DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';

const SOURCE = 'protomaps';

/*
 * Palette. The Protomaps `dark` flavor is a blue-grey cartographic dark theme;
 * Lantage needs near-black so that the single green signal accent is the only
 * thing on screen with chroma. So we do not call namedFlavor('dark') — we key our
 * own minimal layer set to the documented v4 schema instead. Fewer layers is also
 * fewer draw calls under a pitched 3D camera.
 */
const C = {
  shell: '#000000',
  earth: '#08080c',
  water: '#04060b',
  green: '#0b0f13',
  building: '#101319',
  roadMinor: '#191d26',
  roadMajor: '#232833',
  roadTrunk: '#2c323f',
  boundary: '#2b3340',
  labelPrimary: '#9aa1ab',
  labelSecondary: '#6b7280',
  halo: '#000000',
} as const;

/**
 * Minimal near-black basemap over a Protomaps v4 PMTiles archive.
 *
 * `pmtilesUrl` is a plain https URL; the `pmtiles://` prefix is added here.
 * No `sprite` key on purpose — this style draws no icons or highway shields, so
 * it has no spritesheet dependency to break.
 */
export function lantageDarkStyle(pmtilesUrl: string): StyleSpec {
  return {
    version: 8,
    glyphs: PROTOMAPS_GLYPHS,
    sources: {
      [SOURCE]: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: PROTOMAPS_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': C.shell } },
      { id: 'earth', type: 'fill', source: SOURCE, 'source-layer': 'earth', paint: { 'fill-color': C.earth } },
      {
        id: 'landuse-green',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landuse',
        filter: [
          'in',
          ['get', 'kind'],
          ['literal', ['park', 'forest', 'wood', 'grass', 'garden', 'nature_reserve', 'cemetery', 'golf_course']],
        ],
        paint: { 'fill-color': C.green },
      },
      { id: 'water', type: 'fill', source: SOURCE, 'source-layer': 'water', paint: { 'fill-color': C.water } },
      {
        id: 'roads-minor',
        type: 'line',
        source: SOURCE,
        'source-layer': 'roads',
        minzoom: 11,
        filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'path']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.roadMinor,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0.3, 16, 2.2, 20, 8],
        },
      },
      {
        id: 'roads-major',
        type: 'line',
        source: SOURCE,
        'source-layer': 'roads',
        minzoom: 8,
        filter: ['==', ['get', 'kind'], 'major_road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.roadMajor,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 0.4, 16, 3.6, 20, 14],
        },
      },
      {
        id: 'roads-highway',
        type: 'line',
        source: SOURCE,
        'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'highway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.roadTrunk,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 5, 0.5, 16, 5.5, 20, 20],
        },
      },
      {
        /* Flat footprints. The pitched extrusion layer is added separately at
           z14+ by addBuildingExtrusion() so it can no-op on basemaps that have
           no building heights. */
        id: 'buildings',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'buildings',
        minzoom: 12,
        paint: {
          'fill-color': C.building,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 14, 1],
        },
      },
      {
        id: 'boundaries',
        type: 'line',
        source: SOURCE,
        'source-layer': 'boundaries',
        filter: ['in', ['get', 'kind'], ['literal', ['country', 'region', 'county']]],
        paint: { 'line-color': C.boundary, 'line-dasharray': [3, 2], 'line-width': 0.8 },
      },
      {
        id: 'places-neighbourhood',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'places',
        minzoom: 12,
        filter: ['in', ['get', 'kind'], ['literal', ['neighbourhood', 'macrohood']]],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.14,
        },
        paint: { 'text-color': C.labelSecondary, 'text-halo-color': C.halo, 'text-halo-width': 1.1 },
      },
      {
        id: 'places-locality',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'places',
        filter: ['in', ['get', 'kind'], ['literal', ['locality', 'region', 'country']]],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 12, 13],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.14,
        },
        paint: { 'text-color': C.labelPrimary, 'text-halo-color': C.halo, 'text-halo-width': 1.3 },
      },
    ],
  };
}

/** Whether the resolved basemap is the PMTiles one (drives the runtime fallback). */
export const usingPmtiles: boolean = PMTILES_URL.length > 0;

/** The style MapCanvas should boot with. */
export function resolveBasemapStyle(): MapStyle {
  return usingPmtiles ? lantageDarkStyle(PMTILES_URL) : OPENFREEMAP_DARK_STYLE;
}
