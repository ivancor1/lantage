/**
 * Verifier — biome / ecoregion soft mask.
 *
 * Interface plus a documented stub. Implemented last on purpose: it is the
 * weakest of the three verifiers (a temperate deciduous forest covers a third of
 * the northern hemisphere) and its only honest use is as a **soft mask** that
 * down-weights a candidate whose biome contradicts what is visibly growing in
 * the frame. It must never eliminate a candidate and must never seed one.
 *
 * Planned backend, in preference order:
 *
 *  1. **Köppen-Geiger 1km present-day raster** (Beck et al. 2018, CC-BY 4.0) —
 *     a single ~120MB GeoTIFF, 31 classes, trivially sampled by pixel lookup.
 *     Cheapest correct thing: convert to a PMTiles/COG on R2 next to the
 *     basemap and sample the one pixel under each candidate.
 *  2. **WWF Terrestrial Ecoregions of the World** (867 ecoregions, 14 biomes) as
 *     polygons in PostGIS, when a named ecoregion is wanted in the ledger rather
 *     than a climate class. One `ST_Contains` per candidate.
 *
 * Mapping VLM vegetation clues onto either taxonomy is the actual work here, and
 * it needs a hand-built lookup table plus a held-out evaluation before the mask
 * is allowed to move a score at all. Until that exists this returns
 * `not-configured` and the cascade records the skip.
 */

import type { Evidence, LatLon } from '@/lib/contracts/types';
import type { VlmClues } from '@/lib/contracts/schemas';
import { VERIFIERS } from '@/lib/cascade/config';
import { type WorkingCandidate, applyMultiplier } from '@/lib/cascade/candidate';
import {
  type Result,
  type StageContext,
  type StageFailure,
  type StageOutput,
  err,
  failure,
  skipped,
} from '@/lib/cascade/types';

export interface EcoregionSample {
  /** Köppen-Geiger class ("Dfb") or WWF ecoregion code. */
  code: string;
  name: string;
  /** Broad biome label the VLM's `environment` clues are matched against. */
  biome: string;
}

export interface EcoregionMask {
  readonly name: string;
  sample(p: LatLon): Promise<Result<EcoregionSample, StageFailure>>;
}

export const unconfiguredEcoregionMask: EcoregionMask = {
  name: 'ecoregion@unconfigured',
  async sample() {
    return err(
      failure(
        'not-configured',
        'No ecoregion raster is wired, so vegetation and terrain clues were recorded but not cross-checked. Planned backend: Köppen-Geiger 1km (CC-BY) sampled per candidate.',
      ),
    );
  },
};

export async function runEcoregionVerifier(args: {
  candidates: WorkingCandidate[];
  clues: VlmClues | null;
  mask: EcoregionMask;
  ctx: StageContext;
}): Promise<StageOutput<{ checked: number; conflicting: string[] }>> {
  const started = Date.now();
  const environment = args.clues?.environment ?? [];

  if (environment.length === 0) {
    return skipped(
      'verify-ecoregion',
      Date.now() - started,
      failure('no-input', 'No vegetation, terrain, or snow clues were extracted to cross-check.'),
    );
  }

  const evidence: Evidence[] = [];
  const conflicting: string[] = [];
  let checked = 0;

  for (const candidate of args.candidates) {
    const sample = await args.mask.sample(candidate.center);
    if (!sample.ok) {
      // One unconfigured/failed lookup means the mask is unavailable for all of
      // them; there is nothing to gain from repeating it per candidate.
      return skipped('verify-ecoregion', Date.now() - started, sample.error);
    }
    checked += 1;
    const conflict = environment.find(
      (clue) =>
        clue.legibility !== 'guessed' &&
        clue.impliesRegions.length > 0 &&
        !clue.impliesRegions.some((region) => matchesBiome(region, sample.value)),
    );
    if (!conflict) continue;

    const ev: Evidence = {
      kind: 'ecoregion',
      claim: `Visible environment ("${conflict.observed}") is not typical of ${sample.value.name} (${sample.value.code}), the climate class at this candidate.`,
      verifiable:
        'Look at the vegetation in the frame and compare it against the climate class named here; the raster version is listed in the result provenance so the same lookup can be repeated.',
      weight: 0.15,
    };
    candidate.evidence.push(ev);
    evidence.push(ev);
    applyMultiplier(candidate, VERIFIERS.ecoregionConflictPenalty);
    conflicting.push(candidate.id);
  }

  return {
    evidence,
    trace: { stage: 'verify-ecoregion', ranMs: Date.now() - started, costUsd: 0 },
    output: { checked, conflicting },
  };
}

/**
 * TODO: replace with the hand-built clue -> taxonomy table described above. The
 * substring test is a placeholder and is why this verifier stays unconfigured.
 */
function matchesBiome(region: string, sample: EcoregionSample): boolean {
  const needle = region.toLowerCase();
  return (
    sample.biome.toLowerCase().includes(needle) ||
    sample.name.toLowerCase().includes(needle) ||
    needle.includes(sample.biome.toLowerCase())
  );
}
