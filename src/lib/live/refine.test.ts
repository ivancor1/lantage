/**
 * REFINE + COVERAGE tests.
 *
 *   node --test src/lib/live/refine.test.ts
 *
 * These are the no-fabrication rules for stage 2, so most assertions are
 * negative:
 *
 *   - an UNBOUNDED refine is refused with a `policy` failure and never run;
 *   - with NO INDEX — the current state of this deployment — the result is
 *     well-formed, carries zero candidates and a stated reason, and nothing in
 *     it claims street precision;
 *   - a candidate whose evidence chain carries a `vpr-match` passes
 *     `assertStreetPrecisionIsEarned` and keeps `precision: 'street'`;
 *   - a candidate without one is REJECTED, not softened into a city-level
 *     result that inherits the street candidate's rank.
 *
 * No network, no API key, no database. Coverage, embedding and vector search are
 * stubs; the image is a synthetic PNG whose header carries real dimensions,
 * which is exactly what the quality gate reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from '@/lib/cascade/testing/aliasHooks';
import type * as Contracts from '@/lib/contracts/types';
import type * as CoverageModule from './coverage';
import type * as RefineModule from './refine';
import type { WorkingCandidate } from '@/lib/cascade/candidate';
import type { EmbedClient } from '@/lib/cascade/embedClient';
import type { GeoVectorHit, GeoVectorSearch } from '@/lib/cascade/vprRetrieval';
import type { QualityGate } from '@/lib/contracts/types';
import type { CoverageQuery } from './coverage';
import type { RefineBbox } from './contract';

// Relative and first: the hooks are what teach Node about the `@/` alias.
const hooksSpecifier = './../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const contracts = (await import('@/lib/contracts/types')) as typeof Contracts;
const {
  REFINE,
  cluesFromSignage,
  finaliseStreetCandidates,
  refineInRegion,
  resolveScope,
  vprMatchEvidence,
  LiveRefineRequestSchema,
} = (await import('./refine.ts')) as typeof RefineModule;
const { getCoverage, isStreetPrecisionAvailable, annotateRefinable, parseContentRangeTotal } =
  (await import('./coverage.ts')) as typeof CoverageModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A PNG whose IHDR carries real dimensions. `readImageHeader` reads width and
 * height from bytes 16..23 and the quality gate refuses anything under 2048
 * bytes, so the buffer is padded. Nothing here fakes a measurement.
 */
function png(width: number, height: number, byteLength = 8_192): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  writeU32(bytes, 16, width);
  writeU32(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** Pittsburgh's South Side, a ~9 km box. Real coordinates, no index behind them. */
const PITTSBURGH_BBOX: RefineBbox = [-80.02, 40.41, -79.95, 40.46];

const REGION = { candidateId: 'up-region-1', label: 'Pittsburgh', admin1: 'Pennsylvania', country: 'United States' };

const UPLOAD_ID = 'a'.repeat(64);

const frame = async (): Promise<{ bytes: Uint8Array; mime: string }> => ({
  bytes: png(1600, 1200),
  mime: 'image/png',
});

/** A coverage source that reports a real, counted number of rows. */
function stubCoverage(rows: number, metros: string[] = ['pittsburgh']): CoverageQuery {
  return {
    name: 'stub-index',
    async count() {
      return {
        ok: true,
        value: {
          rows,
          metros,
          indexBuilds: ['mapillary-pittsburgh@2026-08-02'],
          authoritative: true,
        },
      };
    },
  };
}

function stubEmbed(): EmbedClient {
  return {
    async embed() {
      return {
        ok: true,
        value: {
          embeddings: {
            eigenplaces: {
              vector: new Array(512).fill(0.04),
              dim: 512,
              model: 'eigenplaces',
              version: 'test',
            },
          },
          tookMs: 120,
        },
      };
    },
  };
}

function hit(overrides: Partial<GeoVectorHit> & { mapillaryId: string }): GeoVectorHit {
  return {
    lat: 40.4285,
    lon: -79.9805,
    similarity: 0.81,
    compassAngle: 214,
    thumbUrl: `https://images.mapillary.com/${overrides.mapillaryId}/thumb-2048.jpg`,
    ...overrides,
  };
}

function stubSearch(hits: GeoVectorHit[], onCall?: (bbox: readonly number[]) => void): GeoVectorSearch {
  return {
    async searchGeoCandidates({ bbox }) {
      onCall?.(bbox);
      return { ok: true, value: { hits, indexBuild: 'mapillary-pittsburgh@2026-08-02' } };
    },
  };
}

const PASSING_GATE: QualityGate = {
  passed: true,
  components: { resolutionPx: { w: 1600, h: 1200 } },
  degraded: false,
};

// ---------------------------------------------------------------------------
// 1. An unbounded refine is refused
// ---------------------------------------------------------------------------

test('a refine with no bbox is refused with a policy failure and never runs', async () => {
  let searched = false;
  const result = await refineInRegion(
    { uploadId: UPLOAD_ID, region: REGION },
    {
      readFrame: frame,
      coverage: stubCoverage(50_000),
      embed: stubEmbed(),
      search: stubSearch([hit({ mapillaryId: 'm1' })], () => {
        searched = true;
      }),
      geocoder: null,
      env: {},
    },
  );

  assert.equal(result.refusal?.kind, 'policy');
  assert.equal(result.candidates.length, 0);
  assert.match(result.refusal?.reason ?? '', /scoped/i);
  assert.equal(searched, false, 'an unscoped ANN query must never be issued');
});

test('resolveScope refuses inverted, out-of-range and planet-sized boxes', () => {
  assert.equal(resolveScope(undefined).ok, false);

  const inverted = resolveScope([-79.95, 40.46, -80.02, 40.41]);
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.equal(inverted.error.kind, 'policy');

  const outOfRange = resolveScope([-200, 40.41, -79.95, 40.46]);
  assert.equal(outOfRange.ok, false);

  // A bbox is not a prune just because it is a bbox.
  const planet = resolveScope([-180, -85, 180, 85]);
  assert.equal(planet.ok, false);
  if (!planet.ok) {
    assert.equal(planet.error.kind, 'policy');
    assert.match(planet.error.reason, /prunes nothing/i);
  }

  const scoped = resolveScope(PITTSBURGH_BBOX);
  assert.equal(scoped.ok, true);
});

test('the request schema requires a bbox — there is no unscoped default', () => {
  const missing = LiveRefineRequestSchema.safeParse({
    uploadId: UPLOAD_ID,
    region: { label: 'Pittsburgh' },
  });
  assert.equal(missing.success, false);

  const present = LiveRefineRequestSchema.safeParse({
    uploadId: UPLOAD_ID,
    region: { label: 'Pittsburgh' },
    bbox: PITTSBURGH_BBOX,
  });
  assert.equal(present.success, true);
});

// ---------------------------------------------------------------------------
// 2. No coverage -> zero candidates, a reason, and no street claim
// ---------------------------------------------------------------------------

test('with no index configured, coverage is unavailable and says so without throwing', async () => {
  // Exactly the current state of this deployment: no Supabase project at all.
  const info = await getCoverage(PITTSBURGH_BBOX, { env: {} });

  assert.equal(info.available, false);
  assert.equal(info.code, 'no-index-configured');
  assert.match(info.reason, /no index configured/i);
  // The gap has to name what would fix it, or the operator is stuck.
  assert.ok(info.gap);
  assert.match(info.gap?.envVar ?? '', /SUPABASE/);
  assert.match(info.gap?.howTo ?? '', /HARVEST/i);
  assert.equal(info.indexedImages, undefined, 'an unverified count must be absent, not zero');
});

test('a coverage source that throws degrades to unreachable rather than propagating', async () => {
  const info = await getCoverage(PITTSBURGH_BBOX, {
    env: {},
    query: {
      name: 'exploding-index',
      async count() {
        throw new Error('connection reset');
      },
    },
  });
  assert.equal(info.available, false);
  assert.equal(info.code, 'index-unreachable');
  assert.match(info.reason, /connection reset/);
});

test('zero rows read with a publishable key is unverifiable, NOT "no coverage"', async () => {
  // RLS grants SELECT on mapillary_images to `authenticated` only, so an anon
  // read of an empty table is indistinguishable from an empty table. Reporting
  // that as "nothing indexed here" would be a claim we cannot support.
  const info = await getCoverage(PITTSBURGH_BBOX, {
    env: {},
    query: {
      name: 'anon-index',
      async count() {
        return { ok: true, value: { rows: 0, metros: [], indexBuilds: [], authoritative: false } };
      },
    },
  });
  assert.equal(info.available, false);
  assert.equal(info.code, 'unverifiable');
  assert.match(info.reason, /SUPABASE_SECRET_KEY/);
});

test('an authoritative zero count IS reported as no coverage in the area', async () => {
  const info = await getCoverage(PITTSBURGH_BBOX, { env: {}, query: stubCoverage(0, []) });
  assert.equal(info.available, false);
  assert.equal(info.code, 'no-rows-in-area');
  assert.equal(info.indexedImages, 0);
});

test('coverage is only claimed when rows were actually counted', async () => {
  const info = await getCoverage(PITTSBURGH_BBOX, { env: {}, query: stubCoverage(23_711) });
  assert.equal(info.available, true);
  assert.equal(info.code, 'covered');
  assert.equal(info.indexedImages, 23_711);
  assert.deepEqual(info.metros, ['pittsburgh']);
  assert.equal(info.gap, undefined);
});

test('no coverage returns zero candidates, a stated reason, and no street precision', async () => {
  let embedded = false;
  let searched = false;

  const result = await refineInRegion(
    { uploadId: UPLOAD_ID, region: REGION, bbox: PITTSBURGH_BBOX },
    {
      readFrame: frame,
      // `null` forces the unconfigured path — what happens today.
      coverage: null,
      embed: {
        async embed() {
          embedded = true;
          throw new Error('must not be reached');
        },
      },
      search: stubSearch([hit({ mapillaryId: 'm1' })], () => {
        searched = true;
      }),
      geocoder: null,
      env: {},
    },
  );

  assert.equal(result.candidates.length, 0, 'no index means no street candidates');
  assert.equal(result.coverage.available, false);
  assert.match(result.coverage.reason, /no index configured/i);

  // The reason has to reach the operator through the result, not only the log.
  assert.ok(result.unavailable.length > 0);
  assert.match(result.unavailable[0].envVar ?? '', /SUPABASE/);
  const skipped = result.stages.find((s) => s.stage === 'vpr-retrieval');
  assert.ok(skipped?.skipped?.reason, 'the skipped retrieval stage must carry the reason');

  // Nothing was spent, and nothing was invented in place of a result.
  assert.equal(embedded, false, 'no embedding spend without coverage');
  assert.equal(searched, false, 'no ANN query without coverage');
  assert.equal(result.provenance.totalCostUsd, 0);

  // The load-bearing negative: no candidate anywhere claims street precision,
  // and no region-level guess was substituted for one.
  for (const candidate of result.candidates) {
    contracts.assertStreetPrecisionIsEarned(candidate);
    assert.notEqual(candidate.precision, 'street');
  }
});

test('coverage exists but nothing matches: still zero candidates, with a different reason', async () => {
  const result = await refineInRegion(
    { uploadId: UPLOAD_ID, region: REGION, bbox: PITTSBURGH_BBOX },
    {
      readFrame: frame,
      coverage: stubCoverage(23_711),
      embed: stubEmbed(),
      search: stubSearch([]),
      geocoder: null,
      env: {},
    },
  );

  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverage.available, true);
  const trace = result.stages.find((s) => s.stage === 'vpr-retrieval');
  assert.match(trace?.skipped?.reason ?? '', /none of them matched/i);
});

test('an unknown upload is a no-input refusal, not a coverage story', async () => {
  const result = await refineInRegion(
    { uploadId: UPLOAD_ID, region: REGION, bbox: PITTSBURGH_BBOX },
    { readFrame: async () => null, coverage: stubCoverage(1_000), env: {} },
  );
  assert.equal(result.refusal?.kind, 'no-input');
  assert.equal(result.candidates.length, 0);
});

test('a frame that fails the quality gate returns no ranking', async () => {
  const result = await refineInRegion(
    { uploadId: UPLOAD_ID, region: REGION, bbox: PITTSBURGH_BBOX },
    {
      // 120px long edge: below QUALITY.refuseLongEdgePx, so there is no
      // descriptor worth matching and we refuse rather than rank noise.
      readFrame: async () => ({ bytes: png(120, 90), mime: 'image/png' }),
      coverage: stubCoverage(23_711),
      embed: stubEmbed(),
      search: stubSearch([hit({ mapillaryId: 'm1' })]),
      env: {},
    },
  );
  assert.equal(result.refusal?.kind, 'quality-gate');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.quality.passed, false);
});

// ---------------------------------------------------------------------------
// 3. A vpr-match earns street precision
// ---------------------------------------------------------------------------

test('a candidate with a vpr-match passes assertStreetPrecisionIsEarned', () => {
  const evidence = vprMatchEvidence(
    hit({ mapillaryId: '1234567890', similarity: 0.84 }),
    REGION,
    [-80.02, 40.41, -79.95, 40.46],
  );

  assert.equal(evidence.kind, 'vpr-match');
  assert.equal(evidence.reference?.mapillaryId, '1234567890');
  assert.ok(evidence.verifiable.length > 0, 'evidence with no verifiable string is telemetry');

  const working: WorkingCandidate = {
    id: 'c1',
    center: { lat: 40.4285, lon: -79.9805 },
    radiusM: 140,
    precision: 'street',
    place: { label: '40.42850, -79.98050' },
    rawScore: 0.84,
    evidence: [evidence],
    calibrationSet: 'vprRetrieval',
    facts: { kind: 'retrieval-agreement', within: 3, of: 12, radiusM: 140 },
  };

  const { candidates, rejected } = finaliseStreetCandidates([working], PASSING_GATE);

  assert.equal(rejected.length, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].precision, 'street');
  assert.equal(candidates[0].rank, 1);
  assert.ok(candidates[0].radiusM > 0, 'a point estimate is a claim this product does not make');
  assert.ok(candidates[0].confidence.reason.length > 0, 'a band with no reason is not shippable');

  // The law, called directly.
  contracts.assertStreetPrecisionIsEarned(candidates[0]);
});

test('an end-to-end refine over a covered region returns cited street candidates', async () => {
  let scoped: readonly number[] = [];
  const result = await refineInRegion(
    { uploadId: UPLOAD_ID, region: REGION, bbox: PITTSBURGH_BBOX },
    {
      readFrame: frame,
      coverage: stubCoverage(23_711),
      embed: stubEmbed(),
      search: stubSearch(
        [
          hit({ mapillaryId: 'm1', similarity: 0.86 }),
          hit({ mapillaryId: 'm2', similarity: 0.81, lat: 40.42855, lon: -79.98045 }),
          hit({ mapillaryId: 'm3', similarity: 0.7, lat: 40.4402, lon: -79.9959 }),
        ],
        (bbox) => {
          scoped = bbox;
        },
      ),
      geocoder: null,
      env: {},
    },
  );

  // The bbox reached the ANN query as the prune, unchanged.
  assert.deepEqual([...scoped], [...PITTSBURGH_BBOX]);

  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.length <= REFINE.maxCandidates);
  assert.equal(result.provenance.indexBuild, 'mapillary-pittsburgh@2026-08-02');

  for (const candidate of result.candidates) {
    contracts.assertStreetPrecisionIsEarned(candidate);
    const match = candidate.evidence.find((e) => e.kind === 'vpr-match');
    assert.ok(match, 'every refine candidate must cite the image it matched');
    assert.ok(match?.reference?.mapillaryId, 'the citation must name the Mapillary image id');
    // Real coordinates from the hits, not a synthesised centre.
    assert.ok(Number.isFinite(candidate.center.lat) && Number.isFinite(candidate.center.lon));
  }

  // Ranks are dense and ordered.
  result.candidates.forEach((c, i) => assert.equal(c.rank, i + 1));
});

test('a legible sign from stage 1 corroborates a retrieval cluster', async () => {
  const result = await refineInRegion(
    {
      uploadId: UPLOAD_ID,
      region: REGION,
      bbox: PITTSBURGH_BBOX,
      signage: [{ observed: "SAM'S DINER", legibility: 'clear', kind: 'business-name' }],
    },
    {
      readFrame: frame,
      coverage: stubCoverage(23_711),
      embed: stubEmbed(),
      search: stubSearch([hit({ mapillaryId: 'm1', similarity: 0.66 })]),
      geocoder: {
        name: 'stub-gazetteer',
        async geocode() {
          // 30 m from the cluster centre: inside VERIFIERS.ocrAgreementRadiusM.
          return {
            ok: true,
            value: [{ label: "Sam's Diner, S 18th St, Pittsburgh", lat: 40.42877, lon: -79.9805 }],
          };
        },
      },
      env: {},
    },
  );

  assert.equal(result.candidates.length, 1);
  const kinds = result.candidates[0].evidence.map((e) => e.kind);
  assert.ok(kinds.includes('vpr-match'));
  assert.ok(kinds.includes('signage-ocr'), 'the agreeing geocode must be cited');
  // Two independent, non-circular signal types is what the contract calls
  // corroboration — and it is the only route to a 'high' band.
  assert.equal(result.candidates[0].precision, 'street');
  contracts.assertStreetPrecisionIsEarned(result.candidates[0]);
});

test('signage with no geocoder wired reports the gap instead of silently skipping', async () => {
  const result = await refineInRegion(
    {
      uploadId: UPLOAD_ID,
      region: REGION,
      bbox: PITTSBURGH_BBOX,
      signage: [{ observed: "SAM'S DINER", legibility: 'clear', kind: 'business-name' }],
    },
    {
      readFrame: frame,
      coverage: stubCoverage(23_711),
      embed: stubEmbed(),
      search: stubSearch([hit({ mapillaryId: 'm1' })]),
      geocoder: null,
      env: {},
    },
  );
  assert.ok(result.unavailable.some((g) => g.envVar === 'NOMINATIM_URL'));
});

// ---------------------------------------------------------------------------
// 4. A candidate without one is rejected
// ---------------------------------------------------------------------------

test('a candidate with no vpr-match or signage-ocr is rejected, not downgraded', () => {
  const working: WorkingCandidate = {
    id: 'c-unearned',
    center: { lat: 40.4285, lon: -79.9805 },
    radiusM: 140,
    precision: 'street',
    place: { label: 'somewhere on the South Side' },
    rawScore: 0.9,
    evidence: [
      {
        kind: 'vlm-clue',
        claim: 'buff-yellow brick rowhouses on a steep hillside',
        verifiable: 'Look at the frame and decide whether it shows this.',
        weight: 0.45,
      },
    ],
    calibrationSet: 'vlmClues',
    facts: { kind: 'vlm-clues', clueCount: 1, categories: 1 },
  };

  const { candidates, rejected } = finaliseStreetCandidates([working], PASSING_GATE);

  assert.equal(candidates.length, 0, 'inference alone cannot support a street candidate');
  assert.deepEqual(rejected, ['c-unearned']);
});

test('a rejected cluster is reported, and never inherits a surviving candidate rank', () => {
  const earned = vprMatchEvidence(hit({ mapillaryId: 'm1', similarity: 0.8 }), REGION, PITTSBURGH_BBOX);
  const good: WorkingCandidate = {
    id: 'good',
    center: { lat: 40.4285, lon: -79.9805 },
    radiusM: 140,
    precision: 'street',
    place: { label: 'a' },
    rawScore: 0.5,
    evidence: [earned],
    calibrationSet: 'vprRetrieval',
    facts: { kind: 'retrieval-agreement', within: 1, of: 2, radiusM: 140 },
  };
  const bad: WorkingCandidate = { ...good, id: 'bad', rawScore: 0.99, evidence: [] };

  const { candidates, rejected } = finaliseStreetCandidates([good, bad], PASSING_GATE);

  assert.deepEqual(rejected, ['bad']);
  assert.equal(candidates.length, 1);
  // `bad` outscored `good` and would have been rank 1. Dropping it must not
  // leave a hole or hand its rank to a candidate that did not earn it.
  assert.equal(candidates[0].id, 'good');
  assert.equal(candidates[0].rank, 1);
});

test('a degraded frame caps the band rather than the precision', () => {
  const degraded: QualityGate = {
    passed: true,
    components: { resolutionPx: { w: 500, h: 400 } },
    degraded: true,
    refusalReason: 'Degraded: 500px long edge is below the 640px recommended floor.',
  };
  const working: WorkingCandidate = {
    id: 'c1',
    center: { lat: 40.4285, lon: -79.9805 },
    radiusM: 140,
    precision: 'street',
    place: { label: 'a' },
    rawScore: 0.95,
    evidence: [vprMatchEvidence(hit({ mapillaryId: 'm1', similarity: 0.95 }), REGION, PITTSBURGH_BBOX)],
    calibrationSet: 'vprRetrieval',
    facts: { kind: 'retrieval-agreement', within: 5, of: 5, radiusM: 140 },
  };

  const { candidates } = finaliseStreetCandidates([working], degraded);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].confidence.band, 'weak');
  assert.equal(candidates[0].precision, 'street');
});

// ---------------------------------------------------------------------------
// The stage-1 "Refine in {region}" affordance
// ---------------------------------------------------------------------------

test('isStreetPrecisionAvailable is false with nothing configured', async () => {
  const available = await isStreetPrecisionAvailable(
    { center: { lat: 40.4406, lon: -79.9959 }, radiusM: 8_000 },
    { env: {} },
  );
  assert.equal(available, false);
});

test('annotateRefinable marks a region refinable only where rows were counted', async () => {
  const candidate = {
    id: 'up-region-1',
    rank: 1,
    center: { lat: 40.4406, lon: -79.9959 },
    radiusM: 8_000,
    precision: 'city' as const,
    place: { label: 'Pittsburgh' },
    confidence: { band: 'moderate' as const, score: 0.5, reason: 'x', calibration: 'y' },
    evidence: [
      { kind: 'vlm-clue' as const, claim: 'a', verifiable: 'b', weight: 0.4 },
    ] as Contracts.EvidenceChain,
    review: 'unreviewed' as const,
  };

  const withIndex = await annotateRefinable([candidate], { env: {}, query: stubCoverage(23_711) });
  assert.equal(withIndex.length, 1);
  assert.equal(withIndex[0].candidateId, 'up-region-1');
  assert.equal(withIndex[0].refinable, true);
  assert.deepEqual(withIndex[0].metros, ['pittsburgh']);
  // The bbox the UI must send back is scoped enough for `resolveScope` to accept.
  assert.equal(resolveScope(withIndex[0].bbox).ok, true);

  const without = await annotateRefinable([candidate], { env: {}, query: null });
  assert.equal(without[0].refinable, false);
  assert.match(without[0].reason, /no index configured/i);
});

// ---------------------------------------------------------------------------
// Small units
// ---------------------------------------------------------------------------

test('the exact row count is read from Content-Range, and an absent total is null', () => {
  assert.equal(parseContentRangeTotal('0-199/23711'), 23_711);
  assert.equal(parseContentRangeTotal('*/0'), 0);
  // No total means no verified count, which must never be read as zero.
  assert.equal(parseContentRangeTotal('0-199/*'), null);
  assert.equal(parseContentRangeTotal(null), null);
});

test('signage forwarded from stage 1 becomes text clues and nothing else', () => {
  const clues = cluesFromSignage([
    { observed: "SAM'S DINER", legibility: 'clear', kind: 'business-name' },
  ]);
  assert.equal(clues.text.length, 1);
  assert.equal(clues.text[0].observed, "SAM'S DINER");
  // Nothing is invented to fill the other buckets: a fabricated observation here
  // geocodes into a confident wrong address.
  assert.deepEqual(clues.infrastructure, []);
  assert.deepEqual(clues.environment, []);
  assert.deepEqual(clues.architecture, []);
  assert.deepEqual(clues.regionPrior, []);
});
