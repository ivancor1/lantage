/**
 * Supabase clients for the browser and for the server.
 *
 * NEXT 16 WARNING, and this is the one that will bite you:
 * `cookies()` is async and synchronous access is FULLY REMOVED — not deprecated,
 * removed. Every server client must be constructed with `await`:
 *
 *   const supabase = await createServerSupabaseClient();
 *
 * See AGENTS.md § "Next.js 16 deltas". Verified against
 * node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md.
 *
 * Never import this module from `services/` or any non-Next runtime — it pulls in
 * `next/headers`. Server-side jobs want `service.ts` instead.
 */

import { createBrowserClient as createSsrBrowserClient, createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import type { Database } from './types';

/** The one client type the whole app passes around. */
export type LantageClient = SupabaseClient<Database, 'public'>;

/**
 * Publishable credentials only. Both are safe in the browser bundle — RLS is what
 * protects the data, not the secrecy of this key. The service-role key is a
 * different thing entirely and lives in `service.ts`, which is `server-only`.
 */
function publicCredentials(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. ' +
        'Copy them from the Supabase project settings into .env.local — see supabase/README.md.',
    );
  }

  return { url, key };
}

/**
 * Browser client. Singleton by default in @supabase/ssr, so calling this in
 * several components does not open several auth listeners.
 */
export function createBrowserSupabaseClient(): LantageClient {
  const { url, key } = publicCredentials();
  return createSsrBrowserClient<Database, 'public'>(url, key);
}

/**
 * Server client for Server Components, Server Actions, and route handlers.
 *
 * Always create a fresh one per request — never hoist it to a module constant.
 * It closes over one request's cookies, and sharing it across requests serves one
 * user's session to another.
 */
export async function createServerSupabaseClient(): Promise<LantageClient> {
  const { url, key } = publicCredentials();
  const cookieStore = await cookies();

  return createServerClient<Database, 'public'>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. That is expected and not an
          // error: `proxy.ts` refreshes the session on every request, so the
          // refreshed token is already on its way to the browser. Swallowing this
          // is only safe BECAUSE that proxy exists — if it is ever removed, users
          // start getting logged out at random and this catch is why it is silent.
        }
      },
    },
  });
}
