/**
 * LOCAL INDEX — the whole street-match path, on one laptop, with no cloud.
 *
 * `coverage.ts` and `refine.ts` are written against Postgres + pgvector, and that
 * is still the production shape. This module is the same two questions —
 * *how many indexed images are in this bbox* and *which of them match this
 * descriptor* — answered from the SQLite checkpoint `services/harvest` already
 * writes, so the operator can walk outside, photograph a Greenwich street, and
 * find out whether it matches without a Supabase project or a Modal account.
 *
 * WHY BRUTE FORCE, AND WHY THAT IS THE *CORRECT* CHOICE HERE
 * ----------------------------------------------------------
 * 1,593 rows x 512 fp32 = ~3.3 MB and ~816k multiply-adds per query. That is a
 * sub-millisecond exact scan. An ANN index over it would be slower to build than
 * to skip, and — the part that actually matters — HNSW is *approximate*: it
 * trades recall for speed. The failure this product cares about is a match that
 * existed and was not returned, and at this scale we can buy zero recall loss
 * for free. Do not add an ANN index here. If a metro-sized index (~300k rows)
 * ever lands in SQLite, that is the moment to reconsider, and the answer then is
 * Postgres, not a hand-rolled graph.
 *
 * WHY THE BBOX PRUNE COMES FIRST
 * ------------------------------
 * Same reason as the SQL path (`search_geo_candidates` applies it as a WHERE
 * before the `<=>` ordering, see `vprRetrieval.ts`): the nearest neighbours of an
 * ambiguous facade are scattered geographically, so scoring first and filtering
 * after returns a different — and worse — answer than filtering first, not merely
 * a slower one. `searchLocalIndex` reports `scored`, the number of rows that
 * actually reached the dot product, precisely so a test can prove the order.
 *
 * WHAT THIS MODULE WILL NOT DO
 * ----------------------------
 * It never invents a row. No index file, no embeddings in it, or nothing inside
 * the bbox all produce zero hits and a stated reason naming the command that
 * would change the answer. There is no sample metro and no demo coordinate.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { type EmbedClient, ModalEmbedClient } from '@/lib/cascade/embedClient';
import {
  type Bbox,
  type Result,
  type StageFailure,
  err,
  failure,
  ok,
} from '@/lib/cascade/types';
import type { GeoVectorHit, GeoVectorSearch } from '@/lib/cascade/vprRetrieval';
import type { CoverageCount, CoverageQuery } from './coverage';
import type { CapabilityGap, EnvLike } from './contract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LOCAL_INDEX = {
  /**
   * Locked by `mapillary_images.embedding halfvec(512)` and by pgvector's
   * 2,000-dim HNSW ceiling. A local index that drifted off it would work here
   * and then fail to load into Postgres, so the mismatch is refused rather than
   * absorbed.
   */
  dim: 512,
  /**
   * Norms further than this from 1.0 are repaired at load and counted. Cosine
   * similarity assumes unit vectors; an unnormalised row is a silent
   * wrong-ranking bug, never an error, so it is fixed and reported instead of
   * trusted.
   */
  normTolerance: 1e-3,
  /** Default embed service for the query side. Matches embed_index.py's default. */
  defaultEmbedUrl: 'http://localhost:8000',
} as const;

/** Env var that turns this backend on. Absent = current behaviour, unchanged. */
export const LOCAL_INDEX_ENV = 'LANTAGE_LOCAL_INDEX';

export const LOCAL_INDEX_GAP: CapabilityGap = {
  capability: 'Street-level index (local SQLite)',
  impact:
    'No local street-imagery index could be read, so street-level refinement has nothing to match against and no candidate can claim street precision. A region-level result is NOT re-labelled as a street result in its place.',
  envVar: `${LOCAL_INDEX_ENV} (+ LANTAGE_LOCAL_EMBED_URL for the query side)`,
  howTo:
    'Harvest and embed locally, then point at the file: `python3 services/harvest/harvest.py run --metro greenwich`, start `services/inference/.venv/bin/python services/inference/local_server.py`, run `python3 services/harvest/embed_index.py --db data/harvest/greenwich.sqlite --target sqlite`, then set LANTAGE_LOCAL_INDEX=data/harvest/greenwich.sqlite. See docs/HARVEST.md §14.',
};

// ---------------------------------------------------------------------------
// node:sqlite, typed locally
// ---------------------------------------------------------------------------
//
// `node:sqlite` ships with Node (>= 22.5, stable since 24) but is not in the
// repo's @types/node v20, and it is deliberately NOT a dependency: adding
// better-sqlite3 would mean a native build step in a tree whose tests run with
// no build step at all. So the surface we use is declared here, the same way
// `aliasHooks.ts` declares `module.registerHooks`.

interface SqliteStatement {
  all(...params: readonly unknown[]): unknown[];
  get(...params: readonly unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null = null;

/**
 * `node:sqlite`, obtained in the one way Turbopack cannot break.
 *
 * `createRequire(import.meta.url)('node:sqlite')` works under plain Node and
 * fails under Turbopack with `Cannot find module 'node:sqlite': Unsupported
 * external type Url for commonjs reference` — the bundler rewrites
 * `import.meta.url` and the resulting require has no resolvable base. That made
 * the entire street-match path return zero candidates in the running app while
 * every test passed, because tests run on plain Node and never see the bundler.
 * A failure invisible to CI and fatal in production is the worst kind, so the
 * lookup is now bundler-proof rather than merely re-ordered.
 *
 * `process.getBuiltinModule` (Node >= 22.14) exists precisely for this: it
 * returns a builtin without going through module resolution at all, so there is
 * nothing for a bundler to rewrite. `createRequire` stays as the fallback for
 * older runtimes, and both paths still surface a typed failure rather than
 * throwing, because a runtime without node:sqlite is a configuration problem the
 * operator has to be told about.
 */
function sqlite(): SqliteModule {
  if (!sqliteModule) {
    const builtin = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined;
    sqliteModule = builtin ?? (createRequire(import.meta.url)('node:sqlite') as SqliteModule);
  }
  return sqliteModule;
}

// ---------------------------------------------------------------------------
// The loaded index
// ---------------------------------------------------------------------------

export interface LocalIndexRow {
  mapillaryId: string;
  lat: number;
  lon: number;
  compassAngle: number | null;
  thumbUrl: string | null;
  sequenceId: string | null;
  capturedAt: string | null;
}

export interface LocalIndex {
  /** Absolute path of the SQLite file the rows came from. */
  readonly path: string;
  readonly rows: readonly LocalIndexRow[];
  /** Row-major `rows.length * dim` fp32 descriptors, each L2-normalised. */
  readonly vectors: Float32Array;
  readonly dim: number;
  /** Total harvested rows, embedded or not. The denominator for "how far along". */
  readonly harvested: number;
  /** Distinct `records.embed_model` values, e.g. `eigenplaces@…-local@1.0`. */
  readonly models: readonly string[];
  /** `meta.index_build`, pinned into result provenance. */
  readonly indexBuild: string | null;
  /** Submap label. Real metro slug when the harvest declared one. */
  readonly metro: string | null;
  /** Bounding box of the EMBEDDED rows — what this file can actually answer for. */
  readonly extent: Bbox | null;
  /** Rows whose stored norm was off and had to be repaired at load. */
  readonly renormalised: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  index: LocalIndex;
}

/**
 * Parsed indexes, keyed by absolute path and invalidated on mtime/size change.
 *
 * Parsing 1,593 pgvector literals is ~816k `Number()` calls. Cheap once, wasteful
 * on every keystroke of a refine loop, and the file only changes when
 * `embed_index.py` runs.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Drops cached state. Tests use it; nothing in the app path needs it.
 *
 * Clears the memoised `node:sqlite` handle as well as the parsed indexes, so a
 * test can observe *how* the module is acquired. Without that, the first test to
 * touch an index fixes the handle for the whole file and the acquisition path
 * becomes unobservable — which is precisely the blind spot that let the
 * Turbopack failure ship.
 */
export function clearLocalIndexCache(): void {
  cache.clear();
  sqliteModule = null;
}

export function resolveLocalIndexPath(env: EnvLike = process.env): string | null {
  const raw = env[LOCAL_INDEX_ENV]?.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/**
 * Reads and parses one harvest checkpoint.
 *
 * Returns a typed failure rather than throwing, for every reachable cause: no
 * file, no `embeddings` table (harvested but never embedded), a wrong-dimension
 * descriptor, or an unreadable database.
 */
export function loadLocalIndex(file: string): Result<LocalIndex, StageFailure> {
  const absolute = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return err(
      failure(
        'not-configured',
        `${LOCAL_INDEX_ENV} points at ${absolute}, which does not exist. Harvest one first — docs/HARVEST.md §14 — or unset the variable.`,
      ),
    );
  }

  const cached = cache.get(absolute);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return ok(cached.index);
  }

  let db: SqliteDatabase;
  try {
    // Read-only: this process must never be able to mutate a harvest
    // checkpoint, and an accidental write would also break `embed_index.py`'s
    // resumability.
    db = new (sqlite().DatabaseSync)(absolute, { readOnly: true });
  } catch (e) {
    return err(failure('unavailable', `Could not open the local index at ${absolute}: ${describe(e)}`));
  }

  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]).map((r) => r.name),
    );
    if (!tables.has('records')) {
      return err(
        failure(
          'invalid-response',
          `${absolute} has no \`records\` table, so it is not a harvest checkpoint. Point ${LOCAL_INDEX_ENV} at data/harvest/<metro>.sqlite.`,
        ),
      );
    }

    const harvested = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n,
    );

    if (!tables.has('embeddings')) {
      return err(
        failure(
          'not-configured',
          `${absolute} holds ${harvested.toLocaleString('en-US')} harvested record(s) but no \`embeddings\` table, so there are no descriptors to match against. Start services/inference/local_server.py and run \`python3 services/harvest/embed_index.py --db ${file} --target sqlite\`.`,
        ),
      );
    }

    const meta = new Map<string, string>();
    for (const row of db.prepare('SELECT key, value FROM meta').all() as {
      key: string;
      value: string;
    }[]) {
      meta.set(row.key, row.value);
    }

    const rawRows = db
      .prepare(
        `SELECT r.mapillary_id AS mapillaryId,
                r.lat          AS lat,
                r.lon          AS lon,
                r.compass_angle AS compassAngle,
                r.thumb_url    AS thumbUrl,
                r.sequence_id  AS sequenceId,
                r.captured_at  AS capturedAt,
                r.embed_model  AS embedModel,
                e.vec          AS vec,
                e.dim          AS dim
           FROM records r
           JOIN embeddings e ON e.mapillary_id = r.mapillary_id
          ORDER BY r.mapillary_id`,
      )
      .all() as LocalIndexSqlRow[];

    const rows: LocalIndexRow[] = [];
    const dim = LOCAL_INDEX.dim;
    const vectors = new Float32Array(rawRows.length * dim);
    const models = new Set<string>();
    let renormalised = 0;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const parsed = parsePgVector(raw.vec);
      if (!parsed || parsed.length !== dim) {
        return err(
          failure(
            'invalid-response',
            `Row ${raw.mapillaryId} in ${absolute} carries a ${parsed ? parsed.length : 'malformed'}-d descriptor; this index is ${dim}-d (mapillary_images.embedding is halfvec(512)). Re-run embed_index.py against a 512-d service.`,
          ),
        );
      }

      let norm = 0;
      for (let k = 0; k < dim; k++) norm += parsed[k] * parsed[k];
      norm = Math.sqrt(norm);
      if (!Number.isFinite(norm) || norm === 0) {
        return err(
          failure(
            'invalid-response',
            `Row ${raw.mapillaryId} in ${absolute} has a zero or non-finite descriptor, which cannot be compared by cosine similarity.`,
          ),
        );
      }
      const scale = Math.abs(norm - 1) > LOCAL_INDEX.normTolerance ? 1 / norm : 1;
      if (scale !== 1) renormalised++;
      const base = i * dim;
      for (let k = 0; k < dim; k++) vectors[base + k] = parsed[k] * scale;

      const lat = Number(raw.lat);
      const lon = Number(raw.lon);
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;

      if (raw.embedModel) models.add(String(raw.embedModel));
      rows.push({
        mapillaryId: String(raw.mapillaryId),
        lat,
        lon,
        compassAngle: raw.compassAngle === null ? null : Number(raw.compassAngle),
        thumbUrl: raw.thumbUrl === null ? null : String(raw.thumbUrl),
        sequenceId: raw.sequenceId === null ? null : String(raw.sequenceId),
        capturedAt: raw.capturedAt === null ? null : String(raw.capturedAt),
      });
    }

    const index: LocalIndex = {
      path: absolute,
      rows,
      vectors,
      dim,
      harvested,
      models: [...models].sort(),
      indexBuild: meta.get('index_build') ?? null,
      metro: metroLabel(meta.get('params'), absolute),
      extent: rows.length > 0 ? [minLon, minLat, maxLon, maxLat] : null,
      renormalised,
    };
    cache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, index });
    return ok(index);
  } catch (e) {
    return err(failure('unavailable', `Could not read the local index at ${absolute}: ${describe(e)}`));
  } finally {
    db.close();
  }
}

interface LocalIndexSqlRow {
  mapillaryId: string;
  lat: number;
  lon: number;
  compassAngle: number | null;
  thumbUrl: string | null;
  sequenceId: string | null;
  capturedAt: string | null;
  embedModel: string | null;
  vec: string;
  dim: number;
}

/** `'[1,2,3]'` — the literal `embed_index.py` writes, ready for `::vector`. */
function parsePgVector(literal: string): Float64Array | null {
  if (typeof literal !== 'string') return null;
  const body = literal.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (body.length === 0) return null;
  const parts = body.split(',');
  const out = new Float64Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

/**
 * A submap label the operator can recognise.
 *
 * `harvest.py` writes `metro: "adhoc"` for a bbox-only run, which names nothing.
 * In that case the file's own basename is the honest identifier, prefixed
 * `local:` so a result assembled from a laptop file is never mistaken in
 * provenance for a row that came out of the shared Postgres index.
 */
function metroLabel(paramsJson: string | undefined, absolute: string): string | null {
  const basename = path.basename(absolute).replace(/\.sqlite$/i, '');
  if (!paramsJson) return `local:${basename}`;
  try {
    const parsed = JSON.parse(paramsJson) as { metro?: unknown };
    const metro = typeof parsed.metro === 'string' ? parsed.metro.trim() : '';
    if (!metro || metro === 'adhoc') return `local:${basename}`;
    return metro;
  } catch {
    return `local:${basename}`;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface LocalSearchResult {
  hits: GeoVectorHit[];
  /** Rows inside the bbox — i.e. rows that reached the dot product. */
  scored: number;
  /** Rows in the file. `scored < scanned` is the prune doing its job. */
  scanned: number;
  indexBuild: string | null;
}

/**
 * Exact cosine top-k inside a bbox.
 *
 * The loop order is the contract: the bbox test comes before the dot product, so
 * a row outside the scope is never scored and can never displace a row inside
 * it. `scored` is returned so that ordering is observable from a test rather
 * than merely asserted in a comment.
 */
export function searchLocalIndex(args: {
  index: LocalIndex;
  embedding: readonly number[];
  bbox: Bbox;
  limit: number;
}): LocalSearchResult {
  const { index, bbox, limit } = args;
  const [west, south, east, north] = bbox;
  const dim = index.dim;

  // Defensive: cosine assumes a unit query. The local server already normalises,
  // but a caller that did not would get systematically deflated similarities and
  // no error anywhere.
  const query = new Float64Array(dim);
  let qNorm = 0;
  for (let k = 0; k < dim; k++) {
    const v = Number(args.embedding[k]);
    query[k] = v;
    qNorm += v * v;
  }
  qNorm = Math.sqrt(qNorm);
  if (qNorm > 0 && Math.abs(qNorm - 1) > LOCAL_INDEX.normTolerance) {
    for (let k = 0; k < dim; k++) query[k] /= qNorm;
  }

  const scoredRows: { row: LocalIndexRow; similarity: number }[] = [];
  let scored = 0;

  for (let i = 0; i < index.rows.length; i++) {
    const row = index.rows[i];
    // THE PRUNE. Before the dot product, deliberately — see the file header.
    if (row.lon < west || row.lon > east || row.lat < south || row.lat > north) continue;
    scored++;

    const base = i * dim;
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += index.vectors[base + k] * query[k];
    scoredRows.push({ row, similarity: Math.max(-1, Math.min(1, dot)) });
  }

  scoredRows.sort((a, b) => b.similarity - a.similarity);

  const hits: GeoVectorHit[] = scoredRows.slice(0, Math.max(0, limit)).map(({ row, similarity }) => ({
    mapillaryId: row.mapillaryId,
    lat: row.lat,
    lon: row.lon,
    similarity,
    compassAngle: row.compassAngle,
    // Mapillary thumb URLs are short-lived signed CDN links, so a stale one only
    // costs the inline preview; `vprMatchEvidence` still cites the permanent
    // mapillary.com/app link, which is what the analyst actually verifies with.
    ...(row.thumbUrl ? { thumbUrl: row.thumbUrl } : {}),
    ...(row.sequenceId ? { sequenceId: row.sequenceId } : {}),
    ...(row.capturedAt ? { capturedAt: row.capturedAt } : {}),
  }));

  return { hits, scored, scanned: index.rows.length, indexBuild: index.indexBuild };
}

/** `GeoVectorSearch` over a harvest checkpoint. Same shape `refine.ts` consumes. */
export class LocalIndexSearch implements GeoVectorSearch {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async searchGeoCandidates(args: {
    embedding: number[];
    bbox: Bbox;
    limit: number;
    signal?: AbortSignal;
  }): Promise<Result<{ hits: GeoVectorHit[]; indexBuild?: string }, StageFailure>> {
    if (args.signal?.aborted) {
      return err(failure('timeout', 'The refine request was aborted before the local index was searched.'));
    }
    if (args.embedding.length !== LOCAL_INDEX.dim) {
      return err(
        failure(
          'invalid-response',
          `Expected a ${LOCAL_INDEX.dim}-d EigenPlaces descriptor, got ${args.embedding.length}. The local index stores ${LOCAL_INDEX.dim}-d vectors, and mixing descriptor sizes silently returns nonsense rather than an error.`,
        ),
      );
    }

    const loaded = loadLocalIndex(this.file);
    if (!loaded.ok) return loaded;

    const found = searchLocalIndex({
      index: loaded.value,
      embedding: args.embedding,
      bbox: args.bbox,
      limit: args.limit,
    });

    if (found.scored === 0) {
      return err(
        failure(
          'no-input',
          `The local index at ${loaded.value.path} holds ${loaded.value.rows.length.toLocaleString('en-US')} embedded image(s), none of them inside this bbox, so nothing was compared. Refine over an area the harvest actually covers${loaded.value.extent ? ` — it spans [${loaded.value.extent.map((n) => n.toFixed(4)).join(', ')}]` : ''}.`,
        ),
      );
    }

    return ok({
      hits: found.hits,
      ...(found.indexBuild ? { indexBuild: found.indexBuild } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * `CoverageQuery` over a harvest checkpoint. Counts embedded rows and nothing else.
 *
 * `authoritative: true` is warranted here and is not the rubber stamp it would
 * be over PostgREST: there is no RLS between this process and the file, so a
 * zero really is "we looked and there is nothing", which is exactly the
 * distinction `coverage.ts` refuses to blur.
 */
export class LocalIndexCoverage implements CoverageQuery {
  readonly name: string;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.name = `local-sqlite:${path.basename(file)}`;
  }

  async count(args: {
    bbox: Bbox;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<CoverageCount, StageFailure>> {
    if (args.timeoutMs <= 0) {
      return err(failure('budget-exhausted', 'No time left to check local street-index coverage.'));
    }

    const loaded = loadLocalIndex(this.file);
    if (!loaded.ok) return loaded;
    const index = loaded.value;

    if (index.rows.length === 0) {
      return err(
        failure(
          'not-configured',
          `the local index at ${index.path} holds ${index.harvested.toLocaleString('en-US')} harvested record(s) but 0 descriptors, so there is nothing to match against. Start services/inference/local_server.py, then run \`python3 services/harvest/embed_index.py --db ${this.file} --target sqlite\`.`,
        ),
      );
    }

    const [west, south, east, north] = args.bbox;
    let rows = 0;
    for (const row of index.rows) {
      if (row.lon < west || row.lon > east || row.lat < south || row.lat > north) continue;
      rows++;
    }

    return ok({
      rows,
      metros: index.metro ? [index.metro] : [],
      indexBuilds: index.indexBuild ? [index.indexBuild] : [],
      authoritative: true,
      ...(index.extent ? { extent: index.extent } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Wiring — every one of these returns null when the local path is not configured
// ---------------------------------------------------------------------------

export function defaultLocalCoverageQuery(env: EnvLike = process.env): CoverageQuery | null {
  const file = resolveLocalIndexPath(env);
  return file ? new LocalIndexCoverage(file) : null;
}

export function defaultLocalVectorSearch(env: EnvLike = process.env): GeoVectorSearch | null {
  const file = resolveLocalIndexPath(env);
  return file ? new LocalIndexSearch(file) : null;
}

/**
 * The query side: the uploaded frame, embedded by the same model as the index.
 *
 * Reuses `ModalEmbedClient` rather than hand-rolling a fetch, because
 * `local_server.py` serves the identical `EmbedRequestSchema` /
 * `EmbedResponseSchema` contract — the class is an HTTP client for that
 * contract, not for Modal specifically. Going through it means the query path
 * keeps the response validation, the timeout handling and the typed failures,
 * and the version string that comes back (`eigenplaces-r50-512-local@1.0`) lands
 * in `ResultProvenance.models` so a local result is never mistaken for one
 * produced on the GPU.
 *
 * Enabled by `LANTAGE_LOCAL_EMBED_URL`, or implied by `LANTAGE_LOCAL_INDEX` —
 * an index with no embedder is a half-configured path, and defaulting the URL to
 * the port `embed_index.py` already assumes is the least surprising thing to do.
 */
export function defaultLocalEmbedClient(env: EnvLike = process.env): EmbedClient | null {
  const explicit = env.LANTAGE_LOCAL_EMBED_URL?.trim();
  if (explicit) return new ModalEmbedClient(explicit, undefined);
  if (resolveLocalIndexPath(env)) {
    return new ModalEmbedClient(LOCAL_INDEX.defaultEmbedUrl, undefined);
  }
  return null;
}

/** Read-only summary for docs, scripts and the honesty report. Never fabricated. */
export function describeLocalIndex(file: string): Result<
  {
    path: string;
    harvested: number;
    embedded: number;
    dim: number;
    models: readonly string[];
    indexBuild: string | null;
    metro: string | null;
    extent: Bbox | null;
    renormalised: number;
  },
  StageFailure
> {
  const loaded = loadLocalIndex(file);
  if (!loaded.ok) return loaded;
  const i = loaded.value;
  return ok({
    path: i.path,
    harvested: i.harvested,
    embedded: i.rows.length,
    dim: i.dim,
    models: i.models,
    indexBuild: i.indexBuild,
    metro: i.metro,
    extent: i.extent,
    renormalised: i.renormalised,
  });
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
