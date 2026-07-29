/**
 * Account provisioning and verification decisions. Service-role only.
 *
 * A2 flagged signup → `app_users` as unowned; it lands here. Two reasons it has
 * to run with the service-role key rather than the user's own client:
 *
 *  1. `orgs` has no INSERT policy for `authenticated` at all — org creation is a
 *     provisioning action, never a client call.
 *  2. `app_users` grants `authenticated` UPDATE on `email` and nothing else
 *     (`20260729180800_rls.sql`). A user cannot set their own `role`, `org_id`,
 *     `verified_at`, or `license_verified_at`, and that is the point: an account
 *     must not be able to self-attest identity verification or promote itself.
 *
 * `import 'server-only'` is inherited transitively from `@/lib/db/service`, so
 * pulling any of this into a Client Component fails the build rather than leaking
 * the key.
 *
 * ## Tenancy: how this cooperates with `current_org_id()`
 *
 * The SQL helper resolves the caller's org from JWT `app_metadata.org_id` first
 * and falls back to their `app_users` row. This module always writes the
 * `app_users` row — the fallback path — so tenancy works with no sign-in hook
 * configured. `stampOrgIdOnJwt` additionally sets `app_metadata.org_id` to take
 * the fast path, which saves one `app_users` read per RLS-checked statement.
 * That is an optimisation, not a requirement; skipping it costs latency, not
 * correctness.
 */

import { createServiceClient } from '@/lib/db/service';
import type { AppUserRow, UserRole } from '@/lib/db/types';
import { unwrap, unwrapMaybe } from '@/lib/db/errors';

import { writeAuditEvent } from '@/lib/audit/log';
import { systemRequestContext, type RequestContext } from './request-context';
import { type Gate, permit, refuse } from './result';
import type { Role, VerificationStatus } from './types';
import { statusForCheck, type LicenceCheck, type LicenceClaim } from './verification';

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export type ProvisionCode = 'already-provisioned' | 'org-not-found' | 'no-email';

export interface ProvisionArgs {
  /** `auth.users.id`, i.e. the JWT `sub`. The `app_users` PK is the same value. */
  readonly userId: string;
  readonly email: string;
  /** Existing org to join. Omit to create one — see `orgName`. */
  readonly orgId?: string;
  /** Used when creating a new org. Defaults to the email domain. */
  readonly orgName?: string;
  /**
   * Defaults to `viewer`. A newly provisioned account gets the *lowest* role and
   * `verified_at: null`, so it can read nothing sensitive and search nothing at
   * all until a human decides otherwise. Never default this to `analyst`.
   */
  readonly role?: Role;
  readonly context?: RequestContext;
}

/**
 * A2's generated `app_users.Update` type is `{ email?: string }`. That is not a
 * mistake — it mirrors the column grant in `20260729180800_rls.sql`, where
 * `authenticated` may update `email` and nothing else, so the type stops anyone
 * from writing code that RLS would reject at runtime.
 *
 * The service role bypasses both RLS and column privileges, and setting
 * `verified_at` / `role` / `org_id` is the entire reason this module holds the
 * key. So the cast is narrow, named, and confined to this file — never re-export
 * it, and never use it with a request-scoped client.
 */
type ServiceUserPatch = Record<string, string | null>;

function asServiceUserUpdate(patch: ServiceUserPatch): { email?: string } {
  return patch as unknown as { email?: string };
}

/** Domain role -> DB role. `investigator` is what the schema calls `analyst`. */
function roleToDb(role: Role): UserRole {
  switch (role) {
    case 'admin':
      return 'admin';
    case 'investigator':
      return 'analyst';
    case 'viewer':
      return 'viewer';
  }
}

/**
 * Create the `app_users` row for a newly signed-up account, and its org if needed.
 *
 * Idempotent: a second call for the same user returns the existing row rather than
 * erroring, because magic-link sign-in can legitimately fire the callback twice
 * (a prefetch plus the real navigation) and a duplicate-key error there would
 * present as a broken login.
 */
export async function provisionAppUser(args: ProvisionArgs): Promise<Gate<AppUserRow, ProvisionCode>> {
  const email = args.email.trim().toLowerCase();
  if (email.length === 0) {
    return refuse('no-email', 'An account cannot be provisioned without an email address.');
  }

  const service = createServiceClient();
  const context = args.context ?? systemRequestContext('provisioning');

  const existing = unwrapMaybe<AppUserRow>(
    'provisionAppUser(select)',
    await service.from('app_users').select('*').eq('id', args.userId).maybeSingle(),
  );
  if (existing) return permit(existing);

  // --- resolve or create the org ------------------------------------------
  let orgId = args.orgId;
  if (orgId) {
    const org = unwrapMaybe<{ id: string }>(
      'provisionAppUser(org)',
      await service.from('orgs').select('id').eq('id', orgId).maybeSingle(),
    );
    if (!org) {
      return refuse('org-not-found', 'That organisation does not exist.', {
        detail: { org_id: orgId },
      });
    }
  } else {
    const name = args.orgName?.trim() || email.split('@')[1] || email;
    const created = unwrap<{ id: string }>(
      'provisionAppUser(createOrg)',
      await service.from('orgs').insert({ name }).select('id').single(),
    );
    orgId = created.id;
  }

  const row = unwrap<AppUserRow>(
    'provisionAppUser(insert)',
    await service
      .from('app_users')
      .insert({
        id: args.userId,
        org_id: orgId,
        email,
        role: roleToDb(args.role ?? 'viewer'),
        // Explicit, not omitted. A new account is unverified and can search
        // nothing — that is the GeoSpy rule, and writing it here means a schema
        // default change cannot silently grant search access.
        verified_at: null,
      })
      .select('*')
      .single(),
  );

  await writeAuditEvent(service, {
    action: 'auth.provision',
    actor: { userId: args.userId, orgId, email },
    subject: { type: 'app_user', id: args.userId },
    context,
    outcome: 'allowed',
    detail: { org_id: orgId, role: row.role, created_org: args.orgId ? false : true },
  });

  return permit(row);
}

/**
 * Stamp `app_metadata.org_id` onto the user so `current_org_id()` takes its fast
 * path. Optional — the `app_users` fallback works without it.
 *
 * `app_metadata` is writable only by the service role, which is what makes it
 * trustworthy once the JWT signature verifies. Never put anything in
 * `user_metadata` that authorization reads.
 *
 * Note the token lifetime: an existing session keeps its old claims until it
 * refreshes, so a membership change must always also be reflected in `app_users`
 * (it is — that is the source of truth) or the fast path will serve a stale org.
 */
export async function stampOrgIdOnJwt(userId: string, orgId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.auth.admin.updateUserById(userId, {
    app_metadata: { org_id: orgId },
  });
  if (error) {
    // Not fatal. `current_org_id()` falls back to the app_users row, so tenancy
    // still resolves correctly — this only costs one extra read per statement.
    console.warn(
      `[provisioning] could not stamp app_metadata.org_id for ${userId}: ${error.message}. ` +
        `Tenancy still resolves via the app_users fallback in current_org_id().`,
    );
  }
}

// ---------------------------------------------------------------------------
// Verification decisions
// ---------------------------------------------------------------------------

/**
 * Apply the outcome of a licence check.
 *
 * The only writer of `verified_at` and `license_verified_at`. Every call writes a
 * `verification.change` audit row carrying the provider, the claim, and the
 * outcome — that row is the durable record of *why* an account was approved, which
 * matters because `app_users` has no column for the reason and because "who let
 * this account in" is the first question after an abuse incident.
 */
export async function applyVerificationDecision(args: {
  readonly userId: string;
  readonly orgId: string | null;
  readonly claim: LicenceClaim;
  readonly check: LicenceCheck;
  /** The admin who made the call, for a manual review. Absent for automated checks. */
  readonly decidedBy?: string;
  readonly context?: RequestContext;
}): Promise<VerificationStatus> {
  const service = createServiceClient();
  const context = args.context ?? systemRequestContext('verification');
  const status = statusForCheck(args.check);
  const now = new Date().toISOString();

  const patch: ServiceUserPatch = {
    license_number: args.claim.number,
    license_state: args.claim.state.toUpperCase(),
  };

  if (status === 'verified') {
    patch.verified_at = now;
    patch.license_verified_at = now;
  } else {
    // Explicitly cleared on anything other than an approval. A previously
    // verified account whose licence is later rejected must lose search access
    // immediately, and leaving a stale `verified_at` in place is exactly how that
    // would fail to happen.
    patch.verified_at = null;
    patch.license_verified_at = null;
  }

  const { error } = await service
    .from('app_users')
    .update(asServiceUserUpdate(patch))
    .eq('id', args.userId);
  if (error) {
    throw new Error(`applyVerificationDecision: could not update app_users — ${error.message}`);
  }

  await writeAuditEvent(service, {
    action: 'verification.change',
    actor: { userId: args.decidedBy ?? null, orgId: args.orgId },
    subject: { type: 'app_user', id: args.userId },
    context,
    outcome: args.check.outcome === 'rejected' ? 'denied' : 'allowed',
    refusal:
      args.check.outcome === 'rejected'
        ? { code: 'verification-rejected', reason: args.check.reason }
        : undefined,
    detail: {
      status,
      subject_user_id: args.userId,
      provider: args.check.providerId,
      licence_kind: args.claim.kind,
      licence_state: args.claim.state.toUpperCase(),
      // The licence NUMBER is recorded because it is the thing that was checked
      // and a reviewer must be able to re-check it. It is not a plate, and it is
      // already stored on app_users.
      licence_number: args.claim.number,
      holder_name: args.claim.holderName,
      outcome: args.check.outcome,
      ...(args.decidedBy ? { decided_by: args.decidedBy } : {}),
      ...(args.check.outcome === 'queued' ? { review_id: args.check.reviewId } : {}),
    },
  });

  return status;
}

/**
 * Change a user's role. Admin-gated at the call site via `requireRole('admin')`;
 * this function assumes that already happened and only enforces that the change
 * is recorded.
 */
export async function setUserRole(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly changedBy: string;
  readonly context?: RequestContext;
}): Promise<void> {
  const service = createServiceClient();
  const context = args.context ?? systemRequestContext('admin');

  const { error } = await service
    .from('app_users')
    .update(asServiceUserUpdate({ role: roleToDb(args.role) }))
    .eq('id', args.userId)
    .eq('org_id', args.orgId);
  if (error) throw new Error(`setUserRole: ${error.message}`);

  await writeAuditEvent(service, {
    action: 'admin.role-change',
    actor: { userId: args.changedBy, orgId: args.orgId },
    subject: { type: 'app_user', id: args.userId },
    context,
    outcome: 'allowed',
    detail: { subject_user_id: args.userId, new_role: args.role },
  });
}

/**
 * Records a failed sign-in.
 *
 * Uses the service-role client because there is no session and therefore no org —
 * one of the four uses A2 sanctions. Dropping these rows would hide credential
 * stuffing and the "one account probing many identities" pattern that abuse
 * response looks for.
 */
export async function auditSignInFailure(args: {
  readonly email?: string;
  readonly reason: string;
  readonly context: RequestContext;
}): Promise<void> {
  try {
    const service = createServiceClient();
    await writeAuditEvent(service, {
      action: 'auth.sign-in-failed',
      actor: { userId: null, orgId: null, email: args.email ?? null },
      subject: { type: 'app_user', id: null },
      context: args.context,
      outcome: 'denied',
      refusal: { code: 'sign-in-failed', reason: args.reason },
      detail: args.email ? { attempted_email: args.email } : {},
    });
  } catch (cause) {
    console.error(
      `[auth] could not record a failed sign-in: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
