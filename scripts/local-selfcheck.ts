/**
 * LOCAL PATH self-retrieval check — the one experiment that proves the local
 * street match is wired correctly end to end.
 *
 *   node scripts/local-selfcheck.ts
 *   node scripts/local-selfcheck.ts --db data/harvest/greenwich.sqlite --samples 8
 *   LANTAGE_LOCAL_EMBED_URL=http://127.0.0.1:8010 node scripts/local-selfcheck.ts
 *
 * WHAT IT PROVES AND WHY THAT IS THE RIGHT THING TO PROVE
 * ------------------------------------------------------
 * It takes an image that is already IN the index, re-fetches those exact bytes,
 * and pushes them through the *query* path — the `EmbedClient` interface, as
 * base64, exactly as an uploaded photo travels — then searches the index. If the
 * index-time and query-time preprocessing are identical, that image must come
 * back at rank 1 with cosine similarity ~1.0.
 *
 * A resize mismatch, a different interpolation, a missing ImageNet normalise or
 * a forgotten L2 normalise between the two sides produces NO error anywhere. The
 * server returns 200, the search returns rows, the UI renders candidates — and
 * recall is quietly ruined. This number is the only thing that catches it, which
 * is why the whole local path is not considered wired until it reads ~1.0.
 *
 * WHAT IT DOES *NOT* PROVE
 * ------------------------
 * That a fresh photograph of the same street will match. Same-bytes retrieval is
 * an identity check on the plumbing, and it is the ceiling, not the expectation.
 * See docs/HARVEST.md §14 for what a genuinely new photo should expect from this
 * index (24% of the box's street length covered, 1.73 headings per cell).
 *
 * NOT a test: it needs the local inference server running and it re-fetches from
 * Mapillary's CDN, so `node --test` never runs it.
 */

import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

type NextResolve = (specifier: string, context: unknown) => unknown;
interface ModuleHooksApi {
  registerHooks(hooks: {
    resolve?: (specifier: string, context: { parentURL?: string }, next: NextResolve) => unknown;
  }): void;
}

const hasExtension = (s: string): boolean => /\.[cm]?[jt]sx?$/.test(s) || /\.(json|node)$/.test(s);

// Scoped to this repo's own files — see the long note in scripts/bench-locate.ts
// for why appending `.ts` inside node_modules breaks CommonJS packages.
(nodeModule as unknown as ModuleHooksApi).registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const target = path.join(srcRoot, specifier.slice(2));
      return next(pathToFileURL(hasExtension(target) ? target : `${target}.ts`).href, context);
    }
    const parent = context.parentURL ?? '';
    const ours = parent.startsWith(pathToFileURL(repoRoot).href) && !parent.includes('/node_modules/');
    if (ours && (specifier.startsWith('./') || specifier.startsWith('../')) && !hasExtension(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const localIndex = (await import('../src/lib/live/localIndex.ts')) as typeof import('../src/lib/live/localIndex.ts');
const { defaultLocalEmbedClient, loadLocalIndex, searchLocalIndex } = localIndex;

import type { Bbox } from '../src/lib/cascade/types.ts';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = arg('db', process.env.LANTAGE_LOCAL_INDEX ?? 'data/harvest/greenwich.sqlite');
const samples = Math.max(1, Number(arg('samples', '5')));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const loaded = loadLocalIndex(dbPath);
if (!loaded.ok) {
  console.error(`index unavailable: ${loaded.error.reason}`);
  process.exit(1);
}
const index = loaded.value;

console.log(`index      ${index.path}`);
console.log(`           ${index.rows.length.toLocaleString('en-US')} embedded / ${index.harvested.toLocaleString('en-US')} harvested, ${index.dim}-d`);
console.log(`model      ${index.models.join(', ') || '(none recorded)'}`);
console.log(`build      ${index.indexBuild ?? '(none)'}   metro ${index.metro ?? '(none)'}`);
console.log(`extent     [${(index.extent ?? []).map((n) => n.toFixed(5)).join(', ')}]`);
console.log(`renormed   ${index.renormalised} row(s) had to be re-normalised at load`);

if (index.rows.length === 0) {
  console.error('nothing embedded — run embed_index.py first. Refusing to report a similarity.');
  process.exit(1);
}

// The whole harvested extent, padded so a boundary row is not pruned out by a
// floating-point hair. Still a real prune: it is the file's own box.
const extent = index.extent as Bbox;
const pad = 1e-6;
const bbox: Bbox = [extent[0] - pad, extent[1] - pad, extent[2] + pad, extent[3] + pad];

const embedder = defaultLocalEmbedClient({
  LANTAGE_LOCAL_EMBED_URL: process.env.LANTAGE_LOCAL_EMBED_URL,
  LANTAGE_LOCAL_INDEX: dbPath,
});
if (!embedder) {
  console.error('no local embed client could be built — set LANTAGE_LOCAL_EMBED_URL.');
  process.exit(1);
}

// A deterministic stride rather than the first N, so the sample is not one
// sequence photographed on one afternoon.
const stride = Math.max(1, Math.floor(index.rows.length / samples));
const picked = Array.from({ length: samples }, (_, i) => index.rows[(i * stride) % index.rows.length]);

console.log('');
console.log('mapillary_id          rank  self-sim  next-best  margin  fetch+embed');
console.log('-------------------------------------------------------------------');

const similarities: number[] = [];
let failures = 0;

for (const row of picked) {
  if (!row.thumbUrl) {
    console.log(`${row.mapillaryId.padEnd(20)}  —     (no thumb url on record)`);
    failures++;
    continue;
  }

  const started = Date.now();
  let bytes: Uint8Array;
  try {
    const res = await fetch(row.thumbUrl);
    if (!res.ok) {
      console.log(`${row.mapillaryId.padEnd(20)}  —     (CDN HTTP ${res.status}: signed thumb URL expired)`);
      failures++;
      continue;
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.log(`${row.mapillaryId.padEnd(20)}  —     (fetch failed: ${e instanceof Error ? e.message : String(e)})`);
    failures++;
    continue;
  }

  // The QUERY path: bytes in, base64 over the same EmbedClient interface the
  // refine flow uses. Not the imageUrl path the index was built with — that
  // asymmetry is deliberate, because it is the path a real upload takes.
  const embedded = await embedder.embed({
    image: { imageId: row.mapillaryId, bytes, mimeType: 'image/jpeg' },
    models: ['eigenplaces'],
    timeoutMs: 60_000,
  });
  if (!embedded.ok) {
    console.log(`${row.mapillaryId.padEnd(20)}  —     (embed failed: ${embedded.error.reason})`);
    failures++;
    continue;
  }
  const vector = embedded.value.embeddings.eigenplaces?.vector ?? [];
  const tookMs = Date.now() - started;

  const found = searchLocalIndex({ index, embedding: vector, bbox, limit: 5 });
  const rank = found.hits.findIndex((h) => h.mapillaryId === row.mapillaryId) + 1;
  const self = rank > 0 ? found.hits[rank - 1].similarity : NaN;
  const nextBest = found.hits.find((h) => h.mapillaryId !== row.mapillaryId)?.similarity ?? NaN;

  if (rank === 1) similarities.push(self);
  else failures++;

  console.log(
    `${row.mapillaryId.padEnd(20)}  ${String(rank || '—').padStart(4)}  ${self.toFixed(6).padStart(8)}  ${nextBest.toFixed(6).padStart(9)}  ${(self - nextBest).toFixed(4).padStart(6)}  ${String(tookMs).padStart(6)}ms`,
  );
}

console.log('');
if (similarities.length === 0) {
  console.error('NO sample retrieved itself at rank 1. The local path is NOT wired correctly.');
  process.exit(1);
}

const min = Math.min(...similarities);
const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
console.log(
  `rank-1 on ${similarities.length}/${picked.length} samples; self-similarity min ${min.toFixed(6)}, mean ${mean.toFixed(6)}`,
);
if (min < 0.999) {
  console.error(
    'A self-similarity below ~1.0 means the index and the query were NOT preprocessed identically. Fix that before trusting any match.',
  );
  process.exit(1);
}
console.log(
  'Preprocessing matches on both sides. Note what this does NOT say: a FRESH photo of a covered street is a different and much harder question — see docs/HARVEST.md §14.',
);
if (failures > 0) process.exitCode = 1;
