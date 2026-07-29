/**
 * Public surface of the data layer.
 *
 * Deliberately does NOT re-export `client.ts` or `service.ts`.
 *
 *   • `client.ts` imports `next/headers`, which throws if it is pulled into a
 *     Client Component.
 *   • `service.ts` is `server-only`, and re-exporting it here would make importing
 *     anything from `@/lib/db` fail a client build.
 *
 * So construct clients from their own modules and use this barrel for everything
 * else:
 *
 *   import { createServerSupabaseClient } from '@/lib/db/client';
 *   import { createSearch, toSearchResult } from '@/lib/db';
 */

export * from './errors';
export * from './mappers';
export * from './queries';
export * from './types';
