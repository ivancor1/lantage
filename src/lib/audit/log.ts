/**
 * The audit write path.
 *
 * A thin, opinionated layer over A2's `writeAudit`. It exists to do three things
 * that a bare insert cannot:
 *
 *  1. **Flatten the domain event onto the row shape** so that `imageId`,
 *     `caseId`, `searchId`, `module`, the refusal code, and the request-context
 *     trust flag all land in predictable places. A discovery query that has to
 *     guess where the image id was put is a query that misses rows.
 *  2. **Pick the right client.** A signed-in user's row goes through the
 *     request-scoped client so RLS stamps the tenancy. A pre-authentication row
 *     (`auth.sign-in-failed`, `auth.provision`) has no org and no session, so it
 *     needs the service-role client — one of the four uses A2 sanctions.
 *  3. **Fail loudly.** `writeAudit` throws, and this does not catch. If the
 *     action cannot be recorded, the action does not happen. `withAudit` is what
 *     turns that throw into a typed refusal for the caller.
 */

import type { LantageClient } from '@/lib/db/client';
import { writeAudit } from '@/lib/db/queries/audit';
import type { Json } from '@/lib/db/types';

import type { AuditEvent, AuditReceipt } from './types';

/**
 * Appends one row. Throws if it cannot — see the note above and A2's docstring.
 *
 * Pass the request-scoped client for anything a signed-in user did. Pass a
 * service-role client only for pre-authentication events.
 */
export async function writeAuditEvent(
  client: LantageClient,
  event: AuditEvent,
): Promise<AuditReceipt> {
  const row = await writeAudit(client, {
    orgId: event.actor.orgId,
    actorId: event.actor.userId,
    ip: event.context.ip,
    userAgent: event.context.userAgent,
    action: event.action,
    subjectType: event.subject.type,
    subjectId: event.subject.id,
    detail: buildDetail(event),
  });

  return { id: row.id, at: row.at, action: event.action, requestId: event.context.requestId };
}

/**
 * The `detail` payload.
 *
 * Keys are snake_case to match everything else in the column across the product —
 * a discovery export that mixes `imageId` and `image_id` is a filter that silently
 * misses half the rows.
 */
function buildDetail(event: AuditEvent): Record<string, Json> {
  const detail: Record<string, Json> = {
    outcome: event.outcome,
    request_id: event.context.requestId,
  };

  // Correlation keys. Always present when known, even when they duplicate
  // `subject_id`, because the discovery query filters on these names.
  if (event.subject.imageId) detail.image_id = event.subject.imageId;
  if (event.subject.caseId) detail.case_id = event.subject.caseId;
  if (event.subject.searchId) detail.search_id = event.subject.searchId;
  if (event.subject.module) detail.module = event.subject.module;

  if (event.actor.email) detail.actor_email = event.actor.email;
  if (event.actor.role) detail.actor_role = event.actor.role;
  if (event.actor.verification) detail.actor_verification = event.actor.verification;

  if (event.refusal) {
    detail.refusal_code = event.refusal.code;
    detail.refusal_reason = event.refusal.reason;
    if (event.refusal.citation) detail.refusal_citation = event.refusal.citation;
  }

  if (event.priorAuditId) detail.prior_audit_id = event.priorAuditId;

  // Persisted rather than dropped: `false` here means a handler was reached
  // without passing through proxy.ts, so the IP on this row is unverified. That
  // is a fact a defence expert is entitled to, and an alerting signal for us.
  if (!event.context.trusted) detail.context_untrusted = true;
  if (event.context.path) detail.path = event.context.path;

  // Caller-supplied keys last, but they cannot overwrite the correlation keys —
  // a stage that puts its own `image_id` in `detail` must not be able to point a
  // discovery query at the wrong image.
  if (event.detail) {
    for (const [key, value] of Object.entries(event.detail)) {
      if (key in detail) continue;
      if (value === undefined) continue;
      detail[key] = value;
    }
  }

  return detail;
}
