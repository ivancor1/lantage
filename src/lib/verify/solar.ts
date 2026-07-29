/**
 * Verifier — the ShadowFinder constraint (Bellingcat, MIT licence).
 *
 * **This is a verifier, not a solver, and the distinction is the whole point.**
 *
 * A shadow-to-height ratio gives the sun's elevation angle. Elevation alone is
 * satisfied by a two-parameter family of (latitude, date, time) triples: the same
 * 40° elevation happens at some hour on some day almost everywhere on Earth. So
 * with a ratio and no timestamp, latitude is **jointly underdetermined** and this
 * module returns "no constraint". It does not guess, and it never seeds a search.
 *
 * With a timestamp the geometry closes: at a known UTC instant the sun is
 * directly overhead exactly one point (the subsolar point), and the set of places
 * seeing a given elevation θ is the small circle at angular radius (90° - θ) from
 * it — ShadowFinder's ring. That constrains, and constraining existing candidates
 * up or down is all this module is allowed to do.
 *
 * Solar position uses the NOAA general solar-position equations (fractional-year
 * form), accurate to well under a degree over our date range — far tighter than
 * the several degrees of error in reading a shadow ratio off a photograph.
 */

import type { Evidence, LatLon } from '@/lib/contracts/types';
import { VERIFIERS } from '@/lib/cascade/config';
import { type WorkingCandidate, applyMultiplier } from '@/lib/cascade/candidate';
import { type StageContext, type StageOutput, failure, skipped } from '@/lib/cascade/types';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Solar position
// ---------------------------------------------------------------------------

export interface SubsolarPoint {
  /** Solar declination, degrees. */
  lat: number;
  /** Longitude where it is solar noon at this instant, degrees. */
  lon: number;
  /** Equation of time, minutes. Exposed so the calculation is reproducible. */
  equationOfTimeMin: number;
}

/** NOAA fractional-year decomposition, shared by declination and eq. of time. */
function fractionalYearRad(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000) + 1;
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const daysInYear = isLeap(date.getUTCFullYear()) ? 366 : 365;
  return ((2 * Math.PI) / daysInYear) * (dayOfYear - 1 + (hour - 12) / 24);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function solarDeclinationDeg(date: Date): number {
  const g = fractionalYearRad(date);
  const rad =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  return rad / DEG;
}

export function equationOfTimeMin(date: Date): number {
  const g = fractionalYearRad(date);
  return (
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g))
  );
}

export function subsolarPoint(date: Date): SubsolarPoint {
  const eot = equationOfTimeMin(date);
  const minutesUtc =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  // Solar noon at longitude L when: minutesUtc + eot + 4L = 720.
  let lon = (720 - minutesUtc - eot) / 4;
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return { lat: solarDeclinationDeg(date), lon, equationOfTimeMin: eot };
}

/** Solar elevation above the horizon, degrees. Negative below it. */
export function solarElevationDeg(date: Date, p: LatLon): number {
  const decl = solarDeclinationDeg(date) * DEG;
  const eot = equationOfTimeMin(date);
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = minutesUtc + eot + 4 * p.lon;
  const hourAngle = (trueSolarTime / 4 - 180) * DEG;
  const lat = p.lat * DEG;
  const cosZenith =
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / DEG;
}

/** Solar azimuth, degrees clockwise from true north. */
export function solarAzimuthDeg(date: Date, p: LatLon): number {
  const decl = solarDeclinationDeg(date) * DEG;
  const eot = equationOfTimeMin(date);
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = minutesUtc + eot + 4 * p.lon;
  const hourAngleDeg = trueSolarTime / 4 - 180;
  const hourAngle = hourAngleDeg * DEG;
  const lat = p.lat * DEG;
  const cosZenith = Math.max(
    -1,
    Math.min(1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)),
  );
  const zenith = Math.acos(cosZenith);
  const sinZenith = Math.sin(zenith);
  if (Math.abs(sinZenith) < 1e-9) return 180; // Sun at the zenith: azimuth undefined.
  const cosAz = (Math.sin(decl) - Math.sin(lat) * cosZenith) / (Math.cos(lat) * sinZenith);
  const az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / DEG;
  return hourAngleDeg > 0 ? 360 - az : az;
}

/** Elevation implied by a shadow length / object height ratio. */
export function elevationFromShadowRatio(ratio: number): number | undefined {
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  return Math.atan(1 / ratio) / DEG;
}

// ---------------------------------------------------------------------------
// The constraint
// ---------------------------------------------------------------------------

export interface SolarObservation {
  shadowsVisible?: boolean;
  shadowToHeightRatio?: number;
  /** Compass bearing the shadow points toward, degrees. */
  shadowAzimuthDeg?: number;
  /** Claimed or known capture time, ISO 8601. Without it there is no constraint. */
  capturedAt?: string;
}

export type SolarConstraint =
  | { constrained: false; reason: string }
  | {
      constrained: true;
      /** Solar elevation implied by the shadow, degrees. */
      elevationDeg: number;
      toleranceDeg: number;
      instant: string;
      subsolar: SubsolarPoint;
      /** Latitudes the ring can reach, degrees. Descriptive: only one longitude per latitude works. */
      latitudeBandDeg: [number, number];
      /** Solar azimuth implied by the shadow bearing, if one was given. */
      solarAzimuthDeg?: number;
    };

/** Azimuth read off a photograph is coarse; this is the tolerance it earns. */
const AZIMUTH_TOLERANCE_DEG = 20;

export function buildSolarConstraint(
  obs: SolarObservation,
  toleranceDeg: number = VERIFIERS.solarToleranceDeg,
): SolarConstraint {
  if (obs.shadowsVisible === false) {
    return { constrained: false, reason: 'No shadows are visible in the frame.' };
  }
  const elevationDeg = obs.shadowToHeightRatio
    ? elevationFromShadowRatio(obs.shadowToHeightRatio)
    : undefined;
  if (elevationDeg === undefined) {
    return {
      constrained: false,
      reason:
        'No usable shadow-to-height ratio was measured, so no solar constraint could be computed.',
    };
  }
  if (!obs.capturedAt) {
    return {
      constrained: false,
      reason:
        'A shadow ratio without a capture time constrains nothing: latitude, date and time of day are jointly underdetermined, and the same solar elevation occurs at some hour on some day at almost every latitude. No constraint applied.',
    };
  }
  const date = new Date(obs.capturedAt);
  if (Number.isNaN(date.getTime())) {
    return { constrained: false, reason: 'The supplied capture time is not a valid timestamp.' };
  }

  const subsolar = subsolarPoint(date);
  // The ring of places seeing elevation θ sits at angular radius (90 - θ) from
  // the subsolar point, so it spans declination ± that radius in latitude.
  const radius = 90 - Math.max(0, elevationDeg - toleranceDeg);
  const band: [number, number] = [
    Math.max(-90, subsolar.lat - radius),
    Math.min(90, subsolar.lat + radius),
  ];

  const solarAz =
    obs.shadowAzimuthDeg === undefined ? undefined : (obs.shadowAzimuthDeg + 180) % 360;

  return {
    constrained: true,
    elevationDeg,
    toleranceDeg,
    instant: date.toISOString(),
    subsolar,
    latitudeBandDeg: band,
    ...(solarAz === undefined ? {} : { solarAzimuthDeg: solarAz }),
  };
}

export interface SolarCheck {
  consistent: boolean;
  computedElevationDeg: number;
  deltaDeg: number;
  azimuthDeltaDeg?: number;
}

export function checkCandidate(constraint: SolarConstraint, p: LatLon): SolarCheck | null {
  if (!constraint.constrained) return null;
  const date = new Date(constraint.instant);
  const computed = solarElevationDeg(date, p);
  const delta = Math.abs(computed - constraint.elevationDeg);
  let azimuthDelta: number | undefined;
  if (constraint.solarAzimuthDeg !== undefined) {
    const computedAz = solarAzimuthDeg(date, p);
    azimuthDelta = Math.abs(angleDelta(computedAz, constraint.solarAzimuthDeg));
  }
  const consistent =
    delta <= constraint.toleranceDeg &&
    (azimuthDelta === undefined || azimuthDelta <= AZIMUTH_TOLERANCE_DEG);
  return {
    consistent,
    computedElevationDeg: computed,
    deltaDeg: delta,
    ...(azimuthDelta === undefined ? {} : { azimuthDeltaDeg: azimuthDelta }),
  };
}

function angleDelta(a: number, b: number): number {
  const d = ((a - b + 540) % 360) - 180;
  return d;
}

// ---------------------------------------------------------------------------
// Stage wrapper
// ---------------------------------------------------------------------------

export interface SolarVerifierResult {
  constraint: SolarConstraint;
  consistent: string[];
  conflicting: string[];
}

/**
 * Re-ranks existing candidates only. Note there is no code path here that
 * appends to `candidates` — the solar constraint is a filter over hypotheses
 * someone else produced, and if it could seed, a shadow in a featureless field
 * would become a location.
 */
export async function runSolarVerifier(args: {
  candidates: WorkingCandidate[];
  observation: SolarObservation;
  ctx: StageContext;
}): Promise<StageOutput<SolarVerifierResult>> {
  const started = Date.now();
  const constraint = buildSolarConstraint(args.observation);

  if (!constraint.constrained) {
    return skipped('verify-solar', Date.now() - started, failure('no-input', constraint.reason));
  }
  if (args.candidates.length === 0) {
    return skipped(
      'verify-solar',
      Date.now() - started,
      failure('no-input', 'No candidates to constrain. The solar verifier never seeds a search.'),
    );
  }

  const evidence: Evidence[] = [];
  const result: SolarVerifierResult = { constraint, consistent: [], conflicting: [] };

  for (const candidate of args.candidates) {
    const check = checkCandidate(constraint, candidate.center);
    if (!check) continue;
    const ev = solarEvidence(constraint, check, candidate.center);
    candidate.evidence.push(ev);
    evidence.push(ev);
    if (check.consistent) {
      result.consistent.push(candidate.id);
    } else {
      applyMultiplier(candidate, VERIFIERS.solarConflictPenalty);
      result.conflicting.push(candidate.id);
    }
  }

  return {
    evidence,
    trace: { stage: 'verify-solar', ranMs: Date.now() - started, costUsd: 0 },
    output: result,
  };
}

function solarEvidence(
  constraint: Extract<SolarConstraint, { constrained: true }>,
  check: SolarCheck,
  p: LatLon,
): Evidence {
  const verdict = check.consistent ? 'consistent with' : 'inconsistent with';
  return {
    kind: 'solar',
    claim: `Shadow geometry implies a solar elevation of ${constraint.elevationDeg.toFixed(1)}°. At ${constraint.instant} this location would see ${check.computedElevationDeg.toFixed(1)}° — ${verdict} the observation (±${constraint.toleranceDeg}°).`,
    verifiable: `Reproduce it independently: Bellingcat's ShadowFinder (MIT) takes the same shadow-to-height ratio and timestamp and draws the band of possible locations. The subsolar point at this instant is ${constraint.subsolar.lat.toFixed(2)}, ${constraint.subsolar.lon.toFixed(2)}, and the constraint depends entirely on the capture time being true — if the timestamp is wrong, discard this line.`,
    reference: {
      label: `solar elevation at ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`,
      url: 'https://github.com/bellingcat/ShadowFinder',
    },
    // A constraint is worth less than a match: it excludes, it does not identify.
    weight: check.consistent ? 0.25 : 0.15,
  };
}
