/**
 * THE ONE FILE THAT KNOWS ABOUT OTHER AGENTS' MODULES.
 *
 * Everything in `src/lib/cascade` and `src/lib/verify` codes against the narrow
 * interfaces in `deps.ts`. This file is where the real implementations get bound,
 * and it is imported for its side effect by `src/app/api/search/route.ts`.
 *
 * To wire a dependency: uncomment its import, adapt it to the interface in
 * `deps.ts`, and add it to the `registerCascadeRuntime` call. Nothing else in the
 * cascade changes. If an adapter needs more than a few lines of glue, the
 * interface in `deps.ts` is wrong — fix it there rather than reaching into a
 * stage.
 *
 * Until each is wired:
 *  - missing **auth** or **audit** -> `POST /api/search` returns 503, by design.
 *    A search that cannot be attributed to a verified user and written to an
 *    immutable audit row is not a search this product performs.
 *  - missing **image store** -> 503, since there is nothing to analyse.
 *  - missing **vector index** -> the cascade runs and returns the coarse prior
 *    with `vpr-retrieval` skipped, and no candidate can claim street precision.
 */

import { registerCascadeRuntime } from './deps';

// --- WIRE CROSS-AGENT MODULES HERE ----------------------------------------
//
// Checked against what has actually landed in the tree, so the remaining work is
// mechanical rather than exploratory. Three adapter rules:
//
//   1. Their functions take a Supabase client as the first argument and throw on
//      error. Ours return `Result<T, StageFailure>` and never throw. Every adapter
//      is therefore: construct the client, try/catch, map the error to a
//      `StageFailure` with an analyst-readable `reason`.
//   2. Their rows are snake_case; ours are camelCase. Map field by field — do not
//      pass a row through and hope.
//   3. Their bbox order already matches ours ([minLon, minLat, maxLon, maxLat]) —
//      confirmed in `src/lib/db/queries/retrieval.ts`. Do not "fix" it.
//
// A2 — src/lib/db (present):
//   import { createServerSupabaseClient } from '@/lib/db/client';
//   import { searchGeoCandidates, getImage, createSearch, finalizeSearch,
//            insertGeoCandidates, insertAuthenticityResult, getSearch,
//            writeAudit } from '@/lib/db';
//
//   • `searchGeoCandidates(client, { embedding, bbox, metro, indexBuild, limit,
//     efSearch })` returns `GeoAnnHit[]` carrying both `distance` and `similarity`;
//     map `mapillary_id` -> `mapillaryId`, `compass_angle` -> `compassAngle`,
//     `thumb_url` -> `thumbUrl`. It THROWS on a non-512-d descriptor — catch that
//     and return `failure('invalid-response', ...)` so a wrong model degrades the
//     cascade instead of 500ing the request.
//   • `getImage(client, imageId)` returns an `ImageRow` with `storage_path`, not a
//     URL. `ImageStore.resolve` has to turn that into a signed URL (preferred) or
//     bytes: a storage path alone is not something Modal or the VLM can fetch.
//   • Persistence is three calls, not one: `createSearch` -> `insertGeoCandidates`
//     / `insertAuthenticityResult` -> `finalizeSearch`. Wrap them inside
//     `SearchResultStore.save` and keep the whole `SearchResult`, stage traces and
//     provenance included, or the result stops being reproducible.
//   • Audit lives in `src/lib/db/queries/audit.ts` (`writeAudit`), not in
//     `src/lib/audit`. Two rows per search, never an update.
//
// A3 — src/lib/auth (partially present: types, request-context, result, supabase):
//   `canSearch` and `isModuleAllowed` do not exist yet. When they do, A3's
//   `Gate<T>` (permit / refuse-with-code) maps onto `AuthGate` as:
//   `isPermitted(gate) ? { allowed: true, principal } : { allowed: false,
//   reason: gate.message, status: refusalStatus(gate.code) === 403 ? 403 : 401 }`.
//   `verified` comes from their `VerificationStatus === 'verified'`, and
//   `jurisdiction` from `Org.jurisdiction`.
//
// --------------------------------------------------------------------------

let wired = false;

/** Idempotent. Safe to call on every request; the registry is process-global. */
export function wireCascade(): void {
  if (wired) return;
  wired = true;

  registerCascadeRuntime({
    // vectorSearch: { searchGeoCandidates: adaptSearchGeoCandidates() },
    // imageStore: { resolve: adaptResolveImage() },
    // resultStore: { save: adaptSave(), get: adaptGet() },
    // auth: { canSearch, isModuleAllowed },
    // audit: { writeSearchAudit: adaptWriteAudit() },
  });
}
