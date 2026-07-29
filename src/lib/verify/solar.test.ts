/**
 * ShadowFinder constraint tests.
 *
 *   node --test src/lib/verify/solar.test.ts
 *
 * The load-bearing test in this file is the *negative* one: a shadow ratio with no
 * timestamp must return "no constraint". If that ever regresses, the module stops
 * being a verifier and starts being a solver that invents latitudes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from '../cascade/testing/aliasHooks';
import type * as SolarModule from './solar';
import type * as CascadeTypes from '../cascade/types';
import type { WorkingCandidate } from '../cascade/candidate';
import type { StageContext } from '../cascade/types';

const hooksSpecifier = '../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const solarSpecifier = './solar.ts';
const solar = (await import(solarSpecifier)) as typeof SolarModule;
const typesSpecifier = '../cascade/types.ts';
const { Budget } = (await import(typesSpecifier)) as typeof CascadeTypes;

const PITTSBURGH = { lat: 40.4406, lon: -79.9959 };

function context(): StageContext {
  return {
    searchId: 'test-search',
    image: { imageId: 'test-image' },
    budget: new Budget(10_000),
    signal: new AbortController().signal,
    emit: () => {},
  };
}

function candidate(id: string, lat: number, lon: number): WorkingCandidate {
  return {
    id,
    center: { lat, lon },
    radiusM: 200,
    precision: 'city',
    place: { label: id },
    rawScore: 0.8,
    evidence: [],
    calibrationSet: 'vprRetrieval',
    facts: { kind: 'retrieval-agreement', within: 3, of: 5, radiusM: 200 },
  };
}

// ---------------------------------------------------------------------------
// It is a verifier, not a solver
// ---------------------------------------------------------------------------

test('a shadow ratio with no timestamp yields NO constraint', () => {
  const constraint = solar.buildSolarConstraint({ shadowsVisible: true, shadowToHeightRatio: 1.2 });
  assert.equal(constraint.constrained, false);
  if (constraint.constrained) return;
  assert.match(constraint.reason, /jointly underdetermined/i);
});

test('no shadows, or no measurable ratio, yields no constraint', () => {
  assert.equal(
    solar.buildSolarConstraint({ shadowsVisible: false, capturedAt: '2026-06-21T17:00:00Z' })
      .constrained,
    false,
  );
  assert.equal(
    solar.buildSolarConstraint({ shadowsVisible: true, capturedAt: '2026-06-21T17:00:00Z' })
      .constrained,
    false,
  );
});

test('an unparseable timestamp yields no constraint rather than a wrong one', () => {
  const constraint = solar.buildSolarConstraint({
    shadowsVisible: true,
    shadowToHeightRatio: 1,
    capturedAt: 'last summer',
  });
  assert.equal(constraint.constrained, false);
});

test('the verifier never seeds candidates', async () => {
  const ctx = context();
  const candidates: WorkingCandidate[] = [];
  const out = await solar.runSolarVerifier({
    candidates,
    observation: {
      shadowsVisible: true,
      shadowToHeightRatio: 1,
      capturedAt: '2026-06-21T17:00:00Z',
    },
    ctx,
  });
  assert.equal(candidates.length, 0, 'the solar verifier must not invent a candidate');
  assert.equal(out.output, null);
  assert.ok(out.trace.skipped?.reason.includes('never seeds'));
});

// ---------------------------------------------------------------------------
// Solar geometry
// ---------------------------------------------------------------------------

test('elevation from a shadow ratio is the arctangent of its reciprocal', () => {
  assert.equal(solar.elevationFromShadowRatio(1), 45);
  assert.equal(solar.elevationFromShadowRatio(0), undefined, 'a zero ratio is not measurable');
  assert.equal(solar.elevationFromShadowRatio(-2), undefined);
  const long = solar.elevationFromShadowRatio(5);
  assert.ok(long !== undefined && long > 11 && long < 12, `expected ~11.3 deg, got ${long}`);
});

test('declination tracks the solstices and equinoxes', () => {
  assert.ok(Math.abs(solar.solarDeclinationDeg(new Date('2026-06-21T12:00:00Z')) - 23.44) < 0.3);
  assert.ok(Math.abs(solar.solarDeclinationDeg(new Date('2026-12-21T12:00:00Z')) + 23.44) < 0.3);
  assert.ok(Math.abs(solar.solarDeclinationDeg(new Date('2026-03-20T12:00:00Z'))) < 1.5);
});

test('peak solar elevation matches 90 - |latitude - declination|', () => {
  // Pittsburgh, summer solstice, within half an hour of local solar noon.
  const date = new Date('2026-06-21T17:22:00Z');
  const elevation = solar.solarElevationDeg(date, PITTSBURGH);
  const expected = 90 - Math.abs(PITTSBURGH.lat - 23.44);
  assert.ok(
    Math.abs(elevation - expected) < 0.5,
    `expected ~${expected.toFixed(1)} deg, got ${elevation.toFixed(2)}`,
  );

  // Winter solstice at the same place: the sun barely clears 26 degrees.
  const winter = solar.solarElevationDeg(new Date('2026-12-21T17:22:00Z'), PITTSBURGH);
  assert.ok(Math.abs(winter - (90 - (PITTSBURGH.lat + 23.44))) < 0.7, `got ${winter}`);
});

test('azimuth is east of south before local noon and west of south after', () => {
  const before = solar.solarAzimuthDeg(new Date('2026-06-21T15:00:00Z'), PITTSBURGH);
  const after = solar.solarAzimuthDeg(new Date('2026-06-21T19:00:00Z'), PITTSBURGH);
  assert.ok(before < 180, `expected an easterly azimuth before noon, got ${before}`);
  assert.ok(after > 180, `expected a westerly azimuth after noon, got ${after}`);
});

test('the subsolar point is where it is solar noon', () => {
  const date = new Date('2026-06-21T17:22:00Z');
  const subsolar = solar.subsolarPoint(date);
  assert.ok(Math.abs(subsolar.lat - 23.44) < 0.3);
  // Pittsburgh's longitude, because we picked its solar noon.
  assert.ok(Math.abs(subsolar.lon - PITTSBURGH.lon) < 1.5, `got ${subsolar.lon}`);
  // The elevation at the subsolar point is 90 degrees by definition.
  assert.ok(Math.abs(solar.solarElevationDeg(date, { lat: subsolar.lat, lon: subsolar.lon }) - 90) < 0.2);
});

// ---------------------------------------------------------------------------
// Constraint checking
// ---------------------------------------------------------------------------

test('a candidate at the observed elevation is consistent, one far away is not', () => {
  const instant = '2026-06-21T17:22:00Z';
  const trueElevation = solar.solarElevationDeg(new Date(instant), PITTSBURGH);
  // Invert the elevation back into the ratio an analyst would have measured.
  const ratio = 1 / Math.tan((trueElevation * Math.PI) / 180);
  const constraint = solar.buildSolarConstraint({
    shadowsVisible: true,
    shadowToHeightRatio: ratio,
    capturedAt: instant,
  });
  assert.equal(constraint.constrained, true);
  if (!constraint.constrained) return;

  const near = solar.checkCandidate(constraint, PITTSBURGH);
  assert.ok(near?.consistent, `Pittsburgh should be consistent, delta ${near?.deltaDeg}`);

  // Same longitude, southern hemisphere: at this instant the sun is far lower.
  const far = solar.checkCandidate(constraint, { lat: -20, lon: PITTSBURGH.lon });
  assert.equal(far?.consistent, false, `20S should be excluded, delta ${far?.deltaDeg}`);

  // And the honest limit of the method: 10N sits nearly as far from the June
  // declination as Pittsburgh does on the other side, so it sees almost the same
  // elevation and is NOT excluded. A solar constraint narrows the search; it does
  // not identify a latitude, and a test that pretended otherwise would be lying.
  const mirrored = solar.checkCandidate(constraint, { lat: 10, lon: PITTSBURGH.lon });
  assert.ok(
    mirrored !== null && mirrored.deltaDeg < 5,
    'the near-mirror latitude about the declination is expected to survive',
  );

  // The reported latitude band spans declination +/- (90 - elevation).
  const [south, north] = constraint.latitudeBandDeg;
  assert.ok(south < PITTSBURGH.lat && north > PITTSBURGH.lat);
});

test('a conflicting candidate is down-weighted, never deleted', async () => {
  const instant = '2026-06-21T17:22:00Z';
  const elevation = solar.solarElevationDeg(new Date(instant), PITTSBURGH);
  const ratio = 1 / Math.tan((elevation * Math.PI) / 180);
  const consistent = candidate('consistent', PITTSBURGH.lat, PITTSBURGH.lon);
  const conflicting = candidate('conflicting', -20, PITTSBURGH.lon);
  const before = conflicting.rawScore;

  const out = await solar.runSolarVerifier({
    candidates: [consistent, conflicting],
    observation: { shadowsVisible: true, shadowToHeightRatio: ratio, capturedAt: instant },
    ctx: context(),
  });

  assert.equal(out.output?.consistent.length, 1);
  assert.equal(out.output?.conflicting.length, 1);
  assert.ok(conflicting.rawScore < before, 'the conflicting candidate should lose score');
  assert.ok(conflicting.rawScore > 0, 'a soft constraint must not zero a candidate out');
  assert.equal(consistent.rawScore, 0.8, 'a consistent candidate is not inflated');

  // Both candidates carry the solar line, so the analyst sees the excluded one too.
  assert.equal(consistent.evidence.length, 1);
  assert.equal(conflicting.evidence.length, 1);
  assert.equal(conflicting.evidence[0].kind, 'solar');
  assert.match(conflicting.evidence[0].verifiable, /ShadowFinder/);
});

test('a shadow bearing that disagrees with the sun position excludes the candidate', () => {
  const instant = '2026-06-21T17:22:00Z';
  const elevation = solar.solarElevationDeg(new Date(instant), PITTSBURGH);
  const ratio = 1 / Math.tan((elevation * Math.PI) / 180);
  const trueSolarAz = solar.solarAzimuthDeg(new Date(instant), PITTSBURGH);

  // Shadows point away from the sun, so the correct bearing is solar azimuth + 180.
  const correct = solar.buildSolarConstraint({
    shadowsVisible: true,
    shadowToHeightRatio: ratio,
    shadowAzimuthDeg: (trueSolarAz + 180) % 360,
    capturedAt: instant,
  });
  assert.ok(solar.checkCandidate(correct, PITTSBURGH)?.consistent);

  const wrong = solar.buildSolarConstraint({
    shadowsVisible: true,
    shadowToHeightRatio: ratio,
    shadowAzimuthDeg: (trueSolarAz + 270) % 360,
    capturedAt: instant,
  });
  assert.equal(solar.checkCandidate(wrong, PITTSBURGH)?.consistent, false);
});
