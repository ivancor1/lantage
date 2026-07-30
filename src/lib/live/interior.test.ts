/**
 * INTERIOR tests.
 *
 *   node --test src/lib/live/interior.test.ts
 *
 * The invariants being pinned here are the ones that make the module honest
 * rather than impressive:
 *
 *   - nothing it returns can claim street precision, with or without a
 *     provenance hit;
 *   - a clue set with no country signal produces no candidates at all, not weak
 *     ones;
 *   - a region the model proposed but did not cite from its own observations is
 *     discarded (the documented VLM failure mode);
 *   - a missing key produces a named `CapabilityGap`, never a placeholder result;
 *   - the response always states in words whether the image is resolvable to a
 *     building.
 *
 * `@/lib/live/vision` (L1's provider selector) is stubbed by a loader hook: this
 * module injects its own provider, so the unit under test must not depend on
 * another agent's module being present or on its selection behaviour.
 */

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import test from 'node:test';
import type * as AliasHooks from '@/lib/cascade/testing/aliasHooks';
import type { VlmClues } from '@/lib/contracts/schemas';
import type { GeoCandidate, QualityGate } from '@/lib/contracts/types';
import type { ProvenanceHit } from './contract';
import type * as InteriorModule from './interior';
import type * as ProvenanceModule from './provenance';

// ---------------------------------------------------------------------------
// Loader setup
// ---------------------------------------------------------------------------

type NextResolve = (specifier: string, context: unknown) => unknown;
interface ModuleHooksApi {
  registerHooks(hooks: {
    resolve?: (specifier: string, context: unknown, next: NextResolve) => unknown;
  }): void;
}

/** Data URL so the stub needs no file on disk that L1 might be writing to. */
const VISION_STUB_URL = 'data:text/javascript,export function selectProvider(){return null}';

function registerVisionStub(): void {
  const api = nodeModule as unknown as ModuleHooksApi;
  api.registerHooks({
    resolve(specifier, context, next) {
      // Matched before and after the alias hook rewrites it, since hook order is
      // not something this test should depend on.
      if (specifier === '@/lib/live/vision' || /\/lib\/live\/vision(\.ts|\/index\.ts)?$/.test(specifier)) {
        return { url: VISION_STUB_URL, shortCircuit: true, format: 'module' };
      }
      return next(specifier, context);
    },
  });
}

const hooksSpecifier = '../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();
registerVisionStub();

const specifier = './interior.ts';
const {
  INTERIOR_CLUE_EXTRACTION_PROMPT,
  analyzeInterior,
  builtinRegionResolver,
} = (await import(specifier)) as typeof InteriorModule;

const contracts = (await import('@/lib/contracts/types')) as typeof import('@/lib/contracts/types');
const config = (await import('@/lib/cascade/config')) as typeof import('@/lib/cascade/config');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function clues(partial: Partial<VlmClues>): VlmClues {
  return {
    text: [],
    infrastructure: [],
    environment: [],
    architecture: [],
    regionPrior: [],
    insufficientSignal: false,
    ...partial,
  };
}

const UK_SOCKET = 'Three rectangular pins in a square white plate with an integral rocker switch';

function ukClues(): VlmClues {
  return clues({
    architecture: [
      {
        observed: UK_SOCKET,
        legibility: 'clear',
        kind: 'building-material',
        impliesRegions: ['United Kingdom', 'Ireland', 'Malta'],
      },
      {
        observed: 'Vertically sliding sash window with a horizontal glazing bar',
        legibility: 'clear',
        kind: 'window-style',
        impliesRegions: ['United Kingdom'],
      },
    ],
    regionPrior: [
      {
        label: 'United Kingdom',
        country: 'United Kingdom',
        rawConfidence: 0.72,
        supportedBy: [UK_SOCKET, 'sash window'],
      },
    ],
  });
}

function gate(overrides: Partial<QualityGate> = {}): QualityGate {
  return {
    passed: true,
    degraded: false,
    components: { resolutionPx: { w: 1600, h: 1200 } },
    ...overrides,
  };
}

function fakeVlm(value: VlmClues, name = 'fake-vlm@test'): InteriorModule.InteriorVlmProvider {
  return {
    name,
    async extractClues() {
      return { ok: true, value: { clues: value, modelVersion: name, attempts: 1 } };
    },
  };
}

function fakeProvenance(hits: ProvenanceHit[]): ProvenanceModule.ProvenanceProvider {
  return {
    name: 'Fake Reverse Search',
    gap: { capability: 'Fake', impact: 'test double' },
    configured: true,
    usdPerSearch: 0.01,
    async search() {
      return { ok: true, value: { hits } };
    },
  };
}

/**
 * A JPEG SOI marker and nothing else. Enough for the module to have "bytes"
 * without pretending to be a decodable image: every test that needs a verdict
 * about image quality passes its own `QualityGate` instead.
 */
const STUB_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

async function run(
  overrides: Partial<InteriorModule.InteriorInput> = {},
): Promise<InteriorModule.InteriorAnalysis> {
  return analyzeInterior({
    image: { imageId: 'test-image', bytes: STUB_BYTES, mimeType: 'image/jpeg' },
    quality: gate(),
    provider: fakeVlm(ukClues()),
    provenanceProviders: [],
    env: {},
    ...overrides,
  });
}

const claims = (result: InteriorModule.InteriorAnalysis): string =>
  result.evidence.map((e) => e.claim).join('\n');

/** Candidate-level citations live on the candidate, not on the response. */
const candidateClaims = (result: InteriorModule.InteriorAnalysis): string =>
  result.geo.flatMap((c) => c.evidence.map((e) => e.claim)).join('\n');

// ---------------------------------------------------------------------------
// Street precision — the invariant that cannot bend
// ---------------------------------------------------------------------------

test('a country-level fixture set produces a region candidate that cannot claim street precision', async () => {
  const result = await run();

  assert.equal(result.geo.length, 1);
  const candidate: GeoCandidate = result.geo[0];
  assert.equal(candidate.place.label, 'United Kingdom');
  assert.notEqual(candidate.precision, 'street');
  assert.ok(
    ['country', 'region', 'continent'].includes(candidate.precision),
    `interior fixtures cannot support ${candidate.precision} precision`,
  );
  assert.ok(
    candidate.radiusM >= config.RETRIEVAL.regionRadiusM,
    'without a locator the radius is floored at the region radius',
  );
  assert.ok(candidate.evidence.length >= 2, 'a candidate exists only with its citations');
  assert.ok(candidate.confidence.reason.length > 0, 'a band with no stated reason is not shippable');
  assert.ok(['weak', 'moderate'].includes(candidate.confidence.band));
  // The real invariant function, not a local reimplementation.
  contracts.assertStreetPrecisionIsEarned(candidate);
});

test('even with a provenance hit, no candidate claims street precision', async () => {
  const result = await run({
    provenanceProviders: [
      fakeProvenance([
        {
          url: 'https://rentals.example.com/unit/7',
          source: 'Fake Reverse Search',
          title: '2 bed at 1234 N Maple Street, Springfield, IL 62704',
          place: '1234 N Maple Street, Springfield, IL 62704',
        },
      ]),
    ],
  });

  assert.equal(result.provenanceHits.length, 1);
  assert.equal(result.resolvableToBuilding, true);
  for (const candidate of result.geo) {
    assert.notEqual(candidate.precision, 'street');
    contracts.assertStreetPrecisionIsEarned(candidate);
  }
  const text = claims(result);
  assert.match(text, /Fake Reverse Search reports a matching copy/);
  assert.match(text, /source page's own claim/, 'an address from a page is attributed to that page');
  assert.match(text, /building-level lead exists here/);
});

// ---------------------------------------------------------------------------
// No country signal -> no candidates
// ---------------------------------------------------------------------------

test('a clue set reporting insufficient signal yields no candidates', async () => {
  const result = await run({
    provider: fakeVlm(
      clues({
        architecture: [
          { observed: 'Plain white wall', legibility: 'clear', kind: 'building-material', impliesRegions: [] },
        ],
        regionPrior: [
          { label: 'Unknown', rawConfidence: 0.1, supportedBy: ['Plain white wall'] },
        ],
        insufficientSignal: true,
      }),
    ),
  });

  assert.deepEqual(result.geo, []);
  assert.match(claims(result), /does not contain enough signal to constrain a country/);
  const vlmStage = result.stages.find((s) => s.stage === 'vlm-clues');
  assert.ok(vlmStage?.skipped?.reason, 'the reason for producing nothing is recorded on the stage');
});

test('a region the gazetteer cannot place yields no candidate rather than an invented centre', async () => {
  const result = await run({
    provider: fakeVlm(
      clues({
        architecture: [
          {
            observed: 'Neutral hotel-style headboard',
            legibility: 'clear',
            kind: 'building-material',
            impliesRegions: ['somewhere temperate'],
          },
        ],
        regionPrior: [
          {
            label: 'a residential interior',
            rawConfidence: 0.4,
            supportedBy: ['Neutral hotel-style headboard'],
          },
        ],
      }),
    ),
  });

  assert.deepEqual(result.geo, []);
  assert.match(claims(result), /Could not place 1 proposed region/);
});

test('a region the model proposed but did not cite is discarded, not softened', async () => {
  const result = await run({
    provider: fakeVlm(
      clues({
        architecture: [
          { observed: 'Beige carpet', legibility: 'clear', kind: 'building-material', impliesRegions: [] },
        ],
        regionPrior: [
          { label: 'Japan', country: 'Japan', rawConfidence: 0.9, supportedBy: ['general vibe of the room'] },
        ],
      }),
    ),
  });

  assert.deepEqual(result.geo, []);
  assert.match(claims(result), /Discarded 1 proposed region \(Japan\)/);
});

test('with no vision model at all there are no candidates and the gap names the env var', async () => {
  const result = await run({ provider: null });

  assert.deepEqual(result.geo, []);
  const gap = result.unavailable.find((g) => g.capability === 'Interior fixture analysis');
  assert.ok(gap, 'a missing vision key must be reported as a capability gap');
  assert.match(gap?.envVar ?? '', /ANTHROPIC_API_KEY/);
  assert.match(claims(result), /no vision model ran/);
});

test('a failed quality gate returns no ranking, even with a strong clue set', async () => {
  const result = await run({
    quality: gate({ passed: false, refusalReason: 'Long edge 180px is below the 320px floor.' }),
  });

  assert.deepEqual(result.geo, [], 'show the refusal, not a ranking');
  assert.match(claims(result), /failed the quality gate/);
});

test('unreadable bytes produce a refusal instead of a throw', async () => {
  const result = await analyzeInterior({
    image: { imageId: 'broken', bytes: new Uint8Array([1, 2, 3]) },
    provider: fakeVlm(ukClues()),
    provenanceProviders: [],
    env: {},
  });

  assert.deepEqual(result.geo, []);
  const preprocess = result.stages.find((s) => s.stage === 'preprocess');
  assert.ok(preprocess, 'the metadata stage still reports its timing');
  assert.ok(preprocess !== undefined && preprocess.ranMs >= 0);
});

test('with no bytes the metadata stage is skipped with a stated reason', async () => {
  const result = await run({ image: { imageId: 'test-image' } });
  const preprocess = result.stages.find((s) => s.stage === 'preprocess');
  assert.match(preprocess?.skipped?.reason ?? '', /No image bytes/);
});

// ---------------------------------------------------------------------------
// Provenance wiring
// ---------------------------------------------------------------------------

test('with no reverse-image service the response says so and names both env vars', async () => {
  const result = await run({ env: {} });

  assert.deepEqual(result.provenanceHits, []);
  assert.equal(result.resolvableToBuilding, false);
  const envVars = result.unavailable.map((g) => g.envVar);
  assert.ok(envVars.includes('TINEYE_API_KEY'));
  assert.ok(envVars.includes('GOOGLE_CLOUD_VISION_API_KEY'));

  const text = claims(result);
  assert.match(text, /NOT resolvable to a specific building/);
  assert.match(text, /TINEYE_API_KEY/);
});

test('a service that was queried and found nothing is reported as a real negative', async () => {
  const result = await run({ provenanceProviders: [fakeProvenance([])] });

  assert.deepEqual(result.provenanceHits, []);
  assert.match(claims(result), /Fake Reverse Search was queried and returned no copy/);
  assert.match(claims(result), /found no published copy of this image/);
});

test('a window view is called out as the cue that makes the frame geolocatable', async () => {
  const result = await run({
    provider: fakeVlm({
      ...ukClues(),
      environment: [
        {
          observed: 'Deciduous street trees in leaf and a low grey sky visible through the window',
          legibility: 'clear',
          kind: 'vegetation',
          impliesRegions: ['United Kingdom'],
        },
      ],
    }),
  });

  const text = claims(result);
  assert.match(text, /Visible outside the window/);
  assert.match(text, /reduces this to ordinary outdoor geolocation/);
});

// ---------------------------------------------------------------------------
// Operator hints
// ---------------------------------------------------------------------------

test('an operator bbox narrows the candidate when it overlaps', async () => {
  const result = await run({ hints: { bbox: [-6, 51, 0, 55] } });
  assert.equal(result.geo.length, 1);
  assert.match(candidateClaims(result), /narrowed to the operator-supplied search area/);
  assert.ok(
    result.geo[0].radiusM >= config.RETRIEVAL.regionRadiusM,
    'narrowing must not push the radius below what the signal supports',
  );
});

test('an operator bbox that contradicts the fixtures is stated as a conflict, not silently dropped', async () => {
  const result = await run({ hints: { bbox: [-80, 40, -70, 45] } });
  assert.equal(result.geo.length, 1, 'the visual signal is not discarded because a hint disagrees');
  assert.match(candidateClaims(result), /does not overlap the operator-supplied search area/);
});

// ---------------------------------------------------------------------------
// Cost and provenance bookkeeping
// ---------------------------------------------------------------------------

test('vlm cost is recorded only for the vendor whose price we actually know', async () => {
  const unknownVendor = await run({ provider: fakeVlm(ukClues(), 'anthropic:claude-x') });
  const unknownStage = unknownVendor.stages.find((s) => s.stage === 'vlm-clues');
  assert.equal(unknownStage?.costUsd, undefined, 'an unset cost is honest; a guessed one is not');

  const priced = await run({ provider: fakeVlm(ukClues(), 'gemini:gemini-3-flash') });
  const pricedStage = priced.stages.find((s) => s.stage === 'vlm-clues');
  assert.equal(pricedStage?.costUsd, config.COSTS.vlmUsdPerCall);
  assert.equal(priced.costUsd, config.COSTS.vlmUsdPerCall, 'total cost is the sum of measured stages');
});

test('every stage reports a real elapsed time and the model/source versions are recorded', async () => {
  const result = await run({ provider: fakeVlm(ukClues(), 'gemini:gemini-3-flash') });
  const stageNames = result.stages.map((s) => s.stage);
  assert.deepEqual(stageNames, ['preprocess', 'vlm-clues', 'provenance']);
  for (const stage of result.stages) {
    assert.equal(typeof stage.ranMs, 'number');
    assert.ok(stage.ranMs >= 0);
  }
  assert.equal(result.models.vlm, 'gemini:gemini-3-flash');
  assert.match(result.sources.gazetteer, /coarse-region-boxes/);
});

// ---------------------------------------------------------------------------
// The coarse gazetteer
// ---------------------------------------------------------------------------

test('the gazetteer resolves country names, blocs and sub-national names, and refuses the rest', async () => {
  const uk = await builtinRegionResolver.resolve({ label: 'United Kingdom' });
  assert.ok(uk);
  assert.equal(uk?.label, 'United Kingdom');
  assert.ok((uk?.radiusM ?? 0) > 0, 'a zero radius would be a point estimate');
  assert.match(uk?.basis ?? '', /coarse reference box/);

  const scotland = await builtinRegionResolver.resolve({ label: 'Scotland' });
  assert.equal(scotland?.label, 'United Kingdom');
  assert.equal(scotland?.coarserThanAsked, 'Scotland', 'answering coarsely than asked must be stated');

  const bloc = await builtinRegionResolver.resolve({ label: 'North America' });
  assert.match(bloc?.label ?? '', /North America/);

  const viaCountry = await builtinRegionResolver.resolve({ label: 'Kreuzberg', country: 'Germany' });
  assert.equal(viaCountry?.label, 'Germany');

  assert.equal(await builtinRegionResolver.resolve({ label: 'a nice living room' }), null);
  assert.equal(await builtinRegionResolver.resolve({ label: '' }), null);
});

test('the longest name match wins, so "United States" beats the "us" alias', async () => {
  const us = await builtinRegionResolver.resolve({ label: 'United States' });
  assert.equal(us?.label, 'United States');
  assert.match(us?.basis ?? '', /contiguous 48/, 'the box\'s own caveat travels with it');
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

test('the interior prompt asks for the signals that actually discriminate indoors', () => {
  const prompt = INTERIOR_CLUE_EXTRACTION_PROMPT;
  const lower = prompt.toLowerCase();
  for (const needle of [
    'electrical outlets and switches',
    'type a/b',
    'type g',
    'schuko',
    'type i',
    'switch plate',
    'lever handle',
    'tilt-turn',
    'radiator',
    'mini-split',
    'smoke',
    'skirting',
    'book spines',
    'mail',
    'window or open door',
    'built-in closet',
    'insufficientsignal',
    'regionprior',
  ]) {
    assert.ok(lower.includes(needle), `the prompt must still ask about ${needle}`);
  }
  assert.match(prompt, /never ask|not to identify the place|ENUMERATE WHAT IS VISIBLE/i);
  assert.match(prompt, /NEVER transcribe or guess licence-plate characters/);
});
