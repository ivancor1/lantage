'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPinOff } from 'lucide-react';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';
import { formatCoord } from './format';

/**
 * A live, interactive Google Street View panorama.
 *
 * LICENSING — the constraint this file exists to respect.
 * Rendering Street View *live* through the official Maps JavaScript embed is
 * permitted; storing or caching the panorama pixels is not. Google's terms
 * forbid copying, scraping, pre-fetching, indexing or otherwise persisting
 * imagery served by the API. So this component holds **no imagery in state
 * beyond the live view** — there is no canvas read-back, no screenshot, no
 * blob, no `<img>` pointing at the Street View Static API — and the only thing
 * it ever hands upward or lets anything persist is a **pano ID** plus the
 * coordinates. A pano ID is a pointer that re-fetches from Google on every
 * view, which is exactly the relationship the licence requires.
 *
 * The second rule this file follows is the product's: with no key configured it
 * renders an honest, empty placeholder naming the variable to set. It never
 * shows a stand-in panorama, a stock photograph, or a map tile pretending to be
 * street imagery. An empty state must look empty.
 *
 * API shape verified against Google's live docs on 2026-07-31:
 *   - developers.google.com/maps/documentation/javascript/load-maps-js-api
 *   - developers.google.com/maps/documentation/javascript/streetview
 *   - developers.google.com/maps/documentation/javascript/reference/street-view
 *   - developers.google.com/maps/documentation/javascript/reference/geocoder
 *   - developers.google.com/maps/documentation/javascript/events (auth errors)
 */

/* Inlined by Next at build time from the literal reference below — do not
   rewrite these as dynamic lookups or they will be `undefined` in the browser. */
const MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

/**
 * Reverse geocoding is a separately-billed API that has to be enabled on the
 * same key, so its presence cannot be inferred from the key alone. The operator
 * declares it. Unset means we show coordinates and no address — never a guess.
 */
export const GEOCODER_ENV_VAR = 'NEXT_PUBLIC_GOOGLE_GEOCODING_ENABLED';
export const MAPS_KEY_ENV_VAR = 'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY';
export const GEOCODER_CONFIGURED = process.env.NEXT_PUBLIC_GOOGLE_GEOCODING_ENABLED === 'true';
export const STREET_VIEW_CONFIGURED = Boolean(MAPS_API_KEY);

// ---------------------------------------------------------------------------
// Minimal typings for the slice of the Maps JS API used here
// ---------------------------------------------------------------------------
//
// `@types/google.maps` is not a dependency and adding one for four interfaces
// is not worth the supply chain. These mirror the reference documentation cited
// above; anything not declared here is not called.

interface GLatLng {
  lat(): number;
  lng(): number;
}

interface GPov {
  heading: number;
  pitch: number;
}

interface GMapsEventListener {
  remove(): void;
}

interface GStreetViewPanoramaOptions {
  position?: { lat: number; lng: number };
  pov?: GPov;
  zoom?: number;
  visible?: boolean;
  addressControl?: boolean;
  linksControl?: boolean;
  panControl?: boolean;
  zoomControl?: boolean;
  fullscreenControl?: boolean;
  imageDateControl?: boolean;
  motionTracking?: boolean;
  motionTrackingControl?: boolean;
  enableCloseButton?: boolean;
  clickToGo?: boolean;
  scrollwheel?: boolean;
  showRoadLabels?: boolean;
  controlSize?: number;
}

interface GStreetViewPanorama {
  getPosition(): GLatLng | null;
  getPano(): string;
  getPov(): GPov;
  setPosition(latLng: { lat: number; lng: number }): void;
  setPov(pov: GPov): void;
  addListener(eventName: string, handler: () => void): GMapsEventListener;
}

interface GGeocoderResult {
  formatted_address?: string;
}

interface GGeocoder {
  geocode(request: { location: { lat: number; lng: number } }): Promise<{ results: GGeocoderResult[] }>;
}

interface GoogleMapsNamespace {
  StreetViewPanorama: new (
    container: HTMLElement,
    options?: GStreetViewPanoramaOptions,
  ) => GStreetViewPanorama;
  Geocoder: new () => GGeocoder;
}

declare global {
  interface Window {
    google?: { maps?: GoogleMapsNamespace };
    __lantageGoogleMapsReady?: () => void;
    /** Google's documented hook for key / billing / referrer failures. */
    gm_authFailure?: () => void;
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const READY_CALLBACK = '__lantageGoogleMapsReady';

const AUTH_FAILURE_MESSAGE =
  'Google rejected the key. gm_authFailure fired, which means the Maps JavaScript API is not enabled on it, ' +
  'billing is off, or this origin is outside the key restrictions. No panorama is shown.';

/* The API refuses to load twice on a page, so the promise is module-scoped and
   shared by every frame the operator opens. */
let loader: Promise<GoogleMapsNamespace> | null = null;
let authFailed = false;
const authSubscribers = new Set<(message: string) => void>();

function loadMapsApi(apiKey: string): Promise<GoogleMapsNamespace> {
  if (loader) return loader;

  loader = new Promise<GoogleMapsNamespace>((resolve, reject) => {
    const already = window.google?.maps;
    if (already) {
      resolve(already);
      return;
    }

    window.gm_authFailure = () => {
      authFailed = true;
      for (const notify of authSubscribers) notify(AUTH_FAILURE_MESSAGE);
    };

    /* Dynamic library import. `libraries` is requested up front rather than via
       importLibrary() so a single network round trip covers both, and the
       documented `callback` parameter is what makes `loading=async` legal. */
    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      loading: 'async',
      libraries: GEOCODER_CONFIGURED ? 'streetView,geocoding' : 'streetView',
      callback: READY_CALLBACK,
    });

    window[READY_CALLBACK] = () => {
      const maps = window.google?.maps;
      if (maps) resolve(maps);
      else reject(new Error('maps.googleapis.com loaded but exposed no google.maps namespace.'));
    };

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      reject(
        new Error(
          'maps.googleapis.com could not be reached. Street View needs outbound network access from the browser.',
        ),
      );
    };
    document.head.append(script);
  });

  return loader;
}

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Where the operator is currently looking.
 *
 * `address` is present only when a geocoder was configured AND returned one.
 * There is no fallback string: a location we cannot name stays unnamed.
 */
export interface StreetViewPosition {
  lat: number;
  lon: number;
  /** Google panorama id. The only imagery identifier that may be persisted. */
  panoId?: string;
  heading?: number;
  pitch?: number;
  address?: string;
}

export interface StreetViewFrameProps {
  /** Where the panorama opens, and where `resetKey` sends it back to. */
  position: { lat: number; lon: number };
  /** Change this value to return the panorama to `position`. */
  resetKey?: number;
  /** Fires on every pan, step and re-geocode. Memoise it in the parent. */
  onPositionChange?: (next: StreetViewPosition) => void;
  /** Accessible name for the panorama region. */
  label?: string;
  className?: string;
}

type FrameStatus = 'unconfigured' | 'loading' | 'ready' | 'failed';

interface ViewState {
  lat: number;
  lon: number;
  panoId?: string;
  heading?: number;
  pitch?: number;
}

/**
 * The outcome of one reverse geocode, tagged with the view it belongs to.
 *
 * Only outcomes are stored — "pending" is derived from `panoKey` not yet having
 * one — so nothing is ever attributed to a position the operator has already
 * left, and an address never survives a move.
 */
interface GeocodeOutcome {
  panoKey: string;
  /** Absent when the geocoder returned no result. Never filled in. */
  address?: string;
  /** The geocoder's own message. REQUEST_DENIED usually means API not enabled. */
  error?: string;
}

export function StreetViewFrame({
  position,
  resetKey = 0,
  onPositionChange,
  label = 'Street View',
  className,
}: StreetViewFrameProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panoramaRef = useRef<GStreetViewPanorama | null>(null);
  /* Held in a ref so a parent that re-creates the callback each render cannot
     retrigger the reporting effect and loop. */
  const reportRef = useRef(onPositionChange);
  const geocoderRef = useRef<GGeocoder | null>(null);
  /* Captured once: the panorama is constructed a single time and afterwards
     moved with setPosition(), so the constructor must not depend on later props. */
  const openAtRef = useRef({ lat: position.lat, lon: position.lon });

  const [status, setStatus] = useState<FrameStatus>(
    MAPS_API_KEY ? 'loading' : 'unconfigured',
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [coverage, setCoverage] = useState<'unknown' | 'present' | 'none'>('unknown');
  const [geocode, setGeocode] = useState<GeocodeOutcome | null>(null);

  useEffect(() => {
    reportRef.current = onPositionChange;
  }, [onPositionChange]);

  // Construct the panorama. Runs once; movement is handled by the effect below.
  useEffect(() => {
    if (!MAPS_API_KEY) return;

    let cancelled = false;
    const listeners: GMapsEventListener[] = [];
    const notifyAuthFailure = (message: string) => {
      if (cancelled) return;
      setStatus('failed');
      setFailure(message);
    };
    authSubscribers.add(notifyAuthFailure);
    if (authFailed) notifyAuthFailure(AUTH_FAILURE_MESSAGE);

    loadMapsApi(MAPS_API_KEY)
      .then((maps) => {
        const container = containerRef.current;
        if (cancelled || !container) return;

        const panorama = new maps.StreetViewPanorama(container, {
          position: { lat: openAtRef.current.lat, lng: openAtRef.current.lon },
          pov: { heading: 0, pitch: 0 },
          visible: true,
          /* Google's own address plate is suppressed: "currently viewing" is a
             first-class card in StreetCompare, and two disagreeing addresses on
             one screen is worse than one. Navigation controls stay — the whole
             point of this surface is that the operator can walk the street. */
          addressControl: false,
          linksControl: true,
          panControl: true,
          zoomControl: true,
          clickToGo: true,
          imageDateControl: true,
          showRoadLabels: true,
          fullscreenControl: false,
          motionTracking: false,
          motionTrackingControl: false,
          enableCloseButton: false,
        });
        panoramaRef.current = panorama;

        const read = () => {
          const at = panorama.getPosition();
          if (!at) {
            setCoverage('none');
            return;
          }
          const pov = panorama.getPov();
          const panoId = panorama.getPano() || undefined;
          const next: ViewState = {
            lat: at.lat(),
            lon: at.lng(),
            panoId,
            heading: pov?.heading,
            pitch: pov?.pitch,
          };
          setCoverage('present');
          /* pov_changed fires continuously while the operator drags. Returning
             the previous object when nothing actually moved keeps the identity
             stable, so the report effect below does not fire on every frame. */
          setView((prev) =>
            prev &&
            prev.lat === next.lat &&
            prev.lon === next.lon &&
            prev.panoId === next.panoId &&
            prev.heading === next.heading &&
            prev.pitch === next.pitch
              ? prev
              : next,
          );
        };

        listeners.push(panorama.addListener('position_changed', read));
        listeners.push(panorama.addListener('pov_changed', read));
        listeners.push(panorama.addListener('pano_changed', read));
        setStatus('ready');
        read();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus('failed');
        setFailure(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      authSubscribers.delete(notifyAuthFailure);
      for (const listener of listeners) listener.remove();
      panoramaRef.current = null;
    };
  }, []);

  /* Re-seat the panorama when the proposed result changes, or on reset.
     `status` is a dependency so a candidate switched while the API was still
     loading is applied once the panorama exists. */
  useEffect(() => {
    const panorama = panoramaRef.current;
    if (!panorama) return;
    panorama.setPosition({ lat: position.lat, lng: position.lon });
  }, [position.lat, position.lon, resetKey, status]);

  // Reverse geocode, only when the operator has said the geocoder is enabled.
  const panoKey = view ? (view.panoId ?? `${view.lat},${view.lon}`) : null;
  useEffect(() => {
    if (!GEOCODER_CONFIGURED || !view || !panoKey) return;

    let cancelled = false;
    const maps = window.google?.maps;
    if (!maps) return;
    geocoderRef.current ??= new maps.Geocoder();

    geocoderRef.current
      .geocode({ location: { lat: view.lat, lng: view.lon } })
      .then((response) => {
        if (cancelled) return;
        /* No result is a result. It is recorded as such rather than papered over
           with whatever else came back in the list. */
        setGeocode({ panoKey, address: response.results?.[0]?.formatted_address });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGeocode({
          panoKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
    // `view.lat`/`view.lon` are covered by `panoKey`, which changes with them.
  }, [panoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report upward. Primitive deps only, so an unmemoised parent cannot loop.
  const current = geocode && geocode.panoKey === panoKey ? geocode : null;
  const resolvedAddress = current?.address;
  useEffect(() => {
    if (!view) return;
    reportRef.current?.({
      lat: view.lat,
      lon: view.lon,
      panoId: view.panoId,
      heading: view.heading,
      pitch: view.pitch,
      address: resolvedAddress,
    });
  }, [view, resolvedAddress]);

  return (
    <div
      className={cx(
        'relative isolate h-full w-full overflow-hidden',
        /* True black, like the query pane beside it — the two panes read as one
           instrument rather than two widgets. */
        'bg-[var(--map-shell)]',
        className,
      )}
    >
      {status === 'ready' ? null : (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
          {status === 'unconfigured' ? (
            <MissingKey />
          ) : status === 'failed' ? (
            <FrameNotice title="street view unavailable" body={failure ?? 'The panorama did not load.'} tone="alert" />
          ) : (
            <Eyebrow mono className="shimmer">
              loading street view
            </Eyebrow>
          )}
        </div>
      )}

      {/* The live panorama. Nothing is ever read back out of this element. */}
      <div
        ref={containerRef}
        role="application"
        aria-label={label}
        className="absolute inset-0"
      />

      {status === 'ready' && coverage === 'none' ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--map-shell)] p-6">
          <FrameNotice
            title="no coverage"
            body={`Google returned no panorama at ${formatCoord(position.lat)}, ${formatCoord(position.lon)}. Nothing is shown in its place.`}
            tone="neutral"
          />
        </div>
      ) : null}

      {status === 'ready' && current?.error ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 border-t border-border bg-[var(--glass-1)] px-3 py-2">
          <Eyebrow mono className="block" style={{ color: 'var(--color-caution)' }}>
            reverse geocode failed
          </Eyebrow>
          {/* The geocoder's own words, unedited. */}
          <p className="mt-1 text-[12px] leading-snug text-fg-secondary">{current.error}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The no-key state. It names the variable and shows nothing else — no map, no
 * blurred stand-in, no sample street. This is the same contract the rest of the
 * product keeps with `CapabilityGap`.
 */
function MissingKey() {
  return (
    <div className="max-w-[36ch] text-center">
      <MapPinOff aria-hidden className="mx-auto size-4 text-n-400" />
      <Eyebrow mono className="mt-3 block">
        street view not configured
      </Eyebrow>
      <p className="mt-2 text-[12px] leading-snug text-fg-secondary">
        No panorama is shown, and none is substituted.
      </p>
      <p className="mt-2.5">
        <span className="eyebrow-mono mr-1.5 text-n-400">set</span>
        <code className="rounded-sm border border-border bg-n-0 px-1.5 py-px font-mono text-[11px] text-fg">
          {MAPS_KEY_ENV_VAR}
        </code>
      </p>
      <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
        Enable the Maps JavaScript API on the key, then restart the dev server.
      </p>
    </div>
  );
}

function FrameNotice({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: 'neutral' | 'alert';
}) {
  return (
    <div className="max-w-[46ch] text-center">
      <Eyebrow
        mono
        className="block"
        style={tone === 'alert' ? { color: 'var(--color-alert)' } : undefined}
      >
        {title}
      </Eyebrow>
      <p className="mt-2 text-[12px] leading-snug text-fg-secondary">{body}</p>
    </div>
  );
}
