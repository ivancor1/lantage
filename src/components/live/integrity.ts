/**
 * The product invariants, applied to whatever the API actually returned.
 *
 * AGENTS.md is explicit: import the invariants, do not restate them. So these
 * helpers call the assertions in `src/lib/contracts/types.ts` and turn a thrown
 * Error into a string the panel can render. If the server ever hands back a
 * ranking behind a failed quality gate, or street precision with nothing in the
 * chain that could earn it, the operator sees the violation instead of a result
 * that looks fine.
 */

import {
  assertRefusalIsHonoured,
  assertStreetPrecisionIsEarned,
  type GeoCandidate,
  type ModuleId,
  type SearchResult,
} from '@/lib/contracts/types';
import type { Analysis } from './api';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the violation message when a refused run still carries a ranking.
 *
 * The adapter object exists only to reach the assertion, which reads just
 * `id`, `quality`, `geo`, `vehicles` and `corpusMatches`. The live module names
 * are a different union from the cascade's `ModuleId`, and none of the filler
 * below is ever rendered.
 */
export function refusalViolation(analysis: Analysis): string | null {
  const quality = analysis.quality;
  if (!quality) return null;
  const adapter: SearchResult = {
    id: analysis.id ?? 'live-run',
    module: 'GEO' as ModuleId,
    imageId: analysis.uploads[0]?.id ?? '',
    quality,
    geo: analysis.geo,
    vehicles: analysis.vehicles,
    stages: analysis.stages,
    provenance: { models: {}, totalCostUsd: 0 },
    createdAt: analysis.createdAt ?? '',
  };
  try {
    assertRefusalIsHonoured(adapter);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/** Returns the violation message when `precision: 'street'` was not earned. */
export function precisionViolation(candidate: GeoCandidate): string | null {
  try {
    assertStreetPrecisionIsEarned(candidate);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}
