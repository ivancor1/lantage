/**
 * Proxy — session refresh, route protection, and request-context capture.
 *
 * NEXT 16, VERIFIED against
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
 * and `.../02-guides/upgrading/version-16.md` on 2026-07-29. Do not write any of
 * this from memory:
 *
 *  - This file is **`proxy.ts`**, not `middleware.ts`. The named export is
 *    **`proxy`**, not `middleware`.
 *  - **The `edge` runtime is NOT supported here.** Proxy runs `nodejs` and that
 *    is not configurable — "Setting the `runtime` config option in Proxy will
 *    throw an error." So there is no `export const runtime` below, deliberately.
 *  - Config flags were renamed: `skipMiddlewareUrlNormalize` is now
 *    `skipProxyUrlNormalize`.
 *  - **Location matters and fails silently.** The docs: "Create a `proxy.ts` file
 *    in the project root, **or inside `src` if applicable, so that it is located
 *    at the same level as `pages` or `app`**." This app's router is `src/app`, so
 *    the proxy belongs at `src/proxy.ts`. At the repository root it is simply
 *    never loaded — `next build` prints no `ƒ Proxy (Middleware)` line and every
 *    request bypasses it, with no error anywhere. Verify that line is present in
 *    the build output after touching this file.
 *
 * ## What this file is and is not responsible for
 *
 * It refreshes the session cookie and bounces unauthenticated navigation to
 * `/login`. It is **not** the authorization boundary. The Next docs are explicit:
 * "A matcher change or a refactor that moves a Server Function to a different
 * route can silently remove Proxy coverage. Always verify authentication and
 * authorization inside each Server Function rather than relying on Proxy alone."
 *
 * So every real check is re-done server-side — `requireUser`, `requireOrg`,
 * `requireRole`, `canSearch`, `isModuleAllowed`. This is a redirect for humans and
 * a session refresher, and if it were deleted tomorrow nothing would become
 * *authorized* that is not authorized now. Users would just get logged out at
 * random, because Server Components cannot write cookies.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { contextHeaderEntries, deriveRequestContext } from '@/lib/auth/request-context';

/**
 * Routes reachable without a session. Everything else is authenticated.
 *
 * Deliberately short. There is no anonymous tier in this product (MASTER_PLAN §7),
 * so this list is the login flow and the marketing page — nothing that touches an
 * image or a search.
 */
const PUBLIC_PATHS = new Set(['/', '/login', '/auth/callback']);

/** Prefixes that are public. Kept separate so the exact-match set stays exact. */
const PUBLIC_PREFIXES = ['/auth/callback'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // --- request context ------------------------------------------------------
  // Derived once here and stamped onto the forwarded request, because headers are
  // one of the only supported channels from proxy into the app. Downstream code
  // reads it with `readRequestContext(await headers())`.
  const context = deriveRequestContext(request);
  const requestHeaders = new Headers(request.headers);
  // Strip any inbound spoof attempt before stamping our own values. A client that
  // sends `x-lantage-ip` must not be able to influence what lands in the audit row.
  requestHeaders.delete('x-lantage-ip');
  requestHeaders.delete('x-lantage-ua');
  requestHeaders.delete('x-lantage-request-id');
  requestHeaders.delete('x-lantage-path');
  requestHeaders.delete('x-lantage-proxy-stamp');
  for (const [name, value] of contextHeaderEntries(context)) {
    requestHeaders.set(name, value);
  }

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without credentials there is no session to refresh and nothing to protect
  // against. Fail *open* on the redirect, closed everywhere that matters: the
  // server-side gates all refuse when Supabase is unreachable, so a misconfigured
  // env produces an unusable app rather than an unprotected one. Redirecting to
  // /login here instead would make the misconfiguration look like a logout loop.
  if (!url || !key) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[proxy] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are unset. ' +
          'Sessions are not being refreshed. Route protection is still enforced server-side.',
      );
    }
    return response;
  }

  // --- session refresh ------------------------------------------------------
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, responseHeaders) {
        // The response has to be rebuilt so the refreshed cookies ride on it AND
        // the stamped request headers survive. Mutating `response.cookies` on the
        // original object works, but rebuilding is what the Supabase SSR guide
        // specifies and it keeps both concerns in one place.
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Non-negotiable. A response carrying `Set-Cookie` that a CDN caches will
        // serve one analyst's session to another. @supabase/ssr hands us
        // `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`
        // plus `Expires: 0` and `Pragma: no-cache` for exactly this reason.
        for (const [name, value] of Object.entries(responseHeaders)) {
          response.headers.set(name, value);
        }
      },
    },
  });

  // MUST be awaited before the response is finalised. @supabase/ssr: "If a token
  // refresh completes after the HTTP response has already been committed, the
  // updated session cannot be written and will be lost, causing the next request
  // to refresh again." `getClaims` verifies the JWT signature; `getSession` alone
  // would not.
  let authenticated = false;
  try {
    const { data } = await supabase.auth.getClaims();
    authenticated = typeof data?.claims?.sub === 'string';
  } catch {
    // Auth server unreachable. Treated as unauthenticated for the redirect, which
    // sends the user somewhere that explains itself rather than to a page that
    // will fail to load its data.
    authenticated = false;
  }

  // --- route protection -----------------------------------------------------
  if (!authenticated && !isPublic(pathname)) {
    // API routes get a 401, not a redirect. An HTML login page arriving where JSON
    // was expected produces a parse error and hides the real cause.
    if (pathname.startsWith('/api/')) {
      const unauthorized = NextResponse.json(
        {
          error: 'not-authenticated',
          message:
            'Sign in to continue. Lantage has no anonymous access — every action is ' +
            'attributed to a verified account.',
        },
        { status: 401 },
      );
      for (const cookie of response.cookies.getAll()) unauthorized.cookies.set(cookie);
      return unauthorized;
    }

    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    // Only the path, and only a same-origin path. Reflecting a full URL here is a
    // standard open-redirect; the login page re-validates it before using it.
    login.searchParams.set('next', `${pathname}${request.nextUrl.search}`);

    const redirect = NextResponse.redirect(login);
    // Carry the refreshed cookies onto the redirect, or the very next request
    // starts another refresh and the user can end up in a loop.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    redirect.headers.set('Cache-Control', 'private, no-store');
    return redirect;
  }

  // An authenticated user has no business on the login page.
  if (authenticated && pathname === '/login') {
    const home = request.nextUrl.clone();
    home.pathname = '/';
    home.search = '';
    const redirect = NextResponse.redirect(home);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
}

/**
 * Runs on everything except static assets and image optimisation.
 *
 * Note from the docs, and it is load-bearing: even when `_next/data` is excluded
 * by a negative matcher, proxy still runs for `_next/data` routes. That is
 * intentional upstream behaviour "to prevent accidental security issues where you
 * might protect a page but forget to protect the corresponding data route".
 *
 * `/api/` is NOT excluded. Route handlers need the session refreshed and the
 * request context stamped, and `POST /api/search` in particular must never be
 * reachable without an attributable session.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|pmtiles|json)$).*)',
  ],
};
