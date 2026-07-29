/**
 * Magic-link callback — exchanges the code for a session, then provisions.
 *
 * Public route (see `PUBLIC_PATHS` in `proxy.ts`): the caller has no session yet,
 * by definition. That is the only reason it is public, and it does nothing except
 * exchange a code it did not mint.
 *
 * Provisioning runs here rather than in a database trigger because it needs the
 * service-role key, has to be idempotent across a double-fired callback, and has
 * to write an `auth.provision` audit row. A trigger could do the insert but not
 * the audit row, and an account appearing with no record of how is the opposite of
 * what §7 asks for.
 */

import { NextResponse } from 'next/server';

import { readRequestContext } from '@/lib/auth/request-context';
import { auditSignInFailure, provisionAppUser, stampOrgIdOnJwt } from '@/lib/auth/provisioning';
import { writeAuditEvent } from '@/lib/audit/log';
import { createServerSupabaseClient } from '@/lib/db/client';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const context = readRequestContext(request.headers);
  const next = safeNext(url.searchParams.get('next')) ?? '/';

  if (!code) {
    await auditSignInFailure({ reason: 'Callback reached with no code parameter.', context });
    return redirectTo(url, '/login?error=link-invalid');
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session?.user) {
    // Expired or already-used links land here and are the common case, not an
    // attack. Recorded anyway: a burst of them from one IP is a signal.
    await auditSignInFailure({
      reason: error?.message ?? 'Code exchange returned no session.',
      context,
    });
    return redirectTo(url, '/login?error=link-expired');
  }

  const user = data.session.user;

  // Idempotent — a prefetch plus the real navigation can both arrive.
  const provisioned = await provisionAppUser({
    userId: user.id,
    email: user.email ?? '',
    context,
  });

  if (provisioned.ok) {
    // Optimisation only: `current_org_id()` falls back to the app_users row, so
    // a failure here costs one read per statement, not correctness.
    await stampOrgIdOnJwt(user.id, provisioned.value.org_id);

    await writeAuditEvent(supabase, {
      action: 'auth.sign-in',
      actor: { userId: user.id, orgId: provisioned.value.org_id, email: user.email ?? null },
      subject: { type: 'app_user', id: user.id },
      context,
      outcome: 'allowed',
      detail: { method: 'magic-link' },
    });
  } else {
    // Signed in but not provisioned. Not bounced to /login — that would be a loop,
    // since the session is valid. `requireUser` returns `not-provisioned` and the
    // UI explains it.
    console.error(`[auth/callback] provisioning failed for ${user.id}: ${provisioned.reason}`);
  }

  return redirectTo(url, next);
}

function redirectTo(base: URL, path: string): Response {
  const target = new URL(path, base.origin);
  const response = NextResponse.redirect(target);
  // Never cache a response that just set session cookies.
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

/** Same-origin single-slash paths only. See the note in `login/page.tsx`. */
function safeNext(value: string | null): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('/')) return undefined;
  if (value.startsWith('//')) return undefined;
  if (value.startsWith('/login')) return undefined;
  return value;
}
