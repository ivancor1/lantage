/**
 * Service-role client. Bypasses RLS entirely.
 *
 * `import 'server-only'` is the first line for a reason: it makes the bundler fail
 * the build if any of this is ever reachable from a Client Component. A leaked
 * service-role key is not a bug, it is a breach — it reads and writes every
 * tenant's data, and it can write the append-only tables.
 */

import 'server-only';

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './types';

export type LantageServiceClient = SupabaseClient<Database, 'public'>;

/**
 * Legitimate uses, and they are narrow:
 *
 *   • provisioning an org and its first app_users row after identity verification
 *   • the Mapillary harvester writing mapillary_images
 *   • BENCH writing benchmark_runs
 *   • recording audit rows for pre-authentication events, which have no org yet
 *
 * Anything a signed-in analyst does should go through the request-scoped client in
 * `client.ts` so that RLS remains the thing enforcing tenancy. Reaching for this
 * because a policy is in the way means the policy is wrong.
 */
export function createServiceClient(): LantageServiceClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SECRET_KEY. This key is server-only and must ' +
        'never appear in a NEXT_PUBLIC_* variable — see supabase/README.md.',
    );
  }

  return createClient<Database, 'public'>(url, key, {
    auth: {
      // No cookies, no refresh loop, no persisted session. This client has no user.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
