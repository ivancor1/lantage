/**
 * LOCAL INDEX tests.
 *
 *   node --test src/lib/live/localIndex.test.ts
 *
 * The three properties that make a local street match trustworthy, and one that
 * makes it honest:
 *
 *   - the BBOX PRUNE RUNS BEFORE SCORING. Asserted by construction, not by
 *     inspection: the fixture puts the globally best-matching descriptor
 *     *outside* the scope, so a filter-after-scoring implementation would return
 *     it. `scored` is also checked directly against the in-bbox row count.
 *   - SELF-RETRIEVAL RANKS FIRST at ~1.0 similarity. This is the check that
 *     catches a preprocessing mismatch between index and query, which produces
 *     no error anywhere — only silently worse recall.
 *   - an EMPTY INDEX returns zero candidates AND a stated reason. Never a
 *     fabricated hit, and never a bare empty array with no explanation.
 *   - with NOTHING configured the behaviour is exactly what it was before this
 *     backend existed: null wiring, `no-index-configured`, zero candidates.
 *
 * No network and no model. The fixtures are real SQLite files in a temp dir with
 * the harvest schema, and the descriptors are hand-built unit vectors — so every
 * similarity asserted here is arithmetic, not a stand-in.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as AliasHooks from '@/lib/cascade/testing/aliasHooks';
import type * as LocalIndexModule from './localIndex';
import type * as CoverageModule from './coverage';
import type * as RefineModule from './refine';
import type { EmbedClient } from '@/lib/cascade/embedClient';
import type { Bbox } from '@/lib/cascade/types';

const hooksSpecifier = './../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const {
  LOCAL_INDEX,
  LOCAL_INDEX_ENV,
  LocalIndexCoverage,
  LocalIndexSearch,
  clearLocalIndexCache,
  defaultLocalCoverageQuery,
  defaultLocalEmbedClient,
  defaultLocalVectorSearch,
  describeLocalIndex,
  loadLocalIndex,
  resolveLocalIndexPath,
  searchLocalIndex,
} = (await import('./localIndex.ts')) as typeof LocalIndexModule;
const { getCoverage, defaultCoverageQuery } = (await import('./coverage.ts')) as typeof CoverageModule;
const { refineInRegion, defaultVectorSearch } = (await import('./refine.ts')) as typeof RefineModule;

// ---------------------------------------------------------------------------
// Fixtures — real SQLite files with the harvest schema
// ---------------------------------------------------------------------------

// `node:sqlite` is not in @types/node v20, so the write surface used to build
// fixtures is declared here — same approach as `localIndex.ts` and
// `aliasHooks.ts`, and the reason is the same: no new dependency, no build step.
interface WritableStatement {
  run(...params: readonly (string | number | null)[]): unknown;
}
interface WritableDatabase {
  exec(sql: string): void;
  prepare(sql: string): WritableStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => WritableDatabase;
};

const DIM = 512;

interface FixtureRow {
  id: string;
  lat: number;
  lon: number;
  vector: number[];
  compassAngle?: number;
}

/** A unit vector that is `1` in one slot. Two of them are orthogonal, so cosine is 0. */
function basis(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot % DIM] = 1;
  return v;
}

/** Unit vector `cos(t)*e0 + sin(t)*e1`, so its cosine against e0 is exactly cos(t). */
function tilted(radians: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos(radians);
  v[1] = Math.sin(radians);
  return v;
}

function literal(vector: readonly number[]): string {
  return `[${vector.map((n) => n.toFixed(9)).join(',')}]`;
}

let fixtureSeq = 0;

/**
 * Writes a harvest checkpoint. `rows` with no `vector` are harvested-but-unembedded,
 * which is a real state of the pipeline and has to be distinguishable from empty.
 */
function makeIndex(options: {
  rows: FixtureRow[];
  unembedded?: { id: string; lat: number; lon: number }[];
  metro?: string;
  indexBuild?: string;
  withEmbeddingsTable?: boolean;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantage-localindex-'));
  const file = path.join(dir, `fixture-${fixtureSeq++}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE records (
      bucket_key TEXT PRIMARY KEY,
      cell_key TEXT NOT NULL,
      sector TEXT NOT NULL,
      mapillary_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      compass_angle REAL,
      captured_at TEXT,
      thumb_url TEXT NOT NULL,
      sequence_id TEXT,
      is_pano INTEGER NOT NULL,
      blur_applied INTEGER NOT NULL,
      score REAL NOT NULL,
      geom_source TEXT NOT NULL,
      quality_score REAL,
      embedded_at TEXT,
      embed_model TEXT,
      embed_dim INTEGER
    );
  `);
  if (options.withEmbeddingsTable !== false) {
    db.exec(`
      CREATE TABLE embeddings (
        mapillary_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        version TEXT NOT NULL,
        dim INTEGER NOT NULL CHECK (dim = 512),
        vec TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  const meta = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)');
  meta.run('params', JSON.stringify({ metro: options.metro ?? 'greenwich', schema: 1 }));
  meta.run('index_build', options.indexBuild ?? 'mapillary-greenwich@2026-08-01');

  const record = db.prepare(
    `INSERT INTO records(bucket_key, cell_key, sector, mapillary_id, lat, lon, compass_angle,
                         captured_at, thumb_url, sequence_id, is_pano, blur_applied, score,
                         geom_source, quality_score, embedded_at, embed_model, embed_dim)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const embedding = options.withEmbeddingsTable === false
    ? null
    : db.prepare(
        'INSERT INTO embeddings(mapillary_id, model, version, dim, vec, created_at) VALUES(?,?,?,?,?,?)',
      );

  for (const row of options.rows) {
    record.run(
      `${row.id}:n`,
      `${row.id}`,
      'n',
      row.id,
      row.lat,
      row.lon,
      row.compassAngle ?? 90,
      '2024-05-01T12:00:00Z',
      `https://example.invalid/${row.id}.jpg`,
      'seq-1',
      0,
      1,
      1,
      'computed',
      0.9,
      '2026-08-01T00:00:00Z',
      'eigenplaces@eigenplaces-r50-512-local@1.0',
      DIM,
    );
    embedding?.run(
      row.id,
      'eigenplaces',
      'eigenplaces-r50-512-local@1.0',
      DIM,
      literal(row.vector),
      '2026-08-01T00:00:00Z',
    );
  }

  for (const row of options.unembedded ?? []) {
    record.run(
      `${row.id}:n`,
      `${row.id}`,
      'n',
      row.id,
      row.lat,
      row.lon,
      90,
      '2024-05-01T12:00:00Z',
      `https://example.invalid/${row.id}.jpg`,
      'seq-1',
      0,
      1,
      1,
      'computed',
      0.9,
      null,
      null,
      null,
    );
  }

  db.close();
  clearLocalIndexCache();
  return file;
}

/** Downtown Greenwich, the harvested box. */
const GREENWICH: Bbox = [-73.64, 41.015, -73.615, 41.04];
/** Somewhere else entirely — used to hide the best match outside the scope. */
const FAR_LAT = 41.9;
const FAR_LON = -72.7;

// ---------------------------------------------------------------------------
// 1. The bbox prune runs BEFORE scoring
// ---------------------------------------------------------------------------

test('the bbox prune is applied before scoring, not after', () => {
  // `outside` is a perfect match for the query; `inside-*` are progressively
  // worse. A post-filter implementation ranks `outside` first and then drops it,
  // returning fewer rows than asked for; a pre-filter never scores it at all.
  const file = makeIndex({
    rows: [
      { id: 'outside', lat: FAR_LAT, lon: FAR_LON, vector: tilted(0) },
      { id: 'inside-near', lat: 41.02, lon: -73.63, vector: tilted(0.2) },
      { id: 'inside-far', lat: 41.03, lon: -73.62, vector: tilted(1.0) },
    ],
  });

  const loaded = loadLocalIndex(file);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const found = searchLocalIndex({
    index: loaded.value,
    embedding: tilted(0),
    bbox: GREENWICH,
    limit: 10,
  });

  assert.equal(found.scanned, 3, 'the file holds three rows');
  assert.equal(found.scored, 2, 'only the two rows inside the bbox reached the dot product');
  assert.deepEqual(
    found.hits.map((h) => h.mapillaryId),
    ['inside-near', 'inside-far'],
    'the out-of-scope perfect match must never appear, and the in-scope rows keep cosine order',
  );
  // The arithmetic is checked too, so "ranked correctly" is not just ordering luck.
  assert.ok(Math.abs(found.hits[0].similarity - Math.cos(0.2)) < 1e-5);
  assert.ok(Math.abs(found.hits[1].similarity - Math.cos(1.0)) < 1e-5);
});

test('a bbox that contains nothing scores nothing and says so', async () => {
  const file = makeIndex({
    rows: [{ id: 'g1', lat: 41.02, lon: -73.63, vector: basis(0) }],
  });

  const search = new LocalIndexSearch(file);
  const result = await search.searchGeoCandidates({
    embedding: basis(0),
    bbox: [-80.02, 40.41, -79.95, 40.46], // Pittsburgh
    limit: 10,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'no-input');
  assert.match(result.error.reason, /none of them inside this bbox/i);
  // The reason has to say where the index DOES reach, or it is not actionable.
  assert.match(result.error.reason, /-73\.63/);
});

// ---------------------------------------------------------------------------
// 2. Self-retrieval
// ---------------------------------------------------------------------------

test('an indexed descriptor retrieves itself at rank 1 with similarity ~1.0', () => {
  const target = tilted(0.35);
  const file = makeIndex({
    rows: [
      { id: 'decoy-a', lat: 41.021, lon: -73.631, vector: tilted(0.9) },
      { id: 'target', lat: 41.022, lon: -73.632, vector: target },
      { id: 'decoy-b', lat: 41.023, lon: -73.633, vector: basis(7) },
    ],
  });

  const loaded = loadLocalIndex(file);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const found = searchLocalIndex({
    index: loaded.value,
    embedding: target,
    bbox: GREENWICH,
    limit: 3,
  });

  assert.equal(found.hits[0].mapillaryId, 'target');
  assert.ok(
    found.hits[0].similarity > 0.9999,
    `self-retrieval similarity was ${found.hits[0].similarity}; anything below ~1.0 means the stored and queried descriptors were not produced identically`,
  );
});

test('an unnormalised query is repaired rather than silently mis-ranked', () => {
  const file = makeIndex({
    rows: [{ id: 'g1', lat: 41.02, lon: -73.63, vector: basis(3) }],
  });
  const loaded = loadLocalIndex(file);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const scaled = basis(3).map((v) => v * 17);
  const found = searchLocalIndex({
    index: loaded.value,
    embedding: scaled,
    bbox: GREENWICH,
    limit: 1,
  });
  assert.ok(found.hits[0].similarity > 0.9999, 'cosine must not scale with the query magnitude');
});

// ---------------------------------------------------------------------------
// 3. An empty index returns zero candidates and a reason
// ---------------------------------------------------------------------------

test('a harvested-but-unembedded index reports the gap instead of claiming coverage', async () => {
  const file = makeIndex({
    rows: [],
    unembedded: [
      { id: 'u1', lat: 41.02, lon: -73.63 },
      { id: 'u2', lat: 41.03, lon: -73.62 },
    ],
  });

  const info = await getCoverage(GREENWICH, { query: new LocalIndexCoverage(file), env: {} });
  assert.equal(info.available, false);
  assert.equal(info.code, 'no-index-configured');
  assert.match(info.reason, /2 harvested record\(s\) but 0 descriptors/);
  assert.match(info.reason, /embed_index\.py/);
  assert.ok(info.gap, 'an unavailable coverage answer must name what would change it');
});

test('an index file that does not exist is a stated gap, not a crash', async () => {
  const missing = path.join(os.tmpdir(), 'lantage-does-not-exist', 'nope.sqlite');
  const info = await getCoverage(GREENWICH, { query: new LocalIndexCoverage(missing), env: {} });
  assert.equal(info.available, false);
  assert.equal(info.code, 'no-index-configured');
  assert.match(info.reason, /does not exist/i);
});

test('coverage over a real local index reports counted rows, its metro and its extent', async () => {
  const file = makeIndex({
    rows: [
      { id: 'g1', lat: 41.02, lon: -73.63, vector: basis(0) },
      { id: 'g2', lat: 41.03, lon: -73.62, vector: basis(1) },
      { id: 'far', lat: FAR_LAT, lon: FAR_LON, vector: basis(2) },
    ],
    metro: 'greenwich',
  });

  const info = await getCoverage(GREENWICH, { query: new LocalIndexCoverage(file), env: {} });
  assert.equal(info.available, true);
  assert.equal(info.code, 'covered');
  assert.equal(info.indexedImages, 2, 'the out-of-bbox row is counted out, not in');
  assert.deepEqual(info.metros, ['greenwich']);
  assert.deepEqual(info.indexBuilds, ['mapillary-greenwich@2026-08-01']);
  // [west, south, east, north] over ALL embedded rows, including the far one —
  // "where this file reaches", not "where the bbox was".
  assert.deepEqual(info.extent, [-73.63, 41.02, FAR_LON, FAR_LAT]);
  assert.match(info.reason, /spans \[/);
});

test('an adhoc harvest is labelled by its file, never left nameless', () => {
  const file = makeIndex({
    rows: [{ id: 'g1', lat: 41.02, lon: -73.63, vector: basis(0) }],
    metro: 'adhoc',
  });
  const described = describeLocalIndex(file);
  assert.equal(described.ok, true);
  if (!described.ok) return;
  assert.match(described.value.metro ?? '', /^local:fixture-/);
  assert.equal(described.value.embedded, 1);
  assert.equal(described.value.dim, LOCAL_INDEX.dim);
});

// ---------------------------------------------------------------------------
// 4. With nothing configured, behaviour is unchanged
// ---------------------------------------------------------------------------

test('with neither Postgres nor a local index configured, nothing is wired and nothing is claimed', async () => {
  assert.equal(resolveLocalIndexPath({}), null);
  assert.equal(defaultLocalCoverageQuery({}), null);
  assert.equal(defaultLocalVectorSearch({}), null);
  assert.equal(defaultLocalEmbedClient({}), null);
  assert.equal(defaultCoverageQuery({}), null);
  assert.equal(defaultVectorSearch({}), null);

  const info = await getCoverage(GREENWICH, { env: {}, query: defaultCoverageQuery({}) });
  assert.equal(info.available, false);
  assert.equal(info.code, 'no-index-configured');
});

test(`${LOCAL_INDEX_ENV} alone wires coverage, search and the query embedder`, () => {
  const file = makeIndex({ rows: [{ id: 'g1', lat: 41.02, lon: -73.63, vector: basis(0) }] });
  const env = { [LOCAL_INDEX_ENV]: file };

  assert.equal(resolveLocalIndexPath(env), file);
  assert.ok(defaultCoverageQuery(env), 'coverage falls back to the local file');
  assert.ok(defaultVectorSearch(env), 'refine falls back to the local file');
  assert.ok(defaultLocalEmbedClient(env), 'the query side defaults to the local embed server');
});

test('Postgres wins over a local index when both are configured', () => {
  const file = makeIndex({ rows: [{ id: 'g1', lat: 41.02, lon: -73.63, vector: basis(0) }] });
  const query = defaultCoverageQuery({
    [LOCAL_INDEX_ENV]: file,
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
  });
  assert.equal(query?.name, 'supabase:mapillary_images');
});

// ---------------------------------------------------------------------------
// 5. End to end through refineInRegion — the shape refine.ts already consumes
// ---------------------------------------------------------------------------

function png(width: number, height: number, byteLength = 8_192): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  for (const [offset, value] of [
    [16, width],
    [20, height],
  ] as const) {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function embedClientReturning(vector: number[]): EmbedClient {
  return {
    async embed() {
      return {
        ok: true,
        value: {
          embeddings: {
            eigenplaces: {
              vector,
              dim: vector.length,
              model: 'eigenplaces',
              version: 'eigenplaces-r50-512-local@1.0',
            },
          },
          tookMs: 900,
        },
      };
    },
  };
}

test('refineInRegion over a local index produces street candidates with vpr-match evidence', async () => {
  const target = tilted(0.05);
  const file = makeIndex({
    rows: [
      { id: 'm-target', lat: 41.0205, lon: -73.6305, vector: target, compassAngle: 44 },
      { id: 'm-neighbour', lat: 41.0206, lon: -73.6306, vector: tilted(0.12), compassAngle: 47 },
      { id: 'm-elsewhere', lat: 41.0380, lon: -73.6180, vector: tilted(1.3), compassAngle: 200 },
    ],
  });
  const env = { [LOCAL_INDEX_ENV]: file };

  const result = await refineInRegion(
    {
      uploadId: 'b'.repeat(64),
      region: { label: 'Greenwich', admin1: 'Connecticut', country: 'United States' },
      bbox: GREENWICH,
    },
    {
      readFrame: async () => ({ bytes: png(1600, 1200), mime: 'image/png' }),
      coverage: defaultCoverageQuery(env),
      embed: embedClientReturning(target),
      search: defaultVectorSearch(env),
      geocoder: null,
      env,
    },
  );

  assert.equal(result.refusal, undefined);
  assert.equal(result.coverage.available, true);
  assert.equal(result.coverage.indexedImages, 3);
  assert.ok(result.candidates.length > 0, 'a covered area with a matching descriptor yields candidates');

  const top = result.candidates[0];
  assert.equal(top.precision, 'street');
  assert.ok(
    top.evidence.some((e) => e.kind === 'vpr-match'),
    'street precision is earned by a vpr-match or it is not earned at all',
  );
  assert.equal(top.evidence[0].reference?.mapillaryId, 'm-target');
  assert.equal(result.provenance.indexBuild, 'mapillary-greenwich@2026-08-01');
  assert.match(result.provenance.models.vpr ?? '', /local/);
});

test('refineInRegion over an EMPTY local index returns zero candidates and a stated reason', async () => {
  const file = makeIndex({ rows: [], unembedded: [{ id: 'u1', lat: 41.02, lon: -73.63 }] });
  const env = { [LOCAL_INDEX_ENV]: file };

  const result = await refineInRegion(
    {
      uploadId: 'c'.repeat(64),
      region: { label: 'Greenwich' },
      bbox: GREENWICH,
    },
    {
      readFrame: async () => ({ bytes: png(1600, 1200), mime: 'image/png' }),
      coverage: defaultCoverageQuery(env),
      embed: embedClientReturning(basis(0)),
      search: defaultVectorSearch(env),
      geocoder: null,
      env,
    },
  );

  assert.equal(result.candidates.length, 0);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.coverage.available, false);
  assert.match(result.coverage.reason, /0 descriptors/);
  assert.ok(result.unavailable.length > 0, 'the gap must be named, not left blank');
  // Nothing anywhere in the result may claim street precision.
  assert.equal(
    JSON.stringify(result.candidates).includes('street'),
    false,
  );
});

/**
 * REGRESSION GUARD — the bug this catches cost the product every street result.
 *
 * `createRequire(import.meta.url)('node:sqlite')` resolves fine under plain Node
 * and throws under Turbopack ("Unsupported external type Url for commonjs
 * reference"). Because every test in this file runs on plain Node, the entire
 * suite passed while `/api/refine` returned zero candidates in the running app,
 * for weeks. A test that merely opens an index cannot see the difference.
 *
 * So this asserts the *acquisition strategy* rather than the outcome:
 * `process.getBuiltinModule` must be consulted first, because it is the one
 * lookup a bundler cannot rewrite. If someone reorders these and puts
 * `createRequire` back in front, this fails here instead of silently in
 * production.
 */
test('node:sqlite is acquired via process.getBuiltinModule, not createRequire', () => {
  clearLocalIndexCache();
  const file = makeIndex({ rows: [{ id: 'g1', lat: 41.02, lon: -73.63, vector: basis(0) }] });

  const original = process.getBuiltinModule;
  let consulted = false;
  try {
    process.getBuiltinModule = ((id: string) => {
      if (id === 'node:sqlite') consulted = true;
      return original.call(process, id as 'node:sqlite');
    }) as typeof process.getBuiltinModule;
    const result = loadLocalIndex(file);
    assert.equal(result.ok, true, 'the index must still load');
  } finally {
    process.getBuiltinModule = original;
  }

  assert.equal(
    consulted,
    true,
    'process.getBuiltinModule("node:sqlite") was never called \u2014 the loader has ' +
      'reverted to a bundler-fragile require and Turbopack will return zero ' +
      'candidates in the running app while this suite stays green.',
  );
});
