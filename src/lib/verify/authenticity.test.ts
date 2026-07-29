/**
 * VERIFY rule tests.
 *
 *   node --test src/lib/verify/authenticity.test.ts
 *
 * These cover the four product rules that are easiest to violate by accident:
 * absence of a manifest means nothing, authenticity is never asserted,
 * suppression beats a probabilistic positive, and PPV is surfaced.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from '../cascade/testing/aliasHooks';
import type * as AuthenticityModule from './authenticity';
import type { AuthenticityInput } from './authenticity';

const hooksSpecifier = '../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const specifier = './authenticity.ts';
const { decideVerdict, detectSuppressionClasses } = (await import(
  specifier
)) as typeof AuthenticityModule;

function input(overrides: Partial<AuthenticityInput> = {}): AuthenticityInput {
  return {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    header: { format: 'png', width: 1600, height: 1200, byteLength: 400_000 },
    metadata: { tagCount: 4, stripped: false, cameraMake: 'Canon', cameraModel: 'R6' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Verdict rules
// ---------------------------------------------------------------------------

test('a valid manifest naming a generative tool is strong on its own', () => {
  assert.equal(
    decideVerdict({
      cryptographicGenerativeClaim: true,
      metadataGenerativeClaim: false,
      detectorBand: null,
      suppressedBy: [],
    }),
    'strong-indicators',
  );
});

test('a cryptographic claim is not overridden by a suppression class', () => {
  // Suppression exists because the *detector* is miscalibrated on these inputs.
  // A signature is a signature regardless.
  assert.equal(
    decideVerdict({
      cryptographicGenerativeClaim: true,
      metadataGenerativeClaim: false,
      detectorBand: 'high',
      suppressedBy: ['screenshot', 'recompressed'],
    }),
    'strong-indicators',
  );
});

test('an editable metadata claim earns moderate, not strong', () => {
  assert.equal(
    decideVerdict({
      cryptographicGenerativeClaim: false,
      metadataGenerativeClaim: true,
      detectorBand: null,
      suppressedBy: [],
    }),
    'moderate-indicators',
  );
});

test('a lone detector reading never reaches strong', () => {
  assert.equal(
    decideVerdict({
      cryptographicGenerativeClaim: false,
      metadataGenerativeClaim: false,
      detectorBand: 'high',
      suppressedBy: [],
    }),
    'moderate-indicators',
  );
  assert.equal(
    decideVerdict({
      cryptographicGenerativeClaim: false,
      metadataGenerativeClaim: false,
      detectorBand: 'moderate',
      suppressedBy: [],
    }),
    'weak-indicators',
  );
});

test('two agreeing signals reach strong', () => {
  assert.equal(
    decideVerdict({
      cryptographicGenerativeClaim: false,
      metadataGenerativeClaim: true,
      detectorBand: 'high',
      suppressedBy: [],
    }),
    'strong-indicators',
  );
});

test('nothing found is never reported as authentic', () => {
  const verdict = decideVerdict({
    cryptographicGenerativeClaim: false,
    metadataGenerativeClaim: false,
    detectorBand: 'weak',
    suppressedBy: [],
  });
  assert.equal(verdict, 'no-indicators-found');
  // The type has no 'authentic' member; this asserts the intent survives refactors.
  assert.notEqual(verdict as string, 'authentic');
});

test('a suppression class turns a probabilistic positive into inconclusive', () => {
  for (const band of ['high', 'moderate', 'weak', null] as const) {
    assert.equal(
      decideVerdict({
        cryptographicGenerativeClaim: false,
        metadataGenerativeClaim: false,
        detectorBand: band,
        suppressedBy: ['computational-photography'],
      }),
      'inconclusive',
      `band ${band} should be suppressed`,
    );
  }
});

// ---------------------------------------------------------------------------
// Suppression classes
// ---------------------------------------------------------------------------

test('a clean camera original triggers no suppression', () => {
  assert.deepEqual(detectSuppressionClasses(input()), []);
});

test('computational photography, upscaling and retouching are detected', () => {
  assert.ok(
    detectSuppressionClasses(
      input({ metadata: { tagCount: 3, stripped: false, software: 'Apple Smart HDR 5' } }),
    ).includes('computational-photography'),
  );
  assert.ok(
    detectSuppressionClasses(
      input({ metadata: { tagCount: 3, stripped: false, software: 'Topaz Gigapixel AI 7' } }),
    ).includes('ai-upscaled'),
  );
  assert.ok(
    detectSuppressionClasses(
      input({ metadata: { tagCount: 3, stripped: false, software: 'Adobe Photoshop 27.0' } }),
    ).includes('heavy-retouching'),
  );
});

test('a screenshot-sized image with no camera tags is suppressed', () => {
  const classes = detectSuppressionClasses(
    input({
      header: { format: 'png', width: 2796, height: 1290, byteLength: 900_000 },
      metadata: { tagCount: 0, stripped: true },
    }),
  );
  assert.ok(classes.includes('screenshot'));
});

test('the same dimensions WITH camera metadata are not called a screenshot', () => {
  const classes = detectSuppressionClasses(
    input({
      header: { format: 'png', width: 2796, height: 1290, byteLength: 900_000 },
      metadata: { tagCount: 12, stripped: false, cameraMake: 'Apple', cameraModel: 'iPhone 16 Pro' },
    }),
  );
  assert.ok(!classes.includes('screenshot'));
});

test('an unusably small image suppresses rather than pretends', () => {
  const classes = detectSuppressionClasses(
    input({ header: { format: 'png', width: 200, height: 150, byteLength: 9_000 } }),
  );
  assert.ok(classes.includes('resolution-too-low'));
});

test('a stripped, mid-quality JPEG reads as a platform recompression', () => {
  // Minimal JPEG carrying a quality-55 luminance table and no EXIF block.
  const bytes = jpegWithQuality(55, 1600, 1200);
  const classes = detectSuppressionClasses(
    input({
      bytes,
      header: { format: 'jpeg', width: 1600, height: 1200, byteLength: bytes.byteLength },
      metadata: { tagCount: 0, stripped: true },
    }),
  );
  assert.ok(classes.includes('recompressed'), `got ${classes.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Builds a header-valid JPEG whose DQT encodes the requested libjpeg quality. */
export function jpegWithQuality(quality: number, width: number, height: number): Uint8Array {
  const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  const table = STD_LUMA.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));

  const out: number[] = [0xff, 0xd8];
  out.push(0xff, 0xdb, 0x00, 0x43, 0x00, ...table);
  out.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  );
  out.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  // Filler standing in for entropy-coded data, so byte-level gates see a real file.
  for (let i = 0; i < 4096; i += 1) out.push((i * 31) % 251);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}
