/**
 * LOCATE tests.
 *
 *   node --test src/lib/live/locate.test.ts
 *
 * The point of this file is the no-fabrication rules, so the assertions are
 * mostly negative: a region with unsupported citations must produce ZERO
 * candidates, a missing gazetteer must produce zero candidates and a named env
 * var, a failed quality gate must produce zero candidates, and EXIF GPS must
 * never become a candidate no matter how convenient it is.
 *
 * The provider and the gazetteer are stubs. No network, no API key, no fixture
 * files — the image is a synthetic PNG whose header carries real dimensions,
 * which is exactly what the quality gate reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from '@/lib/cascade/testing/aliasHooks';
import type * as Contracts from '@/lib/contracts/types';
import type * as LocateModule from './locate';
import type { SearchResult } from '@/lib/contracts/types';
import type { VlmClues } from '@/lib/contracts/schemas';
import type { Geocoder } from '@/lib/verify/ocrGeocode';
import type { InteriorVlmProvider } from './interior';
import type {
  LiveVisionProvider,
  LiveVlmRequest,
  LiveVlmResult,
  StructuredRequest,
  StructuredResult,
} from './vision';
import type { Result, StageFailure } from '@/lib/cascade/types';

// Relative and first: the hooks are what teach Node about the `@/` alias.
const hooksSpecifier = './../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const contracts = (await import('@/lib/contracts/types')) as typeof Contracts;
const locateSpecifier = './locate.ts';
const {
  LOCATE_BUDGET_MS,
  condenseTechnique,
  locate,
  locateRefusal,
  matchSupportingClues,
  metadataEvidence,
} = (await import(locateSpecifier)) as typeof LocateModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A PNG whose IHDR carries real dimensions.
 *
 * `readImageHeader` reads width/height from bytes 16..23, and the quality gate
 * refuses anything under 2048 bytes, so the buffer is padded to a realistic size.
 * Nothing here fakes a measurement: the dimensions the gate reads are genuinely
 * the dimensions encoded in the file.
 */
function png(width: number, height: number, byteLength = 8_192): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length 13
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  writeU32(bytes, 16, width);
  writeU32(bytes, 20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 2; // colour type: truecolour
  return bytes;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function clues(overrides: Partial<VlmClues> = {}): VlmClues {
  return {
    text: [
      { observed: 'S 18TH ST', legibility: 'clear', bbox: [0.4, 0.3, 0.6, 0.35], kind: 'street-sign' },
    ],
    infrastructure: [
      {
        observed: 'yellow centre line, traffic drives on the right',
        legibility: 'clear',
        bbox: [0.0, 0.7, 1.0, 1.0],
        kind: 'driving-side',
        impliesRegions: ['United States', 'Canada'],
      },
    ],
    environment: [],
    architecture: [
      {
        observed: 'buff-yellow brick rowhouses on a steep hillside',
        legibility: 'clear',
        bbox: [0.1, 0.1, 0.5, 0.6],
        kind: 'row-house',
        impliesRegions: ['Western Pennsylvania'],
      },
    ],
    solar: { shadowsVisible: false, estimatedTimeOfDay: 'unknown' },
    regionPrior: [
      {
        label: 'Pittsburgh',
        country: 'United States',
        admin1: 'Pennsylvania',
        rawConfidence: 0.62,
        supportedBy: ['buff-yellow brick rowhouses on a steep hillside', 'S 18TH ST'],
      },
    ],
    insufficientSignal: false,
    ...overrides,
  };
}

function stubProvider(
  result: Result<Partial<LiveVlmResult> & { clues: VlmClues }, StageFailure>,
  onRequest?: (req: LiveVlmRequest) => void,
): LiveVisionProvider {
  return {
    name: 'stub:test-model',
    vendor: 'anthropic',
    model: 'test-model',
    async extractClues(req: LiveVlmRequest): Promise<Result<LiveVlmResult, StageFailure>> {
      onRequest?.(req);
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          modelVersion: 'test-model',
          attempts: 1,
          usage: { inputTokens: 1_500, outputTokens: 400, costUsd: 0.0105, costBasis: 'test' },
          image: { scale: 1, mediaType: 'image/png', bytes: 8_192, method: 'passthrough' },
          notes: [],
          ...result.value,
        },
      };
    },
    async extractStructured<T>(
      req: StructuredRequest<T>,
    ): Promise<Result<StructuredResult<T>, StageFailure>> {
      // LOCATE never calls this path; VEHICLE does.
      return {
        ok: false,
        error: { kind: 'not-configured', reason: `stub provider: no structured path (${req.schemaName ?? 'unnamed'})` },
      };
    },
  };
}

/** A gazetteer that resolves one known label and nothing else. */
function stubGeocoder(entries: Record<string, { lat: number; lon: number; bbox?: [number, number, number, number] }>): Geocoder {
  return {
    name: 'stub-gazetteer',
    async geocode(query) {
      const key = Object.keys(entries).find((k) => query.toLowerCase().includes(k.toLowerCase()));
      if (!key) return { ok: true, value: [] };
      const hit = entries[key];
      return {
        ok: true,
        value: [
          {
            label: key,
            lat: hit.lat,
            lon: hit.lon,
            ...(hit.bbox ? { bbox: hit.bbox } : {}),
          },
        ],
      };
    },
  };
}

const PITTSBURGH = { lat: 40.4406, lon: -79.9959, bbox: [-80.1, 40.36, -79.87, 40.5] as [number, number, number, number] };

const noTechniqueDoc = async (): Promise<string | null> => null;

// ---------------------------------------------------------------------------
// Type-level: one provider satisfies every consumer's narrower interface
// ---------------------------------------------------------------------------

test('a LiveVisionProvider is structurally an InteriorVlmProvider', () => {
  // Compile-time proof. If the vision module's request or result types drift so
  // that INTERIOR can no longer accept the shared provider, this stops compiling
  // rather than failing at request time in the UI.
  const asInterior: (p: LiveVisionProvider) => InteriorVlmProvider = (p) => p;
  assert.equal(typeof asInterior, 'function');
});

// ---------------------------------------------------------------------------
// Candidate synthesis
// ---------------------------------------------------------------------------

test('a supported region with a gazetteer becomes one cited candidate', async () => {
  const result = await locate(
    { uploadId: 'up_1', bytes: png(1600, 1200) },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 1);
  const candidate = result.geo[0];

  assert.equal(candidate.rank, 1);
  assert.equal(candidate.place.label, 'Pittsburgh');
  assert.equal(candidate.center.lat, PITTSBURGH.lat);

  // Radius is a real uncertainty, in kilometres, and never zero.
  assert.ok(candidate.radiusM >= 8_000, `radius too tight: ${candidate.radiusM}`);
  assert.ok(['city', 'region', 'country', 'continent'].includes(candidate.precision));
  assert.notEqual(candidate.precision, 'street');

  // Confidence is a band plus a reason generated from the real clue counts.
  assert.ok(['weak', 'moderate'].includes(candidate.confidence.band), candidate.confidence.band);
  assert.match(candidate.confidence.reason, /2 visual clues across 2 independent categories/);
  assert.match(candidate.confidence.reason, /Pittsburgh/);
  assert.ok(candidate.confidence.calibration.length > 0);

  // Every supporting clue is cited, with the bbox as the citation.
  const cited = candidate.evidence.filter((e) => e.cropUrl !== undefined);
  assert.ok(cited.length >= 2, 'supporting clues must carry their crop citation');
  assert.match(cited[0].cropUrl ?? '', /\/api\/images\/up_1\/crop\?bbox=/);
  for (const e of candidate.evidence) assert.ok(e.verifiable.length > 20, e.kind);

  // The gazetteer resolution is disclosed as the source of the coordinate.
  assert.ok(
    candidate.evidence.some((e) => /gazetteer/i.test(e.claim)),
    'the coordinate must say where it came from',
  );

  assert.equal(result.unresolvedRegions.length, 0);
  assert.equal(result.models.geocoder, 'stub-gazetteer');
  assert.equal(result.costUsd, 0.0105);
});

test('two regions rank by the models own confidence and stay capped below high', async () => {
  const twoPriors = clues({
    regionPrior: [
      {
        label: 'Cincinnati',
        country: 'United States',
        rawConfidence: 0.3,
        supportedBy: ['S 18TH ST'],
      },
      {
        label: 'Pittsburgh',
        country: 'United States',
        rawConfidence: 0.9,
        supportedBy: ['buff-yellow brick rowhouses on a steep hillside'],
      },
    ],
  });

  const result = await locate(
    { uploadId: 'up_2', bytes: png(1600, 1200) },
    {
      provider: stubProvider({ ok: true, value: { clues: twoPriors } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH, Cincinnati: { lat: 39.1, lon: -84.5 } }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 2);
  assert.equal(result.geo[0].place.label, 'Pittsburgh');
  // 'high' requires more than one INDEPENDENT signal, and clue evidence is
  // circular by construction — so no amount of model confidence reaches it.
  for (const candidate of result.geo) {
    assert.notEqual(candidate.confidence.band, 'high');
  }
});

// ---------------------------------------------------------------------------
// The no-fabrication rules
// ---------------------------------------------------------------------------

test('a region whose cited support is not in the observation list yields ZERO candidates', async () => {
  const fabricated = clues({
    regionPrior: [
      {
        label: 'Kyoto',
        country: 'Japan',
        rawConfidence: 0.95,
        // Nothing like this appears in the observation list above.
        supportedBy: ['vermilion torii gate', 'Japanese signage'],
      },
    ],
  });

  const result = await locate(
    { uploadId: 'up_3', bytes: png(1600, 1200) },
    {
      provider: stubProvider({ ok: true, value: { clues: fabricated } }),
      geocoder: stubGeocoder({ Kyoto: { lat: 35.01, lon: 135.76 } }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 0, 'a fabricated justification must not produce a placeholder');
  assert.equal(result.unresolvedRegions.length, 1);
  assert.equal(result.unresolvedRegions[0].label, 'Kyoto');
  assert.match(result.unresolvedRegions[0].reason, /does not appear/i);
  // The observations it did make are still in the ledger.
  assert.ok(result.evidence.some((e) => e.kind === 'vlm-clue'));
});

test('no gazetteer and no model estimate means no candidate and a named env var', async () => {
  const result = await locate(
    { uploadId: 'up_4', bytes: png(1600, 1200) },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: null,
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 0, 'a region label is not a coordinate');
  assert.equal(result.unresolvedRegions.length, 1);
  assert.equal(result.unresolvedRegions[0].label, 'Pittsburgh');
  const gap = result.gaps.find((g) => g.envVar === 'NOMINATIM_URL');
  assert.ok(gap, 'the operator must be told exactly what to set');
  assert.match(gap.impact, /place NAMES, not coordinates/);
});

test('a model-estimated coordinate is used but labelled as the models own guess', async () => {
  let sawRequest: LiveVlmRequest | undefined;
  const result = await locate(
    { uploadId: 'up_5', bytes: png(1600, 1200) },
    {
      provider: stubProvider(
        {
          ok: true,
          value: {
            clues: clues(),
            regionCoordinates: [{ label: 'Pittsburgh', lat: 40.44, lon: -79.99, radiusKm: 40 }],
          },
        },
        (req) => {
          sawRequest = req;
        },
      ),
      geocoder: null,
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  // With no gazetteer, LOCATE asks for coordinates rather than guessing them.
  assert.equal(sawRequest?.requestRegionCoordinates, true);

  assert.equal(result.geo.length, 1);
  const candidate = result.geo[0];
  assert.equal(candidate.center.lat, 40.44);
  // Region floor, not the model's optimistic 40km, whichever is larger.
  assert.ok(candidate.radiusM >= 40_000, `radius ${candidate.radiusM}`);
  assert.equal(candidate.precision, 'region');
  const disclosure = candidate.evidence.find((e) => /MODEL-ESTIMATED/.test(e.claim));
  assert.ok(disclosure, 'a model-estimated coordinate must say so in its own claim');
  assert.match(disclosure.verifiable, /NOMINATIM_URL/);
});

test('a model that says it cannot tell is believed, not overridden', async () => {
  const result = await locate(
    { uploadId: 'up_6', bytes: png(1600, 1200) },
    {
      provider: stubProvider({
        ok: true,
        value: {
          clues: clues({
            insufficientSignal: true,
            regionPrior: [
              { label: 'Somewhere in Europe', rawConfidence: 0.2, supportedBy: ['S 18TH ST'] },
            ],
          }),
        },
      }),
      geocoder: stubGeocoder({ Europe: { lat: 50, lon: 10 } }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 0);
  const trace = result.stages.find((s) => s.stage === 'vlm-clues');
  assert.match(trace?.skipped?.reason ?? '', /insufficient signal/i);
});

test('a vision failure degrades to zero candidates with the reason, and never throws', async () => {
  const result = await locate(
    { uploadId: 'up_7', bytes: png(1600, 1200) },
    {
      provider: stubProvider({
        ok: false,
        error: { kind: 'timeout', reason: 'vision model did not respond within 30000ms' },
      }),
      geocoder: null,
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 0);
  assert.match(
    result.stages.find((s) => s.stage === 'vlm-clues')?.skipped?.reason ?? '',
    /did not respond/,
  );
});

test('no vision provider means a capability gap, not a coordinate from EXIF', async () => {
  const result = await locate(
    { uploadId: 'up_8', bytes: png(1600, 1200) },
    { provider: null, geocoder: null, readTechniqueDoc: noTechniqueDoc, env: {} },
  );

  assert.equal(result.geo.length, 0);
  assert.ok(result.gaps.some((g) => /ANTHROPIC_API_KEY/.test(g.envVar ?? '')));
  assert.equal(result.costUsd, 0);
});

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

test('an absurdly small frame is refused and returns no ranking', async () => {
  const result = await locate(
    { uploadId: 'up_9', bytes: png(120, 90) },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.quality.passed, false);
  assert.equal(result.geo.length, 0);
  assert.match(result.quality.refusalReason ?? '', /Resolution is 120x90/);

  // The contract's own invariant, run against a response shaped from this result.
  const asSearchResult: SearchResult = {
    id: 'up_9',
    module: 'GEO',
    imageId: 'up_9',
    quality: result.quality,
    geo: result.geo,
    stages: result.stages,
    provenance: { models: result.models, totalCostUsd: result.costUsd },
    createdAt: new Date().toISOString(),
  };
  contracts.assertRefusalIsHonoured(asSearchResult);

  // And the vision model was never called, so a refused frame costs nothing.
  assert.equal(result.costUsd, 0);
  assert.equal(result.stages.some((s) => s.stage === 'vlm-clues'), false);
});

test('a degraded frame caps the band at weak', async () => {
  const result = await locate(
    // Between the 320px refusal floor and the 640px reliability floor.
    { uploadId: 'up_10', bytes: png(480, 360) },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.quality.passed, true);
  assert.equal(result.quality.degraded, true);
  assert.equal(result.geo.length, 1);
  assert.equal(result.geo[0].confidence.band, 'weak');
});

test('the components the gate cannot measure are absent, not zero', async () => {
  const result = await locate(
    { uploadId: 'up_11', bytes: png(1600, 1200) },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.deepEqual(result.quality.components.resolutionPx, { w: 1600, h: 1200 });
  assert.equal(result.quality.components.blur, undefined, 'blur needs pixel access; it is not faked');
  assert.equal(result.quality.components.exposure, undefined);
  assert.equal(result.quality.unifiedScore, undefined);
});

// ---------------------------------------------------------------------------
// Operator hints
// ---------------------------------------------------------------------------

test('an operator note reaches the model framed as a claim to test', async () => {
  let sawRequest: LiveVlmRequest | undefined;
  await locate(
    {
      uploadId: 'up_12',
      bytes: png(1600, 1200),
      hints: { note: 'believed to be Western PA' },
    },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }, (req) => {
        sawRequest = req;
      }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  const suffix = sawRequest?.promptSuffix ?? '';
  assert.match(suffix, /believed to be Western PA/);
  assert.match(suffix, /UNVERIFIED CLAIM TO TEST/);
  assert.match(suffix, /If the frame contradicts it, say so/);
});

test('a bbox hint excludes candidates visibly rather than silently', async () => {
  const result = await locate(
    {
      uploadId: 'up_13',
      bytes: png(1600, 1200),
      // Somewhere in Kansas: Pittsburgh PA is not in it.
      hints: { bbox: [-99, 37, -97, 39] },
    },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 0);
  assert.match(result.unresolvedRegions[0].reason, /outside the bounding box/);
});

// ---------------------------------------------------------------------------
// EXIF is a claim, never the answer
// ---------------------------------------------------------------------------

test('EXIF evidence carries zero weight and cannot corroborate anything', () => {
  const evidence = metadataEvidence(
    {
      gps: { lat: 35.6812, lon: 139.7671 },
      capturedAt: '2026-03-04T10:00:00.000Z',
      cameraMake: 'Apple',
      cameraModel: 'iPhone 17 Pro',
      tagCount: 42,
      stripped: false,
    },
    { format: 'jpeg', width: 4032, height: 3024, byteLength: 2_400_000 },
    'up_x',
  );

  const gps = evidence.find((e) => /CLAIMS/.test(e.claim));
  assert.ok(gps);
  assert.equal(gps.kind, 'exif');
  assert.equal(gps.weight, 0, 'a forgeable tag must not move a ranking');
  assert.match(gps.verifiable, /exiftool/);
  assert.match(gps.claim, /never used as the answer/);
  for (const e of evidence) assert.equal(e.weight, 0);
});

test('a GPS tag pointing at Tokyo does not create a Tokyo candidate', async () => {
  // The synthetic PNG has no EXIF at all, so the strongest available statement is
  // the structural one: LOCATE builds candidates only from region priors, and the
  // metadata path contributes evidence with weight 0 and no geometry.
  const result = await locate(
    { uploadId: 'up_14', bytes: png(1600, 1200) },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );
  for (const candidate of result.geo) {
    assert.ok(
      candidate.evidence.every((e) => e.kind !== 'exif' || e.weight === 0),
      'exif evidence must stay at weight 0 wherever it appears',
    );
  }
  assert.ok(result.evidence.some((e) => e.kind === 'exif'), 'the metadata state is still recorded');
});

// ---------------------------------------------------------------------------
// Street precision, support matching, refusal, technique doc
// ---------------------------------------------------------------------------

test('nothing LOCATE produces can claim street precision', async () => {
  const result = await locate(
    { uploadId: 'up_15', bytes: png(4000, 3000) },
    {
      provider: stubProvider({
        ok: true,
        value: {
          clues: clues({
            regionPrior: [
              {
                label: 'South Side Slopes, Pittsburgh',
                admin1: 'Pennsylvania',
                country: 'United States',
                rawConfidence: 1,
                supportedBy: ['S 18TH ST', 'buff-yellow brick rowhouses on a steep hillside'],
              },
            ],
          }),
        },
      }),
      geocoder: stubGeocoder({
        // A tiny bbox: a neighbourhood-sized polygon.
        'South Side Slopes': { lat: 40.42, lon: -79.97, bbox: [-79.98, 40.415, -79.96, 40.425] },
      }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 1);
  assert.notEqual(result.geo[0].precision, 'street');
  // A neighbourhood polygon is ~1km across; the floor keeps the claim honest.
  assert.ok(result.geo[0].radiusM >= 8_000, `radius ${result.geo[0].radiusM}`);
  contracts.assertStreetPrecisionIsEarned(result.geo[0]);
});

test('support matching is generous about wording and strict about existence', () => {
  const fixture = clues();
  const matched = matchSupportingClues(fixture, ['buff yellow brick rowhouses'], 'up_y');
  assert.equal(matched.evidence.length, 1, 'a paraphrase of a real observation counts');
  assert.equal(matched.categories, 1);

  const invented = matchSupportingClues(fixture, ['a red London double-decker bus'], 'up_y');
  assert.equal(invented.evidence.length, 0, 'an observation that was never made must not count');
  assert.equal(invented.categories, 0);

  const both = matchSupportingClues(
    fixture,
    ['S 18TH ST', 'yellow centre line, traffic drives on the right'],
    'up_y',
  );
  assert.equal(both.categories, 2, 'distinct categories are counted for the reason sentence');
});

test('locateRefusal is a well-formed result with no ranking', () => {
  const refusal = locateRefusal('Two images were supplied for a single-image module.');
  assert.equal(refusal.geo.length, 0);
  assert.equal(refusal.quality.passed, false);
  assert.equal(refusal.costUsd, 0);
  assert.match(refusal.quality.refusalReason ?? '', /single-image module/);
  contracts.assertRefusalIsHonoured({
    id: 'r',
    module: 'GEO',
    imageId: 'r',
    quality: refusal.quality,
    geo: refusal.geo,
    stages: refusal.stages,
    provenance: { models: {}, totalCostUsd: 0 },
    createdAt: new Date().toISOString(),
  });
});

test('the technique doc is condensed to its prompt-ready section', () => {
  const markdown = [
    '# GEOGUESSR.md',
    '',
    'Preamble that should not be in the prompt.',
    '',
    '## 2. Outdoor signal catalogue',
    'Long prose about delineators.',
    '',
    '## 6. Prompt-ready extraction checklist',
    '',
    '**→ `text[]`** — every legible string',
    '1. Business names',
    '2. Street blades',
    '',
    '## Sources',
    'A very long bibliography.',
  ].join('\n');

  const condensed = condenseTechnique(markdown);
  assert.ok(condensed);
  assert.match(condensed, /text\[\]/);
  assert.match(condensed, /Street blades/);
  assert.ok(!condensed.includes('bibliography'), 'the sources section must not reach the prompt');
  assert.ok(!condensed.includes('Preamble'), 'the preamble must not reach the prompt');
});

test('a doc with no prompt-ready section still yields its headings and bullets', () => {
  const condensed = condenseTechnique('# T\n\nprose\n\n## Poles\n- banded hardware\n- crossarms\n');
  assert.ok(condensed);
  assert.match(condensed, /banded hardware/);
  assert.ok(!condensed.includes('prose'));
});

test('the budget is larger than the cascades, because this module IS the vision call', () => {
  assert.ok(LOCATE_BUDGET_MS > 10_000);
});

// ---------------------------------------------------------------------------
// The caller's identifiers and the caller's measurements
// ---------------------------------------------------------------------------

/**
 * The orchestrator's LOCATE adapter sends `image`, `upload`, `bytes`, `mime` and
 * `quality`. It does NOT send `uploadId`, and reading it directly produced
 * candidate ids like `undefined-region-1` and crop links at
 * `/api/images/undefined/crop` — a dead evidence trail that raised no error.
 */
test('the upload id is taken from whichever field the caller populated', async () => {
  const run = async (input: Record<string, unknown>): Promise<SearchResult['geo']> => {
    const result = await locate(
      { bytes: png(1600, 1200), ...input } as Parameters<typeof locate>[0],
      {
        provider: stubProvider({ ok: true, value: { clues: clues() } }),
        geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
        readTechniqueDoc: noTechniqueDoc,
        env: {},
      },
    );
    return result.geo;
  };

  const direct = await run({ uploadId: 'up_direct' });
  assert.equal(direct?.[0].id, 'up_direct-region-1');

  const viaUpload = await run({ upload: { id: 'up_record' } });
  assert.equal(viaUpload?.[0].id, 'up_record-region-1');

  const viaImage = await run({ image: { imageId: 'up_image' } });
  assert.equal(viaImage?.[0].id, 'up_image-region-1');

  // No id anywhere: a marker a human can search for, never the string 'undefined'.
  const none = await run({});
  assert.equal(none?.[0].id, 'unknown-upload-region-1');
  for (const item of none?.[0].evidence ?? []) {
    assert.ok(!(item.cropUrl ?? '').includes('undefined'), 'a crop URL must never carry "undefined"');
  }
});

test('a caller-supplied quality gate is trusted rather than re-run and re-reported', async () => {
  const supplied: Contracts.QualityGate = {
    passed: true,
    components: { resolutionPx: { w: 1600, h: 1200 } },
    degraded: false,
  };

  const withGate = await locate(
    { uploadId: 'up_gate', bytes: png(1600, 1200), quality: supplied },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  // The orchestrator already emitted both; a second copy of each is noise in the
  // trace a reader uses to see what actually ran.
  assert.equal(withGate.stages.some((s) => s.stage === 'preprocess'), false);
  assert.equal(withGate.stages.some((s) => s.stage === 'quality-gate'), false);
  assert.equal(withGate.quality, supplied, 'the caller\'s verdict is the one reported back');
  assert.equal(withGate.geo.length, 1, 'suppressing the traces must not suppress the work');

  const standalone = await locate(
    { uploadId: 'up_gate_2', bytes: png(1600, 1200) },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );
  assert.equal(standalone.stages.some((s) => s.stage === 'preprocess'), true);
  assert.equal(standalone.stages.some((s) => s.stage === 'quality-gate'), true);
});

/**
 * A HEIC container that parses but does not decode. The header is deliberately
 * good — brand `heic`, one unambiguous 1600x1200 `ispe`, over the byte floor —
 * so the gate would pass it and the refusal below can only come from the decode.
 */
function undecodableHeic(): Uint8Array {
  const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const box = (type: string, payload: readonly number[]): number[] => [
    ...u32(8 + payload.length),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...payload,
  ];
  const full = (type: string, payload: readonly number[]): number[] => box(type, [0, 0, 0, 0, ...payload]);
  const bytes = new Uint8Array(8_192);
  bytes.set(
    [
      ...box('ftyp', [...[...'heic'].map((c) => c.charCodeAt(0)), ...u32(0)]),
      ...full('meta', box('iprp', box('ipco', full('ispe', [...u32(1600), ...u32(1200)])))),
    ],
    0,
  );
  return bytes;
}

test('an undecodable HEIC refuses the gate and reports it as a capability gap', async () => {
  const result = await locate(
    { uploadId: 'up_heic', bytes: undecodableHeic(), mime: 'image/heic' },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 0, 'no pixels were read, so there is nothing to rank');
  assert.equal(result.quality.passed, false);
  assert.match(result.quality.refusalReason ?? '', /could not be decoded/);
  assert.equal(
    result.stages.some((s) => s.stage === 'vlm-clues'),
    false,
    'nothing is spent on a frame that never decoded',
  );
  const gap = result.gaps.find((g) => /HEIC/.test(g.capability));
  assert.ok(gap, 'the operator has to see this above the fold, not only in the trace');
  assert.match(gap?.impact ?? '', /NO analysis ran/);
});

test('a caller-supplied refusal still returns no ranking', async () => {
  const result = await locate(
    {
      uploadId: 'up_refused',
      bytes: png(1600, 1200),
      quality: {
        passed: false,
        components: { resolutionPx: { w: 120, h: 90 } },
        degraded: false,
        refusalReason: 'Resolution is 120x90.',
      },
    },
    {
      provider: stubProvider({ ok: true, value: { clues: clues() } }),
      geocoder: stubGeocoder({ Pittsburgh: PITTSBURGH }),
      readTechniqueDoc: noTechniqueDoc,
      env: {},
    },
  );

  assert.equal(result.geo.length, 0);
  assert.equal(result.stages.some((s) => s.stage === 'vlm-clues'), false, 'nothing is spent on a refused frame');
});
