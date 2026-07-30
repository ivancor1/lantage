/**
 * VEHICLE identification tests.
 *
 *   node --test src/lib/live/vehicle.test.ts
 *
 * The load-bearing test in this file is the vPIC one: a candidate the vision
 * model invented must not appear as verified. If that regresses, the module
 * stops being an identifier and starts being a plausible-sounding guess
 * generator, which is worse than returning nothing.
 *
 * Both the vision provider and the vPIC client are injected, so the whole suite
 * runs offline and deterministically. A live-network variant is gated behind
 * LANTAGE_TEST_LIVE_VPIC=1.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as VehicleModule from './vehicle';

/*
 * Local resolve hook rather than `cascade/testing/aliasHooks`: that shim appends
 * `.ts` to every extensionless relative specifier including ones originating
 * inside node_modules, which breaks CommonJS dependencies. This one only
 * rewrites specifiers whose parent is in our own source tree.
 */
const nodeModule = await import('node:module');
const nodePath = await import('node:path');
const nodeUrl = await import('node:url');

type NextResolve = (specifier: string, context: unknown) => unknown;
interface ModuleHooksApi {
  registerHooks(hooks: {
    resolve?: (specifier: string, context: unknown, next: NextResolve) => unknown;
  }): void;
}

const srcRoot = nodePath.resolve(
  nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)),
  '../..',
);
const hasExtension = (s: string): boolean => /\.[cm]?[jt]sx?$/.test(s) || /\.(json|node)$/.test(s);

(nodeModule as unknown as ModuleHooksApi).registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const target = nodePath.join(srcRoot, specifier.slice(2));
      return next(
        nodeUrl.pathToFileURL(hasExtension(target) ? target : `${target}.ts`).href,
        context,
      );
    }
    const parentURL =
      context && typeof context === 'object' && 'parentURL' in context
        ? String((context as { parentURL?: unknown }).parentURL ?? '')
        : '';
    if (
      !parentURL.includes('/node_modules/') &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      return next(hasExtension(specifier) ? specifier : `${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const specifier = './vehicle.ts';
const vehicle = (await import(specifier)) as typeof VehicleModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function jpegBytes(): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const buf = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 95, b: 105 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}

type Reading = VehicleModule.VehicleReading;

function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    vehiclePresent: true,
    color: { name: 'silver', legibility: 'clear' },
    candidates: [
      {
        make: 'Chevrolet',
        model: 'Silverado 1500',
        yearFrom: 2019,
        yearTo: 2021,
        bodyStyle: 'pickup-truck',
        selfReportedConfidence: 0.62,
        supportedBy: ['stacked rectangular tail lights'],
      },
      {
        make: 'Zorbicron Motors',
        model: 'Vantablack GT',
        yearFrom: 2020,
        yearTo: 2022,
        bodyStyle: 'pickup-truck',
        // Deliberately the model's FAVOURITE, so a naive ranking would put the
        // invented candidate first.
        selfReportedConfidence: 0.95,
        supportedBy: ['a make that does not exist'],
      },
      {
        make: 'Toyota',
        model: 'Zephyrion Grand',
        yearFrom: 2019,
        yearTo: 2020,
        bodyStyle: 'suv',
        selfReportedConfidence: 0.8,
        supportedBy: ['a real make with an invented model'],
      },
    ],
    features: [
      {
        observed: 'stacked rectangular tail lights with a chrome upper bar',
        kind: 'taillight',
        legibility: 'clear',
        bbox: [0.61, 0.42, 0.78, 0.6],
      },
    ],
    jurisdictionStyle: [],
    insufficientSignal: false,
    ...overrides,
  };
}

function fakeVision(json: unknown, costUsd?: number): VehicleModule.VehicleVisionProvider {
  return {
    name: 'fake:test',
    async extract() {
      return { ok: true, value: { json, modelVersion: 'claude-opus-5', costUsd, attempts: 1 } };
    },
  };
}

/**
 * A vPIC stand-in that knows Chevrolet and Toyota but has never heard of
 * Zorbicron Motors, and lists "Silverado" but not "Zephyrion Grand" — the two
 * shapes of hallucination this module has to separate.
 */
function fakeVpic(): VehicleModule.VpicClient {
  return {
    async allMakes() {
      return {
        ok: true,
        value: [
          { makeId: 467, makeName: 'CHEVROLET' },
          { makeId: 448, makeName: 'TOYOTA' },
          { makeId: 460, makeName: 'FORD' },
        ],
      };
    },
    async modelsForMake(make) {
      const endpoint = `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeIdYear/makeId/${make.makeId}/modelyear/2019?format=json`;
      if (make.makeId === 467) {
        return {
          ok: true,
          value: {
            endpoint,
            models: [
              { makeId: 467, makeName: 'CHEVROLET', modelId: 1850, modelName: 'Silverado' },
              { makeId: 467, makeName: 'CHEVROLET', modelId: 1829, modelName: 'Camaro' },
            ],
          },
        };
      }
      if (make.makeId === 448) {
        return {
          ok: true,
          value: {
            endpoint,
            models: [{ makeId: 448, makeName: 'TOYOTA', modelId: 2100, modelName: 'Camry' }],
          },
        };
      }
      return { ok: true, value: { endpoint, models: [] } };
    },
  };
}

// ---------------------------------------------------------------------------
// The anti-hallucination check
// ---------------------------------------------------------------------------

test('a vehicle candidate rejected by vPIC does not appear as verified', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: fakeVpic() },
  );

  const makes = result.vehicles.map((v) => v.make);
  assert.ok(
    !makes.some((m) => /zorbicron/i.test(m)),
    'a make vPIC does not list must not be returned at all',
  );

  // It is not silently dropped either: the audit records why.
  const rejected = result.vpicAudit.find((a) => /Zorbicron/i.test(a.proposed.make));
  assert.ok(rejected, 'the dropped candidate must be recorded in the audit');
  assert.equal(rejected?.status, 'rejected');
  assert.match(rejected?.reason ?? '', /lists no make named/);

  // ...and the evidence ledger carries a checkable statement of the drop.
  const dropEvidence = result.evidence.find((e) => /DROPPED/.test(e.claim));
  assert.ok(dropEvidence, 'the drop belongs in the evidence ledger, not just a log line');
  assert.match(dropEvidence?.verifiable ?? '', /getallmakes/);
});

test('an unverified model keeps no vPIC model id and is ranked last', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: fakeVpic() },
  );

  const toyota = result.vehicles.find((v) => v.make === 'TOYOTA');
  assert.ok(toyota, 'a real make with an unresolved model is kept, but flagged');
  assert.equal(toyota?.vpic?.makeId, 448, 'the make was verified, so its id is present');
  assert.equal(
    toyota?.vpic?.modelId,
    undefined,
    'the ABSENT model id is the unverified signal in the contract',
  );

  const chevy = result.vehicles.find((v) => v.make === 'CHEVROLET');
  assert.ok(chevy?.vpic?.modelId, 'the fully verified candidate carries both ids');
  assert.ok(
    (chevy?.rank ?? 99) < (toyota?.rank ?? 0),
    'a vPIC-confirmed model must outrank an unverified one even with a lower self-report',
  );

  const audit = result.vpicAudit.find((a) => /Zephyrion/.test(a.proposed.model));
  assert.equal(audit?.status, 'make-only');
  assert.match(audit?.reason ?? '', /UNVERIFIED/);
});

test('taxonomy verification outranks the model self-report', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: fakeVpic() },
  );
  // Zorbicron had the highest self-report (0.95) and Toyota the second (0.8),
  // yet the verified Chevrolet (0.62) is rank 1.
  assert.equal(result.vehicles[0]?.make, 'CHEVROLET');
  assert.equal(result.vehicles[0]?.rank, 1);
});

test('trim names resolve to the vPIC model family, and say so', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: fakeVpic() },
  );
  const chevy = result.vehicles.find((v) => v.make === 'CHEVROLET');
  assert.equal(chevy?.model, 'Silverado (Silverado 1500)');
  assert.equal(chevy?.vpic?.modelId, 1850);
  const audit = result.vpicAudit.find((a) => /Silverado/.test(a.proposed.model));
  assert.match(audit?.reason ?? '', /model family/);
});

test('vPIC unreachable withholds candidates rather than returning them unvalidated', async () => {
  const brokenVpic: VehicleModule.VpicClient = {
    async allMakes() {
      return { ok: false, error: { kind: 'unavailable', reason: 'vpic.nhtsa.dot.gov unreachable' } };
    },
    async modelsForMake() {
      return { ok: false, error: { kind: 'unavailable', reason: 'unreachable' } };
    },
  };
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: brokenVpic },
  );
  assert.equal(result.vehicles.length, 0, 'an unvalidated ranking is the thing we refuse to ship');
  assert.ok(result.gaps.some((g) => g.capability === 'NHTSA vPIC validation'));
  assert.ok(result.vpicAudit.every((a) => a.status === 'unchecked'));
});

test('matchModel prefers an exact match and falls back to the family', () => {
  const models = [
    { makeId: 1, makeName: 'X', modelId: 10, modelName: 'Silverado' },
    { makeId: 1, makeName: 'X', modelId: 11, modelName: 'Silverado HD' },
    { makeId: 1, makeName: 'X', modelId: 12, modelName: 'F-150' },
  ];
  assert.equal(vehicle.matchModel('Silverado', models)?.kind, 'exact');
  assert.equal(vehicle.matchModel('Silverado', models)?.model.modelId, 10);
  // Punctuation and case are normalised away, so "F150" finds "F-150".
  assert.equal(vehicle.matchModel('f150', models)?.kind, 'exact');
  assert.equal(vehicle.matchModel('Silverado HD 2500', models)?.model.modelId, 11);
  assert.equal(vehicle.matchModel('Zephyrion', models), null);
});

test('matchMake is exact on the normalised name, never fuzzy', () => {
  const makes = [
    { makeId: 467, makeName: 'CHEVROLET' },
    { makeId: 448, makeName: 'TOYOTA' },
  ];
  assert.equal(vehicle.matchMake('chevrolet', makes)?.makeId, 467);
  assert.equal(vehicle.matchMake('Chevrolet', makes)?.makeId, 467);
  // "Chevy" is not a vPIC make. Guessing it is would be the fuzziness that lets
  // invented names through.
  assert.equal(vehicle.matchMake('Chevy', makes), null);
  assert.equal(vehicle.matchMake('Zorbicron Motors', makes), null);
});

// ---------------------------------------------------------------------------
// No plate characters, ever
// ---------------------------------------------------------------------------

test('plate characters are redacted from every field before they reach the ledger', async () => {
  const withPlates = reading({
    features: [
      {
        observed: 'rear licence plate reads 8XYZ432 below the bumper',
        kind: 'other',
        legibility: 'partial',
        bbox: null,
      },
    ],
    jurisdictionStyle: [
      {
        observed: 'white field, blue slogan across the top, characters 7ABC123',
        impliesRegions: ['California, US'],
      },
    ],
  });

  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(withPlates, 0.02), vpic: fakeVpic() },
  );

  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('8XYZ432'), 'plate characters must not survive anywhere');
  assert.ok(!serialised.includes('7ABC123'), 'plate characters must not survive anywhere');
  assert.match(serialised, /redacted/, 'the redaction must be visible, not a silent deletion');

  // The style description itself survives — that is the legitimate signal.
  assert.ok(result.evidence.some((e) => /blue slogan/.test(e.claim)));
});

test('redaction leaves legitimate model and trim names alone', () => {
  const kept = vehicle.redactPlateCharacters(
    reading({
      features: [
        {
          observed: 'Silverado 1500 badge on the tailgate, 6.2L V8 marking on the wing',
          kind: 'badge-shape',
          legibility: 'clear',
          bbox: null,
        },
      ],
    }),
  );
  assert.match(kept.features[0].observed, /Silverado 1500/, 'no plate context, no redaction');
  assert.equal(kept.candidates[0].model, 'Silverado 1500');
});

// ---------------------------------------------------------------------------
// Honest emptiness
// ---------------------------------------------------------------------------

test('no vehicle in the frame returns no candidates', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    {
      vision: fakeVision(reading({ vehiclePresent: false, candidates: [] }), 0.01),
      vpic: fakeVpic(),
    },
  );
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.vpicAudit.length, 0);
  assert.ok(result.stages.some((s) => s.stage === 'rerank' && s.skipped));
});

test('an off-contract vision response yields nothing, not a partial guess', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision({ nonsense: true }, 0.01), vpic: fakeVpic() },
  );
  assert.equal(result.vehicles.length, 0);
  assert.ok(result.gaps.some((g) => g.capability === 'Structured vehicle reading'));
});

test('a vision failure is a gap, never a thrown error', async () => {
  const failing: VehicleModule.VehicleVisionProvider = {
    name: 'fake:failing',
    async extract() {
      return { ok: false, error: { kind: 'timeout', reason: 'the model did not respond in 90000ms' } };
    },
  };
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: failing, vpic: fakeVpic() },
  );
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.costUsd, 0);
  assert.ok(result.gaps.length > 0);
});

test('bytes that are not an image are a typed refusal, not a crash', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: new Uint8Array([1, 2, 3, 4]) },
    { vision: fakeVision(reading(), 0.01), vpic: fakeVpic() },
  );
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.stages[0]?.stage, 'preprocess');
  assert.ok(result.stages[0]?.skipped, 'the preprocess stage must record why it stopped');
});

// ---------------------------------------------------------------------------
// Honest numbers
// ---------------------------------------------------------------------------

test('similarity is the self-report, and the ledger says so in those words', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: fakeVpic() },
  );
  const chevy = result.vehicles.find((v) => v.make === 'CHEVROLET');
  assert.equal(chevy?.similarity, 0.62, 'the number is passed through, not transformed');
  assert.equal(chevy?.referenceImageUrl, undefined, 'no gallery means no reference image');

  const disclosure = result.evidence.find((e) => /SELF-REPORTED/.test(e.claim));
  assert.ok(disclosure, 'presenting a self-report as a similarity without saying so is the failure');
  assert.match(disclosure?.claim ?? '', /not a measured/);
  assert.ok(result.gaps.some((g) => /Reference-image gallery/.test(g.capability)));
});

test('every piece of evidence carries a real verifiable instruction', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: fakeVpic() },
  );
  assert.ok(result.evidence.length > 0);
  for (const e of result.evidence) {
    assert.ok(e.claim.length > 0, 'a claim is required');
    assert.ok(
      e.verifiable.length > 20,
      `evidence "${e.claim.slice(0, 40)}" needs a real verification instruction`,
    );
    assert.ok(e.weight >= 0 && e.weight <= 1, 'weight must be 0..1');
  }
  // The feature evidence must point the investigator at a specific reference.
  const feature = result.evidence.find((e) => /taillight/.test(e.claim));
  assert.match(feature?.verifiable ?? '', /compare its shape against/);
  assert.match(feature?.verifiable ?? '', /Silverado/, 'it must name the ranked candidate');
});

test('cost comes from token usage, and is undefined for an unpriced model', () => {
  const cost = vehicle.anthropicCostUsd('claude-opus-5', {
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
  assert.equal(cost, 5, 'published input price is $5 per million tokens');
  assert.equal(
    vehicle.anthropicCostUsd('claude-opus-5', { input_tokens: 0, output_tokens: 1_000_000 }),
    25,
  );
  assert.equal(
    vehicle.anthropicCostUsd('a-model-we-have-no-price-for', { input_tokens: 100 }),
    undefined,
    'an unknown price must be undefined, never 0 — the call was not free',
  );
});

test('an unpriced model is reported as a cost gap rather than billed at zero', async () => {
  const provider: VehicleModule.VehicleVisionProvider = {
    name: 'fake:unpriced',
    async extract() {
      return { ok: true, value: { json: reading(), modelVersion: 'mystery-model', attempts: 1 } };
    },
  };
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: provider, vpic: fakeVpic() },
  );
  assert.equal(result.costUsd, 0);
  assert.ok(
    result.gaps.some((g) => /cost accounting/i.test(g.capability)),
    'a zero that means "unknown" has to be labelled as such',
  );
});

test('stage traces carry real elapsed times', async () => {
  const result = await vehicle.identifyVehicle(
    { uploadId: 'u1', bytes: await jpegBytes() },
    { vision: fakeVision(reading(), 0.02), vpic: fakeVpic() },
  );
  for (const stage of result.stages) {
    assert.ok(Number.isFinite(stage.ranMs) && stage.ranMs >= 0, `${stage.stage} ranMs must be real`);
  }
  assert.ok(result.stages.some((s) => s.stage === 'vlm-clues' && s.costUsd === 0.02));
  assert.match(result.sources['nhtsa-vpic'] ?? '', /vpic\.nhtsa\.dot\.gov/);
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('the reading schema rejects a single-year claim below vPIC coverage', () => {
  const bad = reading();
  bad.candidates[0].yearFrom = 1970;
  assert.equal(
    vehicle.VehicleReadingSchema.safeParse(bad).success,
    false,
    'vPIC starts at 1981, so an earlier year is unverifiable by construction',
  );
});

test('the reading schema rejects unknown fields, so a drifting model is caught', () => {
  const bad = { ...reading(), surpriseField: 'hello' };
  assert.equal(vehicle.VehicleReadingSchema.safeParse(bad).success, false);
});

test('the JSON Schema sent to the provider drops unsupported keywords', () => {
  const sanitised = vehicle.sanitiseJsonSchema({
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1981, maximum: 2031 },
      s: { type: 'string', minLength: 1, maxLength: 40, pattern: '^a' },
      a: { type: 'array', maxItems: 6, items: { type: 'string' } },
    },
    required: ['n'],
    additionalProperties: false,
  }) as Record<string, unknown>;

  const serialised = JSON.stringify(sanitised);
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'maxItems']) {
    assert.ok(!serialised.includes(key), `${key} is not supported by structured outputs`);
  }
  // The parts that carry meaning survive.
  assert.match(serialised, /additionalProperties/);
  assert.match(serialised, /required/);
  assert.match(serialised, /"type":"integer"/);
});

test('the prompt forbids plate transcription and demands a ranked set', () => {
  assert.match(vehicle.VEHICLE_PROMPT, /NEVER transcribe or guess licence-plate characters/);
  assert.match(vehicle.VEHICLE_PROMPT, /RANKED SET/);
  assert.match(vehicle.VEHICLE_PROMPT, /3 to 5 candidates/);
  assert.match(vehicle.VEHICLE_PROMPT, /not a single model year/);
});

// ---------------------------------------------------------------------------
// Live vPIC, opt-in
// ---------------------------------------------------------------------------

test('live NHTSA vPIC confirms a real model and rejects an invented make', async (t) => {
  if (process.env.LANTAGE_TEST_LIVE_VPIC !== '1') {
    t.skip('set LANTAGE_TEST_LIVE_VPIC=1 to query vpic.nhtsa.dot.gov');
    return;
  }
  vehicle.resetVpicCache();
  const client = new vehicle.NhtsaVpicClient();
  const makes = await client.allMakes();
  assert.ok(makes.ok, 'vPIC GetAllMakes must be reachable');
  if (!makes.ok) return;
  assert.ok(makes.value.length > 10_000, 'vPIC lists over 12,000 makes');

  const ford = vehicle.matchMake('Ford', makes.value);
  assert.ok(ford, 'Ford is a real make');
  assert.equal(vehicle.matchMake('Zorbicron Motors', makes.value), null);

  if (!ford) return;
  const models = await client.modelsForMake(ford, 2019);
  assert.ok(models.ok);
  if (!models.ok) return;
  assert.ok(vehicle.matchModel('F-150', models.value.models), 'the F-150 exists in 2019');
  assert.equal(vehicle.matchModel('Zephyrion Grand', models.value.models), null);
});
