/**
 * GET /api/search/[id] — fetch a persisted result.
 *
 * Next 16: `params` is a Promise and **must be awaited**. Synchronous access was
 * fully removed, not deprecated (AGENTS.md §1).
 *
 * The org scope is taken from the authenticated principal and never from the
 * request, so a result id from another tenant reads as 404 rather than 403 — an
 * existence oracle across tenants is itself a leak.
 */

import { getCascadeRuntime, missingRequiredDependencies } from '@/lib/cascade/deps';
import { wireCascade } from '@/lib/cascade/wiring';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  // Generated type helper, not a hand-written prop type (AGENTS.md §3). It is
  // produced by `next typegen`, which `next dev` and `next build` run for you.
  context: RouteContext<'/api/search/[id]'>,
): Promise<Response> {
  // Next 16: `params` is a Promise. Synchronous access was removed outright.
  const { id } = await context.params;

  wireCascade();
  const cascade = getCascadeRuntime();

  const missing = missingRequiredDependencies(cascade);
  if (missing.length > 0) {
    return json(
      {
        error: 'service-unavailable',
        message: 'Results are not available because required dependencies are not wired.',
        missing,
      },
      503,
    );
  }
  const auth = cascade.auth;
  if (!auth) {
    return json({ error: 'service-unavailable', message: 'Auth is not wired.' }, 503);
  }

  const decision = await auth.canSearch(request);
  if (!decision.allowed || !decision.principal) {
    return json(
      {
        error: decision.status === 403 ? 'forbidden' : 'unauthorized',
        message: decision.reason ?? 'Not permitted to read search results.',
      },
      decision.status ?? 401,
    );
  }

  if (!cascade.resultStore) {
    return json(
      {
        error: 'service-unavailable',
        message:
          'Result persistence is not wired, so past results cannot be read back. Re-run the search.',
      },
      503,
    );
  }

  const found = await cascade.resultStore.get({ id, orgId: decision.principal.orgId });
  if (!found.ok) {
    return json({ error: 'internal-error', message: found.error.reason }, 500);
  }
  if (!found.value) {
    return json({ error: 'not-found', message: `No result ${id} for this organisation.` }, 404);
  }
  return json(found.value, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
