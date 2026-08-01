/**
 * POST /api/refine — stage 2: street-level analysis scoped to ONE region.
 *
 * THIS ROUTE IS INTENTIONALLY UNAUTHENTICATED. It is for local single-operator
 * use only: no session, no org scoping, no audit row, and it reads images from
 * `.lantage-uploads/` on the machine running the dev server. The authenticated,
 * audited, org-scoped production path is `/api/search` — deploy that one
 * publicly, never this one.
 *
 * The `bbox` is required by the schema and there is no default. That is the
 * contract of this endpoint: refinement is a *scoped* search, and a request
 * without a scope is a 400 rather than a planet-wide ANN query. `refineInRegion`
 * refuses it a second time for callers that reach it directly.
 *
 * A module that cannot run is never an error here. No index, no embedding
 * service, no match — all of those return 200 with zero candidates, the reason,
 * and the env var or harvest command that would change the answer. Only a
 * malformed request is a 4xx.
 */

import { LiveRefineRequestSchema, refineInRegion } from '@/lib/live/refine';

/** Node runtime: this reads uploaded bytes from local disk and decodes images. */
export const runtime = 'nodejs';

/**
 * Retrieval is two network hops — the embedding container and the first HNSW
 * page after an idle database — either of which can be cold. `REFINE_BUDGET_MS`
 * caps the work at 20s; this is the platform ceiling above it.
 */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad-request', message: 'Body must be JSON.' }, 400);
  }

  const parsed = LiveRefineRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: 'bad-request',
        message:
          'The refine request did not match the contract. A bbox is required: refinement is a scoped search and is never run unbounded.',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400,
    );
  }

  try {
    const result = await refineInRegion({
      uploadId: parsed.data.uploadId,
      region: parsed.data.region,
      bbox: parsed.data.bbox,
      ...(parsed.data.signage ? { signage: parsed.data.signage } : {}),
      signal: request.signal,
    });

    // A refusal is a well-formed result, not an HTTP error — except for an
    // unknown upload, which is a client mistake and has to read as one.
    if (result.refusal?.kind === 'no-input') {
      return json({ error: 'not-found', message: result.refusal.reason, result }, 404);
    }
    return json(result, 200);
  } catch (e) {
    // `refineInRegion` catches its own faults and returns a refusal, so reaching
    // here means something outside it broke.
    return json(
      {
        error: 'internal-error',
        message: `The refinement failed before it could produce a result: ${e instanceof Error ? e.message : String(e)}`,
      },
      500,
    );
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
