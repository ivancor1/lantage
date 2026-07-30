/**
 * Orchestrator tests.
 *
 *   node --test src/lib/live/orchestrator.test.ts
 *
 * These cover the four things this file exists to guarantee, all of which are
 * failure paths:
 *
 *   1. A request that does not match the contract is refused before anything runs.
 *   2. A module that is not in this build produces a capability gap, not a crash.
 *   3. A module that throws produces a stated failure, not a 500.
 *   4. The invariants are enforced on the way out: a refused gate returns no
 *      ranking, and street precision that was not earned is downgraded.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { GeoCandidate } from '@/lib/contracts/types';
import type * as OrchestratorModule from './orchestrator';
import type * as UploadsModule from './uploads';

/*
 * Local resolve hook rather than `cascade/testing/aliasHooks`: that shim appends
 * `.ts` to every extensionless relative specifier regardless of who asked, which
 * breaks CommonJS packages inside node_modules. This version only rewrites
 * specifiers whose parent lives in our own source tree.
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

const srcRoot = nodePath.resolve(nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)), '../..');
const hasExtension = (s: string): boolean => /\.[cm]?[jt]sx?$/.test(s) || /\.(json|node)$/.test(s);

(nodeModule as unknown as ModuleHooksApi).registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const target = nodePath.join(srcRoot, specifier.slice(2));
      return next(nodeUrl.pathToFileURL(hasExtension(target) ? target : `${target}.ts`).href, context);
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

let root = '';

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lantage-orchestrator-test-'));
  process.env.LANTAGE_UPLOAD_DIR = root;
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/*
 * Variable specifiers, not literals: the repo tsconfig leaves
 * `allowImportingTsExtensions` off, so a literal './orchestrator.ts' is a
 * compile error (TS5097). The specifier is opaque to the checker and the types
 * come from the sibling `import type` above, so both halves stay type-checked.
 */
const orchestratorSpecifier = './orchestrator.ts';
const uploadsSpecifier = './uploads.ts';
const orchestrator = (await import(orchestratorSpecifier)) as typeof OrchestratorModule;
const uploads = (await import(uploadsSpecifier)) as typeof UploadsModule;

/** Return type inferred: sharp's default export is awkward to name explicitly. */
async function sharpLib() {
  return (await import('sharp')).default;
}

/** A real image of a real size, so the quality gate has something true to measure. */
async function storeImage(width: number, height: number, tint = 90): Promise<string> {
  const sharp = await sharpLib();
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 60, b: tint } },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
  const stored = await uploads.storeUpload({ filename: `${width}x${height}.jpg`, bytes: new Uint8Array(buf) });
  if (!stored.ok) throw new Error(`fixture rejected: ${stored.reason}`);
  return stored.record.id;
}

// A candidate that claims street precision on nothing but inference. This is the
// exact overclaim `assertStreetPrecisionIsEarned` exists to stop.
function unearnedStreetCandidate(): GeoCandidate {
  return {
    id: 'cand-1',
    rank: 1,
    center: { lat: 40.4406, lon: -79.9959 },
    radiusM: 120,
    precision: 'street',
    place: { label: 'Pittsburgh, Pennsylvania', country: 'US' },
    confidence: {
      band: 'moderate',
      score: 0.5,
      reason: 'A single inferred signal. Not corroborated.',
      calibration: 'test',
    },
    evidence: [
      {
        kind: 'vlm-clue',
        claim: 'Roof pitch and siding are consistent with the US north-east.',
        verifiable: 'Compare the siding profile against local housing stock in Street View.',
        weight: 0.3,
      },
    ],
    review: 'unreviewed',
  };
}

// ---------------------------------------------------------------------------
// 1. Request validation
// ---------------------------------------------------------------------------

test('FACE with one image is refused, and the issue names the field', async () => {
  const id = await storeImage(900, 700);
  await assert.rejects(
    () => orchestrator.analyze({ module: 'FACE', uploadIds: [id] }),
    (e: unknown) => {
      assert.ok(e instanceof orchestrator.LiveRequestError);
      assert.equal(e.status, 400);
      assert.ok(e.issues.some((i) => i.path === 'uploadIds' && /exactly 2 images/.test(i.message)));
      return true;
    },
  );
});

test('a single-image module refuses two images', async () => {
  const a = await storeImage(900, 700, 40);
  const b = await storeImage(900, 700, 41);
  await assert.rejects(
    () => orchestrator.analyze({ module: 'VEHICLE', uploadIds: [a, b] }),
    (e: unknown) => e instanceof orchestrator.LiveRequestError && e.status === 400,
  );
});

test('FACE refuses two ids that are the same file', async () => {
  const id = await storeImage(900, 700, 60);
  await assert.rejects(
    () => orchestrator.analyze({ module: 'FACE', uploadIds: [id, id] }),
    (e: unknown) => {
      assert.ok(e instanceof orchestrator.LiveRequestError);
      assert.match(e.issues.map((i) => i.message).join(' '), /similarity of 1\.0/);
      return true;
    },
  );
});

test('an unknown module is refused', async () => {
  const id = await storeImage(900, 700, 61);
  await assert.rejects(
    () =>
      orchestrator.analyze({
        module: 'PLATE' as unknown as 'LOCATE',
        uploadIds: [id],
      }),
    (e: unknown) => e instanceof orchestrator.LiveRequestError && e.status === 400,
  );
});

test('an unknown upload id is a 404, not a 500', async () => {
  await assert.rejects(
    () => orchestrator.analyze({ module: 'LOCATE', uploadIds: ['c'.repeat(64)] }),
    (e: unknown) => {
      assert.ok(e instanceof orchestrator.LiveRequestError);
      assert.equal(e.status, 404);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 2. A missing module is a gap, not a crash
// ---------------------------------------------------------------------------

test('a module that is not in the build reports a capability gap and no result', async () => {
  const id = await storeImage(1200, 900, 70);
  const result = await orchestrator.analyze(
    { module: 'LOCATE', uploadIds: [id] },
    { modules: { LOCATE: null } },
  );

  assert.equal(result.module, 'LOCATE');
  assert.equal(result.geo, undefined, 'no section is invented for a module that did not run');
  assert.ok(result.unavailable.some((g) => /Locate module/.test(g.capability)));
  assert.ok(result.unavailable.some((g) => /not part of this build/.test(g.impact)));
  // The measurement stages still ran and are still reported honestly.
  assert.deepEqual(
    result.stages.map((s) => s.stage),
    ['preprocess', 'quality-gate'],
  );
  assert.equal(result.provenance.totalCostUsd, 0);
  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0].path, undefined, 'the disk path never leaves the server');
});

// ---------------------------------------------------------------------------
// 3. A module that throws, or answers off-contract
// ---------------------------------------------------------------------------

test('a module that throws becomes a stated failure', async () => {
  const id = await storeImage(1200, 900, 71);
  const result = await orchestrator.analyze(
    { module: 'VEHICLE', uploadIds: [id] },
    {
      modules: {
        VEHICLE: async () => {
          throw new Error('vPIC lookup exploded');
        },
      },
    },
  );
  assert.equal(result.vehicles, undefined);
  assert.ok(result.unavailable.some((g) => /vPIC lookup exploded/.test(g.impact)));
});

test('a candidate with no verifiable evidence is dropped, not displayed', async () => {
  const id = await storeImage(1200, 900, 72);
  const bad = unearnedStreetCandidate();
  const result = await orchestrator.analyze(
    { module: 'LOCATE', uploadIds: [id] },
    {
      modules: {
        LOCATE: async () => ({
          geo: [
            {
              ...bad,
              precision: 'region',
              // `verifiable` missing: a signal nobody can check is telemetry.
              evidence: [{ kind: 'vlm-clue', claim: 'Looks European.', weight: 0.2 }],
            },
          ],
          evidence: [],
          stages: [],
          gaps: [],
          models: {},
          costUsd: 0,
        }),
      },
    },
  );
  assert.equal(result.geo, undefined);
  assert.ok(result.unavailable.some((g) => /result validation/.test(g.capability)));
});

// ---------------------------------------------------------------------------
// 4. Invariants on the way out
// ---------------------------------------------------------------------------

test('unearned street precision is widened rather than shipped', async () => {
  const id = await storeImage(1200, 900, 73);
  const result = await orchestrator.analyze(
    { module: 'LOCATE', uploadIds: [id] },
    {
      modules: {
        LOCATE: async () => ({
          geo: [unearnedStreetCandidate()],
          evidence: [],
          stages: [{ stage: 'vlm-clues', ranMs: 12, costUsd: 0.00225 }],
          gaps: [],
          models: { vlm: 'test-model@1' },
          costUsd: 0.00225,
        }),
      },
    },
  );

  assert.equal(result.geo?.length, 1);
  assert.notEqual(result.geo?.[0].precision, 'street');
  assert.ok((result.geo?.[0].radiusM ?? 0) > 120, 'the region must widen, not stay a pin');
  assert.ok(result.unavailable.some((g) => g.capability === 'Street-level precision'));
  // Real cost and real models are carried through from the module.
  assert.equal(result.provenance.totalCostUsd, 0.00225);
  assert.equal(result.provenance.models.vlm, 'test-model@1');
  assert.ok(result.stages.some((s) => s.stage === 'vlm-clues'));
});

test('street precision earned by a retrieval match survives untouched', async () => {
  const id = await storeImage(1200, 900, 74);
  const earned: GeoCandidate = {
    ...unearnedStreetCandidate(),
    evidence: [
      {
        kind: 'vpr-match',
        claim: 'Matches Mapillary panorama 1234 at cosine 0.71.',
        verifiable: 'Open the linked panorama and compare the roofline.',
        weight: 0.6,
      },
    ],
  };
  const result = await orchestrator.analyze(
    { module: 'LOCATE', uploadIds: [id] },
    {
      modules: {
        LOCATE: async () => ({ geo: [earned], evidence: [], stages: [], gaps: [], models: {}, costUsd: 0 }),
      },
    },
  );
  assert.equal(result.geo?.[0].precision, 'street');
  assert.equal(result.geo?.[0].radiusM, 120);
  assert.equal(
    result.unavailable.some((g) => g.capability === 'Street-level precision'),
    false,
  );
});

test('a refused quality gate returns no ranking and nothing is spent', async () => {
  // 200px long edge is under the 320px retrieval floor: the gate refuses.
  const id = await storeImage(200, 150, 75);
  let moduleRan = false;
  const result = await orchestrator.analyze(
    { module: 'LOCATE', uploadIds: [id] },
    {
      modules: {
        LOCATE: async () => {
          moduleRan = true;
          return {
            geo: [unearnedStreetCandidate()],
            evidence: [],
            stages: [],
            gaps: [],
            models: {},
            costUsd: 5,
          };
        },
      },
    },
  );

  assert.equal(result.quality.passed, false);
  assert.equal(result.geo, undefined, 'a failed gate returns the refusal, not a ranking');
  assert.equal(moduleRan, false, 'nothing is spent on a frame the gate already refused');
  assert.equal(result.provenance.totalCostUsd, 0);
  assert.match(result.quality.refusalReason ?? '', /320px/);
  assert.ok(result.unavailable.some((g) => /ranking/.test(g.capability)));
});

test('a ranking returned despite a refused gate is withheld', async () => {
  // FACE runs even on a refused gate — it owns the only gate that matters for it —
  // so it is the path where a module could hand back a ranking after a refusal.
  const small = await storeImage(200, 150, 76);
  const other = await storeImage(200, 150, 77);
  const result = await orchestrator.analyze(
    { module: 'FACE', uploadIds: [small, other] },
    {
      modules: {
        FACE: async () => ({
          // Off-contract on purpose: a face module has no business returning geo.
          geo: [{ ...unearnedStreetCandidate(), precision: 'region' as const, radiusM: 40_000 }],
          face: {
            verdict: 'refused',
            confidence: { band: 'refused', score: 0, reason: 'Inter-eye distance too small.', calibration: 'test' },
            probes: [],
            refusalReason: 'Both probes are below the recognition floor.',
          },
          evidence: [],
          stages: [],
          gaps: [],
          models: {},
          costUsd: 0,
        }),
      },
    },
  );

  assert.equal(result.quality.passed, false);
  assert.equal(result.geo, undefined);
  assert.equal(result.face?.verdict, 'refused');
  assert.ok(result.unavailable.some((g) => /withheld|ranking/i.test(g.impact + g.capability)));
});

// ---------------------------------------------------------------------------
// AUTHENTIC, end to end, with no keys at all
// ---------------------------------------------------------------------------

test('AUTHENTIC runs offline and never asserts authenticity', async () => {
  delete process.env.HIVE_API_KEY;
  delete process.env.HIVE_API_URL;

  const id = await storeImage(1600, 1200, 80);
  const result = await orchestrator.analyze({ module: 'AUTHENTIC', uploadIds: [id] });

  assert.ok(result.authenticity, 'AUTHENTIC must produce a result with no keys set');
  const verdict = result.authenticity?.verdict ?? '';
  assert.notEqual(verdict as string, 'authentic');
  assert.ok(['no-indicators-found', 'inconclusive', 'weak-indicators'].includes(verdict));

  // The C2PA line must be present and must not read as an indicator.
  const c2pa = result.authenticity?.evidence.find((e) => e.kind === 'c2pa');
  assert.ok(c2pa, 'the provenance line is always recorded');
  assert.equal(c2pa?.weight, 0, 'absence of a manifest carries no weight');
  assert.match(c2pa?.claim ?? '', /NOT evidence of manipulation/);

  // PPV is surfaced, and the detector is reported as the missing capability.
  assert.equal(typeof result.authenticity?.ppv.value, 'number');
  assert.equal(typeof result.authenticity?.ppv.assumedBaseRate, 'number');
  assert.ok(
    result.unavailable.some((g) => /Statistical AI-generation detector/.test(g.capability)),
    'a missing detector is stated, with the env var',
  );
  assert.ok(result.unavailable.some((g) => g.envVar?.includes('HIVE_API_KEY')));
  assert.equal(result.provenance.totalCostUsd, 0, 'offline means free');
  assert.ok(result.stages.some((s) => s.stage === 'provenance'));
  assert.ok(result.stages.some((s) => s.stage === 'detector' && s.skipped));
});
