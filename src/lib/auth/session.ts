/**
 * Session and principal resolution.
 *
 * Next 16: `cookies()` is async and synchronous access is *fully removed*. A2's
 * `createServerSupabaseClient()` awaits it, and every function here awaits that.
 * There is no synchronous path to a session in this codebase.
 *
 * ## `getClaims()`, not `getSession()`
 *
 * `getSession()` decodes the cookie without verifying the signature — the
 * auth-js docstring is explicit that with an insecure storage medium "the user
 * object returned by this function **must not be trusted**". A cookie is an
 * insecure storage medium. So the authoritative read here is `getClaims()`, which
 * verifies against the project's JWKS (and falls back to a server round-trip for
 * symmetric secrets). `getSession()` is exported because the spec asks for it, and
 * it is documented as the *unverified* read, for UI hints only.
 *
 * ## Role, org, and verification come from the database
 *
 * Not from `user_metadata`, which the user can write. `app_metadata` is
 * service-role-only and therefore trustworthy, but the `app_users` row is the
 * authority — it is what `current_org_id()` falls back to and what the RLS
 * policies compare against, so reading anything else here would let the app and
 * the database disagree about who someone is.
 */

import { cookies } from 'next/headers';

import { createServerSupabaseClient, type LantageClient } from '@/lib/db/client';
import { unwrapMaybe } from '@/lib/db/errors';
import type { AppUserRow, OrgRow } from '@/lib/db/types';

import { type Gate, permit, refuse } from './result';
import { jurisdictionForOrg } from '@/lib/jurisdiction/assignment';
import {
  authUserFromRows,
  orgFromRow,
  roleSatisfies,
  type AuthUser,
  type Org,
  type Role,
} from './types';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface LantageSession {
  readonly userId: string;
  readonly email: string | null;
  readonly isAnonymous: boolean;
  /** Unix seconds. Present when the token carries `exp`. */
  readonly expiresAt?: number;
}

/**
 * The signed-in user's verified session, or `null`.
 *
 * Verified: the JWT signature is checked. Safe to authorize against.
 */
export async function getSession(client?: LantageClient): Promise<LantageSession | null> {
  const supabase = client ?? (await createServerSupabaseClient());

  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;

  const claims = data.claims;
  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  if (!sub) return null;

  return {
    userId: sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    isAnonymous: claims.is_anonymous === true,
    expiresAt: typeof claims.exp === 'number' ? claims.exp : undefined,
  };
}

/**
 * The *unverified* cookie contents. Never authorize against this.
 *
 * Exists for one legitimate case: deciding whether to render a "signing in…"
 * state without paying for a JWKS verification on a page that shows nothing
 * sensitive. Anything that gates data must use `getSession` or `requireUser`.
 */
export async function getUnverifiedSessionHint(): Promise<{ userId: string } | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id;
  return id ? { userId: id } : null;
}

/** True when a session cookie is present at all. Used by `proxy.ts`-adjacent code. */
export async function hasSessionCookie(): Promise<boolean> {
  const store = await cookies();
  return store.getAll().some((c) => c.name.startsWith('sb-') && c.value.length > 0);
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/**
 * Resolve the full principal: session + `app_users` row + org classification.
 *
 * Returns `null` when there is no verified session. Returns an `AuthUser` with
 * `org: null` when the session is valid but no `app_users` row exists — that is
 * the un-provisioned state, and it is deliberately distinguishable from "not
 * signed in" so the UI can say "your account is being set up" instead of bouncing
 * them to the login page in a loop.
 */
export async function getCurrentUser(client?: LantageClient): Promise<AuthUser | null> {
  const supabase = client ?? (await createServerSupabaseClient());
  const session = await getSession(supabase);
  if (!session) return null;

  const row = unwrapMaybe<AppUserRow>(
    'getCurrentUser(app_users)',
    await supabase.from('app_users').select('*').eq('id', session.userId).maybeSingle(),
  );

  if (!row) {
    // No profile row. `provisioned: false` carries that fact explicitly rather
    // than leaving callers to infer it from a viewer-with-no-org shape — an
    // inference that would misread a legitimately org-less user as a provisioning
    // failure. See `provisionAppUser` in provisioning.ts for the fix path.
    return {
      id: session.userId,
      email: session.email,
      role: 'viewer',
      verification: 'unverified',
      org: null,
      isAnonymous: session.isAnonymous,
      provisioned: false,
      licence: { number: null, state: null, verifiedAt: null },
    };
  }

  const org = await loadOrg(supabase, row.org_id);
  return authUserFromRows(row, org, { isAnonymous: session.isAnonymous });
}

async function loadOrg(client: LantageClient, orgId: string | null): Promise<Org | null> {
  if (!orgId) return null;

  const row = unwrapMaybe<OrgRow>(
    'getCurrentUser(orgs)',
    await client.from('orgs').select('*').eq('id', orgId).maybeSingle(),
  );
  if (!row) return null;

  const classification = jurisdictionForOrg(orgId);
  return orgFromRow(row, classification);
}

// ---------------------------------------------------------------------------
// Requirements — typed refusals, never thrown strings
// ---------------------------------------------------------------------------

export type AuthDenialCode = 'not-authenticated' | 'not-provisioned' | 'no-org' | 'insufficient-role';

/**
 * A verified, provisioned user.
 *
 * Note that this does NOT imply identity verification — that is `canSearch`.
 * `requireUser` is "who is this", `canSearch` is "may they search". Conflating
 * them would mean a pending-verification user could not read their own case files,
 * which is wrong: they can read, they cannot search.
 */
export async function requireUser(client?: LantageClient): Promise<Gate<AuthUser, AuthDenialCode>> {
  const user = await getCurrentUser(client);
  if (!user) {
    return refuse('not-authenticated', 'Sign in to continue.');
  }
  if (!user.provisioned) {
    return refuse('not-provisioned', 'Your account is still being set up.', {
      remedy:
        'This normally completes within a few seconds of first sign-in. If it persists, ' +
        'contact support — the account exists but has no organisation record yet.',
    });
  }
  return permit(user);
}

export interface OrgScopedUser {
  readonly user: AuthUser;
  readonly org: Org;
}

/** A user *and* their org. Everything tenant-scoped needs this, not `requireUser`. */
export async function requireOrg(client?: LantageClient): Promise<Gate<OrgScopedUser, AuthDenialCode>> {
  const gate = await requireUser(client);
  if (!gate.ok) return gate;

  const user = gate.value;
  if (!user.org) {
    return refuse('no-org', 'Your account is not attached to an organisation.', {
      remedy: 'An administrator must add you to an organisation before you can open a case.',
    });
  }
  return permit({ user, org: user.org });
}

/**
 * A user holding at least `required`. Roles are strictly ordered, so `admin`
 * satisfies `requireRole('investigator')`.
 */
export async function requireRole(
  required: Role,
  client?: LantageClient,
): Promise<Gate<OrgScopedUser, AuthDenialCode>> {
  const gate = await requireOrg(client);
  if (!gate.ok) return gate;

  const { user } = gate.value;
  if (!roleSatisfies(user.role, required)) {
    return refuse('insufficient-role', `This action requires ${required} access.`, {
      detail: { held: user.role, required },
      remedy: 'Ask an administrator to change your role.',
    });
  }
  return gate;
}
