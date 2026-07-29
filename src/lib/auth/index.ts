/**
 * Public surface of the governance layer's auth half.
 *
 * Deliberately does NOT re-export `provisioning.ts`. That module reaches
 * `@/lib/db/service`, which is `server-only`, and re-exporting it here would make
 * `import { canSearch } from '@/lib/auth'` fail any client build. Import it
 * directly from `@/lib/auth/provisioning` in server code.
 *
 * Start here:
 *   requireUser / requireOrg / requireRole  — who is this, and may they be here
 *   canSearch                              — may they search at all (no anonymous tier)
 *   guardSearch                            — the full pipeline for one search
 */

export * from './result';
export * from './types';
export * from './request-context';
export * from './session';
export * from './verification';
export * from './rate-limit';
export * from './guard';
