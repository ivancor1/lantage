/**
 * Geodesy helpers. Small, dependency-free, and pure so BENCH can test them.
 *
 * Bbox order is [west, south, east, north] everywhere — see `Bbox` in types.ts.
 */

import type { LatLon } from '@/lib/contracts/types';
import type { Bbox, RegionPrior } from './types';

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bboxFromCenterRadius(center: LatLon, radiusM: number): Bbox {
  const dLat = (radiusM / EARTH_RADIUS_M) / DEG;
  // Guard the pole singularity: cos(lat) -> 0 makes the longitude span explode.
  const cosLat = Math.max(0.01, Math.cos(center.lat * DEG));
  const dLon = dLat / cosLat;
  return [
    clampLon(center.lon - dLon),
    clampLat(center.lat - dLat),
    clampLon(center.lon + dLon),
    clampLat(center.lat + dLat),
  ];
}

export function padBbox(bbox: Bbox, padKm: number): Bbox {
  const dLat = (padKm * 1000 / EARTH_RADIUS_M) / DEG;
  const midLat = (bbox[1] + bbox[3]) / 2;
  const dLon = dLat / Math.max(0.01, Math.cos(midLat * DEG));
  return [
    clampLon(bbox[0] - dLon),
    clampLat(bbox[1] - dLat),
    clampLon(bbox[2] + dLon),
    clampLat(bbox[3] + dLat),
  ];
}

export function bboxContains(bbox: Bbox, p: LatLon): boolean {
  return p.lon >= bbox[0] && p.lon <= bbox[2] && p.lat >= bbox[1] && p.lat <= bbox[3];
}

/** Intersection, or null when the two priors disagree entirely. */
export function bboxIntersection(a: Bbox, b: Bbox): Bbox | null {
  const west = Math.max(a[0], b[0]);
  const south = Math.max(a[1], b[1]);
  const east = Math.min(a[2], b[2]);
  const north = Math.min(a[3], b[3]);
  if (west >= east || south >= north) return null;
  return [west, south, east, north];
}

export function bboxCenter(bbox: Bbox): LatLon {
  return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
}

/** Radius that covers the bbox from its centre. */
export function bboxRadiusM(bbox: Bbox): number {
  const c = bboxCenter(bbox);
  return haversineM(c, { lat: bbox[3], lon: bbox[2] });
}

export function weightedCentroid(points: Array<{ lat: number; lon: number; weight: number }>): LatLon {
  // 3-D mean so antimeridian-straddling sets don't average to the wrong hemisphere.
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (const p of points) {
    const w = Math.max(0, p.weight);
    if (w === 0) continue;
    const lat = p.lat * DEG;
    const lon = p.lon * DEG;
    x += w * Math.cos(lat) * Math.cos(lon);
    y += w * Math.cos(lat) * Math.sin(lon);
    z += w * Math.sin(lat);
    total += w;
  }
  if (total === 0) return { lat: 0, lon: 0 };
  x /= total;
  y /= total;
  z /= total;
  const hyp = Math.sqrt(x * x + y * y);
  return { lat: Math.atan2(z, hyp) / DEG, lon: Math.atan2(y, x) / DEG };
}

/** Largest pairwise distance in a point set, in km. Our multimodality measure. */
export function spreadKm(points: LatLon[]): number {
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      max = Math.max(max, haversineM(points[i], points[j]));
    }
  }
  return max / 1000;
}

/**
 * Precision label a radius can honestly support.
 *
 * Note this never returns 'street' — street precision is not a function of
 * radius, it is *earned* by a retrieval match or an OCR geocode. Callers set
 * 'street' explicitly and then submit to `assertStreetPrecisionIsEarned()`.
 */
export function precisionForRadius(radiusM: number): Exclude<RegionPrior['precision'], 'street'> {
  if (radiusM <= 15_000) return 'city';
  if (radiusM <= 200_000) return 'region';
  if (radiusM <= 1_500_000) return 'country';
  return 'continent';
}

/** Greedy single-link clustering. Cheap and adequate at annLimit=50. */
export function clusterByProximity<T extends LatLon>(
  items: T[],
  radiusM: number,
): Array<{ members: T[]; center: LatLon }> {
  const clusters: Array<{ members: T[]; center: LatLon }> = [];
  for (const item of items) {
    const hit = clusters.find((c) => haversineM(c.center, item) <= radiusM);
    if (hit) {
      hit.members.push(item);
      hit.center = weightedCentroid(hit.members.map((m) => ({ lat: m.lat, lon: m.lon, weight: 1 })));
    } else {
      clusters.push({ members: [item], center: { lat: item.lat, lon: item.lon } });
    }
  }
  return clusters;
}

function clampLat(v: number): number {
  return Math.max(-90, Math.min(90, v));
}

function clampLon(v: number): number {
  return Math.max(-180, Math.min(180, v));
}
