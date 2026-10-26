/**
 * Decode-path tests.
 *
 *   node --test src/lib/live/imageDecode.test.ts
 *
 * These pin the three separate ways an iPhone photograph used to disappear:
 *
 *  1. `readImageHeader` scanned for the first `ispe` box and found the
 *     **thumbnail's**, so a 12 MP capture was measured as 512x512 and the quality
 *     gate refused it in those words. A dimension attributed to the wrong item is
 *     a fabricated dimension, and the synthetic containers below are built to
 *     have exactly that trap in them.
 *  2. libvips advertises HEIF input and reads the header but has no HEVC decoder
 *     compiled in, so the decode failed at the moment pixels were requested. The
 *     real HEIC fixture proves the wasm fallback covers it.
 *  3. The failure was recorded only in a stage trace. `undecodableGap` and
 *     `undecodableRefusal` are the two sentences that put it where the operator
 *     reads it, and both are asserted to say plainly that nothing ran.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as ImageHeaderModule from '@/lib/cascade/imageHeader';
import type * as ImageDecodeModule from './imageDecode';

/*
 * Parent-aware resolve hook, for the same reason `uploads.test.ts` has one: the
 * shared shim in `cascade/testing/aliasHooks` appends `.ts` to every
 * extensionless relative specifier regardless of who asked, and the decode path
 * loads CommonJS packages out of node_modules that require each other.
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

const { readImageHeader } = (await import('@/lib/cascade/imageHeader')) as typeof ImageHeaderModule;
const decodeSpecifier = './imageDecode.ts';
const { decodeToJpeg, ensureAnalysable, needsLocalDecode, undecodableGap, undecodableRefusal } =
  (await import(decodeSpecifier)) as typeof ImageDecodeModule;

// ---------------------------------------------------------------------------
// Synthetic ISOBMFF, so the association logic can be tested without a codec
// ---------------------------------------------------------------------------

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, payload: readonly number[]): number[] {
  const size = 8 + payload.length;
  return [...u32(size), ...[...type].map((c) => c.charCodeAt(0)), ...payload];
}

/** A FullBox: one version byte and three flag bytes ahead of the payload. */
function fullBox(type: string, version: number, flags: number, payload: readonly number[]): number[] {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff, ...payload]);
}

function ispe(width: number, height: number): number[] {
  return fullBox('ispe', 0, 0, [...u32(width), ...u32(height)]);
}

/** `irot`: the low two bits are the number of counter-clockwise quarter turns. */
function irot(quarterTurns: number): number[] {
  return box('irot', [quarterTurns & 0x03]);
}

interface SyntheticHeif {
  /** `ipco` children, in order. Their 1-based position is their identity. */
  properties: readonly (readonly number[])[];
  /** Primary item id and the property indices bound to it. Omit for neither box. */
  primary?: { itemId: number; propertyIndices: readonly number[] };
  /** Padded so the quality gate's byte floor is not what is under test. */
  byteLength?: number;
}

function heif({ properties, primary, byteLength = 8_192 }: SyntheticHeif): Uint8Array {
  const ipco = box('ipco', properties.flat());
  const ipma = primary
    ? fullBox('ipma', 0, 0, [
        ...u32(1),
        (primary.itemId >> 8) & 0xff,
        primary.itemId & 0xff,
        primary.propertyIndices.length,
        ...primary.propertyIndices.map((i) => i & 0x7f),
      ])
    : [];
  const pitm = primary
    ? fullBox('pitm', 0, 0, [(primary.itemId >> 8) & 0xff, primary.itemId & 0xff])
    : [];
  const meta = fullBox('meta', 0, 0, [...pitm, ...box('iprp', [...ipco, ...ipma])]);
  const ftyp = box('ftyp', [
    ...[...'heic'].map((c) => c.charCodeAt(0)),
    ...u32(0),
    ...[...'mif1'].map((c) => c.charCodeAt(0)),
  ]);

  const head = [...ftyp, ...meta];
  const bytes = new Uint8Array(Math.max(byteLength, head.length));
  bytes.set(head, 0);
  return bytes;
}

test('the primary item wins over the thumbnail that precedes it in the box order', () => {
  // The exact shape of IMG_7211.HEIC, reduced: the thumbnail's `ispe` is first in
  // `ipco`, and only `ipma` says which one belongs to the photograph.
  const bytes = heif({
    properties: [ispe(512, 512), ispe(4032, 3024), irot(1)],
    primary: { itemId: 1, propertyIndices: [2, 3] },
  });

  const header = readImageHeader(bytes);
  assert.equal(header.format, 'heif');
  // 4032x3024 stored, one quarter turn in `irot`, so 3024x4032 displayed — which
  // is what every decoder reports and therefore what the pipeline must agree with.
  assert.equal(header.width, 3024);
  assert.equal(header.height, 4032);
});

test('an ambiguous container reports no dimensions rather than the wrong ones', () => {
  const bytes = heif({ properties: [ispe(512, 512), ispe(4032, 3024)] });
  const header = readImageHeader(bytes);

  assert.equal(header.format, 'heif');
  assert.equal(header.width, undefined, 'guessing between two candidates is fabrication');
  assert.equal(header.height, undefined);
});

test('a single unambiguous ispe is read even with no association table', () => {
  const header = readImageHeader(heif({ properties: [ispe(1600, 1200)] }));
  assert.equal(header.width, 1600);
  assert.equal(header.height, 1200);
});

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

/**
 * 30x40 HEVC-coded HEIC, ftyp `heic`, produced from IMG_7211.HEIC (iPhone 14) so
 * the container is a genuine Apple one rather than a synthesised approximation.
 * Embedded rather than kept on disk because `.lantage-uploads` is gitignored and
 * routinely cleared, and a test that silently skips when its fixture is missing
 * is exactly how this class of bug survived the first time.
 */
const TINY_HEIC_BASE64: string = [
  "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" +
  "AAABAAAAPAAAAAMAAAACMjAyNjowODowMSAxMzoxMDoyMwAyMDI2OjA4OjAxIDEzOjEwOjIzAC0wNDowMAAALTA0OjAwAAAt" +
  "MDQ6MDAAAAAA9EYAAClNAABsdwAAXLYAAEfjAAAk7gAAAAAAAAABAAAAOQAAAAoH1wXkCKUFMEFwcGxlIGlPUwAAAU1NADIA" +
  "AQAJAAAAAQAAABAAAgAHAAACAAAAAmwAAwAHAAAAaAAABGwABAAJAAAAAQAAAAEABQAJAAAAAQAAAKgABgAJAAAAAQAAAKwA" +
  "BwAJAAAAAQAAAAEACAAKAAAAAwAABNQADAAKAAAAAgAABOwADQAJAAAAAf///+EADgAJAAAAAQAAAAAAEAAJAAAAAQAAAAEA" +
  "FAAJAAAAAQAAAAwAFwAQAAAAAQAABPwAGQAJAAAAAQAAIAIAGgACAAAABgAABQQAHwAJAAAAAQAAAAAAIAACAAAAJQAABQoA" +
  "IQAKAAAAAQAABS8AIwAJAAAAAgAABTcAJQAQAAAAAQAABT8AJgAJAAAAAQAAAAMAJwAKAAAAAQAABUcAKwACAAAAJQAABU8A" +
  "LQAJAAAAAQAAEqoALgAJAAAAAQAAAAEALwAJAAAAAQAAACsAMAAKAAAAAQAABXQANgAJAAAAAQAAANgANwAJAAAAAQAAAAQA" +
  "OgAJAAAAAQAAAAAAOwAJAAAAAQAAAAAAPAAJAAAAAQAAAAQAPwAJAAAAAQAAAAAAQAAHAAAASgAABXwAQQAJAAAAAQAAAAAA" +
  "QwAJAAAAAQAAAAAARAAJAAAAAQAAAAAARQAJAAAAAQAAAAAARgAJAAAAAQAAAAAASgAJAAAAAQAAAAIATQAKAAAAAQAABcYA" +
  "TgAHAAAAeQAABc4ATwAHAAAAKwAABkcAUgAJAAAAAQAAAAEAUwAJAAAAAQAAAAIAVQAJAAAAAQAAAAAAWAAJAAAAAQAABwMA" +
  "YAAJAAAAAQAAN74AYQAJAAAAAQAAABoAAAAAawBtAHIAegCIAIkAiwCKAIcAggB6AGAARQBjAFoAXwBrAGoAbgBbAFgAhgCK" +
  "AIwAjwCMAHoAWgBPAFsAVwBTAHIAcwB2AHYAiACNAI4AkACQAI0AdQBOAGcAYgBdAF0AcwB2AHsAggCNAJQAogClAJ8AlABw" +
  "AFgAZgBdAF8AXwB0AHgAfQB4AGsAdACGALAApACVAF8AagBoAGkAagBoAHUAeQB+AH8AfQCEAI4AugCvAKEAdQBpAFIAVgBZ" +
  "AFcAdgB6AH8AgAB+AH4AjADEALgAqACFAG0AVQBXAFgAVwB3AHoAfgB7AGsAcACHALsAsgCqAIoAcwBeAFYAWQBbAHcAeQB9" +
  "AIAAiACNAJsAowCtAKoAjgB3AGYAWgBdAF4AdwB4AHsAfwCCAIgAkQCVAJYAjgB/AHcAawBqAF8AZAB1AHUAdgB5AHwAgQCO" +
  "AKAAnACdAJ0AqQCOAIQAawBtAGkAagBwAFMB9QA2AYUBQQHJAKoAuwDKAKoAkgB/AHgAYwBoAHYAWwL9AXAC/wIEAkoAWwCt" +
  "AOwA0QCnAJMAdwBhAGgAfwAEAwkDWgOBA60ChgFSAqYBdgEPAboAmwB1AF8AZwCCACUDYQOiA8gDNAPDAUMDqwLtATEBtwCX" +
  "AFYAXgBmAJEAOANNA14DAgS7AnIAvAL2AWEB2gCLAGsARgBicGxpc3QwMNQBAgMEBQYHCFVmbGFnc1V2YWx1ZVl0aW1lc2Nh" +
  "bGVVZXBvY2gQARMAAHoQy74YMxI7msoAEAAIERcdJy0vOD0AAAAAAAABAQAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAPwAAIfMA" +
  "AY8Q//9+xgAAg4P//27VAAMneQAAAAEAAAAIAAAAFwAAAIAAAAAAAFAgBHE4MjVzAEFFMjVDNzNELTM1QTgtNEFFOC04QUM1" +
  "LTgwODYwMDY1MTQ3NgAAAPlBAAEnmgAAAR8QAABcAAAAAAAAEI4AAzHoAAAVp0U4MThEODBBLTJBMjEtNDVFNy1BMzdELTgw" +
  "NTNGRkYyNjIzNgAAAAQjAAInCWJwbGlzdDAw1AECAwQFBgYHUTNRMVEyUTAQACIAAAAAEAEIERMVFxkbIAAAAAAAAAEBAAAA" +
  "AAAAAAgAAAAAAAAAAAAAAAAAAAAiAAKLNwAADxVicGxpc3QwMNIBAgMEUTFRMhADogUK0gYHCAlTMi4xUzIuMiNAn8/bIAAA" +
  "ACNAVsAAAAAAANIGBwsMIwAAAAAAAAAAI0BTAAAAAAAACA0PERMWGx8jLDU6QwAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAA" +
  "AAAAAABMYnBsaXN0MDAQAAgAAAAAAAABAQAAAAAAAAABAAAAAAAAAAAAAAAAAAAACgAMUcUAB//nAC2ZfQAH//sAAAADAAAA" +
  "AgAAAAwAAAAFQXBwbGUAaVBob25lIDE0IGJhY2sgZHVhbCB3aWRlIGNhbWVyYSA1LjdtbSBmLzEuNQA8eDp4bXBtZXRhIHht" +
  "bG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0i" +
  "aHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRm" +
  "OmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgICAgICAg" +
  "ICAgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIj4KICAgICAgICAgPHhtcDpD" +
  "cmVhdGVEYXRlPjIwMjYtMDgtMDFUMTM6MTA6MjM8L3htcDpDcmVhdGVEYXRlPgogICAgICAgICA8eG1wOkNyZWF0b3JUb29s" +
  "PjI2LjY8L3htcDpDcmVhdG9yVG9vbD4KICAgICAgICAgPHhtcDpNb2RpZnlEYXRlPjIwMjYtMDgtMDFUMTM6MTA6MjM8L3ht" +
  "cDpNb2RpZnlEYXRlPgogICAgICAgICA8cGhvdG9zaG9wOkRhdGVDcmVhdGVkPjIwMjYtMDgtMDFUMTM6MTA6MjM8L3Bob3Rv" +
  "c2hvcDpEYXRlQ3JlYXRlZD4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CgAA" +
  "AWgoAa+hNPjScWVSQCrNKEdN7vGwuv2/r/+TJC52V8Lk8DfkwO+wWUvD11KtEmkBJX7IxVs19grjGCGpEoh4RKSIBs8eKaJt" +
  "pqCk5p29p5JF6R9q8AavthJe4LCqhpWf/MPW5wQuQVW7PX9qKjdfoyGvIDViIz9GfB7Ecm9ehzhv1akedEmIHcRfEpbPCCzM" +
  "0NK/ui3n7PiV0ZnBjBgu4Jhfj8Xn48JPK2sKHwfFA3OtyT0CCR2my0Xn2g/VwkOr9QFhu6SXlqHyZvc9uzHjJ9pEa//Noa3w" +
  "6Q5h3CEpdV1qd9wjN973ZPTIaZPd8v3eHxMoq77BydIlRh9oO39qWEYWUvUQh/xPRc5hrbKcHPlrBD5aHGx/q74bqnTTEur+" +
  "HS13fqpH6ZY8RHKDMr8coPbUxQMIeKippO5P9qnyb/D74MGmeQOcskeeZz+R+ilbBv6X1SAOTUAwkGYUfffilyMza/MTbfU7" +
  "8bA="
].join('');

const REAL_HEIC = Buffer.from(TINY_HEIC_BASE64, 'base64');

test('a real HEIC decodes, and to the same dimensions the container header reports', async () => {
  const header = readImageHeader(REAL_HEIC);
  assert.equal(header.format, 'heif');
  assert.equal(needsLocalDecode(header.format), true);
  assert.deepEqual({ w: header.width, h: header.height }, { w: 30, h: 40 });

  const decoded = await decodeToJpeg(REAL_HEIC, header.format);
  assert.ok(decoded.ok, `the HEIC must decode: ${decoded.ok ? '' : decoded.failure.reason}`);
  if (!decoded.ok) return;

  assert.equal(decoded.value.width, 30, 'the decode measures the same frame the header describes');
  assert.equal(decoded.value.height, 40);
  assert.equal(decoded.value.mimeType, 'image/jpeg');
  assert.deepEqual([...decoded.value.bytes.slice(0, 2)], [0xff, 0xd8], 'a JPEG SOI, not raw pixels');

  // Round-trip: the bytes handed downstream must describe themselves correctly,
  // because `./vision/image.ts` computes the scale it reports from this header.
  const reread = readImageHeader(decoded.value.bytes);
  assert.equal(reread.format, 'jpeg');
  assert.deepEqual({ w: reread.width, h: reread.height }, { w: 30, h: 40 });

  // A canary, not a preference. sharp is tried first, so this only holds while
  // the bundled libvips has no HEVC decoder. If it ever fails, libvips gained one
  // and the wasm fallback can be reconsidered.
  assert.match(decoded.value.decoder, /libheif/);
});

test('ensureAnalysable re-points the reference for HEIC and leaves a JPEG alone', async () => {
  const original = { imageId: 'heic-upload', bytes: new Uint8Array(REAL_HEIC), mimeType: 'image/heic' };
  const prepared = await ensureAnalysable(original);

  assert.equal(prepared.failure, undefined);
  assert.ok(prepared.decoded, 'a HEIC must have been transcoded');
  assert.equal(prepared.image.mimeType, 'image/jpeg');
  assert.notEqual(prepared.image.bytes, original.bytes);
  assert.equal(original.mimeType, 'image/heic', 'the caller\'s reference is not mutated');

  const jpeg = { imageId: 'jpeg-upload', bytes: prepared.image.bytes, mimeType: 'image/jpeg' };
  const untouched = await ensureAnalysable(jpeg);
  assert.equal(untouched.decoded, undefined, 'a format the pipeline handles is not re-encoded');
  assert.equal(untouched.failure, undefined);
  assert.equal(untouched.image.bytes, jpeg.bytes, 'the same buffer, not a copy');
});

// ---------------------------------------------------------------------------
// Failure has to be loud
// ---------------------------------------------------------------------------

test('an undecodable container fails with a stated reason, never silently', async () => {
  // A well-formed HEIC container header with no image item behind it: every
  // decoder recognises the brand and none of them can produce pixels.
  const bytes = heif({ properties: [ispe(4032, 3024)] });

  const decoded = await decodeToJpeg(bytes, 'heif');
  assert.equal(decoded.ok, false);
  if (decoded.ok) return;

  assert.ok(decoded.failure.reason.length > 0, 'a failure with no reason is a silent skip');
  assert.match(decoded.failure.reason, /sharp/, 'both attempts are named, not just the last');
  assert.match(decoded.failure.reason, /libheif/);
  assert.equal(decoded.failure.format, 'heif');

  const gap = undecodableGap(decoded.failure);
  assert.match(gap.capability, /HEIC\/HEIF/, 'the panel entry names the format');
  assert.match(gap.impact, /NO analysis ran/);
  assert.ok(gap.impact.includes(decoded.failure.reason), 'the decoder output is quoted verbatim');
  assert.match(gap.howTo ?? '', /JPEG|PNG/, 'and it says what to do about it');

  const refusal = undecodableRefusal(decoded.failure);
  assert.match(refusal, /could not be decoded/);
  assert.match(refusal, /no ranking is returned/);
});
