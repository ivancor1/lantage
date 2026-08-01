'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, RotateCcw, X } from 'lucide-react';
import type { GeoCandidate, ReviewState } from '@/lib/contracts/types';
import { Button } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { GlassCard } from '@/components/ui/GlassCard';
import { LeadDisclaimer } from '@/components/ui/LeadDisclaimer';
import { ReviewSelect } from '@/components/ui/ReviewSelect';
import { cx } from '@/components/ui/cx';
import { ABSENT, formatCoord, formatRadius } from './format';
import {
  GEOCODER_CONFIGURED,
  GEOCODER_ENV_VAR,
  StreetViewFrame,
  type StreetViewPosition,
} from './StreetViewFrame';

/**
 * Side-by-side verification: the operator's frame, and a live Street View they
 * can walk.
 *
 * The structure is the argument. The machine *proposes* — that is the "Original
 * result" card, fixed, with the coordinates the system actually returned. The
 * operator *navigates* — that is the panorama and the "Currently viewing" card,
 * which tracks wherever they have got to. Only when those two disagree does
 * "Update result" become pressable, and pressing it promotes the operator's view
 * to be the result. The verification is the navigation; the button is just where
 * it gets written down.
 *
 * Two consequences that must not be optimised away:
 *
 *   1. `originalResult` and `currentlyViewing` are separate state. Collapsing
 *      them into one "current location" destroys the only thing on screen that
 *      shows the machine was wrong and by how much.
 *   2. A promotion is an *operator assertion*, not a machine finding. It does
 *      not add evidence, it does not raise confidence, and it does not earn
 *      street precision — `assertStreetPrecisionIsEarned` still governs that.
 *      The card says so, because a promoted pin that looks like a match would be
 *      the most dangerous object in this product.
 *
 * Licensing: no panorama pixels are held anywhere here. What a promotion carries
 * is a pano ID and coordinates — pointers that re-fetch from Google on view.
 */

export interface PromotedLocation {
  lat: number;
  lon: number;
  /** Google pano ID for the view the operator promoted, when one was reported. */
  panoId?: string;
  /** Only when a geocoder was configured and named it. Never invented. */
  address?: string;
}

interface OriginalResult {
  lat: number;
  lon: number;
  label: string;
  sublabel?: string;
  radiusM: number;
  /** Set once the operator has promoted their own view over the proposal. */
  promoted?: PromotedLocation;
}

export interface StreetCompareProps {
  /** The full ranked set — the pager walks it. */
  candidates: readonly GeoCandidate[];
  index: number;
  onIndexChange: (next: number) => void;
  /** The operator's query image. Letterboxed, never cropped to fit. */
  queryImageUrl?: string;
  queryImageAlt?: string;
  review: ReviewState;
  onReview: (next: ReviewState) => void;
  /** Fires when the operator promotes the viewed location over the proposal. */
  onUpdateResult?: (candidateId: string, next: PromotedLocation) => void;
  onClose?: () => void;
  className?: string;
}

export function StreetCompare({
  candidates,
  index,
  onIndexChange,
  queryImageUrl,
  queryImageAlt,
  review,
  onReview,
  onUpdateResult,
  onClose,
  className,
}: StreetCompareProps) {
  const candidate = candidates[index];

  /* Keyed by candidate id so paging away and back does not silently discard a
     promotion the operator already made. */
  const [promotions, setPromotions] = useState<Record<string, PromotedLocation>>({});
  const [viewing, setViewing] = useState<StreetViewPosition | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const original: OriginalResult | null = useMemo(() => {
    if (!candidate) return null;
    const promoted = promotions[candidate.id];
    return {
      lat: promoted?.lat ?? candidate.center.lat,
      lon: promoted?.lon ?? candidate.center.lon,
      /* Once promoted, the machine's place label no longer describes these
         coordinates, and pairing the two would be a false statement about where
         that name is. With no geocoder there is no replacement name, so the
         card says what the row actually is instead of inventing one. */
      label: promoted
        ? (promoted.address ?? 'Operator-selected location')
        : candidate.place.label,
      sublabel:
        [candidate.place.admin1, candidate.place.country].filter(Boolean).join(' · ') || undefined,
      radiusM: candidate.radiusM,
      promoted,
    };
  }, [candidate, promotions]);

  /* Memoised: StreetViewFrame reports on every pan, and a fresh callback each
     render would churn its reporting effect. */
  const handlePositionChange = useCallback((next: StreetViewPosition) => {
    setViewing(next);
  }, []);

  function goTo(next: number) {
    if (next < 0 || next >= candidates.length || next === index) return;
    /* A new candidate is a new proposal, so the viewed location is no longer
       about anything. Clearing it is what keeps "Update result" from promoting
       one candidate's street onto another's. */
    setViewing(null);
    onIndexChange(next);
  }

  if (!candidate || !original) {
    return (
      <GlassCard className={cx('flex h-full flex-col items-center justify-center p-8', className)}>
        <Eyebrow mono>no candidate selected</Eyebrow>
      </GlassCard>
    );
  }

  /* Divergence is measured at the precision the screen prints — five decimals,
     about a metre (see formatCoord). So the button turns on exactly when the two
     cards stop reading the same, which is the only rule an operator can see. */
  const diverged =
    viewing !== null &&
    (formatCoord(viewing.lat) !== formatCoord(original.lat) ||
      formatCoord(viewing.lon) !== formatCoord(original.lon));

  function promote() {
    if (!viewing || !diverged) return;
    const next: PromotedLocation = {
      lat: viewing.lat,
      lon: viewing.lon,
      panoId: viewing.panoId,
      address: viewing.address,
    };
    setPromotions((prev) => ({ ...prev, [candidate.id]: next }));
    onUpdateResult?.(candidate.id, next);
  }

  return (
    <GlassCard className={cx('blur-in flex h-full flex-col overflow-hidden', className)}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 pb-3.5 pt-4">
        <div className="min-w-0">
          <Eyebrow mono>Verification · side by side</Eyebrow>
          <h2 className="mt-1.5 truncate text-[15px] text-fg">{candidate.place.label}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Eyebrow mono className="hidden rounded-full border border-border px-2 py-[3px] sm:block">
            {candidate.precision}
          </Eyebrow>
          {onClose ? (
            <Button variant="icon" onClick={onClose} aria-label="Close verification">
              <X aria-hidden className="size-4" />
            </Button>
          ) : null}
        </div>
      </header>

      {/* Scrolls on short/narrow viewports where the stacked panes plus the three
          cards do not fit; locked at wide sizes, where the whole point is that
          everything is visible at once. */}
      <div
        data-lenis-prevent
        className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden"
      >
        {/* The two panes. Equal width, both on true black, so the eye compares
            content rather than chrome. */}
        <div className="grid shrink-0 grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-2">
          <figure className="relative m-0 flex min-h-[240px] items-center justify-center overflow-hidden border-b border-border bg-[var(--map-shell)] lg:border-b-0 lg:border-r">
            <Eyebrow
              mono
              className="pointer-events-none absolute left-3 top-3 z-10 rounded-full bg-[#00000099] px-2 py-[3px]"
            >
              Query image
            </Eyebrow>
            {queryImageUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element -- a blob: object
                 URL or a local preview path for the operator's own file, neither of
                 which next/image accepts. */
              <img
                src={queryImageUrl}
                alt={queryImageAlt ?? 'The uploaded frame under verification'}
                /* Letterboxed: object-contain, never cover. Cropping the query
                   frame to fill would hide the part the operator is matching on. */
                className="block h-full max-h-full w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 p-6 text-center">
                <ImageOff aria-hidden className="size-4 text-n-400" />
                <Eyebrow mono className="text-n-400">
                  no query image supplied
                </Eyebrow>
              </div>
            )}
          </figure>

          <div className="relative min-h-[320px]">
            <Eyebrow
              mono
              className="pointer-events-none absolute left-3 top-3 z-20 rounded-full bg-[#00000099] px-2 py-[3px]"
            >
              Street view · live
            </Eyebrow>
            <StreetViewFrame
              position={{ lat: original.lat, lon: original.lon }}
              resetKey={resetKey}
              onPositionChange={handlePositionChange}
              label={`Street view near ${candidate.place.label}`}
            />
          </div>
        </div>

        {/* Original · currently viewing · pager. */}
        <div className="grid shrink-0 gap-3 border-t border-border p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <OriginalResultCard
            original={original}
            candidate={candidate}
            review={review}
            onReview={onReview}
            canUpdate={diverged}
            onUpdate={promote}
          />

          <CurrentlyViewingCard
            viewing={viewing}
            diverged={diverged}
            onReset={() => {
              setResetKey((n) => n + 1);
            }}
          />

          <Pager
            index={index}
            total={candidates.length}
            onPrev={() => goTo(index - 1)}
            onNext={() => goTo(index + 1)}
          />
        </div>
      </div>

      <footer className="shrink-0 border-t border-border px-5 py-3.5">
        <LeadDisclaimer />
      </footer>
    </GlassCard>
  );
}

/**
 * What the system proposed.
 *
 * Rendered on the raised neutral rather than on the deep surface, which is how a
 * dark-only monochrome system carries the light/dark pairing the reference gets
 * from a white card. A literal white card would be a second theme and a second
 * set of tokens; DESIGN_SYSTEM.md §1 does not have them and inventing them here
 * would be the first crack in a palette whose whole job is that colour means
 * something.
 */
function OriginalResultCard({
  original,
  candidate,
  review,
  onReview,
  canUpdate,
  onUpdate,
}: {
  original: OriginalResult;
  candidate: GeoCandidate;
  review: ReviewState;
  onReview: (next: ReviewState) => void;
  canUpdate: boolean;
  onUpdate: () => void;
}) {
  return (
    <section className="rounded-nested min-w-0 border border-border-strong bg-n-150 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow mono className="text-fg-secondary">
          Original result
        </Eyebrow>
        {original.promoted ? (
          <Eyebrow mono style={{ color: 'var(--color-caution)' }}>
            operator-updated
          </Eyebrow>
        ) : null}
      </div>

      <p className="mt-1.5 truncate text-[13px] text-fg" title={original.label}>
        {original.label}
      </p>
      {original.sublabel ? (
        <p className="mt-0.5 truncate text-[12px] text-fg-tertiary">{original.sublabel}</p>
      ) : null}

      <p className="tnum mt-1.5 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
        {formatCoord(original.lat)}, {formatCoord(original.lon)} · ±{formatRadius(original.radiusM)}
      </p>
      {original.promoted?.panoId ? (
        <Eyebrow mono className="tnum mt-0.5 block truncate text-n-400" title={original.promoted.panoId}>
          pano {original.promoted.panoId}
        </Eyebrow>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
        <ReviewSelect
          value={review}
          onChange={onReview}
          aria-label={`Disposition for ${candidate.place.label}`}
        />
        <Button variant="primary" onClick={onUpdate} disabled={!canUpdate} className="h-9 px-4 text-sm">
          Update result
        </Button>
      </div>

      <p className="mt-2 text-[12px] leading-snug text-fg-tertiary">
        {canUpdate
          ? 'Records the viewed location as an operator assertion. It adds no evidence and does not raise confidence.'
          : 'Enabled once the street view moves off the proposed coordinates.'}
      </p>
    </section>
  );
}

/** Wherever the operator has actually got to. Tracked separately, on purpose. */
function CurrentlyViewingCard({
  viewing,
  diverged,
  onReset,
}: {
  viewing: StreetViewPosition | null;
  diverged: boolean;
  onReset: () => void;
}) {
  return (
    <section className="rounded-nested min-w-0 border border-border bg-n-0 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow mono>Currently viewing</Eyebrow>
        {diverged ? (
          <Eyebrow mono style={{ color: 'var(--color-caution)' }}>
            moved
          </Eyebrow>
        ) : null}
      </div>

      {viewing ? (
        <>
          {viewing.address ? (
            <p className="mt-1.5 text-[13px] leading-snug text-fg">{viewing.address}</p>
          ) : (
            /* No geocoder, no address. The coordinates below stand alone rather
               than being dressed up with a nearby place name. */
            <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
              {GEOCODER_CONFIGURED
                ? 'No address available for this position.'
                : 'Coordinates only — no geocoder configured.'}
            </p>
          )}

          <p className="tnum mt-1.5 font-mono text-[10.5px] tracking-[0.04em] text-fg-secondary">
            {formatCoord(viewing.lat)}, {formatCoord(viewing.lon)}
          </p>
          <Eyebrow mono className="tnum mt-0.5 block truncate text-n-400" title={viewing.panoId}>
            pano {viewing.panoId ?? ABSENT}
          </Eyebrow>

          {!GEOCODER_CONFIGURED ? (
            <p className="mt-1.5">
              <span className="eyebrow-mono mr-1.5 text-n-400">set</span>
              <code className="rounded-sm border border-border bg-n-0 px-1.5 py-px font-mono text-[11px] text-fg-secondary">
                {GEOCODER_ENV_VAR}
              </code>
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
          Nothing reported yet. The panorama has not returned a position.
        </p>
      )}

      <div className="mt-3 border-t border-border pt-2.5">
        <Button variant="secondary" onClick={onReset} disabled={!diverged} className="h-9">
          <RotateCcw aria-hidden className="size-3.5" />
          Reset street view
        </Button>
      </div>
    </section>
  );
}

/** Walks the ranked set. Rank order is the result, so it stays navigable. */
function Pager({
  index,
  total,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <section className="rounded-nested flex items-center justify-between gap-3 border border-border bg-n-0 px-3.5 py-3 lg:flex-col lg:items-stretch lg:justify-center">
      <Eyebrow mono className="tnum whitespace-nowrap text-fg-secondary lg:text-center">
        Result {index + 1} of {total}
      </Eyebrow>
      <div className="flex items-center gap-2 lg:justify-center">
        <Button variant="icon" onClick={onPrev} disabled={index <= 0} aria-label="Previous result">
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button
          variant="icon"
          onClick={onNext}
          disabled={index >= total - 1}
          aria-label="Next result"
        >
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      </div>
    </section>
  );
}
