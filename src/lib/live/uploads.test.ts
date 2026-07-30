/**
 * Upload store tests.
 *
 *   node --test src/lib/live/uploads.test.ts
 *
 * What is actually load-bearing here is the refusals. A store that accepts
 * anything and measures nothing would pass a happy-path test and then hand a
 * module a PDF, a 400 MB TIFF, or a filename with `../` in it. So: the MIME type
 * comes from the magic bytes and not the client, the size cap is enforced and
 * stated, the id is content-derived so dedup is automatic, and no client string
 * ever reaches a path.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type * as UploadsModule from './uploads';

/*
 * Local resolve hook rather than `cascade/testing/aliasHooks`: that shim appends
 * `.ts` to every extensionless relative specifier regardless of who asked, which
 * breaks CommonJS packages inside node_modules — sharp requires `./constructor`
 * internally and would end up looking for `./constructor.ts`. This version only
 * rewrites specifiers whose parent lives in our own source tree.
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
  // Every test writes to a throwaway directory, so a run never touches the
  // operator's own .lantage-uploads.
  root = await mkdtemp(path.join(tmpdir(), 'lantage-uploads-test-'));
  process.env.LANTAGE_UPLOAD_DIR = root;
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const specifier = './uploads.ts';
const uploads = (await import(specifier)) as typeof UploadsModule;

/** Return type inferred: sharp's default export is awkward to name explicitly. */
async function sharpLib() {
  return (await import('sharp')).default;
}

async function realPng(width: number, height: number): Promise<Uint8Array> {
  const sharp = await sharpLib();
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 60, b: 90 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

async function realJpeg(width: number, height: number): Promise<Uint8Array> {
  const sharp = await sharpLib();
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 30 } },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// MIME sniffing
// ---------------------------------------------------------------------------

test('the MIME type comes from the magic bytes, not the filename', async () => {
  const png = await realPng(800, 600);
  const stored = await uploads.storeUpload({ filename: 'evidence.jpg', bytes: png });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  // Named .jpg, sniffed as PNG. The client's word is not consulted.
  assert.equal(stored.record.mime, 'image/png');
  assert.equal(stored.record.filename, 'evidence.jpg');
});

test('a PDF wearing a .jpg extension is refused, and the message says why', async () => {
  const pdf = new Uint8Array([
    ...Buffer.from('%PDF-1.7\n', 'ascii'),
    ...new Uint8Array(512).fill(0x20),
  ]);
  const outcome = await uploads.storeUpload({ filename: 'claim-photo.jpg', bytes: pdf });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /PDF/);
  assert.match(outcome.reason, /JPEG, PNG, WebP, HEIC, HEIF, TIFF/);
});

test('formats outside the accepted set are named in the refusal', () => {
  const gif = new Uint8Array([...Buffer.from('GIF89a', 'ascii'), 0, 0, 0, 0]);
  assert.equal(uploads.sniffMime(gif), 'image/gif');
  assert.equal(uploads.sniffAcceptedFormat(gif), null);

  const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'ascii'));
  assert.equal(uploads.sniffMime(svg), 'image/svg+xml');
  assert.equal(uploads.sniffAcceptedFormat(svg), null);
});

test('HEIC is recognised from the ISOBMFF compatible-brand list', () => {
  // Major brand `mif1`, with `heic` only in the compatible list — how iPhone
  // HEICs actually declare themselves.
  const heic = new Uint8Array(32);
  heic.set(Buffer.from('\x00\x00\x00\x20ftypmif1', 'binary'), 0);
  heic.set(Buffer.from('\x00\x00\x00\x00mif1heic', 'binary'), 12);
  assert.equal(uploads.sniffMime(heic), 'image/heic');
  assert.equal(uploads.sniffAcceptedFormat(heic)?.mime, 'image/heic');
});

test('TIFF is accepted in both byte orders', () => {
  const le = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  const be = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  assert.equal(uploads.sniffMime(le), 'image/tiff');
  assert.equal(uploads.sniffMime(be), 'image/tiff');
});

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

test('dimensions and byte length are measured, not taken on trust', async () => {
  const jpeg = await realJpeg(1280, 960);
  const stored = await uploads.storeUpload({ filename: 'frame.jpeg', bytes: jpeg });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  assert.equal(stored.record.width, 1280);
  assert.equal(stored.record.height, 960);
  assert.equal(stored.record.bytes, jpeg.byteLength);
  assert.equal(stored.record.mime, 'image/jpeg');
  // The id is the sha256 of exactly these bytes.
  assert.match(stored.record.id, /^[0-9a-f]{64}$/);
  assert.equal(stored.record.sha256, stored.record.id);
  assert.equal(stored.record.previewUrl, `/api/uploads/${stored.record.id}`);
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

test('the same bytes uploaded twice return one record and one file', async () => {
  const png = await realPng(700, 500);
  const first = await uploads.storeUpload({ filename: 'a.png', bytes: png });
  const second = await uploads.storeUpload({ filename: 'renamed-copy.png', bytes: new Uint8Array(png) });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(first.record.id, second.record.id);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  // The original record wins, including its filename: the bytes were already ours.
  assert.equal(second.record.filename, 'a.png');

  const files = await readdir(root);
  assert.equal(files.filter((f) => f.startsWith(first.record.id) && f.endsWith('.png')).length, 1);
});

test('different bytes get different ids', async () => {
  const a = await uploads.storeUpload({ filename: 'a.png', bytes: await realPng(320, 240) });
  const b = await uploads.storeUpload({ filename: 'b.png', bytes: await realPng(321, 240) });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.record.id, b.record.id);
});

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

test('an oversize file is refused and the cap is stated', async () => {
  // A real JPEG header on a buffer past the cap: the size check must fire before
  // anything tries to decode 26 MB.
  const oversize = new Uint8Array(uploads.MAX_UPLOAD_BYTES + 1);
  oversize.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const outcome = await uploads.storeUpload({ filename: 'huge.jpg', bytes: oversize });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  // Both figures round to 25.0 MB at one byte over, so the exact counts are what
  // make the refusal readable.
  assert.match(outcome.reason, /26,214,401 bytes/);
  assert.match(outcome.reason, /26,214,400 bytes/);
  assert.match(outcome.reason, /25\.0 MB/);
});

test('a truncated transfer is refused rather than stored', async () => {
  const outcome = await uploads.storeUpload({
    filename: 'stub.jpg',
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /bytes/);
});

// ---------------------------------------------------------------------------
// The client never gets to name a path
// ---------------------------------------------------------------------------

test('a traversal filename cannot escape the upload directory', async () => {
  const png = await realPng(400, 300);
  const stored = await uploads.storeUpload({ filename: '../../../../etc/passwd.png', bytes: png });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  assert.equal(stored.record.filename, 'passwd.png');
  const onDisk = stored.record.path ?? '';
  assert.equal(path.dirname(onDisk), root, 'the stored file must sit directly in the upload root');
  assert.equal(path.basename(onDisk), `${stored.record.id}.png`);
});

test('the disk path is stripped before the record crosses the HTTP boundary', async () => {
  const stored = await uploads.storeUpload({ filename: 'x.png', bytes: await realPng(410, 300) });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  assert.equal(typeof stored.record.path, 'string');
  assert.equal(uploads.toClientRecord(stored.record).path, undefined);
  assert.equal('path' in uploads.toClientRecord(stored.record), false);
});

test('an id that is not a sha256 is rejected before it reaches the filesystem', async () => {
  assert.equal(uploads.isUploadId('../../etc/passwd'), false);
  assert.equal(uploads.isUploadId('a'.repeat(64)), true);
  assert.equal(uploads.isUploadId('A'.repeat(64)), false);
  assert.equal(await uploads.getUpload('../../etc/passwd'), null);
  assert.equal(await uploads.readUpload('nope'), null);
});

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

test('a browser-renderable original is served as itself', async () => {
  const jpeg = await realJpeg(900, 700);
  const stored = await uploads.storeUpload({ filename: 'served.jpg', bytes: jpeg });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  const served = await uploads.readUploadForServing(stored.record.id);
  assert.notEqual(served, null);
  assert.equal(served?.variant, 'original');
  assert.equal(served?.mime, 'image/jpeg');
  assert.equal(served?.bytes.byteLength, jpeg.byteLength);
});

test('the generated preview is smaller than the original and is labelled as a preview', async () => {
  const jpeg = await realJpeg(3000, 2000);
  const stored = await uploads.storeUpload({ filename: 'big.jpg', bytes: jpeg });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  const preview = await uploads.readUploadForServing(stored.record.id, { forcePreview: true });
  assert.equal(preview?.variant, 'preview');
  assert.equal(preview?.mime, 'image/jpeg');
  assert.ok(
    (preview?.bytes.byteLength ?? Infinity) < jpeg.byteLength,
    'a 3000px original must downscale',
  );
});

test('an unknown id serves nothing', async () => {
  assert.equal(await uploads.readUploadForServing('b'.repeat(64)), null);
});
