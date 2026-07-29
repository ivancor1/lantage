/**
 * Contract-invariant tests.
 *
 *   node --test src/lib/cascade/invariants.test.ts
 *
 * These are the rules that make the product defensible, so they are tested
 * against the real invariant functions in `@/lib/contracts/types` — not against a
 * local reimplementation — and against the assembly path in `candidate.ts` that
 * every result goes through.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from './testing/aliasHooks';
import type * as Contracts from '@/lib/contracts/types';
import type * as CandidateModule from './candidate';
import type { Evidence, EvidenceChain, GeoCandidate, QualityGate, SearchResult } from '@/lib/contracts/types';
import type { WorkingCandidate } from './candidate';

const hooksSpecifier = './testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const contracts = (await import('@/lib/contracts/types')) as typeof Contracts;
const candidateSpecifier = './candidate.ts';
const { finaliseCandidates, independentSignalCount, hasEarnedStreetPrecision } = (await import(
  candidateSpecifier
)) as typeof CandidateModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function evidence(kind: Evidence['kind'], weight = 0.6): Evidence {
  return {
    kind,
    claim: `${kind} claim`,
    verifiable: `how to check the ${kind} claim`,
    weight,
  };
}

function geoCandidate(overrides: Partial<GeoCandidate> = {}): GeoCandidate {
  return {
    id: 'c1',
    rank: 1,
    center: { lat: 40.4406, lon: -79.9959 },
    radiusM: 120,
    precision: 'city',
    place: { label: 'Pittsburgh' },
    confidence: {
      band: 'moderate',
      score: 0.6,
      reason: 'test',
      calibration: 'test-set@0',
    },
    evidence: [evidence('embedding-prior')] as EvidenceChain,
    review: 'unreviewed',
    ...overrides,
  };
}

function gate(overrides: Partial<QualityGate> = {}): QualityGate {
  return {
    passed: true,
    components: { resolutionPx: { w: 1600, h: 1200 } },
    degraded: false,
    ...overrides,
  };
}

function working(overrides: Partial<WorkingCandidate> = {}): WorkingCandidate {
  return {
    id: 'w1',
    center: { lat: 40.4406, lon: -79.9959 },
    radiusM: 150,
    precision: 'city',
    place: { label: 'Pittsburgh' },
    rawScore: 0.9,
    evidence: [evidence('vpr-match', 0.8)],
    calibrationSet: 'vprRetrieval',
    facts: { kind: 'retrieval-agreement', within: 4, of: 5, radiusM: 150 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Street precision must be earned
// ---------------------------------------------------------------------------

test('street precision without a vpr-match or signage-ocr throws', () => {
  const unearned = geoCandidate({
    precision: 'street',
    evidence: [evidence('embedding-prior'), evidence('vlm-clue'), evidence('exif', 0)] as EvidenceChain,
  });
  assert.throws(
    () => contracts.assertStreetPrecisionIsEarned(unearned),
    /claims street precision without a vpr-match or signage-ocr/,
  );
});

test('street precision earned by retrieval or by an OCR geocode is allowed', () => {
  assert.doesNotThrow(() =>
    contracts.assertStreetPrecisionIsEarned(
      geoCandidate({ precision: 'street', evidence: [evidence('vpr-match')] as EvidenceChain }),
    ),
  );
  assert.doesNotThrow(() =>
    contracts.assertStreetPrecisionIsEarned(
      geoCandidate({ precision: 'street', evidence: [evidence('signage-ocr')] as EvidenceChain }),
    ),
  );
});

test('coarser precisions are never gated', () => {
  for (const precision of ['continent', 'country', 'region', 'city'] as const) {
    assert.doesNotThrow(() => contracts.assertStreetPrecisionIsEarned(geoCandidate({ precision })));
  }
});

test('assembly downgrades an unearned street claim instead of emitting it', () => {
  const [result] = finaliseCandidates(
    [working({ precision: 'street', evidence: [evidence('embedding-prior')] })],
    gate(),
  );
  assert.equal(result.precision, 'city', 'an unearned street claim must be downgraded');
  assert.doesNotThrow(() => contracts.assertStreetPrecisionIsEarned(result));
});

test('assembly keeps a street claim that retrieval earned', () => {
  const [result] = finaliseCandidates([working({ precision: 'street' })], gate());
  assert.equal(result.precision, 'street');
  assert.ok(hasEarnedStreetPrecision(result.evidence));
});

// ---------------------------------------------------------------------------
// A refused quality gate returns no ranking
// ---------------------------------------------------------------------------

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 's1',
    module: 'GEO',
    imageId: 'img1',
    quality: gate({ passed: false, refusalReason: 'Resolution is 120x90.' }),
    stages: [],
    provenance: { models: {}, totalCostUsd: 0 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test('a failed gate with ranked candidates throws', () => {
  assert.throws(
    () => contracts.assertRefusalIsHonoured(searchResult({ geo: [geoCandidate()] })),
    /failed the quality gate but returned 1 ranked/,
  );
  assert.throws(
    () =>
      contracts.assertRefusalIsHonoured(
        searchResult({
          corpusMatches: [
            { rank: 1, recordId: 'r', corpusId: 'c', similarity: 0.9, relation: 'near-duplicate', review: 'unreviewed' },
          ],
        }),
      ),
    /ranked/,
  );
});

test('a failed gate with no ranking is honoured', () => {
  assert.doesNotThrow(() => contracts.assertRefusalIsHonoured(searchResult()));
  assert.doesNotThrow(() => contracts.assertRefusalIsHonoured(searchResult({ geo: [] })));
});

test('a passed gate with candidates is fine', () => {
  assert.doesNotThrow(() =>
    contracts.assertRefusalIsHonoured(searchResult({ quality: gate(), geo: [geoCandidate()] })),
  );
});

// ---------------------------------------------------------------------------
// Degraded input caps the band
// ---------------------------------------------------------------------------

test('bandCeiling refuses everything when the gate failed', () => {
  const failed = gate({ passed: false });
  for (const band of ['high', 'moderate', 'weak', 'refused'] as const) {
    assert.equal(contracts.bandCeiling(failed, band), 'refused');
  }
});

test('bandCeiling caps a degraded pass at weak', () => {
  const degraded = gate({ degraded: true });
  assert.equal(contracts.bandCeiling(degraded, 'high'), 'weak');
  assert.equal(contracts.bandCeiling(degraded, 'moderate'), 'weak');
  assert.equal(contracts.bandCeiling(degraded, 'weak'), 'weak');
  assert.equal(contracts.bandCeiling(gate(), 'high'), 'high');
});

test('assembly applies the ceiling and says why in the reason', () => {
  const [result] = finaliseCandidates(
    [
      working({
        rawScore: 0.99,
        evidence: [evidence('vpr-match', 0.9), evidence('signage-ocr', 0.85)],
      }),
    ],
    gate({ degraded: true, refusalReason: 'Degraded: Resolution is 400x300.' }),
  );
  assert.equal(result.confidence.band, 'weak');
  assert.match(result.confidence.reason, /Capped at 'weak'/);
  assert.match(result.confidence.reason, /Resolution is 400x300/);
  assert.ok(!result.confidence.reason.includes('Degraded: Degraded'));
});

// ---------------------------------------------------------------------------
// Evidence and corroboration
// ---------------------------------------------------------------------------

test('EXIF never counts as corroboration', () => {
  // Otherwise a falsified EXIF tag could promote a band, which is the exact
  // failure mode the "record metadata, never trust it" rule exists to prevent.
  assert.equal(independentSignalCount([evidence('exif', 0.9), evidence('vpr-match')]), 1);
  assert.equal(independentSignalCount([evidence('vpr-match'), evidence('signage-ocr')]), 2);
  assert.equal(independentSignalCount([evidence('vpr-match', 0), evidence('solar', 0)]), 0);
  // Two lines of the same kind are one signal, not two.
  assert.equal(independentSignalCount([evidence('vpr-match'), evidence('vpr-match')]), 1);
});

test('the signals that chose the search region cannot corroborate its results', () => {
  // Retrieval only looked inside the region the prior and the clues selected, so a
  // match agreeing with them is the consequence of the prune, not confirmation.
  assert.equal(
    independentSignalCount([evidence('embedding-prior'), evidence('vlm-clue'), evidence('vpr-match')]),
    1,
  );
  // Physics and a gazetteer are independent of the prune, so they do corroborate.
  assert.equal(independentSignalCount([evidence('vpr-match'), evidence('solar')]), 2);
});

test("a single signal cannot produce a 'high' band through assembly", () => {
  const [single] = finaliseCandidates([working({ rawScore: 1 })], gate());
  assert.equal(single.confidence.band, 'moderate');

  const [corroborated] = finaliseCandidates(
    [working({ rawScore: 1, evidence: [evidence('vpr-match', 0.9), evidence('signage-ocr', 0.9)] })],
    gate(),
  );
  assert.equal(corroborated.confidence.band, 'high');
});

test('every emitted candidate has a non-empty evidence chain and a real radius', () => {
  const results = finaliseCandidates([working({ radiusM: 0 })], gate(), [evidence('exif', 0)]);
  assert.equal(results.length, 1);
  assert.ok(results[0].evidence.length >= 1);
  assert.ok(results[0].radiusM > 0, 'a zero radius is a point estimate we do not claim');
  for (const line of results[0].evidence) {
    assert.ok(line.verifiable.length > 0, 'every evidence line needs an independent check');
  }
});

test('a candidate with no evidence at all is dropped, not softened', () => {
  const results = finaliseCandidates([working({ evidence: [] })], gate(), []);
  assert.equal(results.length, 0);
});

test('candidates come back ranked, capped, and unreviewed', () => {
  const results = finaliseCandidates(
    [
      working({ id: 'a', rawScore: 0.4 }),
      working({ id: 'b', rawScore: 0.95 }),
      working({ id: 'c', rawScore: 0.7 }),
    ],
    gate(),
  );
  assert.deepEqual(
    results.map((r) => r.id),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    results.map((r) => r.rank),
    [1, 2, 3],
  );
  for (const r of results) assert.equal(r.review, 'unreviewed');
});

test('the lead disclaimer is a constant, not a suggestion', () => {
  assert.equal(contracts.LEAD_DISCLAIMER, 'INVESTIGATIVE LEAD · VERIFY INDEPENDENTLY');
});
