/**
 * The discovery read path.
 *
 * Design premise, stated plainly: **a subpoena will arrive asking for every
 * search that touched a given image.** Possibly years later, possibly naming an
 * analyst rather than an image, possibly asking what the tool refused to do. The
 * answer has to be complete and producible without a developer improvising a
 * query under time pressure — an incomplete production is what gets a case
 * excluded, and "our logging didn't capture that" is the worst possible answer.
 *
 * So the queries a production needs exist here, named, with the completeness
 * rules baked in:
 *
 *  - refusals are included, always. `search.refuse` and `module.blocked` rows are
 *    exculpatory and omitting them makes the production look curated.
 *  - the image id is filtered on `detail->>image_id`, which `log.ts` guarantees
 *    on every image-touching row, rather than joined through searches → results.
 *    A join misses rows whose search never persisted.
 *  - results are chronological, because a production read out of order is not a
 *    narrative.
 *
 * Reads are org-scoped by RLS through the request-scoped client. A cross-tenant
 * production is a legal instruction, not a feature, and needs the service-role
 * client and a human decision — hence `SCOPE_NOTE` below rather than a flag.
 */

import type { LantageClient } from '@/lib/db/client';
import { unwrap } from '@/lib/db/errors';
import type { AuditLogRow } from '@/lib/db/types';

import { IMAGE_TOUCHING_ACTIONS, type AuditAction } from './types';

export const SCOPE_NOTE =
  'Every function here reads through the caller’s RLS scope, so a production covers one ' +
  'org. Responding to a subpoena that reaches more than one tenant requires the ' +
  'service-role client and a documented legal decision — it is deliberately not a ' +
  'parameter on these functions.';

/**
 * Postgres indexes this read path needs. Written here because the queries below
 * are the reason they exist, and a sequential scan over a multi-year audit table
 * during a production is a real operational failure.
 *
 * TODO(A2): add these as a migration.
 *
 *   create index if not exists audit_log_image_idx
 *     on public.audit_log ((detail->>'image_id')) where detail ? 'image_id';
 *   create index if not exists audit_log_search_idx
 *     on public.audit_log ((detail->>'search_id')) where detail ? 'search_id';
 *   create index if not exists audit_log_case_idx
 *     on public.audit_log ((detail->>'case_id')) where detail ? 'case_id';
 *   create index if not exists audit_log_actor_at_idx
 *     on public.audit_log (actor_id, at desc);
 *   create index if not exists audit_log_action_at_idx
 *     on public.audit_log (action, at desc);
 */
export const AUDIT_INDEX_HINTS = [
  "(detail->>'image_id')",
  "(detail->>'search_id')",
  "(detail->>'case_id')",
  '(actor_id, at desc)',
  '(action, at desc)',
] as const;

const MAX_ROWS = 5000;

export interface DiscoveryWindow {
  /** ISO 8601, inclusive. */
  readonly since?: string;
  /** ISO 8601, inclusive. */
  readonly until?: string;
  readonly limit?: number;
}

/**
 * Every audit row that touched one image, oldest first.
 *
 * This is the query the premise above is about. It filters on the denormalised
 * `detail->>'image_id'` rather than joining, because a search that was refused
 * before it created a row in `searches` still touched the image, and a join would
 * silently drop it.
 */
export async function auditTrailForImage(
  client: LantageClient,
  imageId: string,
  window: DiscoveryWindow = {},
): Promise<AuditLogRow[]> {
  let q = client
    .from('audit_log')
    .select('*')
    .eq('detail->>image_id', imageId)
    .order('at', { ascending: true })
    .limit(clampLimit(window.limit));

  q = applyWindow(q, window);
  const rows = unwrap('auditTrailForImage', await q);

  // Belt and braces: also catch rows whose subject IS the image, in case a future
  // call site sets `subject` but forgets `subject.imageId`. Duplicates are merged
  // by id. Over-collecting is the right error here.
  let bySubject = client
    .from('audit_log')
    .select('*')
    .eq('subject_type', 'image')
    .eq('subject_id', imageId)
    .order('at', { ascending: true })
    .limit(clampLimit(window.limit));
  bySubject = applyWindow(bySubject, window);

  return mergeById(rows, unwrap('auditTrailForImage(subject)', await bySubject));
}

/** Every row for one search — the write-ahead row, its outcome, and every review. */
export async function auditTrailForSearch(
  client: LantageClient,
  searchId: string,
  window: DiscoveryWindow = {},
): Promise<AuditLogRow[]> {
  let q = client
    .from('audit_log')
    .select('*')
    .eq('detail->>search_id', searchId)
    .order('at', { ascending: true })
    .limit(clampLimit(window.limit));
  q = applyWindow(q, window);

  let bySubject = client
    .from('audit_log')
    .select('*')
    .eq('subject_type', 'search')
    .eq('subject_id', searchId)
    .order('at', { ascending: true })
    .limit(clampLimit(window.limit));
  bySubject = applyWindow(bySubject, window);

  return mergeById(
    unwrap('auditTrailForSearch', await q),
    unwrap('auditTrailForSearch(subject)', await bySubject),
  );
}

/** Every row for one case. The production a defence request for a case file wants. */
export async function auditTrailForCase(
  client: LantageClient,
  caseId: string,
  window: DiscoveryWindow = {},
): Promise<AuditLogRow[]> {
  let q = client
    .from('audit_log')
    .select('*')
    .eq('detail->>case_id', caseId)
    .order('at', { ascending: true })
    .limit(clampLimit(window.limit));
  q = applyWindow(q, window);
  return unwrap('auditTrailForCase', await q);
}

/**
 * Everything one analyst did. The abuse-investigation query, and the one the
 * GeoSpy incident is about — a stalking pattern shows up as one account running
 * many searches against images of the same person.
 */
export async function auditTrailForActor(
  client: LantageClient,
  actorId: string,
  window: DiscoveryWindow = {},
): Promise<AuditLogRow[]> {
  let q = client
    .from('audit_log')
    .select('*')
    .eq('actor_id', actorId)
    .order('at', { ascending: true })
    .limit(clampLimit(window.limit));
  q = applyWindow(q, window);
  return unwrap('auditTrailForActor', await q);
}

/**
 * Everything the tool *refused* to do. Run alongside any production: a log
 * showing only what happened, with no record of what was declined, reads as
 * curated.
 */
export async function refusalTrail(
  client: LantageClient,
  window: DiscoveryWindow = {},
): Promise<AuditLogRow[]> {
  let q = client
    .from('audit_log')
    .select('*')
    .in('action', ['search.refuse', 'module.blocked', 'ratelimit.hit', 'auth.sign-in-failed'])
    .order('at', { ascending: true })
    .limit(clampLimit(window.limit));
  q = applyWindow(q, window);
  return unwrap('refusalTrail', await q);
}

/**
 * A complete production bundle for one image: the trail, plus a manifest stating
 * what was searched for and which actions were considered in scope.
 *
 * The manifest matters as much as the rows. It is what lets the producing party
 * state on the record what the query covered, which is the difference between a
 * production and a pile of logs.
 */
export interface DiscoveryBundle {
  readonly subject: { readonly kind: 'image' | 'search' | 'case' | 'actor'; readonly id: string };
  readonly manifest: {
    readonly generatedAt: string;
    readonly window: DiscoveryWindow;
    readonly actionsInScope: readonly AuditAction[];
    readonly rowCount: number;
    /** True when the row cap was hit — the production is INCOMPLETE. Say so. */
    readonly truncated: boolean;
    readonly scopeNote: string;
  };
  readonly rows: readonly AuditLogRow[];
}

export async function discoveryBundleForImage(
  client: LantageClient,
  imageId: string,
  window: DiscoveryWindow = {},
): Promise<DiscoveryBundle> {
  const limit = clampLimit(window.limit);
  const rows = await auditTrailForImage(client, imageId, { ...window, limit });

  return {
    subject: { kind: 'image', id: imageId },
    manifest: {
      generatedAt: new Date().toISOString(),
      window,
      actionsInScope: IMAGE_TOUCHING_ACTIONS,
      rowCount: rows.length,
      truncated: rows.length >= limit,
      scopeNote: SCOPE_NOTE,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Filterable<T> = {
  gte(column: string, value: string): T;
  lte(column: string, value: string): T;
};

function applyWindow<T extends Filterable<T>>(q: T, window: DiscoveryWindow): T {
  let out = q;
  if (window.since) out = out.gte('at', window.since);
  if (window.until) out = out.lte('at', window.until);
  return out;
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 1000, 1), MAX_ROWS);
}

function mergeById(a: AuditLogRow[], b: AuditLogRow[]): AuditLogRow[] {
  const seen = new Map<string, AuditLogRow>();
  for (const row of [...a, ...b]) seen.set(row.id, row);
  return [...seen.values()].sort((x, y) => x.at.localeCompare(y.at));
}
