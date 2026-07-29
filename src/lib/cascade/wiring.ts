/**
 * THE ONE FILE THAT KNOWS ABOUT OTHER AGENTS' MODULES.
 *
 * Everything in `src/lib/cascade` and `src/lib/verify` codes against the narrow
 * interfaces in `deps.ts`. This file is where the real implementations get bound,
 * and it is imported for its side effect by `src/app/api/search/route.ts`.
 *
 * Fail-closed vs. degrade, restated because it is the whole design:
 *  - missing **auth** or **audit** -> `POST /api/search` returns 503. A search that
 *    cannot be attributed to a verified user and written to an immutable audit row
 *    is not a search this product performs.
 *  - missing **image store** -> 503, since there is nothing to analyse.
 *  - missing **vector index** -> the cascade runs, returns the coarse prior with
 *    `vpr-retrieval` skipped, and no candidate can claim street precision.
 */

import 'server-only';

import { createServerSupabaseClient } from '@/lib/db/client';
import {
  createSearch,
  finalizeSearch,
  getImage,
  getSearch,
  insertAuthenticityResult,
  insertGeoCandidates,
  searchGeoCandidates,
  toSearchResult,
} from '@/lib/db';
import { cascadeAuthGate } from '@/lib/auth/guard';
import { cascadeAuditWriter } from '@/lib/audit/cascade';

import {
  type ImageStore,
  registerCascadeRuntime,
  type SearchResultStore,
} from './deps';
import type { GeoVectorSearch } from './vprRetrieval';
import { err, failure, ok, type Result, type StageFailure } from './types';

/**
 * Bucket holding uploaded evidence. `images.storage_path` is a path *within* this
 * bucket, not a full URL — A2 deliberately stores the pointer rather than a URL so
 * a bucket rename doesn't invalidate every historical row.
 */
const IMAGE_BUCKET = process.env.LANTAGE_IMAGE_BUCKET ?? 'evidence';

/**
 * Signed-URL lifetime. Long enough for Modal and the VLM to fetch, short enough
 * that a URL leaking out of a log is not durable access to evidence.
 */
const SIGNED_URL_TTL_SECONDS = 300;

/**
 * A2's helpers throw on error; the cascade never throws across a boundary. This is
 * the single place that translation happens.
 */
async function attempt<T>(
  what: string,
  kind: StageFailure['kind'],
  fn: () => Promise<T>,
): Promise<Result<T, StageFailure>> {
  try {
    return ok(await fn());
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(failure(kind, `${what}: ${detail}`));
  }
}

// ---------------------------------------------------------------------------
// A2 — vector search
// ---------------------------------------------------------------------------

/**
 * `bbox` is not optional here and must not become optional: it is the prune, and
 * `search_geo_candidates` applies it as a WHERE before the `<=>` ordering. An
 * unpruned planet-wide ANN scan is refused upstream in `vprRetrieval` with a
 * `policy` failure rather than silently run.
 *
 * A2's bbox order already matches ours — [minLon, minLat, maxLon, maxLat]. Do not
 * "fix" it.
 */
const vectorSearch: GeoVectorSearch = {
  async searchGeoCandidates({ embedding, bbox, limit }) {
    const client = await createServerSupabaseClient();

    // A2 throws on a non-512-d descriptor. That is a wiring bug (wrong model
    // requested), not a transport problem, so it maps to `invalid-response` and
    // degrades the stage instead of 500ing the request.
    const hits = await attempt('searchGeoCandidates', 'invalid-response', () =>
      searchGeoCandidates(client, { embedding, bbox, limit }),
    );
    if (!hits.ok) return hits;

    return ok({
      hits: hits.value.map((h) => ({
        mapillaryId: h.mapillary_id,
        lat: h.lat,
        lon: h.lon,
        similarity: h.similarity,
        compassAngle: h.compass_angle,
        thumbUrl: h.thumb_url,
        sequenceId: h.sequence_id ?? undefined,
        capturedAt: h.captured_at ?? undefined,
      })),
      // Every hit carries the same build; pin it into provenance so a result stays
      // reproducible against the exact index it was computed on.
      indexBuild: hits.value[0]?.index_build,
    });
  },
};

// ---------------------------------------------------------------------------
// A2 — image store
// ---------------------------------------------------------------------------

const imageStore: ImageStore = {
  async resolve({ imageId, orgId }) {
    const client = await createServerSupabaseClient();

    const row = await attempt('getImage', 'unavailable', () => getImage(client, imageId));
    if (!row.ok) return row;
    if (!row.value) {
      return err(failure('no-input', `image ${imageId} not found`));
    }

    // Defence in depth. RLS already scopes this by org, but a mismatch here means
    // something is wrong with the caller's scope and we should not analyse the
    // image on the strength of an id alone.
    if (row.value.org_id !== orgId) {
      return err(failure('policy', `image ${imageId} does not belong to the requesting org`));
    }

    const signed = await attempt('createSignedUrl', 'unavailable', async () => {
      const { data, error } = await client.storage
        .from(IMAGE_BUCKET)
        .createSignedUrl(row.value!.storage_path, SIGNED_URL_TTL_SECONDS);
      if (error) throw error;
      if (!data?.signedUrl) throw new Error('no signedUrl returned');
      return data.signedUrl;
    });
    if (!signed.ok) return signed;

    return ok({
      imageId,
      url: signed.value,
      mimeType: row.value.mime,
    });
  },
};

// ---------------------------------------------------------------------------
// A2 — result persistence
// ---------------------------------------------------------------------------

const resultStore: SearchResultStore = {
  async save({ result, orgId, userId, caseId }) {
    const client = await createServerSupabaseClient();

    return attempt('saveSearchResult', 'unavailable', async () => {
      // Three calls, in this order. The row opens first so candidates have a
      // search_id to hang off, and `finalizeSearch` stamps quality/stages/
      // provenance last — those three columns are the only ones an authenticated
      // caller is granted UPDATE on, so a bug that tries to rewrite `image_id` or
      // `module` fails at the database rather than quietly changing what a past
      // result claims to be about.
      const row = await createSearch(client, {
        module: result.module,
        imageId: result.imageId,
        caseId: caseId ?? null,
        orgId,
        createdBy: userId,
      });

      if (result.geo?.length) {
        // insertGeoCandidates re-runs assertStreetPrecisionIsEarned per row, and
        // the CHECK constraint enforces it again in SQL. Both layers stay.
        await insertGeoCandidates(client, row.id, result.geo);
      }
      if (result.authenticity) {
        await insertAuthenticityResult(client, row.id, result.authenticity);
      }

      await finalizeSearch(client, row.id, {
        quality: result.quality,
        stages: result.stages,
        provenance: result.provenance,
      });

      return { id: row.id };
    });
  },

  async get({ id, orgId }) {
    const client = await createServerSupabaseClient();

    const row = await attempt('getSearch', 'unavailable', () => getSearch(client, id));
    if (!row.ok) return row;
    if (!row.value) return ok(null);
    if (row.value.org_id !== orgId) {
      // Indistinguishable from "not found" on purpose — existence of another
      // tenant's search id is not something to confirm.
      return ok(null);
    }

    return ok(toSearchResult(row.value));
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let wired = false;

/** Idempotent. Safe to call on every request; the registry is process-global. */
export function wireCascade(): void {
  if (wired) return;
  wired = true;

  registerCascadeRuntime({
    vectorSearch,
    imageStore,
    resultStore,
    // A3. Both are already typed against B2's `AuthGate` / `AuditWriter`.
    auth: cascadeAuthGate,
    audit: cascadeAuditWriter,
  });
}
