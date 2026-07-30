/**
 * FACE compare tests.
 *
 *   node --test src/lib/live/face.test.ts
 *
 * The load-bearing tests here are the negative ones. A face matcher that returns
 * a number for every input is worthless; the thing that has to be true is that
 * unmatchable input produces a refusal with no similarity attached, and that an
 * upscaled probe cannot launder its way past the gate.
 *
 * Tests that need the real ONNX weights skip themselves when the model directory
 * is empty, so this file passes on a fresh checkout and actually exercises the
 * models when they are present.
 */

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type * as FaceModule from './face';

/*
 * Local resolve hook rather than `cascade/testing/aliasHooks`. That shim appends
 * `.ts` to every extensionless relative specifier regardless of who asked, which
 * breaks CommonJS packages inside node_modules — `onnxruntime-node` requires
 * './backend' internally and ends up looking for './backend.ts'. This version
 * only rewrites specifiers whose parent lives in our own source tree.
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

const specifier = './face.ts';
const face = (await import(specifier)) as typeof FaceModule;

const MODEL_DIR =
  process.env.LANTAGE_FACE_MODEL_DIR ?? path.join(process.cwd(), '.lantage-models', 'face');

async function modelsPresent(): Promise<boolean> {
  try {
    await access(path.join(MODEL_DIR, face.FACE_MODEL.detector.file));
    await access(path.join(MODEL_DIR, face.FACE_MODEL.recogniser.file));
    return true;
  } catch {
    return false;
  }
}

/** Return type inferred: sharp's default export is awkward to name explicitly. */
async function sharpLib() {
  return (await import('sharp')).default;
}

// ---------------------------------------------------------------------------
// The quality gate — pure, so it is tested without any image at all
// ---------------------------------------------------------------------------

test('below-threshold inter-eye distance refuses, and never with a similarity', () => {
  const gate = face.gateForProbe({
    facesDetected: 1,
    interEyeDistancePx: face.FACE_GATE.refuseInterEyePx - 1,
    detectionScore: 0.99,
  });
  assert.equal(gate.passed, false, 'a probe under the floor must not pass');
  assert.ok(gate.reason, 'a refusal must carry a reason the analyst can act on');
  assert.match(gate.reason ?? '', /below the 32px/);
});

test('the floor is the conservative end of the published 24-32px band', () => {
  assert.equal(face.FACE_GATE.refuseInterEyePx, 32);
  assert.ok(face.FACE_GATE.refuseInterEyePx > 21, 'must sit above the ~21px recognition floor');
  assert.ok(face.FACE_GATE.recommendedInterEyePx === 40);
  assert.ok(face.FACE_GATE.enrolmentInterEyePx === 90, 'ISO/IEC 39794-5 enrolment figure');
});

test('between the floor and the recommended minimum, proceed but degraded', () => {
  const gate = face.gateForProbe({
    facesDetected: 1,
    interEyeDistancePx: 35,
    detectionScore: 0.9,
  });
  assert.equal(gate.passed, true);
  assert.equal(gate.degraded, true, 'sub-40px input must cap the band');
});

test('zero faces detected is a refusal, not an error', () => {
  const gate = face.gateForProbe({ facesDetected: 0 });
  assert.equal(gate.passed, false);
  assert.match(gate.reason ?? '', /No face was detected/);
});

test('a low-confidence detection is refused rather than ranked', () => {
  const gate = face.gateForProbe({
    facesDetected: 1,
    interEyeDistancePx: 200,
    detectionScore: face.FACE_GATE.minDetectionScore - 0.05,
  });
  assert.equal(gate.passed, false);
  assert.match(gate.reason ?? '', /Detector confidence/);
});

test('an upscaled probe is gated on effective, not apparent, inter-eye distance', () => {
  // 160px apparent at a detected 4x upscale is ~40px of real detail: below the
  // 90px an upscaled probe has to clear, because the factor is a lower bound.
  const gate = face.gateForProbe({
    facesDetected: 1,
    interEyeDistancePx: 160,
    resampleFactor: 4,
    detectionScore: 0.95,
  });
  assert.equal(gate.passed, false, 'a super-resolved probe must not be treated as matchable');
  assert.equal(gate.effectiveInterEyePx, 40);
  assert.match(gate.reason ?? '', /lower bound/);
  assert.match(gate.reason ?? '', /39794-5/);
});

test('a genuine enlargement of a high-resolution capture still passes, but degraded', () => {
  const gate = face.gateForProbe({
    facesDetected: 1,
    interEyeDistancePx: 660,
    resampleFactor: 2,
    detectionScore: 0.95,
  });
  assert.equal(gate.passed, true, '330px of real detail is plainly matchable');
  assert.equal(gate.degraded, true, 'but any detected interpolation caps the band');
});

// ---------------------------------------------------------------------------
// Verdict banding
// ---------------------------------------------------------------------------

test('the verdict has an inconclusive band around the threshold, not a hard cut', () => {
  const t = face.FACE_THRESHOLD.value;
  const m = face.FACE_INCONCLUSIVE_MARGIN;
  assert.equal(face.verdictFromSimilarity(t + m + 0.01), 'same-person');
  assert.equal(face.verdictFromSimilarity(t - m - 0.01), 'different-person');
  assert.equal(face.verdictFromSimilarity(t), 'inconclusive');
  assert.equal(face.verdictFromSimilarity(t + m - 0.001), 'inconclusive');
  assert.equal(face.verdictFromSimilarity(t - m + 0.001), 'inconclusive');
});

test('the threshold states where the number came from', () => {
  assert.equal(face.FACE_THRESHOLD.value, 0.363);
  assert.match(face.FACE_THRESHOLD.basis, /OpenCV Zoo/);
  assert.match(face.FACE_THRESHOLD.basis, /NOT a Lantage-calibrated/);
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test('the similarity transform recovers a known scale, rotation and translation', () => {
  const src: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [5, 5],
  ];
  const scale = 2.5;
  const theta = 0.37;
  const cos = Math.cos(theta) * scale;
  const sin = Math.sin(theta) * scale;
  const dst = src.map(
    ([x, y]) => [cos * x - sin * y + 17, sin * x + cos * y - 4] as [number, number],
  );
  const m = face.similarityTransform(src, dst);
  for (let i = 0; i < src.length; i += 1) {
    const x = m[0] * src[i][0] + m[1] * src[i][1] + m[2];
    const y = m[3] * src[i][0] + m[4] * src[i][1] + m[5];
    assert.ok(Math.abs(x - dst[i][0]) < 1e-6, `x mismatch at ${i}`);
    assert.ok(Math.abs(y - dst[i][1]) < 1e-6, `y mismatch at ${i}`);
  }
});

test('cosine similarity of a unit vector with itself is 1, and with its negation -1', () => {
  const v = new Float32Array([0.6, 0.8]);
  const neg = new Float32Array([-0.6, -0.8]);
  assert.ok(Math.abs(face.cosineSimilarity(v, v) - 1) < 1e-6);
  assert.ok(Math.abs(face.cosineSimilarity(v, neg) + 1) < 1e-6);
  assert.ok(Number.isNaN(face.cosineSimilarity(v, new Float32Array([1, 2, 3]))));
});

test('the resample estimator finds no signature in random (fully broadband) pixels', () => {
  const w = 96;
  const h = 96;
  const gray = new Float64Array(w * h);
  // Deterministic LCG rather than Math.random, so a failure is reproducible.
  let seed = 12345;
  for (let i = 0; i < gray.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    gray[i] = (seed % 256);
  }
  assert.equal(face.estimateResampleFactor(gray, w, h), 1);
});

function noise(w: number, h: number, seedStart: number): Float64Array {
  const out = new Float64Array(w * h);
  let seed = seedStart;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = seed % 256;
  }
  return out;
}

test('the resample estimator detects a 2x nearest-neighbour enlargement', () => {
  const sw = 48;
  const sh = 48;
  const small = noise(sw, sh, 999);
  const w = sw * 2;
  const h = sh * 2;
  const big = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      big[y * w + x] = small[Math.floor(y / 2) * sw + Math.floor(x / 2)];
    }
  }
  assert.ok(
    face.estimateResampleFactor(big, w, h) >= 2,
    'block replication is the crudest way to inflate a thumbnail and must be caught',
  );
});

/**
 * A lanczos enlargement of textured photographic-like content, which is the
 * realistic laundering path. 4x is inside the coverage documented on
 * FACE_RESAMPLE (2x is a known miss, so asserting it here would be asserting a
 * capability we measured and do not have).
 */
test('the resample estimator detects a 4x smooth enlargement of textured content', async () => {
  const sharp = await sharpLib();
  const side = 120;
  const raw = Buffer.alloc(side * side);
  let seed = 7;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = seed % 256;
  }
  // Blur to give the noise the spatial correlation a photograph has.
  const base = await sharp(raw, { raw: { width: side, height: side, channels: 1 } })
    .blur(1.1)
    .png()
    .toBuffer();

  const readGrey = async (buf: Buffer): Promise<{ g: Float64Array; w: number; h: number }> => {
    const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const g = new Float64Array(info.width * info.height);
    for (let i = 0; i < g.length; i += 1) g[i] = data[i];
    return { g, w: info.width, h: info.height };
  };

  const native = await readGrey(base);
  assert.equal(
    face.estimateResampleFactor(native.g, native.w, native.h),
    1,
    'a natively captured texture must not be accused of being upscaled',
  );

  const enlarged = await readGrey(
    await sharp(base).resize({ width: side * 4, kernel: 'lanczos3' }).png().toBuffer(),
  );
  assert.ok(
    face.estimateResampleFactor(enlarged.g, enlarged.w, enlarged.h) >= 2,
    'a 4x enlargement must be detected, even if the factor is under-reported',
  );
});

test('a flat region is not accused of being upscaled', () => {
  const gray = new Float64Array(64 * 64).fill(128);
  assert.equal(face.estimateResampleFactor(gray, 64, 64), 1);
});

// ---------------------------------------------------------------------------
// End to end, against the real weights
// ---------------------------------------------------------------------------

test('a missing model refuses with a capability gap, never a fabricated match', async () => {
  face.resetFaceModelCache();
  // Auto-fetch off, so this exercises the missing-weights path deterministically
  // and touches no network.
  const previous = process.env.LANTAGE_FACE_MODEL_FETCH;
  process.env.LANTAGE_FACE_MODEL_FETCH = '0';
  try {
    const sharp = await sharpLib();
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const bytes = new Uint8Array(png);
    const run = await face.runFaceCompare(
      { uploadId: 'a', bytes },
      { uploadId: 'b', bytes },
      { modelDir: path.join(process.cwd(), '.lantage-models', '__missing_for_test__') },
    );

    assert.equal(run.face.verdict, 'refused');
    assert.equal(run.face.similarity, undefined, 'a refusal must carry no similarity');
    assert.equal(run.face.threshold, undefined, 'no threshold is reported when nothing was scored');
    assert.equal(run.face.confidence.band, 'refused');
    assert.ok(run.face.refusalReason);
    assert.ok(
      run.gaps.some((g) => g.capability === face.FACE_MODEL_GAP.capability),
      'the missing model must be reported as a capability gap',
    );
    assert.match(
      face.FACE_MODEL_GAP.impact,
      /biometric/,
      'the gap must say why there is no vision-model fallback',
    );
  } finally {
    if (previous === undefined) delete process.env.LANTAGE_FACE_MODEL_FETCH;
    else process.env.LANTAGE_FACE_MODEL_FETCH = previous;
    face.resetFaceModelCache();
  }
});

test('zero faces detected yields a truthful probe rather than an error', async (t) => {
  if (!(await modelsPresent())) {
    t.skip(`weights not in ${MODEL_DIR}`);
    return;
  }
  const sharp = await sharpLib();
  const flat = await sharp({
    create: { width: 900, height: 700, channels: 3, background: { r: 40, g: 90, b: 60 } },
  })
    .png()
    .toBuffer();
  const bytes = new Uint8Array(flat);

  const run = await face.runFaceCompare({ uploadId: 'a', bytes }, { uploadId: 'b', bytes });

  assert.equal(run.face.verdict, 'refused');
  assert.equal(run.face.similarity, undefined, 'no faces means no similarity, not zero');
  assert.equal(run.face.probes.length, 2);
  for (const probe of run.face.probes) {
    assert.equal(probe.facesDetected, 0, 'the probe must report the truth: zero faces');
    assert.equal(probe.passedGate, false);
    assert.equal(probe.selected, undefined, 'nothing was selected, so nothing is reported');
    assert.ok(probe.note, 'a zero-face probe must explain itself');
  }
  assert.match(run.face.refusalReason ?? '', /No face was detected/);
  assert.equal(run.quality.passed, false);
  // The refusal is honoured: no ranking accompanies a failed gate.
  assert.equal(run.face.threshold, undefined);
});

test('OFIQ absence is reported as a gap rather than filled in with invented scores', async () => {
  const sharp = await sharpLib();
  const flat = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .png()
    .toBuffer();
  const bytes = new Uint8Array(flat);
  const run = await face.runFaceCompare({ uploadId: 'a', bytes }, { uploadId: 'b', bytes });
  assert.equal(run.quality.unifiedScore, undefined, 'we do not run OFIQ, so there is no score');
  assert.equal(run.quality.components.blur, undefined);
  assert.equal(run.quality.components.occlusion, undefined);
  assert.ok(run.gaps.some((g) => g.capability === face.OFIQ_GAP.capability));
});

test('the module never throws, even on bytes that are not an image', async () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const run = await face.runFaceCompare({ uploadId: 'a', bytes: junk }, { uploadId: 'b', bytes: junk });
  assert.equal(run.face.verdict, 'refused');
  assert.equal(run.face.similarity, undefined);
  assert.ok(run.face.refusalReason);
});

test('a missing path and missing bytes is a refusal, not a crash', async () => {
  const run = await face.runFaceCompare({ uploadId: 'a' }, { uploadId: 'b' });
  assert.equal(run.face.verdict, 'refused');
  assert.equal(run.face.similarity, undefined);
});

test('confidence never claims high: a 1:1 compare is one uncalibrated signal', async (t) => {
  if (!(await modelsPresent())) {
    t.skip(`weights not in ${MODEL_DIR}`);
    return;
  }
  // Two copies of the same synthetic frame cannot produce a face, so this
  // asserts the invariant through the refusal path; the banding logic itself is
  // covered by the ceiling documented in `confidenceFor`.
  const sharp = await sharpLib();
  const bytes = new Uint8Array(
    await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .png()
      .toBuffer(),
  );
  const run = await face.runFaceCompare({ uploadId: 'a', bytes }, { uploadId: 'b', bytes });
  assert.notEqual(run.face.confidence.band, 'high');
  assert.ok(run.face.confidence.reason.length > 0, 'a band with no reason is not shippable');
  assert.ok(run.face.confidence.calibration.length > 0);
});

test('stage traces carry real elapsed times and zero marginal cost', async () => {
  const bytes = new Uint8Array([0, 0, 0]);
  const run = await face.runFaceCompare({ uploadId: 'a', bytes }, { uploadId: 'b', bytes });
  assert.ok(run.stages.length > 0, 'something must be recorded even on the refusal path');
  for (const stage of run.stages) {
    assert.ok(Number.isFinite(stage.ranMs) && stage.ranMs >= 0, `${stage.stage} ranMs must be real`);
    assert.equal(stage.costUsd, 0, 'local inference is not billed per call');
  }
  assert.equal(run.costUsd, 0);
});
