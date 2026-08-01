/**
 * COVERAGE — the honesty layer under the two-stage refine flow.
 *
 * One question, answered by counting rows and by nothing else: **do we have
 * street imagery indexed for this area?**
 *
 * The reason this module exists as its own file, ahead of the search it gates:
 * the failure mode of a street-level product is not a wrong street, it is a
 * *region-level guess dressed as a street-level answer*. Stage 1 returns
 * "Austin, ~15 mile radius". If stage 2 has no index over Austin and quietly
 * returns the same region with a tighter-looking radius, the operator reads a
 * street claim that nothing earned. So the product is built the other way round:
 * "Street precision available" is a label that must be paid for with rows in
 * `mapillary_images`, and where the rows do not exist the UI says so.
 *
 * Rules, in the order they matter:
 *
 *  1. **Never claim coverage that was not counted.** Every `available: true`
 *     here is backed by an exact `count=exact` over the bbox. There is no
 *     heuristic, no metro allow-list, and no "probably fine".
 *  2. **An unconfigured database is a normal answer, not an exception.** That is
 *     the current state of this deployment: no Supabase project, no harvest, no
 *     embeddings. It returns `{ available: false, code: 'no-index-configured' }`
 *     with the env vars and the harvest command needed, and it does not throw.
 *  3. **Zero rows read by a role that cannot see the table is not zero rows.**
 *     RLS grants `select` on `mapillary_images` to `authenticated` only, so the
 *     publishable/anon key reads an empty table whether or not one exists. That
 *     case reports `unverifiable`, never `no-rows-in-area` — the difference
 *     between "we looked and there is nothing" and "we were not allowed to look"
 *     is exactly the difference this module is for.
 */

import type { GeoCandidate, LatLon } from '@/lib/contracts/types';
import { RETRIEVAL } from '@/lib/cascade/config';
import { bboxFromCenterRadius } from '@/lib/cascade/geo';
import {
  type Bbox,
  type Result,
  type StageFailure,
  err,
  failure,
  ok,
} from '@/lib/cascade/types';
import type { CapabilityGap, EnvLike, RefineBbox, RegionRefinement } from './contract';

// ---------------------------------------------------------------------------
// Tunables, with the reason each has the value it has
// ---------------------------------------------------------------------------

export const COVERAGE = {
  /**
   * Rows pulled back alongside the exact count, purely to report *which* metro
   * submaps and index builds cover the area. The count itself comes from
   * `Content-Range` and is unaffected by this, so it is sized for one small
   * response body rather than for statistical accuracy.
   */
  sampleRows: 200,
  /**
   * Probe radius when `getCoverage` is handed a point instead of a bbox. A
   * street-precision candidate lives inside `RETRIEVAL.streetRadiusM` (120 m);
   * a kilometre is the smallest probe that answers "is this neighbourhood
   * indexed" rather than "is this exact kerb indexed", which is a question the
   * ANN search is there to answer.
   */
  pointProbeRadiusM: 1_000,
  /**
   * Ceiling on how far a stage-1 candidate's own radius may stretch the probe.
   * A continent-scale candidate would otherwise ask "is anything on Earth
   * indexed", and the answer to that is not the answer to "can I refine here".
   */
  maxProbeRadiusM: RETRIEVAL.regionRadiusM,
  /** The index is a database round trip, not a model call. */
  timeoutMs: 2_500,
} as const;

/**
 * What is missing, and exactly what closes it.
 *
 * Named here rather than inlined because three different call sites report the
 * same gap and the operator should read the same sentence from all of them.
 */
export const STREET_INDEX_GAP: CapabilityGap = {
  capability: 'Street-level index (Mapillary VPR)',
  impact:
    'No street-imagery index is reachable, so street-level refinement cannot run and no candidate can claim street precision. Region-level results are NOT re-labelled as street results in its place — where the index does not reach, the product says so.',
  envVar: 'NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY, MAPILLARY_ACCESS_TOKEN, MODAL_EMBED_URL',
  howTo:
    'Build a metro submap first — docs/HARVEST.md: `python3 services/harvest/harvest.py precheck --metro pittsburgh`, then `harvest.py run`, `embed_index.py`, `harvest.py load`, then `services/harvest/build_index.sql`. Point NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY at the database that holds the result.',
};

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * Why the answer is what it is, machine-readable. `reason` is the same fact in
 * English; consumers should branch on this and render that.
 */
export type CoverageCode =
  | 'covered'
  /** No database is configured at all. The current state of this deployment. */
  | 'no-index-configured'
  /** The table was read by a role that can see it, and the area is empty. */
  | 'no-rows-in-area'
  /** Configured, but the count did not complete: timeout, 5xx, bad schema. */
  | 'index-unreachable'
  /** The count returned zero from a role RLS does not let read the table. */
  | 'unverifiable';

export interface CoverageInfo {
  /** True ONLY when rows were counted and the count was greater than zero. */
  available: boolean;
  code: CoverageCode;
  /** One line the operator can act on. Always present, including when covered. */
  reason: string;
  /** The area that was actually counted. */
  bbox: Bbox;
  /** Exact row count inside the bbox. Absent when nothing could be counted. */
  indexedImages?: number;
  /** Distinct metro submaps seen in the sampled rows — the sub-count the UI shows. */
  metros?: string[];
  /** Distinct index builds. Pinned into result provenance for reproducibility. */
  indexBuilds?: string[];
  /** Present whenever `available` is false. Names the env var / command. */
  gap?: CapabilityGap;
}

// ---------------------------------------------------------------------------
// The narrow query interface
// ---------------------------------------------------------------------------

export interface CoverageCount {
  /** Exact number of embedded rows inside the bbox. */
  rows: number;
  metros: string[];
  indexBuilds: string[];
  /**
   * True when the credential used can actually read `mapillary_images`. A zero
   * from a role that cannot is not evidence of absence — see the file header.
   */
  authoritative: boolean;
}

export interface CoverageQuery {
  readonly name: string;
  count(args: {
    bbox: Bbox;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<CoverageCount, StageFailure>>;
}

// ---------------------------------------------------------------------------
// Endpoint resolution — shared with refine.ts's vector search
// ---------------------------------------------------------------------------

export interface IndexEndpoint {
  /** PostgREST base, e.g. https://xyz.supabase.co/rest/v1 */
  restUrl: string;
  key: string;
  /**
   * `service` bypasses RLS and is the only role that can count this table from a
   * server-side job. `publishable` is the anon role, which the RLS policy does
   * not grant `select` to — kept as a legible degraded case rather than treated
   * as equivalent.
   */
  role: 'service' | 'publishable';
}

export function resolveIndexEndpoint(env: EnvLike = process.env): IndexEndpoint | null {
  const base = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  if (!base) return null;

  const service = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  const publishable =
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const key = service ?? publishable;
  if (!key) return null;

  let restUrl: string;
  try {
    restUrl = new URL('/rest/v1', base).toString().replace(/\/$/, '');
  } catch {
    return null;
  }

  return { restUrl, key, role: service ? 'service' : 'publishable' };
}

// ---------------------------------------------------------------------------
// PostgREST implementation
// ---------------------------------------------------------------------------

/**
 * Counts rows over PostgREST rather than through `@supabase/ssr`.
 *
 * Two reasons, both structural. `src/lib/db/client.ts` imports `next/headers`,
 * which makes it unusable from the LIVE path's tests and from any non-request
 * context; and the exact count lives in the `Content-Range` *header*, which
 * `callJson` deliberately discards. So this is one hand-rolled fetch with its
 * own timeout, and it returns a typed failure like everything else.
 */
export class PostgrestCoverage implements CoverageQuery {
  readonly name = 'supabase:mapillary_images';
  private readonly endpoint: IndexEndpoint;

  // Declared and assigned rather than a constructor parameter property: this
  // tree must stay erasable so the node test runner needs no build step.
  constructor(endpoint: IndexEndpoint) {
    this.endpoint = endpoint;
  }

  async count(args: {
    bbox: Bbox;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<CoverageCount, StageFailure>> {
    if (args.timeoutMs <= 0) {
      return err(failure('budget-exhausted', 'No time left to check street-index coverage.'));
    }

    const [west, south, east, north] = args.bbox;
    const url = new URL(`${this.endpoint.restUrl}/mapillary_images`);
    url.searchParams.set('select', 'metro,index_build');
    // A row without a descriptor is in the table but cannot be retrieved, so it
    // is not coverage. Counting it would overstate what refinement can do.
    url.searchParams.append('embedding', 'not.is.null');
    url.searchParams.append('lon', `gte.${west}`);
    url.searchParams.append('lon', `lte.${east}`);
    url.searchParams.append('lat', `gte.${south}`);
    url.searchParams.append('lat', `lte.${north}`);

    const timeout = AbortSignal.timeout(args.timeoutMs);
    const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          apikey: this.endpoint.key,
          authorization: `Bearer ${this.endpoint.key}`,
          accept: 'application/json',
          'range-unit': 'items',
          range: `0-${COVERAGE.sampleRows - 1}`,
          prefer: 'count=exact',
        },
        signal,
        cache: 'no-store',
      });
    } catch (e) {
      if (timeout.aborted) {
        return err(
          failure('timeout', `The street index did not answer within ${args.timeoutMs}ms.`),
        );
      }
      return err(failure('unavailable', `The street index is unreachable: ${describe(e)}`));
    }

    if (res.status === 401 || res.status === 403) {
      return err(
        failure(
          'not-configured',
          'The street index refused the credential supplied. `mapillary_images` grants SELECT to the `authenticated` role only, so a publishable/anon key cannot read it — set SUPABASE_SECRET_KEY.',
        ),
      );
    }
    if (!res.ok) {
      return err(
        failure(
          res.status >= 500 || res.status === 429 ? 'unavailable' : 'invalid-response',
          `The street index returned HTTP ${res.status} when counting indexed images.`,
        ),
      );
    }

    const total = parseContentRangeTotal(res.headers.get('content-range'));
    if (total === null) {
      return err(
        failure(
          'invalid-response',
          'The street index did not return an exact row count, so coverage could not be verified. Coverage is never assumed.',
        ),
      );
    }

    let rows: unknown;
    try {
      rows = await res.json();
    } catch (e) {
      return err(failure('invalid-response', `The street index returned non-JSON: ${describe(e)}`));
    }

    const { metros, indexBuilds } = summariseRows(rows);
    return ok({
      rows: total,
      metros,
      indexBuilds,
      authoritative: this.endpoint.role === 'service',
    });
  }
}

/** `Content-Range: 0-199/12345` or `*​/0`. Returns null when there is no total. */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf('/');
  if (slash < 0) return null;
  const total = header.slice(slash + 1).trim();
  if (total === '*' || total === '') return null;
  const n = Number(total);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function summariseRows(rows: unknown): { metros: string[]; indexBuilds: string[] } {
  const metros = new Set<string>();
  const indexBuilds = new Set<string>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as { metro?: unknown; index_build?: unknown };
      if (typeof r.metro === 'string' && r.metro.length > 0) metros.add(r.metro);
      if (typeof r.index_build === 'string' && r.index_build.length > 0) {
        indexBuilds.add(r.index_build);
      }
    }
  }
  return { metros: [...metros].sort(), indexBuilds: [...indexBuilds].sort() };
}

/** `undefined` resolves from env; the result is null when nothing is configured. */
export function defaultCoverageQuery(env: EnvLike = process.env): CoverageQuery | null {
  const endpoint = resolveIndexEndpoint(env);
  return endpoint ? new PostgrestCoverage(endpoint) : null;
}

// ---------------------------------------------------------------------------
// getCoverage
// ---------------------------------------------------------------------------

/** A bbox to count, or a point to probe around. */
export type CoverageTarget = Bbox | RefineBbox | LatLon;

export interface CoverageDeps {
  /** `undefined` resolves from env; explicit `null` forces the unconfigured path. */
  query?: CoverageQuery | null;
  env?: EnvLike;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Radius used when `target` is a point. Defaults to `COVERAGE.pointProbeRadiusM`. */
  probeRadiusM?: number;
}

/**
 * Do we have street imagery indexed here?
 *
 * Never throws and never returns a guess. The four `available: false` codes are
 * deliberately distinct: an operator who is told "no index configured" goes and
 * runs the harvest, and an operator told "counted 0 rows in this area" goes and
 * widens the metro bbox. Collapsing them into one "unavailable" would hide which
 * of those two things is true.
 */
export async function getCoverage(
  target: CoverageTarget,
  deps: CoverageDeps = {},
): Promise<CoverageInfo> {
  const bbox = toBbox(target, deps.probeRadiusM ?? COVERAGE.pointProbeRadiusM);
  const env = deps.env ?? process.env;
  const query = deps.query === undefined ? defaultCoverageQuery(env) : deps.query;

  if (!query) {
    return {
      available: false,
      code: 'no-index-configured',
      reason:
        'no index configured: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY are unset, so there is no `mapillary_images` table to count rows in. No street-level candidate can exist for this area, and none is invented.',
      bbox,
      gap: STREET_INDEX_GAP,
    };
  }

  let counted: Result<CoverageCount, StageFailure>;
  try {
    counted = await query.count({
      bbox,
      timeoutMs: deps.timeoutMs ?? COVERAGE.timeoutMs,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (e) {
    // A coverage probe that throws must not take the request with it: the whole
    // point of this module is to be the thing that degrades gracefully.
    counted = err(failure('unavailable', `The coverage check failed: ${describe(e)}`));
  }

  if (!counted.ok) {
    return {
      available: false,
      code: counted.error.kind === 'not-configured' ? 'no-index-configured' : 'index-unreachable',
      reason: `Street-index coverage could not be verified, so it is not claimed: ${counted.error.reason}`,
      bbox,
      gap: STREET_INDEX_GAP,
    };
  }

  const { rows, metros, indexBuilds, authoritative } = counted.value;

  if (rows === 0 && !authoritative) {
    return {
      available: false,
      code: 'unverifiable',
      reason:
        'The index returned zero rows, but the query ran with the publishable (anon) key and RLS grants SELECT on `mapillary_images` to the `authenticated` role only. Zero here means "not allowed to look", not "nothing there" — set SUPABASE_SECRET_KEY to get a real count.',
      bbox,
      indexedImages: 0,
      metros,
      indexBuilds,
      gap: STREET_INDEX_GAP,
    };
  }

  if (rows === 0) {
    return {
      available: false,
      code: 'no-rows-in-area',
      reason:
        'Counted 0 indexed street images inside this area. Mapillary coverage is contributed, not systematic, so a gap here is normal — and a region-level result is not re-labelled as street-level to paper over it.',
      bbox,
      indexedImages: 0,
      metros,
      indexBuilds,
      gap: {
        ...STREET_INDEX_GAP,
        impact:
          'The street index is wired but holds nothing inside this area, so street-level refinement has nothing to match against here.',
      },
    };
  }

  return {
    available: true,
    code: 'covered',
    reason: `${rows.toLocaleString('en-US')} indexed street image${rows === 1 ? '' : 's'} inside this area${metros.length > 0 ? `, across ${metros.length} metro submap${metros.length === 1 ? '' : 's'} (${metros.join(', ')})` : ''}. Street precision is available here — subject to a match actually being found.`,
    bbox,
    indexedImages: rows,
    metros,
    indexBuilds,
  };
}

// ---------------------------------------------------------------------------
// UI-facing helpers
// ---------------------------------------------------------------------------

/**
 * Drives the "Street precision available" label on a stage-1 region.
 *
 * Note what it does NOT mean: not that this candidate *is* street-precise, and
 * not that refinement will find anything. It means the index physically covers
 * the area, so a street-level answer is possible in principle. Everything past
 * that has to be earned by a `vpr-match`.
 */
export async function isStreetPrecisionAvailable(
  candidate: Pick<GeoCandidate, 'center' | 'radiusM'>,
  deps: CoverageDeps = {},
): Promise<boolean> {
  const info = await coverageForCandidate(candidate, deps);
  return info.available;
}

/** The same check, with the reason kept. Use this when the UI shows a tooltip. */
export async function coverageForCandidate(
  candidate: Pick<GeoCandidate, 'center' | 'radiusM'>,
  deps: CoverageDeps = {},
): Promise<CoverageInfo> {
  return getCoverage(bboxForCandidate(candidate), deps);
}

/**
 * The bbox a "Refine in {region}" click must be scoped to.
 *
 * Clamped at both ends: never smaller than a city block, never larger than
 * `COVERAGE.maxProbeRadiusM`, because a scoped search whose scope is a continent
 * is not scoped and `refineInRegion` refuses it.
 */
export function bboxForCandidate(candidate: Pick<GeoCandidate, 'center' | 'radiusM'>): Bbox {
  const radiusM = Math.min(
    Math.max(candidate.radiusM, RETRIEVAL.streetRadiusM),
    COVERAGE.maxProbeRadiusM,
  );
  return bboxFromCenterRadius(candidate.center, radiusM);
}

/**
 * Stage-1 annotation: for each region, can it be refined and over what bbox.
 *
 * One coverage call per candidate. That is at most `RETRIEVAL.maxCandidates`
 * count queries against one indexed table, and the alternative — one union query
 * — would return a single answer for regions that are thousands of kilometres
 * apart, which is the wrong answer for all but one of them.
 */
export async function annotateRefinable(
  candidates: readonly GeoCandidate[],
  deps: CoverageDeps = {},
): Promise<RegionRefinement[]> {
  const out: RegionRefinement[] = [];
  for (const candidate of candidates) {
    const bbox = bboxForCandidate(candidate);
    const info = await getCoverage(bbox, deps);
    out.push({
      candidateId: candidate.id,
      refinable: info.available,
      reason: info.reason,
      coverage: info.code,
      bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
      metros: info.metros ?? [],
      ...(info.indexedImages === undefined ? {} : { indexedImages: info.indexedImages }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBbox(target: CoverageTarget, probeRadiusM: number): Bbox {
  if (Array.isArray(target)) {
    return [target[0], target[1], target[2], target[3]];
  }
  return bboxFromCenterRadius(target, probeRadiusM);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
