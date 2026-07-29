/**
 * The corroboration workflow — the Detroit consent-decree standard as enforced
 * workflow rather than a policy PDF.
 *
 * The Robert Williams settlement (June 2024, $300k plus four years of federal
 * oversight over Detroit PD) is the national template, and 8+ states now have
 * statutes to the same effect: no arrest on an AI match alone, and no photo
 * lineup built from a match without independent linking evidence. Detroit's FR
 * use fell ~91% afterwards. MASTER_PLAN §7 makes this a product requirement:
 * "A forced corroboration step before a result can be marked Confirmed."
 *
 * So: **a candidate cannot reach `review: 'confirmed'` without a recorded
 * corroboration**, and that is enforced here at the function and type level, not
 * in the UI.
 *
 * How the enforcement actually holds:
 *
 *  - `canConfirm()` returns a typed refusal, so a caller cannot branch past it.
 *  - `ConfirmedReview` is a branded type mintable only by `recordCorroboration`.
 *    A function that persists a confirmation takes `ConfirmedReview`, so "set
 *    review = 'confirmed'" without going through here does not type-check.
 *  - `recordCorroboration` demands an `AuditedAction`, which only
 *    `withAudit` can produce. A confirmation is therefore always in the log.
 *  - The order of writes is ledger-entry-then-review. If the review update fails,
 *    the corroboration is still on the record; if the ledger append fails, the
 *    candidate stays unconfirmed. Both failure modes are the safe one.
 *
 * A2's `setCandidateReview` is deliberately dumb about this — its docstring says
 * "the caller must also append a ledger entry". This module is that caller. Do
 * not call `setCandidateReview(…, 'confirmed')` from anywhere else.
 */

import type { LedgerEntry, ReviewState } from '@/lib/contracts/types';
import { type Gate, permit, refuse } from '@/lib/auth/result';
import type { AuthUser } from '@/lib/auth/types';
import { roleSatisfies } from '@/lib/auth/types';
import type { LantageClient } from '@/lib/db/client';
import { appendLedger } from '@/lib/db/queries/ledger';
import { setCandidateReview, type ReviewableTable } from '@/lib/db/queries/searches';

import { writeAuditEvent } from './log';
import type { AuditActorRef, AuditSubject } from './types';
import type { AuditedAction } from './with-audit';
import type { RequestContext } from '@/lib/auth/request-context';

// ---------------------------------------------------------------------------
// Corroboration
// ---------------------------------------------------------------------------

/**
 * How the finding was independently checked.
 *
 * The list is closed on purpose. A free-text "method" field collects "verified"
 * and "looks right", which is precisely the non-corroboration the consent decree
 * exists to stop. Every member here names something a human did *outside* this
 * tool, and something a defence expert can go and re-do.
 */
export const CORROBORATION_METHODS = [
  /** Opened the cited pano/Street View and compared the scene by eye. */
  'independent-imagery-review',
  /** Physically attended, or a field adjuster did. */
  'site-visit',
  /** Matched against a document — policy, deed, permit, invoice, police report. */
  'document-match',
  /** A named person confirmed it: witness, insured, claimant, contractor. */
  'witness-statement',
  /** A second analyst reached the same conclusion without seeing the first result. */
  'independent-analyst-review',
  /** Records from a third party: utility, weather, telematics, permit office. */
  'third-party-records',
  /** Metadata verified against an independent source, not just read from the file. */
  'corroborated-metadata',
] as const;

export type CorroborationMethod = (typeof CORROBORATION_METHODS)[number];

export function isCorroborationMethod(v: unknown): v is CorroborationMethod {
  return typeof v === 'string' && (CORROBORATION_METHODS as readonly string[]).includes(v);
}

/** Matches `LedgerEntry['corroboration']` in the contracts, which is the stored shape. */
export type CorroborationRecord = NonNullable<LedgerEntry['corroboration']>;

export interface CorroborationInput {
  readonly method: CorroborationMethod;
  /**
   * What was actually checked and what was found. Free text, but substantive —
   * `MIN_NOTE_LENGTH` exists because "confirmed" is not a corroboration note and
   * the reviewer four years from now needs to be able to follow it.
   */
  readonly note: string;
}

/**
 * Long enough to have said something, short enough not to become a case file.
 * 24 characters is roughly "matched permit #4471 at address", which is the
 * shortest genuinely useful note observed.
 */
export const MIN_NOTE_LENGTH = 24;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type ConfirmDenialCode =
  | 'not-authenticated'
  | 'insufficient-role'
  | 'corroboration-missing'
  | 'corroboration-method-invalid'
  | 'corroboration-note-too-short'
  | 'self-corroboration'
  | 'no-case';

declare const confirmedBrand: unique symbol;

/**
 * A confirmation that has cleared the corroboration gate.
 *
 * Branded so it cannot be constructed by an object literal. Any function that
 * writes `review: 'confirmed'` should take one of these; nothing else can mint
 * it, so "confirmed without corroboration" is unrepresentable rather than merely
 * discouraged.
 *
 * The brand is **type-only** — `declare const` emits no JavaScript, so it must
 * never appear in a runtime object literal.
 */
export interface ConfirmedReview {
  readonly [confirmedBrand]: true;
  readonly review: Extract<ReviewState, 'confirmed'>;
  readonly corroboration: CorroborationRecord;
}

/**
 * May this user mark this result confirmed, with this corroboration?
 *
 * Pure and synchronous — no I/O — so it is usable from a Server Component to
 * decide whether to enable the control, and from the write path to enforce it.
 * Both call it; only the write path is load-bearing.
 *
 * Pass `corroboration: undefined` to ask "could they confirm at all", which is
 * how the UI decides whether to show the corroboration form or a role message.
 */
export function canConfirm(
  user: AuthUser | null,
  args: {
    readonly corroboration?: CorroborationInput;
    /** The ledger requires a case. A confirmation outside a case cannot be recorded. */
    readonly caseId?: string;
    /**
     * Who produced the result being confirmed. When this equals the confirming
     * user, `independent-analyst-review` is not independent — see below.
     */
    readonly originatingAnalystId?: string;
  } = {},
): Gate<ConfirmedReview, ConfirmDenialCode> {
  if (!user) {
    return refuse('not-authenticated', 'Sign in to review results.');
  }

  // A viewer reads the case file; changing a finding's disposition is an
  // investigative act with the analyst's name on it.
  if (!roleSatisfies(user.role, 'investigator')) {
    return refuse('insufficient-role', 'Only an investigator or administrator can confirm a result.', {
      remedy: 'Ask an administrator to change your role.',
      detail: { held: user.role, required: 'investigator' },
    });
  }

  if (!args.caseId) {
    return refuse(
      'no-case',
      'Attach this search to a case before confirming a result.',
      {
        remedy:
          'A confirmation is recorded as a ledger entry, and the ledger belongs to a case. ' +
          'Create or select a case first.',
      },
    );
  }

  const c = args.corroboration;
  if (!c) {
    return refuse(
      'corroboration-missing',
      'A result cannot be confirmed without a recorded corroboration.',
      {
        citation:
          'Detroit PD consent decree (Williams v. Detroit, June 2024) and state ' +
          '"not sole basis for arrest" statutes: an AI match requires independent ' +
          'corroborating evidence.',
        remedy: 'Record how this finding was independently verified, then confirm.',
      },
    );
  }

  if (!isCorroborationMethod(c.method)) {
    return refuse('corroboration-method-invalid', 'Select a recognised corroboration method.', {
      detail: { method: String(c.method) },
    });
  }

  const note = c.note.trim();
  if (note.length < MIN_NOTE_LENGTH) {
    return refuse(
      'corroboration-note-too-short',
      `Describe what was checked and what was found (at least ${MIN_NOTE_LENGTH} characters).`,
      {
        remedy:
          'The note is what a reviewer reads years later, and what opposing counsel will ' +
          'read first. "Confirmed" is not a corroboration.',
        detail: { length: note.length, minimum: MIN_NOTE_LENGTH },
      },
    );
  }

  // "A second analyst reached the same conclusion" cannot be the same analyst.
  // This is the one method whose validity depends on who is asserting it.
  if (c.method === 'independent-analyst-review' && args.originatingAnalystId === user.id) {
    return refuse(
      'self-corroboration',
      'You cannot corroborate your own result as an independent analyst review.',
      {
        remedy:
          'Have another analyst review it, or record a different method — a site visit, a ' +
          'document match, or third-party records.',
      },
    );
  }

  // The brand is not set — it does not exist at runtime. See the note on the type.
  return permit({
    review: 'confirmed',
    corroboration: { method: c.method, note, by: user.id, at: new Date().toISOString() },
  } as unknown as ConfirmedReview);
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

export interface RecordCorroborationArgs {
  readonly table: ReviewableTable;
  readonly candidateId: string;
  readonly searchId: string;
  readonly caseId: string;
  /** For the audit subject. Discovery asks about images, not candidates. */
  readonly imageId?: string;
  /** One line for the case narrative. The corroboration note is stored alongside. */
  readonly summary: string;
}

export interface CorroborationResult {
  readonly ledgerEntryId: string;
  readonly review: Extract<ReviewState, 'confirmed'>;
  readonly corroboration: CorroborationRecord;
}

/**
 * Persist a corroboration and flip the candidate to `confirmed`.
 *
 * Requires:
 *  - a `ConfirmedReview`, which only `canConfirm` mints, and
 *  - an `AuditedAction`, which only `withAudit` mints.
 *
 * Between them, a confirmation that skipped the corroboration gate or the audit
 * trail cannot be expressed. That is the whole design; keep both parameters.
 *
 * Order is deliberate. Ledger first: if the review update then fails, the record
 * shows the corroboration and the candidate stays unconfirmed — a recoverable,
 * honest state. The reverse order would leave a confirmed finding with no
 * corroboration behind it, which is the exact thing this file prevents.
 */
export async function recordCorroboration(
  client: LantageClient,
  confirmed: ConfirmedReview,
  args: RecordCorroborationArgs,
  audited: AuditedAction,
  actor: { user: AuthUser; context: RequestContext },
): Promise<CorroborationResult> {
  const entry = await appendLedger(client, {
    caseId: args.caseId,
    searchId: args.searchId,
    summary: args.summary,
    corroboration: confirmed.corroboration,
    writtenBy: actor.user.id,
  });

  audited.note('ledger_entry_id', entry.id);
  audited.note('corroboration_method', confirmed.corroboration.method);

  await setCandidateReview(client, args.table, args.candidateId, confirmed.review);

  // A separate row from the `result.review` write-ahead: the corroboration is the
  // legally significant event, and a production filtered to
  // `corroboration.record` should return every confirmed finding in the system.
  const subject: AuditSubject = {
    type: candidateSubjectType(args.table),
    id: args.candidateId,
    searchId: args.searchId,
    caseId: args.caseId,
    imageId: args.imageId,
  };

  await writeAuditEvent(client, {
    action: 'corroboration.record',
    actor: actorRef(actor.user),
    subject,
    context: actor.context,
    outcome: 'allowed',
    priorAuditId: audited.auditId,
    detail: {
      corroboration_method: confirmed.corroboration.method,
      corroboration_note: confirmed.corroboration.note,
      corroborated_by: confirmed.corroboration.by,
      corroborated_at: confirmed.corroboration.at,
      ledger_entry_id: entry.id,
      review: confirmed.review,
    },
  });

  return { ledgerEntryId: entry.id, review: confirmed.review, corroboration: confirmed.corroboration };
}

/**
 * The non-confirming dispositions. `nearby`, `incorrect`, and `unreviewed` are
 * all analyst opinions that assert nothing about the world, so they need no
 * corroboration — but they are still audited, because a result being marked
 * `incorrect` and then quietly re-marked is itself a discoverable pattern.
 */
export async function recordNonConfirmingReview(
  client: LantageClient,
  args: {
    readonly table: ReviewableTable;
    readonly candidateId: string;
    readonly searchId: string;
    readonly caseId?: string;
    readonly imageId?: string;
    readonly review: Exclude<ReviewState, 'confirmed'>;
  },
  audited: AuditedAction,
  actor: { user: AuthUser; context: RequestContext },
): Promise<void> {
  await setCandidateReview(client, args.table, args.candidateId, args.review);
  audited.note('review', args.review);

  await writeAuditEvent(client, {
    action: 'result.review',
    actor: actorRef(actor.user),
    subject: {
      type: candidateSubjectType(args.table),
      id: args.candidateId,
      searchId: args.searchId,
      caseId: args.caseId,
      imageId: args.imageId,
    },
    context: actor.context,
    outcome: 'allowed',
    priorAuditId: audited.auditId,
    detail: { review: args.review },
  });
}

/**
 * Guard for anything that persists a review state. Call it in any code path that
 * writes `review` and does not already hold a `ConfirmedReview`.
 *
 * This is the backstop for the case A2's `setCandidateReview` cannot see: a
 * generic "set review" handler wired to a dropdown. Without this, `'confirmed'`
 * arriving as a plain string from a form body would sail straight through.
 */
export function assertReviewIsPermitted(review: ReviewState): asserts review is Exclude<ReviewState, 'confirmed'> {
  if (review === 'confirmed') {
    throw new Error(
      'Refusing to set review = "confirmed" through a generic review handler. A confirmation ' +
        'requires canConfirm() + recordCorroboration() so that the corroboration is on the ' +
        'record (MASTER_PLAN §7, Detroit rules).',
    );
  }
}

function candidateSubjectType(table: ReviewableTable): AuditSubject['type'] {
  switch (table) {
    case 'geo_candidates':
      return 'geo_candidate';
    case 'vehicle_candidates':
      return 'vehicle_candidate';
    case 'corpus_matches':
      return 'corpus_match';
  }
}

function actorRef(user: AuthUser): AuditActorRef {
  return {
    userId: user.id,
    orgId: user.org?.id ?? null,
    email: user.email,
    role: user.role,
    verification: user.verification,
  };
}
