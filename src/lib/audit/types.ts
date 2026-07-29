/**
 * The audit trail — vocabulary.
 *
 * MASTER_PLAN §7: "Immutable audit log per search: who, when, what image, what
 * result, what they did with it — built for defence discovery from day one."
 *
 * "Built for defence discovery" is the design constraint that shapes everything
 * here. Assume a subpoena arrives asking for **every search that touched a given
 * image**, and that the answer has to be complete, attributable, and produced
 * without a developer writing a one-off query. That means:
 *
 *   - the image id is a first-class subject on every row that touched an image,
 *     not a key buried in a JSON blob;
 *   - a refusal is a row, not a silent return — "we declined to search that" is
 *     exculpatory and has to be provable;
 *   - rows are appended, never updated. The outcome of an action is a *second*
 *     row referencing the first. Enforced by a Postgres trigger
 *     (`reject_mutation`), not by convention.
 *
 * The physical write goes through A2's `writeAudit` in
 * `src/lib/db/queries/audit.ts`. This module owns the vocabulary, the wrapper
 * that makes skipping the write hard, and the discovery read path.
 */

import type { ModuleId } from '@/lib/contracts/types';
import type { Json } from '@/lib/db/types';
import type { Role, VerificationStatus } from '@/lib/auth/types';
import type { RequestContext } from '@/lib/auth/request-context';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Every auditable action. A2's `AuditAction` is an open union (`| (string & {})`)
 * so these are all valid at the DB boundary while staying closed here — a typo
 * in an action name is a compile error, which matters because a misspelled action
 * is a row that a discovery query will not find.
 */
export const AUDIT_ACTIONS = [
  // --- the governance-spec set --------------------------------------------
  'search.create',
  'search.view',
  'result.review',
  'case.create',
  'case.export',
  'image.upload',
  'verification.change',
  'ratelimit.hit',
  'module.blocked',

  // --- outcome and lifecycle rows -----------------------------------------
  // Written as *second* rows referencing a `search.create`, because audit rows
  // cannot be updated.
  'search.complete',
  'search.refuse',
  'search.error',
  'case.close',
  'ledger.append',
  'corroboration.record',

  // --- authentication ------------------------------------------------------
  'auth.sign-in',
  'auth.sign-in-failed',
  'auth.sign-out',
  'auth.provision',

  // --- administration ------------------------------------------------------
  'admin.role-change',
  'admin.license-verify',
  'corpus.ingest',
  'corpus.delete',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Actions a discovery request will almost always want. Kept as a named set so the
 * export path cannot forget one: an "every search touching this image" production
 * that omits refusals is incomplete, and incompleteness is what gets challenged.
 */
export const IMAGE_TOUCHING_ACTIONS: readonly AuditAction[] = [
  'image.upload',
  'search.create',
  'search.complete',
  'search.refuse',
  'search.error',
  'search.view',
  'result.review',
  'corroboration.record',
  'case.export',
  'module.blocked',
];

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

export type AuditSubjectType =
  | 'search'
  | 'image'
  | 'case'
  | 'geo_candidate'
  | 'vehicle_candidate'
  | 'corpus_match'
  | 'corpus'
  | 'app_user'
  | 'org'
  | 'module';

/**
 * What the action was done to.
 *
 * `imageId` is carried separately from `id` on purpose. A `result.review` row's
 * subject is a candidate, but discovery asks about the *image* — so the image id
 * rides along on every row that touched one, and `discovery.ts` queries it
 * directly instead of joining through three tables at subpoena time.
 */
export interface AuditSubject {
  readonly type: AuditSubjectType;
  readonly id: string | null;
  /** Set on every row whose action touched an image. */
  readonly imageId?: string;
  readonly caseId?: string;
  readonly searchId?: string;
  readonly module?: ModuleId;
}

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

/**
 * Who did it. `null` ids are legitimate only for pre-authentication events —
 * a failed sign-in has no resolvable user or org, and dropping the row because
 * the actor is unknown would hide exactly the pattern an abuse investigation
 * looks for.
 */
export interface AuditActorRef {
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly email?: string | null;
  readonly role?: Role;
  readonly verification?: VerificationStatus;
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

export type AuditOutcome = 'allowed' | 'denied' | 'error';

export interface AuditEvent {
  readonly action: AuditAction;
  readonly actor: AuditActorRef;
  readonly subject: AuditSubject;
  readonly context: RequestContext;
  readonly outcome: AuditOutcome;
  /**
   * Why, when `outcome !== 'allowed'`. Carries the refusal code and its citation
   * so the log answers "on what authority did you decline" without a lookup.
   */
  readonly refusal?: { readonly code: string; readonly reason: string; readonly citation?: string };
  /**
   * Anything needed to reconstruct the action later.
   *
   * NEVER put plate characters in here (AGENTS.md), never raw image bytes, and
   * never another tenant's identifiers. Keep it JSON-scalar-ish — this column is
   * read in bulk during a production.
   */
  readonly detail?: Readonly<Record<string, Json>>;
  /** The `search.create` row this outcome row refers to. Append, never update. */
  readonly priorAuditId?: string;
}

/** What a successful write hands back. */
export interface AuditReceipt {
  readonly id: string;
  readonly at: string;
  readonly action: AuditAction;
  readonly requestId: string;
}
