/**
 * `withAudit()` — the wrapper that makes it hard to *not* audit an action.
 *
 * Three properties do the work, and each one closes a specific way that an audit
 * trail rots in practice:
 *
 *  1. **Write-ahead.** The row is appended *before* the action runs. A log that
 *     only records completions cannot answer "did anyone search this image" after
 *     a crash, a timeout, or a kill -9 — and "the search failed so we have no
 *     record of it" is not an answer that survives cross-examination. The
 *     attempt is the auditable event.
 *
 *  2. **Fail closed.** If the write fails, the action never runs. The caller gets
 *     `Refusal<'audit-unavailable'>`, which `/api/search` maps to 503. An action
 *     that cannot be recorded is an action this product does not take.
 *
 *  3. **The result is only reachable through the wrapper.** `withAudit` returns
 *     `Gate<T, …>`, so a caller cannot get at `T` without narrowing. Combined with
 *     the branded `AuditedAction` token that the callback receives — and which
 *     `recordCorroboration` and the search cascade demand — "I'll add the audit
 *     call later" stops type-checking rather than shipping.
 *
 * Outcome rows are *appended*, never updated (`reject_mutation` enforces it in
 * Postgres). So a completed action produces two rows: the write-ahead row and an
 * outcome row carrying `prior_audit_id`.
 */

import { type Gate, permit, refuse, type Refusal } from '@/lib/auth/result';
import type { LantageClient } from '@/lib/db/client';
import type { Json } from '@/lib/db/types';

import { writeAuditEvent } from './log';
import type { AuditAction, AuditEvent, AuditReceipt } from './types';

declare const auditedBrand: unique symbol;

/**
 * Proof that an action was written to the audit trail before it ran.
 *
 * Nominal by construction: the only way to obtain one is from inside a
 * `withAudit` callback. Functions that must never run unaudited take this as a
 * parameter — see `recordCorroboration`. There is no public constructor, and
 * adding one would defeat the point of the file.
 *
 * The brand is **type-only** — `declare const` emits no JavaScript, so it must
 * never appear in a runtime object literal.
 */
export interface AuditedAction {
  readonly [auditedBrand]: true;
  readonly auditId: string;
  readonly action: AuditAction;
  readonly requestId: string;
  /**
   * Attach a fact discovered while the action ran. Merged into the outcome row.
   * Use it for the things you could not know up front — the search id, the
   * candidate count, the refusal reason.
   */
  note(key: string, value: Json): void;
}

export type AuditFailureCode = 'audit-unavailable';

export interface WithAuditOptions<T> {
  /** The write-ahead event. Its `outcome` is overwritten to `'allowed'`. */
  readonly event: Omit<AuditEvent, 'outcome' | 'priorAuditId'>;
  /**
   * The action's own outcome row. Defaults to `search.complete`-style pairing via
   * `outcomeActionFor`. Set explicitly when the pairing is not obvious.
   */
  readonly outcomeAction?: AuditAction;
  /**
   * Derives extra detail for the outcome row from the action's return value.
   * Runs inside the same try/catch as the action, so it must not throw.
   */
  readonly summarise?: (value: T) => Readonly<Record<string, Json>>;
}

/**
 * Run `fn` with the action recorded first.
 *
 * ```ts
 * const gate = await withAudit(client, {
 *   event: { action: 'case.export', actor, subject, context },
 * }, async (audited) => {
 *   const blob = await buildExport();
 *   audited.note('bytes', blob.size);
 *   return blob;
 * });
 * if (!gate.ok) return json({ error: gate.code, message: gate.reason }, 503);
 * ```
 *
 * `fn` throwing is not swallowed: an `error` outcome row is appended and the
 * error rethrown, so a bug still surfaces as a 500 with a trail behind it.
 */
export async function withAudit<T>(
  client: LantageClient,
  options: WithAuditOptions<T>,
  fn: (audited: AuditedAction) => Promise<T>,
): Promise<Gate<T, AuditFailureCode>> {
  const notes: Record<string, Json> = {};

  let receipt: AuditReceipt;
  try {
    receipt = await writeAuditEvent(client, { ...options.event, outcome: 'allowed' });
  } catch (cause) {
    // Deliberately not retried here. A retry loop in front of the audit write
    // turns a database outage into a queue of unlogged actions; refusing is the
    // honest failure. The message is written for the analyst, who can do nothing
    // about it except try again or call support.
    return auditUnavailable(options.event.action, cause);
  }

  // The brand is not set — it does not exist at runtime. See the note on the type.
  const audited = {
    auditId: receipt.id,
    action: receipt.action,
    requestId: receipt.requestId,
    note(key: string, value: Json) {
      notes[key] = value;
    },
  } as unknown as AuditedAction;

  try {
    const value = await fn(audited);
    const summary = options.summarise ? options.summarise(value) : {};
    await appendOutcome(client, options, receipt, 'allowed', { ...summary, ...notes });
    return permit(value);
  } catch (cause) {
    await appendOutcome(client, options, receipt, 'error', {
      ...notes,
      error: errorMessage(cause),
    });
    throw cause;
  }
}

/**
 * Record a refusal. A denied action is an audit row too — arguably the most
 * important kind, since "we declined to run that search" is exculpatory and has
 * to be provable.
 *
 * Never fails the caller: by the time you are recording a refusal the request is
 * already being refused, and turning a logging failure into a different error
 * loses the refusal the user needs to see. The write is still attempted, and a
 * failure is surfaced on stderr.
 */
export async function auditRefusal(
  client: LantageClient,
  event: Omit<AuditEvent, 'outcome'>,
  refusal: { code: string; reason: string; citation?: string },
): Promise<void> {
  try {
    await writeAuditEvent(client, { ...event, outcome: 'denied', refusal });
  } catch (cause) {
    console.error(
      `[audit] FAILED to record refusal ${refusal.code} for action ${event.action}: ` +
        `${errorMessage(cause)}. The refusal itself still stands.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function appendOutcome<T>(
  client: LantageClient,
  options: WithAuditOptions<T>,
  receipt: AuditReceipt,
  outcome: 'allowed' | 'error',
  detail: Record<string, Json>,
): Promise<void> {
  const action =
    options.outcomeAction ?? outcomeActionFor(options.event.action, outcome === 'error');

  // No outcome row when the action has no distinct completion — a `search.view`
  // is complete the moment it is recorded, and a second row would be noise in a
  // production.
  if (action === null) return;

  try {
    await writeAuditEvent(client, {
      ...options.event,
      action,
      outcome,
      priorAuditId: receipt.id,
      detail: { ...options.event.detail, ...detail },
    });
  } catch (cause) {
    // The write-ahead row already exists, so the action is attributable. Losing
    // the outcome row degrades the record rather than destroying it, and throwing
    // here would undo work the caller already completed successfully.
    console.error(
      `[audit] wrote ${options.event.action} (${receipt.id}) but FAILED to write its ` +
        `${action} outcome row: ${errorMessage(cause)}`,
    );
  }
}

/** Which second row pairs with a given first row. `null` = no outcome row. */
export function outcomeActionFor(action: AuditAction, errored: boolean): AuditAction | null {
  if (errored) {
    return action === 'search.create' ? 'search.error' : null;
  }
  switch (action) {
    case 'search.create':
      return 'search.complete';
    default:
      return null;
  }
}

function auditUnavailable(action: AuditAction, cause: unknown): Refusal<AuditFailureCode> {
  console.error(`[audit] refusing ${action}: audit write failed — ${errorMessage(cause)}`);
  return refuse('audit-unavailable', 'This action cannot be performed right now.', {
    remedy:
      'Every action in Lantage is recorded before it runs. The audit trail is unavailable, ' +
      'so the action was not attempted. Try again shortly.',
    detail: { action },
  });
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
