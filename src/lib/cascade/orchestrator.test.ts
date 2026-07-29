/**
 * Cascade smoke tests.
 *
 *   node --test src/lib/cascade/orchestrator.test.ts
 *
 * Every external dependency is stubbed, so these run offline and assert the
 * things that must be true of a shipped result: the gate short-circuits, the
 * escalation gate spends money only when the prior is weak, retrieval is pruned
 * to a region, a dead dependency degrades instead of throwing, and the trace and
 * provenance are populated.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from './testing/aliasHooks';
import type * as OrchestratorModule from './orchestrator';
import type { EmbedResponse } from '@/lib/contracts/schemas';
import type { SearchRequest, StageTrace } from '@/lib/contracts/types';
import type { CascadeRuntime } from './deps';
import type { EmbedArgs, EmbedClient } from './embedClient';
import type { GeoVectorSearch } from './vprRetrieval';
import type { Bbox, Result, StageFailure } from './types';

const hooksSpecifier = './testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const orchestratorSpecifier = './orchestrator.ts';
const { runCascade, ModuleNotImplementedError } = (await import(
  orchestratorSpecifier
)) as typeof OrchestratorModule;

const PITTSBURGH = { lat: 40.4406, lon: -79.9959 };

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function stubEmbed(options: {
  priorScore: number;
  spreadDeg?: number;
  fail?: boolean;
  /** Fail only for these models, e.g. ['geoclip'] to kill the prior but not retrieval. */
  failModels?: string[];
}): EmbedClient & { calls: EmbedArgs[] } {
  const calls: EmbedArgs[] = [];
  return {
    calls,
    async embed(args: EmbedArgs): Promise<Result<EmbedResponse, StageFailure>> {
      calls.push(args);
      const failThis =
        options.fail || (options.failModels?.some((m) => args.models.includes(m as never)) ?? false);
      if (failThis) {
        return { ok: false, error: { kind: 'unavailable', reason: 'stub embed service is down' } };
      }
      const spread = options.spreadDeg ?? 0.05;
      return {
        ok: true,
        value: {
          embeddings: Object.fromEntries(
            args.models.map((m) => [
              m,
              { vector: [0.1, 0.2, 0.3], dim: 3, model: m, version: '1.0-test' },
            ]),
          ),
          geoPrior: [
            { ...PITTSBURGH, score: options.priorScore },
            { lat: PITTSBURGH.lat + spread, lon: PITTSBURGH.lon + spread, score: options.priorScore * 0.9 },
            { lat: PITTSBURGH.lat - spread, lon: PITTSBURGH.lon - spread, score: options.priorScore * 0.8 },
          ],
          tookMs: 120,
        },
      };
    },
  };
}

function stubVectorSearch(similarity: number): GeoVectorSearch & { bboxes: Bbox[] } {
  const bboxes: Bbox[] = [];
  return {
    bboxes,
    async searchGeoCandidates(args) {
      bboxes.push(args.bbox);
      return {
        ok: true,
        value: {
          hits: [
            { mapillaryId: 'm1', ...PITTSBURGH, similarity, compassAngle: 90 },
            { mapillaryId: 'm2', lat: PITTSBURGH.lat + 0.0004, lon: PITTSBURGH.lon, similarity: similarity - 0.05, compassAngle: 180 },
            { mapillaryId: 'm3', lat: PITTSBURGH.lat + 0.2, lon: PITTSBURGH.lon + 0.2, similarity: similarity - 0.3, compassAngle: 270 },
          ],
          indexBuild: 'mapillary-pittsburgh@test',
        },
      };
    },
  };
}

function runtime(overrides: Partial<CascadeRuntime> = {}): CascadeRuntime {
  return {
    embed: stubEmbed({ priorScore: 0.95 }),
    vlm: null,
    vectorSearch: null,
    rerankStore: null,
    geocoder: null,
    ecoregion: {
      name: 'test-mask',
      async sample() {
        return { ok: false, error: { kind: 'not-configured', reason: 'no raster in tests' } };
      },
    },
    c2pa: null,
    detector: null,
    imageStore: null,
    resultStore: null,
    auth: null,
    audit: null,
    ...overrides,
  };
}

const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Header-valid JPEG at a chosen size and libjpeg quality. */
function jpeg(width: number, height: number, quality = 92, filler = 8192): Uint8Array {
  const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  const table = STD_LUMA.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
  const out: number[] = [0xff, 0xd8];
  out.push(0xff, 0xdb, 0x00, 0x43, 0x00, ...table);
  out.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  );
  out.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  for (let i = 0; i < filler; i += 1) out.push((i * 31) % 251);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { module: 'GEO', imageId: 'img-1', ...overrides };
}

function traceFor(stages: StageTrace[], name: StageTrace['stage']): StageTrace | undefined {
  return stages.find((s) => s.stage === name);
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

test('a frame below the resolution floor is refused with no ranking', async () => {
  const result = await runCascade(
    { searchId: 's-refuse', request: request(), image: { imageId: 'img-1', bytes: jpeg(200, 150) } },
    runtime(),
  );
  assert.equal(result.quality.passed, false);
  assert.match(result.quality.refusalReason ?? '', /Resolution is 200x150/);
  assert.equal(result.geo, undefined, 'a refusal must not carry candidates');
  // Nothing downstream was allowed to spend money.
  assert.equal(traceFor(result.stages, 'embedding-prior'), undefined);
  assert.equal(result.provenance.totalCostUsd, 0);
});

test('an unreadable image is refused rather than guessed at', async () => {
  const result = await runCascade(
    { searchId: 's-empty', request: request(), image: { imageId: 'img-1' } },
    runtime(),
  );
  assert.equal(result.quality.passed, false);
  assert.equal(result.geo, undefined);
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a confident prior plus retrieval yields a street-precision candidate', async () => {
  const search = stubVectorSearch(0.86);
  const result = await runCascade(
    {
      searchId: 's-happy',
      request: request(),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
    },
    runtime({ embed: stubEmbed({ priorScore: 0.95 }), vectorSearch: search }),
  );

  assert.equal(result.quality.passed, true);
  assert.ok(result.geo && result.geo.length > 0);
  const top = result.geo[0];
  assert.equal(top.rank, 1);
  assert.equal(top.precision, 'street', 'a strong retrieval match earns street precision');
  assert.ok(top.evidence.some((e) => e.kind === 'vpr-match'));
  assert.ok(top.radiusM > 0);
  assert.ok(top.confidence.reason.length > 0);
  assert.ok(top.confidence.calibration.length > 0);
  assert.equal(top.review, 'unreviewed');

  // Every evidence line has to be independently checkable.
  for (const line of top.evidence) assert.ok(line.verifiable.length > 10);

  // Provenance is populated with what actually ran.
  assert.match(result.provenance.models.vpr ?? '', /eigenplaces/);
  assert.equal(result.provenance.indexBuild, 'mapillary-pittsburgh@test');
  assert.ok((result.provenance.benchmarkRef ?? '').length > 0);
  assert.ok(result.provenance.totalCostUsd > 0, 'per-stage cost must be real, not zero');

  // Retrieval was pruned to a region, not run over the planet.
  assert.equal(search.bboxes.length, 1);
  const [west, south, east, north] = search.bboxes[0];
  assert.ok(west < PITTSBURGH.lon && east > PITTSBURGH.lon);
  assert.ok(south < PITTSBURGH.lat && north > PITTSBURGH.lat);
  assert.ok(east - west < 10 && north - south < 10, 'the prune must actually narrow the search');
});

test('a strong prior does not spend money on the vision model', async () => {
  const result = await runCascade(
    {
      searchId: 's-gate',
      request: request(),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
    },
    runtime({ embed: stubEmbed({ priorScore: 0.98 }), vectorSearch: stubVectorSearch(0.8) }),
  );
  const vlm = traceFor(result.stages, 'vlm-clues');
  assert.ok(vlm?.skipped, 'the VLM must be gated off on a confident prior');
  assert.match(vlm.skipped.reason, /above the escalation threshold/);
  assert.equal(vlm.costUsd ?? 0, 0);
});

test('a weak prior escalates, and a missing provider degrades instead of failing', async () => {
  const result = await runCascade(
    {
      searchId: 's-escalate',
      request: request(),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
    },
    runtime({ embed: stubEmbed({ priorScore: 0.2 }), vectorSearch: stubVectorSearch(0.8) }),
  );
  const vlm = traceFor(result.stages, 'vlm-clues');
  assert.match(vlm?.skipped?.reason ?? '', /no vision provider is configured/);
  assert.ok(result.geo && result.geo.length > 0, 'the cascade still returned a result');
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test('with no index wired the result is coarse, never street', async () => {
  const result = await runCascade(
    {
      searchId: 's-noindex',
      request: request(),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
    },
    runtime({ embed: stubEmbed({ priorScore: 0.9 }) }),
  );
  assert.match(traceFor(result.stages, 'vpr-retrieval')?.skipped?.reason ?? '', /not wired/);
  assert.ok(result.geo && result.geo.length === 1);
  assert.notEqual(result.geo[0].precision, 'street');
  assert.ok(result.geo[0].evidence.some((e) => e.kind === 'embedding-prior'));
});

test('a dead embedding service refuses to run an unpruned index scan', async () => {
  const result = await runCascade(
    {
      searchId: 's-deadembed',
      request: request(),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
    },
    runtime({ embed: stubEmbed({ priorScore: 0.9, fail: true }), vectorSearch: stubVectorSearch(0.9) }),
  );
  assert.match(traceFor(result.stages, 'embedding-prior')?.skipped?.reason ?? '', /down/);
  assert.match(
    traceFor(result.stages, 'vpr-retrieval')?.skipped?.reason ?? '',
    /not permitted to scan the whole index/,
  );
  assert.equal(result.geo?.length ?? 0, 0, 'no prior and no match means no candidate');
  assert.equal(result.quality.passed, true, 'the image was fine — the pipeline was not');
});

test("an analyst's bbox hint prunes retrieval even with no model prior", async () => {
  const hint: Bbox = [-80.1, 40.35, -79.85, 40.5];
  const search = stubVectorSearch(0.7);
  const result = await runCascade(
    {
      searchId: 's-hint',
      request: request({ hints: { bbox: hint } }),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
    },
    // The coarse prior is dead; retrieval still works, so the hint is the prune.
    runtime({ embed: stubEmbed({ priorScore: 0.9, failModels: ['geoclip'] }), vectorSearch: search }),
  );
  assert.deepEqual(search.bboxes[0], hint);
  assert.ok(result.geo && result.geo.length > 0);
});

test('a degraded frame cannot produce a high band', async () => {
  const result = await runCascade(
    {
      searchId: 's-degraded',
      request: request(),
      // 480px long edge: over the refusal floor, under the reliable-retrieval one.
      image: { imageId: 'img-1', bytes: jpeg(480, 360) },
    },
    runtime({ embed: stubEmbed({ priorScore: 0.95 }), vectorSearch: stubVectorSearch(0.95) }),
  );
  assert.equal(result.quality.degraded, true);
  assert.ok(result.geo && result.geo.length > 0);
  for (const candidate of result.geo) {
    assert.equal(candidate.confidence.band, 'weak', 'no band may survive a degraded frame');
  }
  // The strongest candidate would have banded higher, so it must say it was capped
  // and why — a silent downgrade is not an explanation.
  assert.match(result.geo[0].confidence.reason, /Capped at 'weak'/);
  assert.match(result.geo[0].confidence.reason, /Resolution is 480x360/);
});

// ---------------------------------------------------------------------------
// Module dispatch
// ---------------------------------------------------------------------------

test('VERIFY runs the authenticity path and reports PPV', async () => {
  const result = await runCascade(
    {
      searchId: 's-verify',
      request: request({ module: 'VERIFY' }),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
    },
    runtime({
      c2pa: {
        name: 'test-c2pa',
        async read() {
          return { ok: true, value: { hasManifest: false } };
        },
      },
    }),
  );
  assert.ok(result.authenticity);
  assert.equal(result.authenticity.verdict, 'no-indicators-found');
  assert.equal(result.authenticity.provenance.hasManifest, false);
  assert.ok(result.authenticity.evidence.length > 0);
  // Absence of a manifest must be stated as meaningless, not as a finding.
  const c2paLine = result.authenticity.evidence.find((e) => e.kind === 'c2pa');
  assert.match(c2paLine?.claim ?? '', /NOT evidence of manipulation/i);
  assert.equal(c2paLine?.weight, 0);
  assert.equal(result.authenticity.ppv.assumedBaseRate > 0, true);
  assert.equal(result.geo, undefined);
});

test('an unbuilt module is a 501, not an empty result', async () => {
  await assert.rejects(
    () =>
      runCascade(
        {
          searchId: 's-vehicle',
          request: request({ module: 'VEHICLE' }),
          image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
        },
        runtime(),
      ),
    (e: unknown) => e instanceof ModuleNotImplementedError,
  );
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test('stage progress is emitted in order for the live readout', async () => {
  const events: string[] = [];
  await runCascade(
    {
      searchId: 's-progress',
      request: request(),
      image: { imageId: 'img-1', bytes: jpeg(1600, 1200) },
      onProgress: (event) => {
        if (event.type === 'stage-start') events.push(event.stage);
      },
    },
    runtime({ embed: stubEmbed({ priorScore: 0.9 }), vectorSearch: stubVectorSearch(0.8) }),
  );
  assert.deepEqual(events.slice(0, 5), [
    'preprocess',
    'quality-gate',
    'embedding-prior',
    'vlm-clues',
    'vpr-retrieval',
  ]);
});
