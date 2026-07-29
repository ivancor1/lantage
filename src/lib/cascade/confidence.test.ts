/**
 * Calibration tests.
 *
 *   node --test src/lib/cascade/confidence.test.ts
 *
 * See `testing/aliasHooks.ts` for why the module is loaded through a variable
 * specifier rather than a static import.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as ConfidenceModule from './confidence';

const specifier = './confidence.ts';
const {
  CALIBRATION_SETS,
  bandFor,
  calibrate,
  isotonicMap,
  measuredRatesFor,
  positivePredictiveValue,
  reasonFor,
  refusedConfidence,
  temperatureScale,
} = (await import(specifier)) as typeof ConfidenceModule;

// ---------------------------------------------------------------------------
// Temperature scaling
// ---------------------------------------------------------------------------

test('temperature scaling is monotone and fixes the midpoint', () => {
  const t = 1.8;
  assert.equal(temperatureScale(0.5, t), 0.5, 'T must not move a 0.5 score');
  let previous = -1;
  for (let raw = 0; raw <= 1.0001; raw += 0.05) {
    const scaled = temperatureScale(raw, t);
    assert.ok(scaled >= previous, `not monotone at raw=${raw}`);
    previous = scaled;
  }
});

test('T > 1 softens an overconfident score toward the middle', () => {
  assert.ok(temperatureScale(0.95, 2.2) < 0.95);
  assert.ok(temperatureScale(0.05, 2.2) > 0.05);
});

test('scaling clamps rubbish input instead of propagating NaN', () => {
  assert.equal(temperatureScale(Number.NaN, 1.4), temperatureScale(0, 1.4));
  assert.ok(temperatureScale(42, 1.4) <= 1);
  assert.ok(temperatureScale(-42, 1.4) >= 0);
});

// ---------------------------------------------------------------------------
// Reliability curve
// ---------------------------------------------------------------------------

test('isotonic map interpolates between knots and clamps outside them', () => {
  const curve = [
    [0, 0.1],
    [0.5, 0.5],
    [1, 0.8],
  ] as const;
  assert.equal(isotonicMap(curve, 0), 0.1);
  assert.equal(isotonicMap(curve, 0.5), 0.5);
  assert.equal(isotonicMap(curve, 1), 0.8);
  assert.equal(isotonicMap(curve, -5), 0.1, 'below the first knot clamps');
  assert.equal(isotonicMap(curve, 5), 0.8, 'above the last knot clamps');
  assert.ok(Math.abs(isotonicMap(curve, 0.25) - 0.3) < 1e-9);
});

test('every shipped calibration set is well formed', () => {
  for (const [name, set] of Object.entries(CALIBRATION_SETS)) {
    assert.ok(set.id.length > 0, `${name} has no calibration id`);
    assert.ok(set.temperature > 0, `${name} has a non-positive temperature`);
    assert.ok(set.curve.length >= 2, `${name} needs at least two knots`);

    for (let i = 1; i < set.curve.length; i += 1) {
      assert.ok(set.curve[i][0] > set.curve[i - 1][0], `${name} curve x must increase`);
      assert.ok(set.curve[i][1] >= set.curve[i - 1][1], `${name} curve must be non-decreasing`);
    }
    assert.ok(set.bands.high > set.bands.moderate, `${name} band thresholds out of order`);
    assert.ok(set.bands.moderate > set.bands.weak, `${name} band thresholds out of order`);

    // A band that publishes no measured error rate cannot be published by BENCH,
    // and PPV cannot be computed from it.
    for (const band of ['high', 'moderate', 'weak'] as const) {
      const rates = set.measured[band];
      assert.ok(rates.tpr > 0 && rates.tpr <= 1, `${name}/${band} tpr out of range`);
      assert.ok(rates.fpr >= 0 && rates.fpr < 1, `${name}/${band} fpr out of range`);
    }
    assert.ok(
      set.measured.high.fpr < set.measured.weak.fpr,
      `${name}: the high band must have a lower false-positive rate than the weak band`,
    );
  }
});

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

test("a single signal can never reach the 'high' band", () => {
  const set = CALIBRATION_SETS.vprRetrieval;
  assert.equal(bandFor(set, 0.99, 1), 'moderate');
  assert.equal(bandFor(set, 0.99, 2), 'high');
});

test('band thresholds are respected at the boundaries', () => {
  const set = CALIBRATION_SETS.vprRetrieval;
  assert.equal(bandFor(set, set.bands.high, 3), 'high');
  assert.equal(bandFor(set, set.bands.high - 0.0001, 3), 'moderate');
  assert.equal(bandFor(set, set.bands.moderate, 3), 'moderate');
  assert.equal(bandFor(set, set.bands.moderate - 0.0001, 3), 'weak');
});

// ---------------------------------------------------------------------------
// calibrate()
// ---------------------------------------------------------------------------

test('calibrate populates every field the contract requires', () => {
  const confidence = calibrate({
    set: 'vprRetrieval',
    raw: 0.82,
    independentSignals: 2,
    facts: { kind: 'retrieval-agreement', within: 4, of: 5, radiusM: 250, place: 'Pittsburgh' },
  });
  assert.ok(confidence.score >= 0 && confidence.score <= 1);
  assert.ok(confidence.reason.length > 0, 'a band with no reason is not shippable');
  assert.equal(confidence.calibration, CALIBRATION_SETS.vprRetrieval.id);
  assert.ok(['high', 'moderate', 'weak'].includes(confidence.band));
});

test('calibrated score is monotone in the raw score', () => {
  let previous = -1;
  for (let raw = 0; raw <= 1.0001; raw += 0.05) {
    const { score } = calibrate({
      set: 'embeddingPrior',
      raw,
      independentSignals: 1,
      facts: { kind: 'embedding-prior', topScorePct: 50, spreadKm: 10 },
    });
    assert.ok(score >= previous, `calibration not monotone at raw=${raw}`);
    previous = score;
  }
});

test('a raw score is never passed through as if it were a probability', () => {
  // The VLM set is squashed hardest because a model's self-report is the least
  // reliable number in the pipeline.
  const { score } = calibrate({
    set: 'vlmClues',
    raw: 0.95,
    independentSignals: 1,
    facts: { kind: 'vlm-clues', clueCount: 12, categories: 3, label: 'Pittsburgh' },
  });
  assert.ok(score < 0.6, `a 0.95 self-report must not survive calibration (got ${score})`);
});

test('refusals carry a band, a zero score, and a stated reason', () => {
  const confidence = refusedConfidence('Resolution is 120x90.');
  assert.equal(confidence.band, 'refused');
  assert.equal(confidence.score, 0);
  assert.match(confidence.reason, /120x90/);
  assert.ok(confidence.calibration.length > 0);
});

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

test('the generated reason states the fact and whether it is corroborated', () => {
  const single = reasonFor(
    { kind: 'retrieval-agreement', within: 4, of: 5, radiusM: 250, place: 'Pittsburgh' },
    1,
  );
  assert.match(single, /4 of 5 retrieval matches/);
  assert.match(single, /250 m/);
  assert.match(single, /not corroborated/i);

  const corroborated = reasonFor({ kind: 'ocr-agreement', text: 'Gus & Yia Yia', distanceM: 40 }, 3);
  assert.match(corroborated, /Gus & Yia Yia/);
  assert.match(corroborated, /Corroborated by 3 independent signal types/);
});

test('the no-indicators reason refuses to assert authenticity', () => {
  const reason = reasonFor({ kind: 'no-indicators' }, 1);
  assert.match(reason, /not a finding of authenticity/i);
  assert.ok(!/\bauthentic\b(?!ity)/i.test(reason), 'must never call an image authentic');
});

// ---------------------------------------------------------------------------
// PPV — the arithmetic the market hides
// ---------------------------------------------------------------------------

test('PPV at a realistic base rate shows most positive flags are false positives', () => {
  const rates = measuredRatesFor('aiDetector', 'moderate');
  const ppv = positivePredictiveValue(rates, 0.05);
  const expected = (rates.tpr * 0.05) / (rates.tpr * 0.05 + rates.fpr * 0.95);
  assert.ok(Math.abs(ppv - expected) < 1e-12);
  assert.ok(ppv < 0.5, `at a 5% base rate a moderate flag must be more likely wrong (got ${ppv})`);
});

test('PPV rises with prevalence and is zero when the band cannot fire', () => {
  const rates = measuredRatesFor('aiDetector', 'high');
  assert.ok(positivePredictiveValue(rates, 0.5) > positivePredictiveValue(rates, 0.05));
  assert.equal(positivePredictiveValue(measuredRatesFor('aiDetector', 'refused'), 0.05), 0);
});
